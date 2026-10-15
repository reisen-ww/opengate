# OpenGate — 本地免费 AI 网关

把 **OpenCode Zen 免费通道**暴露成本地标准的 **OpenAI** + **Anthropic** 双协议 HTTP 服务，
给 Claude Code、Cline、Cherry Studio、opencodex 等任何客户端用。

## 为什么能免费 —— 凭据门禁（2026-10-15 定论）

上游 `https://opencode.ai/zen` 的免费层**不是匿名通道**。它校验 `auth.json` 里的
`oc_sk_…` 凭据，缺失时所有模型一律返回：

```
OpenCode's free tier can only be used from within OpenCode
```

**这个结论是穷举证明的**，下面每一条都做过 A/B 对照并被**证伪**，不要再去试：

| 曾被怀疑的"门禁" | 实测结论 |
|---|---|
| TLS / uTLS 指纹 | ❌ 无关。同指纹换凭据即通 |
| `permission` 拒绝策略 | ❌ 无关。全 deny / 全 ask 结果一样 |
| payload 字段（`agent` / `format`） | ❌ 无关 |
| `--pure` 启动参数 | ❌ 无关 |
| session 级 permission 数组 | ❌ 无关 |
| `prepare()` 注入的 system prompt | ❌ 无关 |
| `watchEvents()` / `pendingPermissions` 轮询 | ❌ 无关 |

门禁本身 **100% 稳定、不间歇**：无凭据时 `big-pickle` 6/6 失败、其余模型 1/1 失败。
带上真凭据后，真实 CLI 的报错从"免费层门禁"变成**模型级**的
`Upstream request failed: Model access is disabled`，证明凭据已被接受。

> **据此，逆向 `opencode.exe` 解包是没必要的** —— 问题从来不在传输层或二进制内部。

**这条推理链上踩过一个代价高昂的坑，务必记住：**
判断请求成败**不能只看 HTTP 200**。`POST /session/{id}/message` 在门禁失败时
返回的是 **HTTP 200 + body 里的 `info.error.name = "APIError"`**。
曾经用"有没有 text part"当判据，导致整整一批实验得出"成功"的错误结论。
**正确判据是先看 `r.json.info.error`。**

## 关键设计：委托给真实 opencode 运行时

凭据门禁无法用纯 HTTP 客户端绕过 —— 只有真正的 opencode 二进制会带上它。
所以本网关**不自造上游客户端**，而是：

```
客户端 → OpenGate(8787) → 委托 → 真实 opencode serve(v1.19.0, 隔离 XDG) → Zen 上游
```

委托层（`delegate.mjs`）复用社区项目 **dsh-opencode-xdbridge**（MIT）的 `vendor/` 实现，
它已经解决了这些脏活：

| 复用点 | 作用 |
|---|---|
| `runtime.js` | 拉起 `opencode serve --pure`，独立 XDG 根，不污染用户环境 |
| `backend.js` | 会话创建、消息投递、结构化信封解析 |
| `protocol.js` | 请求/响应双向转换（含 tool_calls 拼装） |
| `catalog.js` | 模型目录 + 每个模型**真实支持的思考档位** |
| `reasoning.js` | `reasoning_effort` → opencode variant 映射 |
| `shim.js` | 零 DSH 依赖的运行时垫片 |

**保序的六道本地执行防线**（来自 xdbridge，全部保留，确保委托上游不会在本地执行工具）：
原生操作全部 `'ask'` 后由桥接层 `reply:'reject'`；会话级 permission 数组；
响应体扫描拒绝意外的 tool part（`native_tool_activity`）；chatOnly 硬闸；
响应后复查待审批项；环境隔离（`OPENCODE_DISABLE_CLAUDE_CODE` 等 + 独立 XDG 根）。

### 凭据从哪来

`delegate.mjs` 的 `seedAuth()` 会**只**把宿主 `auth.json` 里的 `opencode`
provider 条目复制进隔离运行时（`<dataDir>/opencode/data/opencode/auth.json`，权限 `0600`）。
其它 provider 的密钥**故意不带进去**。

查找顺序：`OPENGATE_AUTH_JSON` → `OPENCODE_AUTH_JSON` → `$XDG_DATA_HOME/opencode/auth.json`
→ `~/.local/share/opencode/auth.json`（含 `.jsonc`）。

