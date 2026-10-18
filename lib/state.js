/**
 * polysearch 状态存取：每个 provider 一份配额账本，落盘到 ~/.polysearch/state.json
 * 结构：{ "doubao": { month, count, circuitOpen, openReason, openedAt, lastUsedAt } }
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const STATE_FILE = path.join(os.homedir(), '.polysearch', 'state.json');

function emptyEntry() {
  return { month: null, count: 0, circuitOpen: false, openReason: null, openedAt: null, lastUsedAt: null };
}

function monthKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** 读状态；文件不存在/损坏时返回空账本 */
function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return typeof raw === 'object' && raw ? raw : {};
  } catch {
    return {};
  }
}

/** 原子写盘（tmp + rename），目录不存在则创建 */
function save(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

/**
 * 自然月跨月自动重置：month 字段与当前月不一致就清零计数、关闭「配额型」熔断。
 * 返回 { state, resetList }，resetList 是本次被重置的 provider 名。
 */
function maybeMonthlyReset(state, now = new Date()) {
  const mk = monthKey(now);
  const resetList = [];
  for (const name of Object.keys(state)) {
    const e = state[name];
    if (e.month !== mk) {
      if (e.month !== null && (e.count > 0 || e.circuitOpen)) resetList.push(name);
      e.month = mk;
      e.count = 0;
      // 只自动恢复配额型熔断（欠费/需人工的不在此列，openReason 保留判断依据）
      if (e.circuitOpen && e.openReason === 'quota') {
        e.circuitOpen = false;
        e.openReason = null;
        e.openedAt = null;
      }
    }
  }
  return { state, resetList };
}

/** 取某 provider 的账本，没有则初始化 */
function entry(state, name) {
  if (!state[name]) state[name] = emptyEntry();
  const e = state[name];
  if (!e.month) e.month = monthKey();
  return e;
}

function recordSuccess(state, name, now = new Date()) {
  const e = entry(state, name);
  e.count += 1;
  e.lastUsedAt = now.toISOString();
}

function openCircuit(state, name, reason, now = new Date()) {
  const e = entry(state, name);
  e.circuitOpen = true;
  e.openReason = reason; // 'quota'（月配额尽/欠费，跨月或手动重置可恢复）| 'fatal'（需人工）
  e.openedAt = now.toISOString();
}

/** 手动重置：清计数、关熔断 */
function reset(state, name) {
  state[name] = emptyEntry();
  entry(state, name);
}

module.exports = { STATE_FILE, load, save, entry, maybeMonthlyReset, recordSuccess, openCircuit, reset, monthKey };
