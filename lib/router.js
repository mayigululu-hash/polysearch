/**
 * polysearch 路由器：按优先级链依次尝试 provider，配额账本驱动熔断与提前切换。
 * 本文件不碰网络，只做决策，方便离线单测。provider 需实现：
 *   name / priority / enabled
 *   hasKey() -> bool
 *   search(params) -> { results: [...], provider }，失败时 throw { status, kind }（kind 见下）
 */
'use strict';

/** 错误分类（由各 provider 的 classifyStatus 给出）：
 *  RETRYABLE —— 限流/临时故障，同 provider 退避重试一次后换下家
 *  QUOTA     —— 月配额尽/欠费，熔断该 provider（跨月或手动重置可恢复），换下家
 *  FATAL     —— key 错、参数错等，熔断（reason=fatal，需人工），换下家
 */
function sortChain(providers) {
  return [...providers].sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99));
}

/**
 * 主入口。providers: 已实例化的 provider 列表；state: 配额账本对象（会被就地修改）；
 * call: async (provider, params) => 结果；now: 可注入时间（测试用）；retryDelayMs: 限流重试等待。
 * 返回 { results, providerName, attempts } 或 throw Error（全部失败）。
 */
async function routeSearch(providers, state, params, { call, now = new Date(), retryDelayMs = 1500 } = {}) {
  if (typeof call !== 'function') throw new Error('routeSearch 需要 call 函数');
  const chain = sortChain(providers).filter(p => p.enabled && p.hasKey() && !state[p.name]?.circuitOpen);

  // 提前切换：配额将尽的 provider 让位给下家（但如果它是链上最后一根稻草，仍允许用）
  const usable = chain.filter(p => {
    const e = state[p.name];
    if (!e || p.monthlyLimit == null) return true;
    const early = p.switchEarly ?? p.monthlyLimit;
    return e.count < early;
  });
  const finalChain = usable.length > 0 ? usable : chain;

  const attempts = [];
  for (const p of finalChain) {
    for (let tryNo = 0; tryNo < 2; tryNo++) {
      try {
        const res = await call(p, params);
        attempts.push({ provider: p.name, ok: true });
        return { ...res, providerName: p.name, attempts };
      } catch (err) {
        const kind = err?.kind || (p.classifyStatus ? p.classifyStatus(err?.status) : 'FATAL');
        attempts.push({ provider: p.name, ok: false, kind, status: err?.status, message: err?.message });
        if (kind === 'RETRYABLE' && tryNo === 0) {
          await new Promise(r => setTimeout(r, retryDelayMs));
          continue; // 同 provider 退避重试一次
        }
        if (kind === 'QUOTA' || kind === 'FATAL') {
          const { openCircuit } = require('./state');
          openCircuit(state, p.name, kind === 'QUOTA' ? 'quota' : 'fatal', now);
        }
        break; // 换下家
      }
    }
  }
  const detail = attempts.map(a => `${a.provider}:${a.ok ? 'ok' : `fail(${a.kind}${a.status ? ' ' + a.status : ''})`}`).join(' → ');
  const err = new Error(`所有搜索源都失败了。尝试记录：${detail}`);
  err.attempts = attempts;
  throw err;
}

module.exports = { routeSearch, sortChain };