### 为什么内存能压到 50MB 级

`opencode` 是 Go 程序，原版常驻 300–500MB 且从不归还。委托层加了两道约束：

1. **启动即注入** `GOMEMLIMIT=96MiB` + `GOGC=30` —— 约束 Go 堆上限与 GC 频率
2. **周期性 `EmptyWorkingSet`**（psapi.dll，默认 60s）—— 把闲置页交还系统

实测：请求后 WS 183MB → trimmer 跑一轮后 **49MB**。
（注意：Go 的 `PrivateMemorySize64` 是虚拟保留量，判断真实占用要看 `WorkingSet64`。）

### 二进制从哪来

**仓库不带二进制**（172MB 超过 GitHub 单文件 100MB 限制），首次启动自动下载。
查找顺序：`OPENGATE_OPENCODE_BINARY` → `bin/opencode.exe`（若你手动放了）→
`findRuntime` 回退链（已装好的 managed 目录 → 用户本机安装 → 官方 npm 包下载）。

**候选会做版本下限校验（≥1.18.0）**：老版本过不了免费层，选中它只会得到一个
"看着健康、每个请求都失败"的网关。实测这一条很关键 —— 本机全局 `npm i -g opencode-ai`
装的是 1.15.3，会被自动跳过并下载 1.19.0：

```
[delegate] 跳过过旧的 OpenCode 1.15.3（免费层要求 ≥ 1.18.0）
[delegate] 正在下载 OpenCode 1.19.0，首次启动可能需要几分钟
```

带 sha512 校验，解包只取 `package/bin/` 下那一个文件（压缩包无法决定写到哪里）。

> 全局 `npm i -g opencode-ai` 装的是 1.15.3，**会拒绝免费层**
> （报 "OpenCode 1.18.0 or newer is required"）。必须用 1.19.0。

## 用法

### 启动

```sh
node server.mjs          # 直接跑（调试）
npm start                # 同上
```

或双击 `start-hidden.vbs`（无窗口后台启动，走 watchdog 守护）。

首次运行会自动生成一个本地 API Key 并写入 `config.json`，启动日志里会打印。
启动时另会打印委托运行时的状态：`[delegate] opencode 已就绪 pid=… version=1.19.0 auth=seeded`。
**`auth=seeded` 是成功标志**；若是 `auth=missing`，说明没找到 Zen 凭据，所有请求都会失败。

### 客户端配置

**OpenAI 兼容**（Cline / Cherry Studio / 任意 SDK / openclaw）：

```
Base URL : http://127.0.0.1:8787/v1
API Key  : <config.json 里的 apiKey>
Model    : mimo-v2.6-flash-free
```

**Claude Code（Anthropic 协议）**：

```sh
export ANTHROPIC_BASE_URL=http://127.0.0.1:8787
export ANTHROPIC_API_KEY=<config.json 里的 apiKey>
```

### 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/v1/chat/completions` | OpenAI Chat Completions（流式/非流式） |
| POST | `/v1/responses` | **OpenAI Responses API**（Codex CLI / ChatGPT Work / 新版 SDK 走这个） |
| POST | `/v1/messages` | Anthropic Messages（流式/非流式） |
| GET | `/v1/models` | 模型列表（**含思考强度能力**，已过滤打不通的） |
| GET | `/v1/models/capabilities` | 纯能力查询（便于客户端做下拉框） |
| GET | `/v1/models/{id}` | 单模型查询（OpenAI 标准端点；不在列表里返回 404 `model_not_found`） |
| GET | `/v1/availability` | 可用性探测状态（哪些可用/不可用/为什么） |
| POST | `/v1/availability/probe` | 手动触发一轮探测 |
| GET | `/healthz` | 健康检查（**免鉴权**，返回 `version` / `uptimeSeconds` / `models` / `availability` / `limits`） |
| GET | `/` 或 `/dashboard` | **状态面板**（HTML，**免鉴权**，每 10 秒自动刷新） |
| GET | `/v1/stats` | 运行统计 JSON（请求数 / 延迟分位 / token / 按模型聚合 / `limits` / `availability`，**免鉴权**） |
| GET | `/v1/logs` | 请求日志（`?limit=100&model=xxx&failed=1`，**免鉴权**） |
| GET | `/metrics` | Prometheus 文本格式指标（**免鉴权**） |

