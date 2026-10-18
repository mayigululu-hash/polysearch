/**
 * DeepSeek 搜索 provider（官方 Search/Fetch API）
 * 文档依据：https://api-docs.deepseek.com/guides/search（2026-10 核实）
 *   POST {base}/v1/tools/search   Bearer 认证，按成功次数计费，429=5QPS 账户级限流
 *   POST {base}/v1/tools/fetch    抓取网页正文，返回 Markdown
 */
'use strict';

const DEFAULT_BASE = process.env.POLYSEARCH_DEEPSEEK_BASE || 'https://api.deepseek.com';

/** 统一错误：带 HTTP 状态码，路由器据此分类 */
function httpError(status, message) {
  const e = new Error(message || `HTTP ${status}`);
  e.status = status;
  return e;
}

class DeepSeekProvider {
  constructor(cfg = {}) {
    this.name = 'deepseek';
    this.priority = cfg.priority ?? 2;
    this.enabled = cfg.enabled !== false;
    this.monthlyLimit = cfg.monthlyLimit ?? null;
    this.switchEarly = cfg.switchEarly ?? null;
    this.base = cfg.base || DEFAULT_BASE;
    this.timeoutMs = cfg.timeoutMs ?? 30000;
    this._key = cfg.apiKey || process.env[cfg.apiKeyEnv || 'POLYSEARCH_DEEPSEEK_KEY'] || '';
  }

  hasKey() { return !!this._key; }

  /** 429/408/5xx 可重试；402=需充值（配额型）；其余 4xx 不改参数重试无意义 */
  classifyStatus(status) {
    if (status === 429 || status === 408 || status >= 500) return 'RETRYABLE';
    if (status === 402) return 'QUOTA';
    return 'FATAL';
  }

  /**
   * params: { query, count, maxAgeDays?, needContent?, lang?, site? }
   * 返回统一格式 { results: [{title,url,snippet,summary,publishedAt,site,authority,extra}] }
   */
  async search(params = {}) {
    const query = this._buildQuery(params);
    const body = { query, count: Math.min(Math.max(params.count ?? 10, 1), 50) };
    if (params.needContent) body.need_content = true;

    const data = await this._post('/v1/tools/search', body);
    const results = (data.results || []).map(r => ({
      title: r.title || '',
      url: r.url || '',
      snippet: r.snippet || '',
      summary: r.summary || '',
      publishedAt: r.date || null,
      site: r.site_name || null,
      authority: typeof r.authority === 'number' ? r.authority : null,
      extra: { rerank_score: r.rerank_score, has_content: !!r.content },
    }));
    return { results, provider: this.name };
  }

  /** 抓取网页正文，返回 { title, content }；content 为 Markdown */
  async fetchPage(url) {
    if (!/^https?:\/\//i.test(url) || url.length > 8192) {
      throw Object.assign(new Error('url 需为 http(s) 且不超过 8192 字符'), { status: 0, kind: 'FATAL' });
    }
    const data = await this._post('/v1/tools/fetch', { url }, 60000);
    return { title: data.title || '', content: data.content || '' };
  }

  /** 把统一参数翻译成 DeepSeek 查询运算符（site:/lang:/after: 原样转发） */
  _buildQuery({ query, maxAgeDays, lang, site }) {
    let q = (query || '').trim();
    if (!q) throw Object.assign(new Error('query 不能为空'), { status: 0, kind: 'FATAL' });
    if (site) q += ` site:${site}`;
    if (lang) q += ` lang:${lang}`;
    if (maxAgeDays && Number.isFinite(maxAgeDays) && maxAgeDays > 0) {
      const d = new Date(Date.now() - maxAgeDays * 86400000);
      q += ` after:${d.toISOString().slice(0, 10)}`;
    }
    // 官方限制 1–128 个 Unicode 字符
    if ([...q].length > 128) q = [...q].slice(0, 128).join('');
    return q;
  }

  async _post(pathname, body, timeoutMs) {
    let res, text = '';
    try {
      res = await fetch(this.base + pathname, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this._key}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs || this.timeoutMs),
      });
      text = await res.text();
    } catch (err) {
      if (err?.name === 'TimeoutError' || err?.code === 'ABORT_ERR') {
        throw Object.assign(new Error('请求超时'), { status: 408, kind: 'RETRYABLE' });
      }
      throw Object.assign(new Error(`网络错误：${err.message}`), { status: 0, kind: 'RETRYABLE' });
    }

    if (!res.ok) {
      let msg = text.slice(0, 300);
      try { msg = JSON.parse(text)?.error?.message || msg; } catch { /* 保留原文 */ }
      throw httpError(res.status, `DeepSeek API ${res.status}：${msg}`);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw Object.assign(new Error('返回体不是合法 JSON'), { status: 0, kind: 'RETRYABLE' });
    }
  }
}

module.exports = { DeepSeekProvider };
