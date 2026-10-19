# v3.9.41

本版是 v3.9.40 之后的一次大补丁：**90+ 个提交，57 个 feat/fix**。没有协议兼容性破坏，没有新增协议路由，默认 wire 字节保持不变（`d014855` 对 `v3.9.40` 的 270/270 比较全部相同）。内容集中在五块：工具名/ID/历史的跨方言卫生、SSE 提交门与错误状态、Dashboard 的只读观测面、Devin Connect 的目录/传输/重试修复，以及账号、日志、统计与缓存的可运维性。

**影响面**：默认开启的工具卫生会改变少数畸形工具名/ID 的线上形状；SSE 提交门默认等待 5 秒，预内容错误现在能以真实 HTTP 状态返回；新增若干默认关闭的日志/ACP 开关和 Dashboard 只读接口。没有改协议字段、没有改默认路由、没有改上游 wire。昂贵模型 live 矩阵只覆盖一个 Pro 账号的一次部署，不等同于对所有账号等级的承诺。

## 用户可感知

### 工具名、工具 ID 与历史：跨方言不再截断或丢轮次

v3.9.40 只在 Messages 侧修了 64 字符 wire 上限；这一版把同一类问题扩到三种方言和请求历史：

- **两遍工具名映射**：先收集本次请求的工具名，再在 egress 时恢复客户端原名；Messages 的 split `function.name`（`get_` + `weather`）不再以首片开块，等完整名确认后再发 `content_block_start`，延迟到达的参数在 finish 前补 flush（`src/handlers/messages.js`，`test/startserver-harness-shapes.test.js`）。
- **工具 ID 卫生**：新增 `src/tool-ids.js`，对过长/重复/空 ID 做确定性收敛；重复 raw ID 会按调用顺序分配唯一 wire ID，结果按 FIFO 配对；`src/tool-names.js` 负责 64 字符 wire 名的双向映射；Responses、Gemini、Messages 三条 egress 都接入了同一套守卫。`WINDSURFAPI_TOOL_HYGIENE=0` 现在真正关闭名称映射、ID 清洗和历史规范化（发布审计 P1-1）。
- **历史尾部规范化**：`src/history-normalize.js` 保留 assistant/tool 轮次和数组内容，不再把 `content` 数组压成字符串或丢掉中间轮；孤儿 tool result 只在连续 tool 段结束后折叠成 user 文本，绝不插在 assistant tool_call 和它的有效 tool result 之间（发布审计 P1-2）。
- **边界测试**：新增/扩展 `test/tool-*.test.js`、`test/request-tail-contract.test.js`、`test/startserver-harness-shapes.test.js`，覆盖 split 名、重复 ID、64 字符边界、空工具数组、非对象部件和真实 HTTP 流。

### SSE：预内容错误不再伪装成 200，帧边界不再靠运气

- **统一 framer**：`src/sse-framer.js` 现在被 chat、Messages、Responses 三个翻译器共用；混合 `\n\n`/`\r\n\r\n` 终止符、跨 chunk 的 CRLF、超长帧都有上限和测试（`test/sse-framer.test.js`、`test/stream-framer-routes.test.js`）。
- **提交门**：`src/sse-commit.js` 在写 200 之前缓冲首批帧，首个真实内容或错误帧决定提交；`WINDSURFAPI_STREAM_COMMIT_MS` 默认 5000 ms，`0` 恢复旧的“先写 200”行为。所有 SSE 路由（chat/completions/responses/messages/gemini）在发头之前接入同一个门（`src/server.js`，`test/stream-commit-route.test.js`）。
- **错误状态按协议保留**：Responses 的 `MODEL_BLOCKED` 仍是 402，Messages 保持 Anthropic 的 403/529 语义，Gemini 优先使用数字 `code`（400/404/413）；流式 429 保留 `Retry-After` 和 rate-limit 类；预内容错误不再追加 `[DONE]`，避免客户端把错误当正常结束（`src/sse-commit.js`、`src/handlers/chat.js`）。
- **客户端断开**：上游取消信号继续传播，客户端中途断开时记 `client disconnected mid-stream` 并 abort 上游，不触发 failover；连接关闭后健康检查仍为 200。

### Dashboard：只读观测面补齐，密钥前缀不再出现在页面上

新增/扩展的只读卡片都走服务端鉴权，响应带 `Cache-Control: no-store`，账号引用只显示哈希：