鉴权同时接受 `Authorization: Bearer <key>` 和 `x-api-key: <key>`。

> **免鉴权端点**（`/healthz`、`/metrics`、`/`、`/dashboard`、`/v1/stats`、`/v1/logs`）
> 专给本机运维用，不经 `apiKey` 校验。只在监听 `127.0.0.1` 时无风险 —— 见技术债第 15、16 条。

### 思考强度（reasoning_effort）

**这是最容易踩的坑**：不同模型支持的强度不同。给模型传了它不支持的档位，
委托上游会直接 **HTTP 400 `unsupported_reasoning_effort`**（拿到真凭据后不再是"空转"，
而是明确的拒绝）。

档位来源是 **opencode 自己声明的 `variants[*].reasoningEffort`**，不是猜的。
用 `/v1/models` 查实时值，或直接看下表（实测 2026-10）：

| 模型 | 支持的档位 |
|---|---|
| `mimo-v2.6-flash-free` | （**无 variants** → 不暴露任何档位） |
| `longcat-2.5-preview-free` | `low medium high` |
| `step-5-preview-free` | `low medium high` |
| `space-bunny-free` | `low medium high xhigh max` |
| `big-pickle` | ⛔ 上游对所有账号禁用（`Model access is disabled`） |

> `big-pickle` 已进 `modelDenylist`：它对**所有人**都返回
> `Model access is disabled`，真实 CLI 也一样。不要拿它当默认模型。
> `ling-3.1-flash-free` 返回 `UnknownError`，同样已拉黑。

网关做三件事：

1. **暴露能力** —— `/v1/models` 每个条目带 `reasoning` 和 `reasoning_efforts`；
   `/v1/models/capabilities` 单独给一份映射表，客户端据此只显示合法档位。
2. **自动裁剪** —— 传了超范围的档位（如给 `step-5` 传 `xhigh`），就近降级到
   不超过请求强度的最强合法档位，日志里留下痕迹：
   ```
   [effort] step-5-preview-free: 请求 xhigh 不支持，降级为 high（支持: low/medium/high）
   ```
   真实生效值可从 `/v1/logs` 的 `effortRequested` / `effortApplied` / `effortDowngraded`
   字段核对，`/metrics` 里还有 `opengate_effort_downgrades_total` 计数器。
3. **不传 = 用模型默认** —— 客户端没指定时不带该字段，保持 provider 行为。

### 参数名对照

| 客户端发的字段 | 生效于 |
|---|---|
| OpenAI: `reasoning_effort` | chat/completions、responses |
| Anthropic: `thinking.effort` 或 `reasoning_effort` | messages |

> 上游只接受 `stream: true`。客户端请求非流式时，网关仍以流式拉取上游，
> 在本地聚合后一次性返回 —— 对客户端透明。

### 接入 opencodex（本机实测链路）

如果前面还套了一层 opencodex（`127.0.0.1:10100`），**模型名必须带 provider 前缀**，
否则 opencodex 会回 `404 model_not_found`：

```jsonc
// ~/.opencodex/config.json
"opengate": {
  "adapter": "openai-chat",              // 或 "openai-responses"，两种都支持
  "baseUrl": "http://127.0.0.1:8787/v1",
  "authMode": "key",
  "apiKey": "og_...",
  "allowPrivateNetwork": true            // 必须，否则拒绝连本机地址
}
```

| 场景 | 模型名写法 |
|---|---|
| 直连 OpenGate | `mimo-v2.6-flash-free` |
| 经 opencodex | `Og/mimo-v2.6-flash-free` ← **注意前缀** |

> 改完 opencodex 配置要**重启它**才生效。模型列表缓存在 `config.json` 里，
> OpenGate 新增/下架模型后，opencodex 侧可能需要重新拉一次 `/v1/models`。

### 模型自动跟随

上游的 `/v1/models` 是**在售列表**，不等于**能调通**。实测 `cat-jam-free`
长期挂在在售列表里，但实际返回 `403 Endpoint is unavailable`。

网关因此有两层机制：

| 机制 | 周期 | 作用 |
|---|---|---|
| 目录刷新 | 5 分钟 | 跟随上游上下架：新免费模型自动出现，下架的自动消失 |
| 可用性探测 | 1 小时 | 实调每个免费模型，打不通的从 `/v1/models` 剔除 |

