# polysearch-mcp

**当前版本 v0.1.2** ｜ Current version: v0.1.2 ｜ [English](#english-英文说明)

配套 skill（搜索路由：什么时候用内置搜索、什么时候用本 MCP、什么时候上浏览器）：
[mayigululu-hash/polysearch-skill](https://github.com/mayigululu-hash/polysearch-skill)

多源搜索 MCP server：把多个搜索 API 聚合成一个 `web_search` 工具，按优先级自动路由——
**前面的配额用完或故障，自动切后面的**。当前接入：豆包搜索（火山引擎，免费 500 次/月）→
DeepSeek Search（$0.75/千次，2026-11-01 起计费）。

零依赖纯 Node（≥18），不用 npm install、不用构建，拷到任何有 Node 的机器直接 `node server.js`。

> 版权说明：本仓库走 clean-room 路线——只依据 MCP 官方协议规范、火山引擎与 DeepSeek 的
> 官方 API 文档实现，未参考任何第三方封装的代码。设计动机受
> [alchaincyf/huashu-doubao-search](https://github.com/alchaincyf/huashu-doubao-search)（MIT）启发，特此致谢。

## 接入

### ZCode / Claude Code / 任意 MCP 客户端

```json
{
  "mcp": {
    "servers": {
      "polysearch": {
        "type": "stdio",
        "command": "node",
        "args": ["/absolute/path/to/polysearch-mcp/server.js"]
      }
    }
  }
}
```

改完配置重启宿主即可。

### 配置文件 `~/.polysearch/config.json`（首次运行自动生成骨架）

```json
{
  "providers": {
    "doubao":   { "enabled": true, "priority": 1, "apiKey": "你的豆包key", "monthlyLimit": 500, "switchEarly": 480 },
    "deepseek": { "priority": 2, "apiKey": "你的DeepSeek key" }
  }
}
```

| 字段 | 说明 |
|---|---|
| `priority` | 数字越小越先用 |
| `enabled` | `false` 直接出局（临时停用某家改这里） |
| `apiKey` | 直接写；也可用 `apiKeyEnv` 指定环境变量名（如 `POLYSEARCH_DOUBAO_KEY`），环境变量优先级低于配置文件 |
| `monthlyLimit` | 本地月度计数上限（豆包免费额度 500） |
| `switchEarly` | 计数到这个数就提前让位给下家（默认等于 monthlyLimit） |

key 是敏感信息：文件权限应为 600（`chmod 600 ~/.polysearch/config.json`）。

## 三个工具

| 工具 | 用途 |
|---|---|
| `web_search` | 统一搜索入口。参数：`query`（必填）、`count`、`maxAgeDays`、`needContent`、`lang`、`site`。自动路由，返回里标注实际用的搜索源 |
| `fetch_page` | 抓取网页正文（Markdown）。v1 由 DeepSeek 的 Fetch API 提供，不占豆包搜索额度 |
| `search_status` | 查各源用量/熔断状态；`{"reset": true, "provider": "doubao"}` 手动重置 |

## 路由与熔断机制

每次搜索按 priority 依次尝试，三种情况三种处理：

| 情况 | 判定 | 动作 |
|---|---|---|
| 偶发限流/服务端抖动 | 豆包 `700429`/`10500`；DeepSeek `429`/`408`/`5xx` | 同源退避重试 1 次，再不行换下家，**不熔断** |
| 配额尽/欠费 | 豆包 `10406`/`10412`；DeepSeek `402` | **熔断**该源（落盘），后续直接走下家 |
| key 错/未开通等 | 豆包 `10400~10410`；DeepSeek 其余 4xx | 熔断（reason=fatal），跨月**不**自动恢复，需手动重置 |

- 配额账本在 `~/.polysearch/state.json`，重启不丢；**自然月跨月自动清零**，quota 型熔断随之恢复（豆包每月 500 次免费额度对齐）。
- 本地计数只是提前量，服务端错误码才是权威判据——两边谁先触发都正确。

## 自己改

```
server.js            MCP 壳 + 工具定义（协议只用了 initialize/tools.list/tools.call/ping 四个方法）
lib/router.js        路由 + 熔断决策（不碰网络，可离线单测）
lib/state.js         配额账本存取（~/.polysearch/state.json）
providers/doubao.js  豆包适配器（Custom 版端点，官方文档见文件头注释）
providers/deepseek.js DeepSeek 适配器（search + fetch）
test/smoke.js        自测：node test/smoke.js（离线 15 项）／--live（真 API + MCP 会话 7 项）
```

**加第三家搜索源**（比如博查、Tavily）：

1. 拷 `providers/deepseek.js` 改成新家的端点、认证和字段映射，类名以 `Provider` 结尾导出；
2. `~/.polysearch/config.json` 的 `providers` 里加一段，给个 priority；
3. `node test/smoke.js` 确认没改坏别的。完事，server 不用动。

各 provider 统一实现两个方法：`search(params) -> { results: [...] }`（字段见 deepseek.js 的映射）
和 `classifyStatus(status)`（HTTP 状态→RETRYABLE/QUOTA/FATAL 三类）；业务错误码为主的
（如豆包）再实现 `classifyCode(codeN)`。

## 已知边界

- 豆包侧不支持 `lang` / `site` / `maxAgeDays` 参数（官方接口无此能力，传入即被忽略）；
  DeepSeek 侧会翻译成 `lang:` / `site:` / `after:` 查询运算符。
- 豆包用的是 **Custom 版**端点（`open.feedcoopapi.com`），免费 500 次/月与 Global 版共用同一账号额度。
- DeepSeek Search/Fetch **自有 key 直调即按成功次数计费**（实测 2026-10-18：约 ¥0.005/次，扣充值余额，**账单延迟数分钟才入账**——对账要隔几分钟再看）。官方文档「11-01 起计费」与实测不符，或仅指 DeepSeek Harness / Claude Code / Codex 内的服务端工具调用。豆包 500 次/月免费额度内未观察到扣费。
- `fetch_page` 只有 DeepSeek 一家提供，豆包配额状态不影响它。

---

# English 英文说明

A zero-dependency MCP (Model Context Protocol) server that aggregates multiple search APIs into one `web_search` tool with priority-based automatic failover: **when the provider up front runs out of quota or breaks, the next one takes over automatically.** Currently wired: Doubao Search (Volcano Engine, 500 free calls/month) → DeepSeek Search ($0.75 per 1,000 successful requests).

Plain Node.js (>= 18), no `npm install`, no build step. Copy it to any machine with Node and run `node server.js`.

## Quick start

```bash
# 1. get the code
git clone https://github.com/mayigululu-hash/polysearch.git
# or: npx -y github:mayigululu-hash/polysearch

# 2. put your keys in ~/.polysearch/config.json
#    (auto-generated from the skeleton on first run, then fill in:)
cp config.example.json ~/.polysearch/config.json
chmod 600 ~/.polysearch/config.json   # keys are sensitive

# 3. register it in your MCP client (ZCode / Claude Code / any MCP host)
```

```json
{
  "mcp": {
    "servers": {
      "polysearch": {
        "type": "stdio",
        "command": "node",
        "args": ["/absolute/path/to/polysearch/server.js"]
      }
    }
  }
}
```

You can also point `apiKey` directly to a key, or use `apiKeyEnv` to name an environment variable (e.g. `POLYSEARCH_DOUBAO_KEY`).

## Configuration `~/.polysearch/config.json`

| Field | Meaning |
|---|---|
| `priority` | Lower number goes first |
| `enabled` | `false` removes a provider from the chain |
| `apiKey` / `apiKeyEnv` | Key inline, or the name of an env var holding it |
| `monthlyLimit` | Local monthly counter cap (Doubao free tier: 500) |
| `switchEarly` | Yield to the next provider once the counter hits this (defaults to `monthlyLimit`) |

**Keys never live in this repo.** They go in `~/.polysearch/config.json` (chmod 600) or environment variables.

## Tools

| Tool | Purpose |
|---|---|
| `web_search` | Unified search entry. Params: `query` (required), `count`, `maxAgeDays`, `needContent`, `lang`, `site`. Auto-routed; the response notes which provider actually served it |
| `fetch_page` | Fetch a page as Markdown (served by DeepSeek Fetch, does not consume Doubao search quota) |
| `search_status` | Per-provider usage / circuit-breaker state; `{"reset": true, "provider": "doubao"}` resets manually |

## Routing & circuit breaking

Each search walks the priority chain:

| Case | Signal | Action |
|---|---|---|
| Transient rate limit / hiccup | Doubao `700429`/`10500`; DeepSeek `429`/`408`/`5xx` | Back off and retry once on the same provider, then move on. No circuit break |
| Quota exhausted / out of credit | Doubao `10406`/`10412`; DeepSeek `402` | **Circuit-break** the provider (persisted); later calls skip it |
| Bad key / not activated | Doubao `10400~10410`; DeepSeek other 4xx | Circuit-break (reason=fatal), does **not** auto-recover across months; reset manually |

- The quota ledger lives in `~/.polysearch/state.json`, survives restarts, and **resets automatically at each calendar month** (aligned with Doubao's 500 free calls).
- Local counting is only a head start; server error codes are the authoritative signal. Either side tripping first is correct.

## Extend

```
server.js            MCP shell + tool definitions (JSON-RPC 2.0 framing, no SDK)
lib/router.js        Routing + circuit-break decisions (no network, offline-testable)
lib/state.js         Quota ledger (~/.polysearch/state.json)
providers/doubao.js  Doubao adapter (Custom endpoint)
providers/deepseek.js DeepSeek adapter (search + fetch)
test/smoke.js        Self-test: node test/smoke.js (15 offline) / --live (7 live)
```

**Add a third provider** (Bocha, Tavily, ...): copy `providers/deepseek.js`, adapt endpoint/auth/field mapping, export a class ending in `Provider`; add a block under `providers` in the config with a `priority`; run `node test/smoke.js`. The server itself never changes.

## Known limits

- The Doubao side ignores `lang` / `site` / `maxAgeDays` (no such capability upstream); the DeepSeek side translates them into `lang:` / `site:` / `after:` query operators.
- Doubao uses the **Custom** endpoint; its 500 free calls/month share the same account quota as the Global endpoint.
- DeepSeek Search/Fetch is billed per successful request when called with your own key (measured 2026-10-18: ~¥0.005/call, billed with a few minutes of delay). The official docs' "billing starts 2026-11-01" appears to apply only to the hosted tool calls inside DeepSeek Harness / Claude Code / Codex.
- `fetch_page` is served by DeepSeek only; Doubao's quota state does not affect it.

## License

MIT. Built by 花叔 (Huashu). Design motivated by, and clean-room implemented from official docs only; thanks to [huashu-doubao-search](https://github.com/alchaincyf/huashu-doubao-search) for the inspiration.