- **账号用量与池冷却**：账号 usage、cooldown 原因/剩余时间、rate-limit/capacity/quota 状态，读取内存池，20 秒轮询不触发上游（`src/dashboard/api.js`、`src/dashboard/pool-events.js`）。
- **请求环**：有界 request ring，记录 chat/completions/responses/messages/gemini 以及 `protocol` 字段，支持最近请求列表和统计；流式请求的耗时按完成时间计算（`src/dashboard/request-ring.js`、`src/server.js`）。
- **目录差异**：live catalog 与静态目录的 diff，能看出新增/缺失/改名的模型（`src/dashboard/catalog-diff.js`）。
- **计费/配额 burn-down**：billing health、quota burn-down、模型对账卡片；没有真实计费值时显示未知，不伪造 0（`src/dashboard/billing-health.js`、`quota-burn-down.js`、`model-reconcile.js`）。
- **安全**：Dashboard 读路径优先使用 Devin session token；不再把 API key 前缀当 fallback 渲染；OTP 片段不再写日志，IMAP SEARCH 解析修复（`src/dashboard/index.html`、`src/dashboard/logger.js`）。
- **视觉验收**：1440 宽桌面截图通过，卡片、空态、错误态和刷新路径都检查过（`.agent/absorption-20261018/dashboard-visual-20261019/`）。

### Devin Connect：目录、模型与传输修复

- **live 目录/模型**：刷新 Connect catalog，补 102 个公开成本表模型和新 family；live credit 乘数落到 `src/models.js`；裸别名与 `-medium` selector 的解析保持一致（`src/devin-connect-models.js`、`src/models.js`）。
- **RATE-RETRY R-1..R-5**：完成剩余限流/重试风险项；`Retry-After`、completion config、严格 tag、post-auth decode 分别有回归测试。
- **在途上限（默认关）**：`DEVIN_CONNECT_MAX_INFLIGHT_PER_ACCOUNT` 默认 `0`（关闭）；设为 `N > 0` 时账号选择跳过已达 N 个在途请求的账号（含 sticky 绑定），突发流量会分散或 429，而不是继续堆在单账号；陈旧计数由 15 分钟下限的清扫回收（`src/auth.js`）。
- **传输/协议**：cancel 信号传播、LS 超时分类、GetUserJwt 15 秒 deadline、catalog/seat surface 的四个协议修复、workspace trust 字段 3/4 双写；`src/devin-connect.js`、`src/client.js`。
- **缓存回放保真**：DEVIN_CONNECT completion cache 保留已交付文本、stop cause 和 model；缓存命中不再改变 finish 语义（`src/handlers/chat.js`、`test/connect-exact-cache.test.js`）。
- **账号过滤（默认关）**：`WAPI_ACCOUNTS_ONLY` 未设置时加载全部账号；设置后按邮箱/账号 id 做每实例隔离；过滤掉的账号仍保留在 `accounts.json`，保存时不再把整份文件裁掉；空匹配 fail-closed（`src/auth.js`、`test/auth-accounts-only.test.js`）。

### 日志、统计与 ACP

- **日志保留/轮转（默认关）**：`LOG_RETENTION_DAYS`、`LOG_MAX_FILE_MB`、`LOG_MAX_TOTAL_MB`；按完整 JSONL 行切分，容量优先于保留期，写失败不会停止后续 append（`src/dashboard/log-files.js`、`src/dashboard/logger.js`）。
- **统计导入**：完整快照导入带验证，缺字段/坏形状不会覆盖现有统计（`src/dashboard/stats.js`）。
- **ACP 原生模型配置（默认关）**：`DEVIN_ACP_CONFIG_OPTIONS=1` 时在 `session/new` 后按 `configOptions` 调 `session/set_config_option`；默认关闭，因为 live option id/value 尚未校准（`src/devin-acp.js`、`docs/ENV-SWITCHES.md`）。

## 工程与门禁

