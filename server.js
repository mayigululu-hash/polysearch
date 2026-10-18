#!/usr/bin/env node
/**
 * polysearch-mcp —— 多源搜索 MCP server（零依赖，Node >= 18）
 *
 * 做什么：把多个搜索 API（豆包搜索、DeepSeek Search，可继续加）聚合成一个 MCP 工具，
 *        按配置的优先级链自动路由：前面的配额用完/故障，自动切后面的。
 * 怎么跑：node server.js（stdio 传输，由 MCP 客户端拉起；配置在 ~/.polysearch/config.json）
 * 怎么改：provider 一家一个文件放 providers/ 下，实现 search() 接口即可被自动加载；
 *        路由与熔断逻辑在 lib/router.js，配额账本在 lib/state.js，改哪个文件互不影响。
 *
 * MCP 协议只用到四个方法（initialize / tools/list / tools/call / ping），
 * 为零依赖直接实现了 JSON-RPC 2.0 分帧，没有引官方 SDK——省掉 npm 安装和构建步骤，
 * 换机器、上服务器拷过去就能跑。
 */
'use strict';
const readline = require('readline');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_DIR = path.join(os.homedir(), '.polysearch');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

/* ---------------- 配置 ---------------- */

const DEFAULT_CONFIG = {
  providers: {
    doubao: { enabled: true, priority: 1, apiKeyEnv: 'POLYSEARCH_DOUBAO_KEY', monthlyLimit: 500, switchEarly: 480 },
    deepseek: { priority: 2, apiKeyEnv: 'POLYSEARCH_DEEPSEEK_KEY' },
  },
};

function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return raw && raw.providers ? raw : DEFAULT_CONFIG;
  } catch {
    // 首次运行：落一份默认配置，用户往里填 key 就能用
    try {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n');
      console.error(`[polysearch] 已生成默认配置 ${CONFIG_FILE}，请填入 API key`);
    } catch (e) {
      console.error(`[polysearch] 配置文件不可写：${e.message}`);
    }
    return DEFAULT_CONFIG;
  }
}

/* ---------------- provider 装配 ----------------
 * 规则：config.providers 里每个名字，到 providers/<名字>.js 找导出的 Provider 类
 * （约定：类名以 Provider 结尾，如 module.exports = { DoubaoProvider }）。
 * 要接新搜索源：拷一份 deepseek.js 改映射，配置里加一段即可，server 不用动。
 */
function loadProviders(cfg) {
  const list = [];
  for (const [name, pcfg] of Object.entries(cfg.providers || {})) {
    try {
      const mod = require(`./providers/${name}`);
      const Ctor = typeof mod === 'function'
        ? mod
        : Object.values(mod).find(v => typeof v === 'function' && /Provider$/.test(v.name || ''));
      if (typeof Ctor !== 'function') throw new Error('模块没有导出 *Provider 类');
      list.push(new Ctor({ ...pcfg, name }));
    } catch (e) {
      console.error(`[polysearch] provider "${name}" 加载失败：${e.message}`);
    }
  }
  return list;
}

/* ---------------- 工具实现 ---------------- */

const state = require('./lib/state');
const { routeSearch } = require('./lib/router');

function makeContext(providers) {
  const byName = Object.fromEntries(providers.map(p => [p.name, p]));

  async function doSearch(params) {
    const st = state.load();
    const { resetList } = state.maybeMonthlyReset(st);
    if (resetList.length) {
      console.error(`[polysearch] 跨月重置：${resetList.join(', ')}`);
    }
    try {
      const out = await routeSearch(providers, st, params, {
        call: async (p, q) => p.search(q),
      });
      state.recordSuccess(st, out.providerName);
      return { results: out.results, providerName: out.providerName, attempts: out.attempts };
    } finally {
      // 成功、失败都要落盘：熔断状态、本地计数不能因异常丢失
      state.save(st);
    }
  }

  return { byName, doSearch };
}

function formatSearch(out, params) {
  const lines = [];
  lines.push(`[搜索源：${out.providerName}] 查询「${params.query}」共 ${out.results.length} 条结果`);
  if (out.results.length === 0) lines.push('（无结果）');
  out.results.forEach((r, i) => {
    lines.push('');
    lines.push(`${i + 1}. ${r.title}`);
    lines.push(`   链接：${r.url}`);
    const metaBits = [];
    if (r.publishedAt) metaBits.push(`时间：${r.publishedAt}`);
    if (r.site) metaBits.push(`来源：${r.site}`);
    if (r.authority != null) metaBits.push(`权威度：${r.authority}/4`);
    if (metaBits.length) lines.push(`   ${metaBits.join(' | ')}`);
    const body = r.summary || r.snippet || '';
    if (body) lines.push(`   ${body.replace(/\s+/g, ' ').slice(0, 900)}`);
  });
  return lines.join('\n');
}

/* ---------------- MCP 协议层（JSON-RPC 2.0 over stdio，按行分帧） ---------------- */

const SERVER_INFO = { name: 'polysearch', version: '1.0.0' };