**探测的判定规则**（`probe.mjs` 的 `classify`，经实测校准）：

| 上游返回 | 判定 | 理由 |
|---|---|---|
| 200 且真出字 | 可用 | — |
| 403 / 404 / 401 | 不可用 | 含 `cat-jam-free` 的 403 |
| 400 且协议不支持/已弃用 | 不可用 | 能力声明不符 |
| 429 / 5xx / 超时 | **说不准** | 共享池限流不代表模型坏了 |
| 403 且 `FreeTierError` | **说不准** | 门禁变更是全局事件，据此判死会清空整个列表 |

**三重防误杀**：

1. 判"不可用"前**复查一次**，两次结论不一致就降级为"说不准"
2. "说不准"**不改变**已有状态
3. 连续 **3 轮**都"说不准"才从列表隐藏（不是判死，恢复了会自动回来）

> ⚠️ 探测会消耗免费额度（每次都打真实请求）。默认每小时一轮、并发 2、
> 只探免费模型。不想要就设 `probe.enabled: false`。

### 可观测性

网关内置 **请求日志 + 用量统计 + Prometheus 导出 + 状态面板**，零依赖手写，对标 LiteLLM 的 `/metrics` 和 new-api 的日志页。

**请求日志记录什么**（每条一条，环形缓冲）：

| 字段 | 含义 |
|---|---|
| `t` | ISO 时间戳 |
| `model` | 模型 id（管理类 GET 为 `null`） |
| `endpoint` | 请求路径 |
| `status` | HTTP 状态码 |
| `durationMs` | 端到端耗时 |
| `stream` | 流式 / 非流式 |
| `promptTokens` / `completionTokens` | 用量（拿不到就是 `null`） |
| `effortRequested` → `effortApplied` | **思考强度降级会被记录**，`effortDowngraded` 标记是否被裁剪 |
| `attempts` | 上游重试次数 |
| `error` | 错误标识（如 `upstream_empty`） |
| `clientIp` | 客户端 IP |

**统计口径**（避免自相矛盾的数字）：

| 规则 | 理由 |
|---|---|
| 成功/失败计数含管理类 GET（`/v1/models` 等） | 否则面板会出现"总请求 9 / 成功 1" |
| 延迟分位 / 模型统计**只算推理请求** | 否则 1ms 的列表请求把 P50 拉到毫无意义 |
| 延迟窗口默认最近 500 次，算 P50 / P95 / P99 / max | 固定窗口，不做时间序列 |
| Prometheus 指标名：`opengate_requests_total`、`opengate_active_requests`、`opengate_request_duration_ms`、`opengate_tokens_total`、`opengate_model_requests_total`、`opengate_model_duration_ms_avg`、`opengate_effort_downgrades_total` | 直接 `curl /metrics` 接 Grafana |

**状态面板**：浏览器打开 `http://127.0.0.1:8787/` 即可。展示运行时长、请求数、延迟分位、token 累计、模型能力表、可用性探测表、最近 50 条请求日志、当前并发闸门水位。**每 10 秒自动刷新**（`<meta http-equiv="refresh" content="10">`）。监听非回环地址时面板顶部会显示红色警告。

> **日志只在内存，不落盘 —— 重启即清空。** 这是**有意的取舍**：网关是本地小工具，
> 不该在用户磁盘上无限增长。要看长期历史请用 Prometheus 抓 `/metrics`，
> 或自行把 `/v1/logs` 接进采集器。

### 并发保护

**为什么需要**：上游是**匿名共享池**，同一出口 IP 高频并发会被限流，表现就是 429 / `Endpoint is unavailable`。
多个客户端同时猛打，等于**自己打自己** —— 这是最蠢的失败模式，所以在网关侧先拦住。

**两级闸门**（`limiter.mjs`）：

| 层级 | 默认 | 作用 |
|---|---|---|
| 全局闸门 | 8 并发 | 控制对上游的总压力 |
| 每模型闸门 | 2 并发 | 上游对**同一模型**的配额更窄，同模型并发最容易触发限流 |
| 等待队列 | 100 | 闸门满时可以排队等槽位 |