- **startServer 真实 HTTP 测试**：`test/startserver-harness-shapes.test.js` 现在覆盖 chat/Messages/Responses/Gemini 的成功、非流式、两请求 tool loop、并行 tool calls、split tool delta、600 KB body、OpenAI/Anthropic 图片和 ring `protocol` 字段；`test/startserver-cancel.test.js` 用真实 socket 断开证明一次上游尝试且服务仍健康；`test/review-history-coverage.test.js` 区分 1M 的 900 KB 与普通 600 KB 预算。
- **回归缺口**：补 PR/issue 回归 intercepts（9 条无测试行）、#32 no-tools override、#41 短 identity rewrite、sentence-boundary identity rewrite；修复两条静默 no-op 测试，让断言真正执行。
- **门禁**：本地 `npm test` 5,461 / 5,379 pass / 0 fail / 82 skip；`npm run test:release`/gate 5,379 pass / 0 fail / 82 skip（442 文件）；HMC `d014855` 5,460 / 5,459 pass / 0 fail / 1 skip；`secret-scan` 0；`git diff --check` 0。
- **wire**：`d014855` 对 `v3.9.40` 270/270 比较全部相同，skip 0（代码与最终 `461e6a6` 相同，只差 baseline pin）。
- **mutation**：`d014855` + `461e6a6` 全量 85/85 份规格通过（767 条突变，754 caught，13 条声明 survivor，0 mismatch）。
- **Node**：Node 矩阵在 `27e30f4` 测得——Node 24 全绿；Node 22 仅 `test/s2-a-golden.test.js` 的跨大版本 fixture guard 失败；Node 20 另缺 `test:summary`/`node:sqlite`。发布门以 Node 24 为准，Node 20/22 的兼容策略另行记录。

## Live 验收（一个 Pro 账号，隔离部署）

- 7/7 路由 smoke 200；昂贵模型 5 个 selector × 4 协议 20/20 200、文本 `PONG`、usage 存在，1.34–4.91 s。
- 23 个 mode 名全部尝试：6 个 live（`swe-2-medium/high/max`、`gpt-6-astra/sol/1-sol`），17 个预上游 `400 model_not_found`。
- 工具 2/2（`gpt-6-astra`、`claude-opus-5-5`）；多轮保留 `Ada`；取消干净；12 并发 Haiku 12/12 200。
- 补测：4 个其他昂贵 selector 的图片 chat 全部 502 `invalid_argument`，加上 opus 的 chat 502 / messages 529，**5 个昂贵 selector 全部拒绝图片**；Gemini 3.5 Flash 控制 200。
- 正确拼写的 `swe-2-medium/high/max-lightning` 3/3 200；`gpt-6-astra`/`claude-opus-5-5` 的流式 tool call 2/2 200，完整名、完整 args、`finish_reason: tool_calls`、`[DONE]`，未出现 split name。
- 73 次客户端请求 / 56 次上游调用，list-price 上限 3,491 credits；wire 没有计费标签，**实际扣费未观测**。
- 证据：`~/.dwgx/ops/research/devinpro-complete-capability-matrix/{MATRIX-REPORT.md,VERIFICATION.md,matrix.json}`。

## 尚未验证

- **实际计费 debit**：2,792 是乘数上限，不是账单读数。
- **图片**：5 个昂贵 selector 的 chat 图片全部失败（4 个本次补测 + opus 既有）；messages 只对 opus 观测到 529，其他四个未重复。
- **streaming tool deltas**：`gpt-6-astra`/`claude-opus-5-5` 的 live 流式 tool call 已覆盖完整名与完整 args；Gemini split 名由 fake upstream 覆盖；Responses 的 split 名仍可能在 `output_item.added` 中先出现首片（既有 P2，未在本次修复）。
- **429/402 停止路径**：本轮没有触发，未验证。
- **Node 20/22**：版本性失败仍在，发布门只声明 Node 24。
- **Any2API 集成**：Codex `responses` 直通和 Claude `anthropic` 的 live 冒烟尚未跑；`PATCH-G5.diff` 只是提案，未应用。

## 升级注意

- `WINDSURFAPI_TOOL_HYGIENE` 默认开启；依赖原始畸形工具名/ID 透传的调用方需要显式设 `0`。
- SSE 提交门默认 5 秒；需要旧的“立即 200”行为时设 `WINDSURFAPI_STREAM_COMMIT_MS=0`。
- 日志保留/轮转和 ACP 原生配置默认关闭；开启前先读 `docs/ENV-SWITCHES.md` 的边界说明。
- 本版没有改协议路由或默认 wire；wire 门禁的 270/270 是默认路径未移动的证据，不是“wire 全部正确”的证明。
