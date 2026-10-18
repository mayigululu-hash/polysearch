/**
 * 豆包搜索 provider（火山引擎「豆包搜索 Custom版」OpenAPI）
 * 文档依据：https://docs.volcengine.com/docs/Networkedsearch/Networkedsearch-2（2026-10 核实）
 *   POST https://open.feedcoopapi.com/search_api/web_search
 *   Authorization: Bearer <API_KEY>，Content-Type: application/json
 *   请求：{ Query(1~100字,过长截断), SearchType:"web", Count(≤50,默认10), EnableWaiting?, MaxWaitTime? }
 *   成功：{ ResponseMetadata, Result: { ResultCount, WebResults: [...], ... } }
 *   失败：{ ResponseMetadata: { Error: { CodeN, Code, Message } }, Result: null }（HTTP 也可能非 2xx）
 *
 * 错误码分类（熔断依据，同文档错误处理表）：
 *   QUOTA     10406 免费额度用尽 / 10412 套餐剩余额度不足 → 熔断，跨月或手动重置可恢复
 *   FATAL     10400/10401/10402/10403/10408/10409/10410 → 熔断，需人工处理（key 错、未开通等）
 *   RETRYABLE 700429 QPS 限流 / 10500 服务端内部错误 → 退避重试
 *
 * 注意：豆包接口不支持 lang/site/时间窗等查询运算符，这几个参数在此 provider 上被忽略
 *      （路由器传同一份参数，DeepSeek 侧会翻译成 site:/lang:/after: 运算符）。
 */
'use strict';

const DEFAULT_BASE = process.env.POLYSEARCH_DOUBAO_BASE || 'https://open.feedcoopapi.com';

const QUOTA_CODES = new Set([10406, 10412]);
const FATAL_CODES = new Set([10400, 10401, 10402, 10403, 10408, 10409, 10410]);
const RETRYABLE_CODES = new Set([700429, 10500]);

class DoubaoProvider {
  constructor(cfg = {}) {
    this.name = 'doubao';
    this.priority = cfg.priority ?? 1;
    this.enabled = cfg.enabled !== false;
    this.monthlyLimit = cfg.monthlyLimit ?? null;
    this.switchEarly = cfg.switchEarly ?? null;
    this.base = cfg.base || DEFAULT_BASE;
    this.timeoutMs = cfg.timeoutMs ?? 30000;
    this._key = cfg.apiKey || process.env[cfg.apiKeyEnv || 'POLYSEARCH_DOUBAO_KEY'] || '';
  }

  hasKey() { return !!this._key; }

  classifyStatus(status) {
    if (status === 429 || status === 408 || status >= 500) return 'RETRYABLE';
    return 'FATAL';
  }

  /** 把业务错误码翻译成路由器的错误分类 */
  classifyCode(codeN) {
    if (QUOTA_CODES.has(codeN)) return 'QUOTA';
    if (RETRYABLE_CODES.has(codeN)) return 'RETRYABLE';
    if (FATAL_CODES.has(codeN)) return 'FATAL';
    return 'RETRYABLE'; // 未知码保守当作服务端临时问题
  }

  /**
   * params: { query, count }（maxAgeDays/lang/site 不支持，忽略）
   * 返回统一格式 { results: [{title,url,snippet,summary,publishedAt,site,authority,extra}] }
   */
  async search(params = {}) {
    const query = (params.query || '').trim();
    if (!query) throw Object.assign(new Error('query 不能为空'), { status: 0, kind: 'FATAL' });
    // 官方限制 1~100 字，过长截断
    const q = [...query].slice(0, 100).join('');
    const body = { Query: q, SearchType: 'web', Count: Math.min(Math.max(params.count ?? 10, 1), 50) };

    const data = await this._post('/search_api/web_search', body);
    const web = data?.Result?.WebResults || [];
    const results = web.map(r => ({
      title: r.Title || '',
      url: r.Url || '',
      snippet: r.Snippet || '',
      summary: r.Summary || r.Snippet || '',
      publishedAt: r.PublishTime || null,
      site: r.SiteName || null,
      authority: typeof r.AuthInfoLevel === 'number' ? r.AuthInfoLevel : null,
      extra: {
        rank_score: r.RankScore,
        auth_des: r.AuthInfoDes,
        has_content: !!r.Content,
      },
    }));
    return { results, provider: this.name };
  }

  async _post(pathname, body) {
    let res, text = '';
    try {
      res = await fetch(this.base + pathname, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this._key}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      text = await res.text();
    } catch (err) {
      if (err?.name === 'TimeoutError' || err?.code === 'ABORT_ERR') {
        throw Object.assign(new Error('请求超时'), { status: 408, kind: 'RETRYABLE' });
      }
      throw Object.assign(new Error(`网络错误：${err.message}`), { status: 0, kind: 'RETRYABLE' });
    }

    let data = null;
    try { data = JSON.parse(text); } catch { /* 不是 JSON，走 HTTP 状态分类 */ }

    // 业务错误信封：ResponseMetadata.Error.CodeN 是权威判据（HTTP 状态可能仍是 200）
    const bizErr = data?.ResponseMetadata?.Error;
    if (bizErr?.CodeN != null) {
      const kind = this.classifyCode(Number(bizErr.CodeN));
      throw Object.assign(
        new Error(`豆包搜索错误 ${bizErr.CodeN}：${bizErr.Message || ''}`),
        { status: res.status, kind, codeN: bizErr.CodeN }
      );
    }
    if (!res.ok) throw Object.assign(new Error(`豆包搜索 HTTP ${res.status}：${text.slice(0, 200)}`), { status: res.status, kind: this.classifyStatus(res.status) });
    if (!data?.Result) throw Object.assign(new Error('豆包搜索返回缺少 Result'), { status: 0, kind: 'RETRYABLE' });
    return data;
  }
}

module.exports = { DoubaoProvider };