请求顺序是**先过全局闸门、再过每模型闸门**（`Gate.enter(model)`），避免同模型自己挤自己。
释放是嵌套的：内层先放、外层后放，任何一步失败都会把已占的槽位还回去。

**队列满 → 立刻拒绝**，不无限排队。理由：排队越久客户端越可能已经放弃，白白占着上游配额。
**客户端应据此退避重试或换模型。**

> ✅ **已验证行为**：闸门抛出 `status: 429` + `code: "QUEUE_FULL"` 或 `"QUEUE_TIMEOUT"`，
> 三个推理端点的 catch 块会**透传这个状态码**，客户端收到的是
> **HTTP 429 + `type: "rate_limit_error"`**（不是 502）。实测 40 并发 → 13 个 200 + 27 个 429。

### 自测

```sh
node verify.mjs                     # 端到端验收：30 项断言，覆盖全部对外协议面
node selftest.mjs                   # 用默认模型跑全部 8 段
node diagnose-models.mjs            # 诊断：上游有什么 / 网关给什么 / 每个能否调通
```

`verify.mjs` 是改完代码必跑的回归：6 端点 + 思考强度暴露/降级 + 错误处理，
全绿才算没砸东西。`selftest.mjs` 更细，分 8 段。

## 配置项（config.json）

| 字段 | 默认 | 说明 |
|---|---|---|
| `listen` | `127.0.0.1:8787` | 监听地址。改 `0.0.0.0:8787` 可局域网访问（**务必保留 apiKey**） |
| `apiKey` | 自动生成 | 本地访问密钥 |
| `upstream` | `delegate` | **核心开关**。`delegate` = 委托真实 opencode（能过凭据门禁，**推荐**）；`direct` = 直连 Zen 纯 HTTP（**过不了门禁，仅作对照**） |
| `delegate.dataDir` | 本目录 | 隔离运行时的落地目录（默认 `runtime-data/`） |
| `defaultModel` | `mimo-v2.6-flash-free` | 客户端不指定 model 时用 |
| `modelDenylist` | 7 个已知死模型 | 上游永久不可用 / 被禁的 id（含 `big-pickle`） |
| `modelAllowlist` | `[]` | 非空时只放行这些 |
| `probe.enabled` | `true` | 是否开启可用性探测。**委托模式下强制关闭**（catalog 本身即权威，直连探测会误判） |
| `probe.intervalSeconds` | `3600` | 探测周期 |
| `probe.concurrency` | `2` | 探测并发（别调太高，会触发限流误判） |
| `probe.missThreshold` | `3` | 连续多少轮打不通才隐藏 |
| `retry.maxAttempts` | `4` | 上游 429/不可用时退避重试次数 |
| `requestTimeoutMs` | `300000` | 单请求总超时 |
| `observability.logCapacity` | `500` | 请求日志环形缓冲容量（**只在内存**，写满覆盖最旧） |
| `observability.latencyWindow` | `500` | 延迟统计窗口（最近 N 次推理请求，算 P50/P95/P99） |
| `limits.globalConcurrency` | `8` | 全局并发上限（<=0 视为不限流） |
| `limits.perModelConcurrency` | `2` | 每模型并发上限（同模型并发最容易触发上游限流） |
| `limits.maxQueue` | `8` | 等待队列上限，**超了直接 429** |
| `limits.maxWaitMs` | `30000` | 排队等待上限，**超时也返回 429**（避免客户端早放弃了还在占配额） |

> 以上都**可以省略**，省略即用默认值（代码里是 `?? 默认`，不是必填）。

委托模式另有环境变量可调：

| 变量 | 默认 | 说明 |
|---|---|---|
| `OPENGATE_OPENCODE_BINARY` | — | 覆盖 opencode 二进制路径 |
| `OPENGATE_AUTH_JSON` | — | 覆盖 Zen 凭据文件路径 |
| `OPENGATE_GOMEMLIMIT` | `96MiB` | Go 堆软上限 |
| `OPENGATE_GOGC` | `30` | GC 目标百分比 |
| `OPENGATE_TRIM_INTERVAL_MS` | `60000` | `EmptyWorkingSet` 周期（0 = 关） |

## 技术债（明确声明）

