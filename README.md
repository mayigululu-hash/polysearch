# polysearch

**给 AI agent 的多源搜索聚合器。一次接入，多个搜索源自动接力，agent 不断网。**

当前版本 v0.1.2 ｜ [English](#english-英文说明) ｜ License MIT

## 为什么需要它

只要给 agent 接过搜索，你就遇到过这三件事：

1. 免费额度总会用完。豆包搜索每月免费 500 次，用完就停
2. 付费的要省着用。DeepSeek Search 便宜（$0.75/千次）但毕竟要钱，你不希望每次搜索都烧它
3. 谁都会抖。限流、超时、服务端故障，任何一家都可能临时不可用

不管哪种，结果都一样：**agent 当场断网，任务中断。**

polysearch 的解法是把多个搜索源接成一条优先级链。豆包搜索在前，免费额度优先烧；DeepSeek 在后兜底。前面的配额用完、欠费或故障，自动切后面的，agent 感知不到任何变化。

## 三个特点

- **自动接力**。该重试的重试，该切换的切换，该熔断的熔断，任务不中断
- **账目透明**。每家用量记在本地账本，`search_status` 随时对账，跨月自动清零，对齐免费额度
- **零依赖**。纯 Node（≥18）实现 MCP 协议，没有 SDK、没有构建、没有 npm install，拷到任何有 Node 的机器直接跑

## 30 秒接入

```bash
git clone https://github.com/mayigululu-hash/polysearch.git
# 或者不 clone，直接 npx -y github:mayigululu-hash/polysearch
cp config.example.json ~/.polysearch/config.json   # 首次运行也会自动生成骨架
chmod 600 ~/.polysearch/config.json                # key 是敏感信息
```

往 `~/.polysearch/config.json` 填两把 key（豆包搜索 key 在火山引擎控制台申请，每月 500 次免费；DeepSeek key 在 DeepSeek 开放平台申请）：

```json
{
  "providers": {
    "doubao":   { "enabled": true, "priority": 1, "apiKeyEnv": "POLYSEARCH_DOUBAO_KEY", "monthlyLimit": 500, "switchEarly": 480 },
    "deepseek": { "priority": 2, "apiKeyEnv": "POLYSEARCH_DEEPSEEK_KEY" }
  }
}
```

在 MCP 客户端里注册（ZCode、Claude Code 及任何 MCP 宿主通用）：

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

重启宿主，完事。

## 配套 skill：让 agent 知道什么时候用哪个

polysearch 只负责把搜索接上。什么时候该用宿主内置搜索、什么时候走 polysearch、什么时候必须上浏览器，是另一层调度的事。配套的 [polysearch-skill](https://github.com/mayigululu-hash/polysearch-skill) 就是这层路由，省钱序五级阶梯，还带交叉核查和切换报备两个小设计。**推荐搭配使用**，单独用 polysearch 也完全成立。

## 三个工具

| 工具 | 用途 |
|---|---|
| `web_search` | 统一搜索入口。参数 `query`（必填）、`count`、`maxAgeDays`、`needContent`、`lang`、`site`。自动路由，返回里标注实际用的搜索源 |
| `fetch_page` | 抓网页正文转 Markdown。由 DeepSeek Fetch 提供，不占豆包搜索额度 |
| `search_status` | 各源用量与熔断状态；`{"reset": true, "provider": "doubao"}` 手动重置 |

## 字段说明

| 字段 | 说明 |
|---|---|
| `priority` | 数字越小越先用 |
| `enabled` | `false` 直接出局（临时停用某家改这里） |
| `apiKey` / `apiKeyEnv` | 直接写 key，或指定环境变量名（环境变量优先级低于配置文件） |
| `monthlyLimit` | 本地月度计数上限（豆包免费额度 500） |
| `switchEarly` | 计数到这个数就提前让位给下家（默认等于 monthlyLimit） |

key 是敏感信息，文件权限应为 600。**本仓库不存任何密钥**，key 只放 `~/.polysearch/config.json` 或环境变量。

## 路由与熔断（进阶）

每次搜索按 priority 依次尝试，三种情况三种处理：

| 情况 | 判定 | 动作 |
|---|---|---|
| 偶发限流/服务端抖动 | 豆包 `700429`/`10500`；DeepSeek `429`/`408`/`5xx` | 同源退避重试 1 次，再不行换下家，**不熔断** |
| 配额尽/欠费 | 豆包 `10406`/`10412`；DeepSeek `402` | **熔断**该源（落盘），后续直接走下家 |
| key 错/未开通等 | 豆包 `10400~10410`；DeepSeek 其余 4xx | 熔断（fatal），跨月**不**自动恢复，需手动重置 |

- 配额账本在 `~/.polysearch/state.json`，重启不丢，自然月跨月自动清零（对齐豆包每月 500 次免费额度）
- 本地计数只是提前量，服务端错误码才是权威判据，两边谁先触发都正确

## 加第三家搜索源

想接博查、Tavily？三步：

1. 拷 `providers/deepseek.js`，改端点、认证和字段映射，导出以 Provider 结尾的类
2. `config.json` 的 providers 里加一段，给个 priority
3. `node test/smoke.js` 确认没改坏别的

server 本身不用动。各 provider 统一实现 `search(params)` 和 `classifyStatus(status)` 两个方法，业务错误码为主的（如豆包）再加 `classifyCode(code)`。

代码结构：`server.js`（MCP 壳）、`lib/router.js`（路由熔断）、`lib/state.js`（账本）、`providers/`（一家一个文件）、`test/smoke.js`（自测，离线 15 项，`--live` 真 API 7 项）。

## 已知边界

- 豆包侧不支持 `lang` / `site` / `maxAgeDays`（上游接口无此能力，传入即忽略）；DeepSeek 侧会翻译成 `lang:` / `site:` / `after:` 查询运算符
- 豆包用 Custom 版端点，免费额度与 Global 版共用同一账号
- DeepSeek Search/Fetch 自有 key 直调即按成功次数计费（2026-10-18 实测约 0.005 元/次，账单延迟数分钟才入账）。官方文档说的 11-01 起计费，实测更像仅指 DeepSeek Harness / Claude Code / Codex 内的托管调用
- `fetch_page` 只有 DeepSeek 一家提供，豆包配额状态不影响它

---

# English 英文说明

A multi-source search aggregator for AI agents. Wire it up once, and your agent's search keeps working: **when one provider runs out of quota or breaks, the next one takes over automatically.**

## Why

Three things happen once your agent can search:

- Free quotas run out (Doubao Search: 500 free calls/month)
- Paid providers need budgeting (DeepSeek: $0.75 per 1,000 successful requests — cheap, but not free)
- Any provider can rate-limit, time out, or go down

All three mean the same thing: your agent goes offline mid-task. polysearch chains providers by priority — Doubao first (burn the free tier first), DeepSeek as fallback — and switches automatically. The agent never notices.

## Highlights

- **Automatic failover**: retry, switch, or circuit-break depending on the failure type. Tasks don't break
- **Transparent accounting**: a local ledger tracks usage per provider; `search_status` shows the bill anytime and resets monthly to align with free quotas
- **Zero dependencies**: plain Node (>= 18), no SDK, no build, no npm install. Copy it to any machine and run

## Quick start

```bash
git clone https://github.com/mayigululu-hash/polysearch.git   # or: npx -y github:mayigululu-hash/polysearch
cp config.example.json ~/.polysearch/config.json
chmod 600 ~/.polysearch/config.json
```

Fill in both keys (Doubao key from the Volcano Engine console, DeepSeek key from the DeepSeek platform), then register the server in your MCP client (ZCode, Claude Code, any MCP host):

```json
{
  "mcp": { "servers": { "polysearch": { "type": "stdio", "command": "node",
    "args": ["/absolute/path/to/polysearch/server.js"] } } }
}
```

Restart your host. Done.

## Tools

| Tool | Purpose |
|---|---|
| `web_search` | Unified search entry. `query` (required), `count`, `maxAgeDays`, `needContent`, `lang`, `site`. Auto-routed; the response notes which provider served it |
| `fetch_page` | Page content as Markdown (served by DeepSeek Fetch; does not consume Doubao quota) |
| `search_status` | Usage / circuit-breaker state; `{"reset": true, "provider": "doubao"}` resets manually |

## Companion skill

polysearch wires the search up. Knowing *when* to use the host's built-in search, when to use polysearch, and when a real browser is needed is a routing problem — that's what the companion [polysearch-skill](https://github.com/mayigululu-hash/polysearch-skill) does: a cheapest-first ladder with cross-check mode and channel reporting. Recommended together, fine alone.

## Config fields

`priority` (lower goes first) · `enabled` · `apiKey` / `apiKeyEnv` · `monthlyLimit` (local cap) · `switchEarly` (yield early). Keys live only in `~/.polysearch/config.json` (chmod 600) or environment variables — **never in this repo**.

## Failover rules

| Case | Signal | Action |
|---|---|---|
| Transient | Doubao `700429`/`10500`; DeepSeek `429`/`408`/`5xx` | Retry once on the same provider, then move on |
| Quota / no credit | Doubao `10406`/`10412`; DeepSeek `402` | Circuit-break (persisted), skip to next |
| Bad key | Doubao `10400`–`10410`; DeepSeek other 4xx | Circuit-break (fatal), manual reset to recover |

Ledger: `~/.polysearch/state.json`, survives restarts, resets each calendar month. Server error codes are authoritative; local counters are just a head start.

## Extend & limits

Add a provider: copy `providers/deepseek.js`, adapt endpoint/auth/mapping, export a class ending in `Provider`, add a config block, run `node test/smoke.js`. The server never changes. Layout: `server.js` (MCP shell) · `lib/router.js` (routing) · `lib/state.js` (ledger) · `providers/` (one file per provider) · `test/smoke.js` (self-test).

Limits: Doubao ignores `lang` / `site` / `maxAgeDays` and uses the Custom endpoint (free quota shared with Global). DeepSeek is billed per successful request with your own key (~¥0.005/call, measured 2026-10-18, billing delayed a few minutes); the documented Nov-1 billing start appears to apply only to hosted calls inside DeepSeek Harness / Claude Code / Codex. `fetch_page` is DeepSeek-only.

## License

MIT. Built by 花叔 (Huashu). Clean-room implemented from official docs only; inspired by [huashu-doubao-search](https://github.com/alchaincyf/huashu-doubao-search) (MIT).
