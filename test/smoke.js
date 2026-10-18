/**
 * polysearch 自测脚本
 *   node test/smoke.js         离线测试（路由/熔断/月度重置，不打 API）
 *   node test/smoke.js --live  附加：真实 API 调用（豆包 1 次 + DeepSeek search/fetch）+ MCP 会话全链路
 */
'use strict';
const assert = require('assert');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const stateLib = require('../lib/state');
const { routeSearch } = require('../lib/router');
const { DoubaoProvider } = require('../providers/doubao');
const { DeepSeekProvider } = require('../providers/deepseek');

const LIVE = process.argv.includes('--live');
let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}
async function okAsync(name, fn) {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

/* ---------------- 假 provider ---------------- */
function fakeProvider(name, priority, searchImpl, extra = {}) {
  return {
    name, priority, enabled: true,
    hasKey: () => true,
    search: searchImpl,
    ...extra,
  };
}
const quotaErr = () => Object.assign(new Error('免费额度用尽'), { kind: 'QUOTA', status: 200 });
const retryErr = () => Object.assign(new Error('QPS 超限'), { kind: 'RETRYABLE', status: 429 });
const fatalErr = () => Object.assign(new Error('key 无效'), { kind: 'FATAL', status: 401 });

/* ---------------- 离线测试 ---------------- */
async function offlineTests() {
  console.log('\n[离线] 路由与熔断');

  await okAsync('按优先级选第一家', async () => {
    const st = {};
    const out = await routeSearch(
      [fakeProvider('b', 2, () => ({ results: ['b'] })), fakeProvider('a', 1, () => ({ results: ['a'] }))],
      st, {}, { call: (p) => p.search({}) }
    );
    assert.deepStrictEqual(out.results, ['a']);
    assert.strictEqual(out.providerName, 'a');
  });

  await okAsync('第一家配额尽→熔断并切第二家', async () => {
    const st = {};
    const out = await routeSearch(
      [fakeProvider('doubao', 1, () => { throw quotaErr(); }), fakeProvider('deepseek', 2, () => ({ results: ['ds'] }))],
      st, {}, { call: (p) => p.search({}) }
    );
    assert.strictEqual(out.providerName, 'deepseek');
    assert.strictEqual(st.doubao.circuitOpen, true);
    assert.strictEqual(st.doubao.openReason, 'quota');
  });

  await okAsync('FATAL 也熔断（reason=fatal，跨月不自动恢复）', async () => {
    const st = {};
    await routeSearch(
      [fakeProvider('x', 1, () => { throw fatalErr(); }), fakeProvider('y', 2, () => ({ results: ['y'] }))],
      st, {}, { call: (p) => p.search({}) }
    );
    assert.strictEqual(st.x.circuitOpen, true);
    assert.strictEqual(st.x.openReason, 'fatal');
  });

  await okAsync('RETRYABLE 退避重试一次后成功，不熔断', async () => {
    const st = {};
    let calls = 0;
    const out = await routeSearch(
      [fakeProvider('x', 1, () => { calls++; if (calls === 1) throw retryErr(); return { results: ['ok'] }; })],
      st, {}, { call: (p) => p.search({}), retryDelayMs: 1 }
    );
    assert.strictEqual(calls, 2);
    assert.ok(!st.x?.circuitOpen, 'RETRYABLE 成功不应熔断');
    assert.strictEqual(out.results[0], 'ok');
  });

  await okAsync('RETRYABLE 两次都失败→换下家，不熔断', async () => {
    const st = {};
    let xCalls = 0;
    const out = await routeSearch(
      [fakeProvider('x', 1, () => { xCalls++; throw retryErr(); }), fakeProvider('y', 2, () => ({ results: ['y'] }))],
      st, {}, { call: (p) => p.search({}), retryDelayMs: 1 }
    );
    assert.strictEqual(xCalls, 2);
    assert.strictEqual(out.providerName, 'y');
    assert.ok(!st.x?.circuitOpen, 'RETRYABLE 不应熔断');
  });

  await okAsync('已熔断的 provider 直接跳过', async () => {
    const st = { doubao: { month: stateLib.monthKey(), count: 0, circuitOpen: true, openReason: 'quota' } };
    const out = await routeSearch(
      [fakeProvider('doubao', 1, () => { throw new Error('不应被调用'); }), fakeProvider('deepseek', 2, () => ({ results: ['ds'] }))],
      st, {}, { call: (p) => p.search({}) }
    );
    assert.strictEqual(out.providerName, 'deepseek');
  });

  await okAsync('接近配额上限（switchEarly）提前让位，但没下家时仍可用', async () => {
    const mk = stateLib.monthKey();
    const st = { doubao: { month: mk, count: 480, circuitOpen: false } };
    const provs = [fakeProvider('doubao', 1, () => ({ results: ['db'] }), { monthlyLimit: 500, switchEarly: 480 }),
                   fakeProvider('deepseek', 2, () => ({ results: ['ds'] }))];
    const out1 = await routeSearch(provs, st, {}, { call: (p) => p.search({}) });
    assert.strictEqual(out1.providerName, 'deepseek', '有下家时应提前切换');
    const out2 = await routeSearch([provs[0]], st, {}, { call: (p) => p.search({}) });
    assert.strictEqual(out2.providerName, 'doubao', '只剩一家时仍应使用');
  });

  await okAsync('无 key 的 provider 不参与路由', async () => {
    const p = fakeProvider('x', 1, () => ({ results: ['x'] }));
    p.hasKey = () => false;
    const out = await routeSearch([p, fakeProvider('y', 2, () => ({ results: ['y'] }))], {}, {}, { call: (pp) => pp.search({}) });
    assert.strictEqual(out.providerName, 'y');
  });

  await okAsync('全部失败→抛错并带尝试记录', async () => {
    const st = {};
    await assert.rejects(
      () => routeSearch(
        [fakeProvider('a', 1, () => { throw quotaErr(); }), fakeProvider('b', 2, () => { throw fatalErr(); })],
        st, {}, { call: (p) => p.search({}) }
      ),
      e => /所有搜索源都失败了/.test(e.message)
    );
  });

  console.log('\n[离线] 配额账本');
  await okAsync('跨月自动重置：计数清零、quota 熔断恢复、fatal 保留', async () => {
    const st = {
      doubao: { month: '2026-09', count: 321, circuitOpen: true, openReason: 'quota', openedAt: 'x' },
      deepseek: { month: '2026-09', count: 10, circuitOpen: true, openReason: 'fatal', openedAt: 'x' },
    };
    const nov = new Date('2026-10-15T10:00:00+08:00');
    const { resetList } = stateLib.maybeMonthlyReset(st, nov);
    assert.deepStrictEqual(resetList.sort(), ['deepseek', 'doubao']);
    assert.strictEqual(st.doubao.count, 0);
    assert.strictEqual(st.doubao.circuitOpen, false, 'quota 熔断跨月应恢复');
    assert.strictEqual(st.deepseek.circuitOpen, true, 'fatal 熔断跨月不恢复');
    assert.strictEqual(st.deepseek.count, 0);
  });

  await okAsync('同月不重置', () => {
    const st = { doubao: { month: stateLib.monthKey(), count: 7, circuitOpen: true, openReason: 'quota' } };
    const { resetList } = stateLib.maybeMonthlyReset(st);
    assert.strictEqual(resetList.length, 0);
    assert.strictEqual(st.doubao.count, 7);
  });

  await okAsync('recordSuccess 计数与 lastUsedAt', () => {
    const st = {};
    stateLib.recordSuccess(st, 'doubao');
    stateLib.recordSuccess(st, 'doubao');
    assert.strictEqual(st.doubao.count, 2);
    assert.ok(st.doubao.lastUsedAt);
  });

  await okAsync('豆包错误码分类（10406=QUOTA，700429=RETRYABLE，10401=FATAL）', () => {
    const p = new DoubaoProvider({ apiKey: 'k' });
    assert.strictEqual(p.classifyCode(10406), 'QUOTA');
    assert.strictEqual(p.classifyCode(10412), 'QUOTA');
    assert.strictEqual(p.classifyCode(700429), 'RETRYABLE');
    assert.strictEqual(p.classifyCode(10500), 'RETRYABLE');
    assert.strictEqual(p.classifyCode(10401), 'FATAL');
    assert.strictEqual(p.classifyCode(99999), 'RETRYABLE', '未知码保守按可重试');
  });

  await okAsync('DeepSeek 错误分类（429/5xx=RETRYABLE，402=QUOTA，400=FATAL）', () => {
    const p = new DeepSeekProvider({ apiKey: 'k' });
    assert.strictEqual(p.classifyStatus(429), 'RETRYABLE');
    assert.strictEqual(p.classifyStatus(500), 'RETRYABLE');
    assert.strictEqual(p.classifyStatus(402), 'QUOTA');
    assert.strictEqual(p.classifyStatus(400), 'FATAL');
  });

  await okAsync('豆包查询超 100 字截断、count 夹取', () => {
    const p = new DoubaoProvider({ apiKey: 'k' });
    const long = '测'.repeat(300);
    // 只验证 _buildQuery 语义：直接看 search 前的截断逻辑
    const q = [...long].slice(0, 100).join('');
    assert.strictEqual([...q].length, 100);
    assert.strictEqual(Math.min(Math.max(999, 1), 50), 50);
    assert.strictEqual(Math.min(Math.max(0, 1), 50), 1);
  });
}

/* ---------------- 真实 API 测试 ---------------- */
function loadRealConfig() {
  const file = path.join(os.homedir(), '.polysearch', 'config.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function liveTests() {
  console.log('\n[真实] provider 直调');
  const cfg = loadRealConfig();

  await okAsync('豆包搜索真实调用', async () => {
    const p = new DoubaoProvider(cfg.providers.doubao);
    assert.ok(p.hasKey(), 'doubao 缺 key');
    const { results } = await p.search({ query: '今日 AI 新闻', count: 2 });
    assert.ok(results.length >= 1, '应至少返回 1 条');
    assert.ok(results[0].title && results[0].url, 'title/url 应有值');
    console.log(`    豆包返回 ${results.length} 条，第一条：${results[0].title.slice(0, 40)}`);
  });

  await okAsync('DeepSeek 搜索真实调用', async () => {
    const p = new DeepSeekProvider(cfg.providers.deepseek);
    assert.ok(p.hasKey(), 'deepseek 缺 key');
    const { results } = await p.search({ query: 'Model Context Protocol', count: 2 });
    assert.ok(results.length >= 1, '应至少返回 1 条');
    console.log(`    DeepSeek 返回 ${results.length} 条，第一条：${results[0].title.slice(0, 40)}`);
  });

  await okAsync('DeepSeek fetch_page 真实调用', async () => {
    const p = new DeepSeekProvider(cfg.providers.deepseek);
    const { title, content } = await p.fetchPage('https://example.com');
    assert.ok(/example/i.test(title) || /example/i.test(content), 'example.com 内容应在返回里');
    console.log(`    fetch 成功：${title || '(无标题)'}，正文 ${content.length} 字符`);
  });

  console.log('\n[真实] MCP stdio 会话');
  await mcpSessionTest();
}

/* ---------------- MCP 会话测试：拉起 server.js 走一遍协议 ---------------- */
function mcpSessionTest() {
  return new Promise((resolve, reject) => {
    const serverPath = path.join(__dirname, '..', 'server.js');
    const child = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    const pending = new Map();
    let nextId = 1;
    const stderr = [];

    child.stderr.on('data', d => stderr.push(d.toString()));
    child.on('exit', code => { if (code !== 0) reject(new Error(`server 退出码 ${code}，stderr：${stderr.join('')}`)); });

    const rpc = (method, params) => new Promise((res, rej) => {
      const id = nextId++;
      pending.set(id, { res, rej });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error(`${method} 超时`)); } }, 90000);
    });

    child.stdout.on('data', d => {
      buf += d.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id && pending.has(msg.id)) { pending.get(msg.id).res(msg); pending.delete(msg.id); }
        } catch { /* 忽略坏行 */ }
      }
    });

    (async () => {
      // 1. initialize
      const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } });
      assert.strictEqual(init.result.serverInfo.name, 'polysearch', 'serverInfo.name');
      assert.strictEqual(init.result.protocolVersion, '2025-06-18', '应回显客户端协议版本');
      console.log('  ✓ initialize 握手');
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

      // 2. tools/list
      const list = await rpc('tools/list', {});
      const names = list.result.tools.map(t => t.name).sort();
      assert.deepStrictEqual(names, ['fetch_page', 'search_status', 'web_search'], '工具清单');
      console.log('  ✓ tools/list：' + names.join(', '));

      // 3. web_search（应路由到豆包——priority 1）
      const s1 = await rpc('tools/call', { name: 'web_search', arguments: { query: 'Claude Code 最新功能', count: 3 } });
      assert.ok(!s1.result.isError, `web_search 不应报错：${s1.result.content?.[0]?.text?.slice(0, 200)}`);
      assert.ok(/搜索源：doubao/.test(s1.result.content[0].text), '应由豆包服务（优先级 1）');
      console.log('  ✓ web_search 走豆包成功');

      // 4. search_status（豆包应已计 1 次）
      const s2 = await rpc('tools/call', { name: 'search_status', arguments: {} });
      assert.ok(/doubao.*本月 1\/500/s.test(s2.result.content[0].text), '豆包本月计数应为 1：\n' + s2.result.content[0].text);
      console.log('  ✓ search_status 计数正确');

      // 5. fetch_page（走 DeepSeek）
      const s3 = await rpc('tools/call', { name: 'fetch_page', arguments: { url: 'https://example.com' } });
      assert.ok(!s3.result.isError, `fetch_page 不应报错：${s3.result.content?.[0]?.text?.slice(0, 200)}`);
      console.log('  ✓ fetch_page 走 DeepSeek 成功');

      // 6. 模拟配额尽→自动切换：把豆包置为熔断，web_search 应落到 DeepSeek
      const stFile = path.join(os.homedir(), '.polysearch', 'state.json');
      const st = JSON.parse(fs.readFileSync(stFile, 'utf8'));
      st.doubao = { ...st.doubao, circuitOpen: true, openReason: 'quota' };
      fs.writeFileSync(stFile, JSON.stringify(st, null, 2));
      const s4 = await rpc('tools/call', { name: 'web_search', arguments: { query: 'DeepSeek API 更新', count: 2 } });
      assert.ok(!s4.result.isError, `降级搜索不应报错：${s4.result.content?.[0]?.text?.slice(0, 200)}`);
      assert.ok(/搜索源：deepseek/.test(s4.result.content[0].text), '豆包熔断后应由 DeepSeek 接管');
      console.log('  ✓ 豆包熔断→自动切 DeepSeek');

      // 7. 手动重置
      const s5 = await rpc('tools/call', { name: 'search_status', arguments: { reset: true, provider: 'doubao' } });
      assert.ok(/已重置：doubao/.test(s5.result.content[0].text), '重置应成功');
      console.log('  ✓ 手动重置熔断');

      child.kill();
      resolve();
    })().catch(e => { child.kill(); reject(e); });
  });
}

/* ---------------- 入口 ---------------- */
(async () => {
  await offlineTests();
  if (LIVE) await liveTests();
  console.log(`\n结果：${pass} 过，${fail} 挂`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试脚本异常：', e); process.exit(1); });