1. **本网关不自造上游客户端。** 我们**曾经**假设免费层是"匿名通道 + 三道门禁
   （session 头 / `stream:true` / 必须带 bash+read）"，并据此写了纯 HTTP 直连实现。
   2026-10-15 穷举证明这个模型是**错的** —— 真正的门槛是凭据。
   现架构委托给真实 opencode 二进制。`direct` 模式代码仍在（`zen.mjs`），
   但**它过不了门禁**，保留只为对照与将来上游若重新开放匿名通道时的备选。

2. **依赖上游 opencode 的版本。** 免费层要求 ≥1.18.0。仓库固化的
   `findRuntime` 也会自动下载 **1.19.0**（仓库不带二进制）。上游若提高门槛，
   `vendor/runtime.js` 的 `MIN_FREE_TIER_VERSION` 需要同步上调。

3. **凭据是命门。** `auth.json` 里的 `opencode` 条目一旦失效（登出/过期），
   所有模型立刻回到 `free tier can only be used from within OpenCode`。
   症状是**全模型统一失败**，不是间歇性失败 —— 据此可快速定位。

4. **`big-pickle` 全局禁用。** 它对所有账号返回 `Model access is disabled`
   （真实 CLI 也一样），已进 denylist。`ling-3.1-flash-free` 返回 `UnknownError`，同样拉黑。

5. **`mimo-v2.6-flash-free` 不暴露任何思考档位**（`variants` 为空）。
   这是上游元数据的实际情况，不是网关的 bug。想用 `max` 请换 `space-bunny-free`。

6. **内存回收靠轮询，不是实时。** WorkingSet 在两次 trim 之间会涨到 150–400MB，
   60s 后回落到 50MB 级。要更激进就调小 `OPENGATE_TRIM_INTERVAL_MS`，
   代价是 `EmptyWorkingSet` 调用频率上升（CPU 微小开销）。

7. **`runtime-data/` 是必要的持久缓存**，约 62MB（含 opencode 的 SQLite 库、
   会话状态、注入的凭据）。**不要删** —— 删了要重建。
   `bin/` 是 172MB 的二进制，同样不要删。

8. **可用性探测在委托模式下关闭。** 早期版本开着它，导致直连探测
   （过不了凭据门禁）把**真正可用的模型全部误标为 `gated`**，污染 dashboard。
   现在 `cfg.upstream === "delegate"` 时强制 `enabled: false`。

6. **协议转换有损**：
   - Anthropic `thinking` 块 → 转发为 `thinking`（流式）/ 保留在 `reasoning_content`
   - OpenAI 的 `seed`、`logprobs`、`response_format` → Anthropic 无等价物，丢弃
   - Responses 的 `store`、`previous_response_id`（服务端会话）、`include`、
     `prompt_cache_key`、`truncation` → **无状态，忽略**。客户端必须自己回传完整
     历史（`input` 里带上之前的 `function_call` / `function_call_output`）。
   - Responses 的 `reasoning` 项只回 `summary_text`，不回 `encrypted_content`。

7. **非流式是伪装的。** 本地聚合整段响应，长回复会有等待感，且首字节延迟等于全量生成时间。
   能流式就用流式。

8. **上游偶发返回空流**（HTTP 200 但内容全空，实测到过）。网关已做重试：
   - 还没向客户端发过任何内容时 → 自动换新 request id 重试（最多 `retry.maxAttempts` 次）
   - 已经发过内容 → **不重试**（重试会导致客户端收到重复内容）
   - 全部重试后仍为空 → 返回明确的 `upstream_empty` 错误，不假装成功

9. **代理不做请求级自动换模型。** 这是刻意的：静默换模型会让用户以为
   在跟 A 对话，实际是 B。客户端拿到 5xx / `upstream_empty` 应自行重试或换模型。

10. **无多轮会话存储。** 网关不保存历史，客户端必须自己回传完整 messages。

11. **上游可能按 IP 限额。** 同一出口 IP 高频调用会被限流。

12. ~~**队列满时返回的不是 429，而是 502。**~~ **已修复**（catch 块改为透传 `err?.status ?? 502`，
    并把 `QUEUE_FULL`/`QUEUE_TIMEOUT` 映射为 `rate_limit_error`）。实测 40 并发 → 13×200 + 27×429。
    遗留：队列参数是全局的，不能按模型单独配置（见第 13 条）。