const TOOL_SCHEMAS = {
  web_search: {
    description:
      '联网搜索（多源自动路由：豆包搜索优先，配额用尽或故障自动切 DeepSeek）。' +
      '返回标题、链接、时间、摘要。适合查新闻、资料、行情等一切需要实时信息的场景。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词' },
        count: { type: 'integer', description: '结果条数，默认 10' },
        maxAgeDays: { type: 'integer', description: '只看最近 N 天（可选）' },
        needContent: { type: 'boolean', description: '是否附带页面正文（更耗 token，默认否）' },
        lang: { type: 'string', description: '限定语言，如 zh、zh,en（可选）' },
        site: { type: 'string', description: '限定站点域名，如 github.com（可选）' },
      },
      required: ['query'],
    },
  },
  fetch_page: {
    description: '抓取指定 URL 的网页正文，返回 Markdown。适合读文章、看文档原文。',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'http(s) 链接' } },
      required: ['url'],
    },
  },
  search_status: {
    description: '查看各搜索源的配额与熔断状态；可传 reset=true 手动重置（默认全部，或指定 provider）。',
    inputSchema: {
      type: 'object',
      properties: {
        reset: { type: 'boolean', description: '置 true 执行重置' },
        provider: { type: 'string', description: '只重置这一家（doubao / deepseek）' },
      },
    },
  },
};

function toolResult(text, isError = false) {
  const r = { content: [{ type: 'text', text }] };
  if (isError) r.isError = true;
  return r;
}

async function handleToolCall(ctx, name, args = {}) {
  if (name === 'web_search') {
    if (!args.query) return toolResult('错误：query 不能为空', true);
    try {
      const out = await ctx.doSearch(args);
      return toolResult(formatSearch(out, args));
    } catch (e) {
      return toolResult(`搜索失败：${e.message}`, true);
    }
  }

  if (name === 'fetch_page') {
    const p = ctx.byName.deepseek; // v1 抓正文只有 DeepSeek 提供
    if (!p || !p.hasKey()) return toolResult('错误：fetch_page 需要 DeepSeek key（providers.deepseek）', true);
    if (p.fetchPage == null) return toolResult('错误：该 provider 不支持 fetch', true);
    try {
      const { title, content } = await p.fetchPage(args.url);
      const MAX = 50000;
      const body = content.length > MAX ? content.slice(0, MAX) + `\n\n…（已截断，原文 ${content.length} 字符）` : content;
      return toolResult(`${title ? title + '\n\n' : ''}${body}`);
    } catch (e) {
      return toolResult(`抓取失败：${e.message}`, true);
    }
  }

  if (name === 'search_status') {
    const st = state.load();
    state.maybeMonthlyReset(st);
    if (args.reset) {
      const names = args.provider ? [args.provider] : Object.keys(st);
      names.forEach(n => state.reset(st, n));
      state.save(st);
      return toolResult(`已重置：${names.join(', ')}`);
    }
    const lines = [`polysearch 状态（${new Date().toISOString().slice(0, 10)}，账本：${state.STATE_FILE}）`];
    for (const [name2, e] of Object.entries(st)) {
      const p = ctx.byName[name2];
      const bits = [
        p && p.hasKey() ? 'key ✓' : 'key ✗（未配置）',
        p ? `enabled=${p.enabled}` : '未装配',
        p ? `priority=${p.priority}` : '',
        p && p.monthlyLimit != null ? `本月 ${e.count}/${p.monthlyLimit}` : `本月 ${e.count} 次`,
        e.circuitOpen ? `熔断：是（${e.openReason}，自 ${e.openedAt}）` : '熔断：否',
      ].filter(Boolean);
      lines.push(`- ${name2}：${bits.join('，')}`);
    }
    return toolResult(lines.join('\n'));
  }

  return toolResult(`未知工具：${name}`, true);
}

/* ---------------- 主循环 ---------------- */

function main() {
  const cfg = loadConfig();
  const providers = loadProviders(cfg);
  const ctx = makeContext(providers);
  console.error(`[polysearch] 启动：${providers.map(p => `${p.name}${p.hasKey() ? '' : '(无key)'}`).join(', ') || '无可用 provider'}`);

  const rl = readline.createInterface({ input: process.stdin, terminal: false });

  const write = obj => process.stdout.write(JSON.stringify(obj) + '\n');

  rl.on('line', line => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try { msg = JSON.parse(trimmed); } catch { return; } // 坏行静默丢弃，不打断会话
    if (!msg || msg.jsonrpc !== '2.0') return;

    const isNotification = msg.id === undefined || msg.id === null;
    if (msg.method === 'initialize') {
      return write({
        jsonrpc: '2.0', id: msg.id,
        result: {
          // 客户端发什么版本就回什么版本，保证兼容
          protocolVersion: msg.params?.protocolVersion || '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        },
      });
    }
    if (msg.method === 'ping') return write({ jsonrpc: '2.0', id: msg.id, result: {} });
    if (msg.method === 'tools/list') {
      return write({
        jsonrpc: '2.0', id: msg.id,
        result: { tools: Object.entries(TOOL_SCHEMAS).map(([name, t]) => ({ name, ...t })) },
      });
    }
    if (msg.method === 'tools/call') {
      const { name, arguments: args } = msg.params || {};
      handleToolCall(ctx, name, args)
        .then(r => write({ jsonrpc: '2.0', id: msg.id, result: r }))
        .catch(e => write({
          jsonrpc: '2.0', id: msg.id,
          error: { code: -32603, message: `内部错误：${e.message}` },
        }));
      return;
    }
    // 未声明的能力不响应列表请求；未知通知忽略，未知请求回 -32601
    if (!isNotification && !msg.method.startsWith('notifications/')) {
      write({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `方法不存在：${msg.method}` } });
    }
  });

  rl.on('close', () => process.exit(0));
}

main();