13. **请求日志不持久化。** 只在内存环形缓冲（默认 500 条），**重启即清空**。
    这是有意的取舍（本地工具不该在磁盘上无限增长），代价是排查"昨天那次失败"
    只能靠 `/metrics` 的累计计数或外部采集器。

14. **并发闸门参数是全局的，不能按模型单独配置。** `limits.*` 三个值对所有模型一视同仁。
    实际上不同模型的配额宽窄不同，理想做法是每模型可覆盖 —— 目前只能靠调大
    `perModelConcurrency` 或干脆关掉闸门（设 `<=0`）。

15. **状态面板免鉴权。** `/` 和 `/dashboard` 不经 `apiKey` 校验，会暴露模型列表、
    可用性、请求日志（含 `clientIp`）。**只监听 `127.0.0.1` 时无风险**；
    改成 `0.0.0.0` 时面板会显示红色警告，但那只是警告，不是拦截 ——
    局域网内任何人都能直接看到你的日志。

16. **`/metrics` 无鉴权。** 同上。Prometheus 文本里含按模型的请求数、token 累计、
    强度裁剪次数。抓取器通常不方便带鉴权头，所以没加；但监听非回环时它同样敞开。

17. **状态面板是服务端渲染 + 10 秒整页刷新。** 没有前端框架、没有增量更新，
    每次刷新都重新渲染整页（含模型能力表和探测表），所以刷新时会闪一下，
    面板日志固定取最近 50 条、不跟随 `observability.logCapacity` 放大。

18. **`/v1/logs` 的 `limit` 被硬上限截到 500。** 传更大的值不会报错，会被静默截断 ——
    这是有意的（防止一次拉爆内存），但客户端不要以为拿到了全部历史。

## 文件

| 文件 | 作用 |
|---|---|
| `server.mjs` | HTTP 服务主体（路由、鉴权、三协议端点、委托接线、闸门与指标接线） |
| `delegate.mjs` | **委托后端**：拉起隔离的 opencode 运行时、注入凭据、GOMEMLIMIT + EmptyWorkingSet 控内存 |
| `zen.mjs` | 直连上游适配（`upstream: "direct"` 时用；含三协议组装、强度裁剪、SSE 解析、重试） |
| `vendor/` | 复用自 dsh-opencode-xdbridge（MIT）的驱动层，**零 DSH 依赖** |
| `convert.mjs` | Anthropic ⇄ OpenAI 协议转换 |
| `convert-responses.mjs` | OpenAI Responses ⇄ Chat Completions 转换 |
| `probe.mjs` | 模型可用性探测（判定规则 + 三重防误杀 + 落盘） |
| `metrics.mjs` | 可观测性（环形日志缓冲 + 计数/延迟分位/token 统计 + Prometheus 导出） |
| `limiter.mjs` | 并发闸门（手写信号量 + 每模型闸门 + 有上限的等待队列） |
| `dashboard.mjs` | 状态面板（零依赖手写 HTML，服务端渲染 + 10 秒自刷新） |
| `verify.mjs` | **端到端验收**（30 项断言，改完必跑） |
| `selftest.mjs` | 8 段自测（鉴权 + 模型列表 + 三协议 × 流式/非流式 + 强度裁剪回归） |
| `diagnose-models.mjs` | 诊断工具：上游有什么 / 网关给什么 / 逐个实测 |
| `watchdog.mjs` | 守护进程（崩溃自动重启 + 指数退避 + 日志轮转），开机自启的真正入口 |
| `config.json` | 配置（含自动生成的 apiKey） |
| `runtime-data/` | 隔离运行时状态（首次启动自动下载 172MB 二进制 + 注入凭据），**别删** |
| `start-hidden.vbs` | 无窗口启动（开机自启用这个） |
| `start.cmd` | 带窗口启动（调试用） |

## 开机自启

已装：启动文件夹快捷方式 `OpenGate.lnk` → `start-hidden.vbs`（无窗口）。

- 查看：`Win+R` 输入 `shell:startup`
- 取消：删掉那个 `OpenGate.lnk` 即可

> 计划任务方式需要管理员权限（`schtasks` 会 Access denied），
> 所以用的是用户级启动文件夹，效果相同且不需要提权。

## 卸载

删掉整个目录 + 启动文件夹里的 `OpenGate.lnk` 即可。网关不写注册表、
不装服务、不留后台常驻。
