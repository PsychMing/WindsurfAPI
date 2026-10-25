# 尚未验证登记册 / Unverified register

> **自动生成，不要手改。** 来源是 `docs/releases/*.md` 里标题含「尚未验证」的小节；改完那些
> 小节后运行 `node scripts/unverified-register.mjs`。`test/unverified-register.test.js` 会重新
> 生成并与本文件逐字节比较，任何漂移都是失败。
>
> 状态只看 bullet 开头的 marker：`[VERIFIED]` → **已复核**（bullet 里要带复核记录），
> `[FIXED]` → **已修**，`[UNVERIFIED]` → **仍缺**；没有 marker 的同样按 **仍缺** 计，marker 列
> 写 `—`。登记册本身不重新测量任何东西：一条从「仍缺」变成「已复核」，必须先在对应
> release note 里补上 marker 和证据，再重新生成本文件。

## 总量

| 项 | 值 |
|---|---|
| 扫描 | `docs/releases/*.md` 共 214 个文件 |
| 命中 | 24 个文件 / 24 个小节 |
| bullet | 72 条 |
| 已复核 | 2 |
| 仍缺 | 70 |
| 已修 | 0 |
| 无 marker | 7 |

## 按 release

| release | 小节 | bullet | 已复核 | 仍缺 | 已修 | 无 marker |
|---|---:|---:|---:|---:|---:|---:|
| [3.141.592654](releases/RELEASE_NOTES_3.141.592654.md) | 1 | 7 | 0 | 7 | 0 | 7 |
| [3.10.0](releases/RELEASE_NOTES_3.10.0.md) | 1 | 3 | 0 | 3 | 0 | 0 |
| [3.9.60](releases/RELEASE_NOTES_3.9.60.md) | 1 | 2 | 0 | 2 | 0 | 0 |
| [3.9.59](releases/RELEASE_NOTES_3.9.59.md) | 1 | 2 | 2 | 0 | 0 | 0 |
| [3.9.58](releases/RELEASE_NOTES_3.9.58.md) | 1 | 2 | 0 | 2 | 0 | 0 |
| [3.9.57](releases/RELEASE_NOTES_3.9.57.md) | 1 | 2 | 0 | 2 | 0 | 0 |
| [3.9.56](releases/RELEASE_NOTES_3.9.56.md) | 1 | 3 | 0 | 3 | 0 | 0 |
| [3.9.55](releases/RELEASE_NOTES_3.9.55.md) | 1 | 2 | 0 | 2 | 0 | 0 |
| [3.9.54](releases/RELEASE_NOTES_3.9.54.md) | 1 | 3 | 0 | 3 | 0 | 0 |
| [3.9.53](releases/RELEASE_NOTES_3.9.53.md) | 1 | 3 | 0 | 3 | 0 | 0 |
| [3.9.52](releases/RELEASE_NOTES_3.9.52.md) | 1 | 3 | 0 | 3 | 0 | 0 |
| [3.9.51](releases/RELEASE_NOTES_3.9.51.md) | 1 | 3 | 0 | 3 | 0 | 0 |
| [3.9.50](releases/RELEASE_NOTES_3.9.50.md) | 1 | 3 | 0 | 3 | 0 | 0 |
| [3.9.49](releases/RELEASE_NOTES_3.9.49.md) | 1 | 3 | 0 | 3 | 0 | 0 |
| [3.9.48](releases/RELEASE_NOTES_3.9.48.md) | 1 | 3 | 0 | 3 | 0 | 0 |
| [3.9.47](releases/RELEASE_NOTES_3.9.47.md) | 1 | 2 | 0 | 2 | 0 | 0 |
| [3.9.46](releases/RELEASE_NOTES_3.9.46.md) | 1 | 1 | 0 | 1 | 0 | 0 |
| [3.9.45](releases/RELEASE_NOTES_3.9.45.md) | 1 | 2 | 0 | 2 | 0 | 0 |
| [3.9.44](releases/RELEASE_NOTES_3.9.44.md) | 1 | 3 | 0 | 3 | 0 | 0 |
| [3.9.43](releases/RELEASE_NOTES_3.9.43.md) | 1 | 3 | 0 | 3 | 0 | 0 |
| [3.9.42](releases/RELEASE_NOTES_3.9.42.md) | 1 | 5 | 0 | 5 | 0 | 0 |
| [3.9.41](releases/RELEASE_NOTES_3.9.41.md) | 1 | 6 | 0 | 6 | 0 | 0 |
| [3.9.40](releases/RELEASE_NOTES_3.9.40.md) | 1 | 3 | 0 | 3 | 0 | 0 |
| [3.9.39](releases/RELEASE_NOTES_3.9.39.md) | 1 | 3 | 0 | 3 | 0 | 0 |

## 3.141.592654 — `docs/releases/RELEASE_NOTES_3.141.592654.md`

1 个小节 · 7 条：已复核 0 · 仍缺 7 · 已修 0（无 marker 7）

小节 `## 已知 / 尚未验证`（`:135`）

| # | 位置 | bullet | marker | 状态 |
|---:|---|---|---|---|
| 1 | `RELEASE_NOTES_3.141.592654.md:139` | **wire 已实测，但只覆盖请求体**：`e3cc399` 对 `v3.10.1`（`b00b3b9`，annotated tag 已验证）**270/270** 逐字节一致，0 mismatch（HMC，见门禁表）。比较范围是 9 组历史 × 5 条 prepare 路由 × 2 native × 3 环境 = 270 个 protobuf 请求体；HTTP/Connect 帧与响应流按设计不在内。本机（Windows）无 `WIRE_BASE_TREE` 时该测试按设计跳过，已声明为 inert。 | — | 仍缺 |
| 2 | `RELEASE_NOTES_3.141.592654.md:140` | **全量 mutation sweep 已实测**：92/92 spec、822 条全部执行，808 被捕获 + 14 条 spec 自带的 `expectCaught:false`，0 drift、0 untrustworthy（HMC，2,953 s，见门禁表）。14 条幸存者是各 spec 文档化的不可达/等价分支，不是漂移。 | — | 仍缺 |
| 3 | `RELEASE_NOTES_3.141.592654.md:141` | **真实 Codex CLI 修复后未重跑**：客户端级 PASS 属于修复前基线（只有打开 `DEVIN_CONNECT_TOOL_CHOICE=1` 才 3/3）；修复后的 200 由探针与单元测试证明，未用真实 CLI 复验。 | — | 仍缺 |
| 4 | `RELEASE_NOTES_3.141.592654.md:142` | **S7 的修法方向是推断**：`swe-1-5` 该落 `MODEL_SWE_1_5_SLOW` 还是 `kimi_k2` 只有快照证据，原证据里已标注。 | — | 仍缺 |
| 5 | `RELEASE_NOTES_3.141.592654.md:143` | **托管 CI / 发布产物未验证**：本版在本地分支准备，tag、CI、HMC 部署与 cosign 资产都要在合并后另行执行与核对。 | — | 仍缺 |
| 6 | `RELEASE_NOTES_3.141.592654.md:144` | **本机门禁的 6 条 inert 声明**：Windows 没有 `/usr/bin/git`，`test/wire-byte-identity.test.js` 无 wire 基线，`test/devin-connect-relogin-live.test.js` 未武装，`detach-soak` / `detach-ls-pool-pressure` 在本机整文件跳过——这些都按 `GATE_INERT_SKIP_PATHS` 声明，不当作绿。 | — | 仍缺 |
| 7 | `RELEASE_NOTES_3.141.592654.md:145` | 明文 `http:` 图片、server-executed 工具类型的 400 仍是**有意**行为：依赖"静默忽略"的客户端会开始收到错误。 | — | 仍缺 |

## 3.10.0 — `docs/releases/RELEASE_NOTES_3.10.0.md`

1 个小节 · 3 条：已复核 0 · 仍缺 3 · 已修 0（无 marker 0）

小节 `## 尚未验证`（`:88`）

| # | 位置 | bullet | marker | 状态 |
|---:|---|---|---|---|
| 1 | `RELEASE_NOTES_3.10.0.md:92` | detach 默认开启（NO-GO 未变）；真实 Cascade 上游 resume。 | `[UNVERIFIED]` | 仍缺 |
| 2 | `RELEASE_NOTES_3.10.0.md:93` | 真实 Enterprise 的 `teams_tier`；历史 secret 扫描。 | `[UNVERIFIED]` | 仍缺 |
| 3 | `RELEASE_NOTES_3.10.0.md:94` | 真实 tag 构建上的 cosign keyless 交换（GitHub OIDC → Fulcio/Rekor 只能在 GitHub runner 上验证）；本地已用 fake cosign 跑通签名步骤与验签脚本，工作流接线由测试锁定。 | `[UNVERIFIED]` | 仍缺 |

## 3.9.60 — `docs/releases/RELEASE_NOTES_3.9.60.md`

1 个小节 · 2 条：已复核 0 · 仍缺 2 · 已修 0（无 marker 0）

小节 `## 尚未验证`（`:32`）

| # | 位置 | bullet | marker | 状态 |
|---:|---|---|---|---|
| 1 | `RELEASE_NOTES_3.9.60.md:36` | 设计 §6.7 的 mutation 表与真实 soak；**默认关**，不开不影响现有路径。 | `[UNVERIFIED]` | 仍缺 |
| 2 | `RELEASE_NOTES_3.9.60.md:37` | 真实 Enterprise 账号的 `teams_tier` 行（无可用账号）。 | `[UNVERIFIED]` | 仍缺 |

## 3.9.59 — `docs/releases/RELEASE_NOTES_3.9.59.md`

1 个小节 · 2 条：已复核 2 · 仍缺 0 · 已修 0（无 marker 0）

小节 `## 尚未验证`（`:22`）

| # | 位置 | bullet | marker | 状态 |
|---:|---|---|---|---|
| 1 | `RELEASE_NOTES_3.9.59.md:26` | Release run `39871636798` **success**（Test + 两个单文件 + Docker + GitHub Release 全绿）。2026-10-25 复核：`gh run view 39871636798` → `conclusion: success`。 | `[VERIFIED]` | 已复核 |
| 2 | `RELEASE_NOTES_3.9.59.md:27` | `gh release view v3.9.59`：5 个资产（含 `SHA256SUMS`）；逐个计算哈希与清单比对 **4/4 OK**（本机 Git Bash 的 `sha256sum -c` 有兼容问题，直接比对为准）。2026-10-25 复核：`gh release view v3.9.59` → 5 assets。 | `[VERIFIED]` | 已复核 |

## 3.9.58 — `docs/releases/RELEASE_NOTES_3.9.58.md`

1 个小节 · 2 条：已复核 0 · 仍缺 2 · 已修 0（无 marker 0）

小节 `## 尚未验证`（`:32`）

| # | 位置 | bullet | marker | 状态 |
|---:|---|---|---|---|
| 1 | `RELEASE_NOTES_3.9.58.md:36` | 真实 Actions 执行（本地 gate + Linux 全量 + 强制 ref clone 已复现对象形态）。 | `[UNVERIFIED]` | 仍缺 |
| 2 | `RELEASE_NOTES_3.9.58.md:37` | 真实上游在预算边界的行为（fake upstream）。 | `[UNVERIFIED]` | 仍缺 |

## 3.9.57 — `docs/releases/RELEASE_NOTES_3.9.57.md`

1 个小节 · 2 条：已复核 0 · 仍缺 2 · 已修 0（无 marker 0）

小节 `## 尚未验证`（`:38`）

| # | 位置 | bullet | marker | 状态 |
|---:|---|---|---|---|
| 1 | `RELEASE_NOTES_3.9.57.md:42` | 真实 Actions 执行（本地用强制 ref clone 复现了对象形态）。 | `[UNVERIFIED]` | 仍缺 |
| 2 | `RELEASE_NOTES_3.9.57.md:43` | v3.9.54–56 的 Release 产物不会补发；它们的内容已包含在 3.9.56/3.9.57。 | `[UNVERIFIED]` | 仍缺 |

## 3.9.56 — `docs/releases/RELEASE_NOTES_3.9.56.md`

1 个小节 · 3 条：已复核 0 · 仍缺 3 · 已修 0（无 marker 0）

小节 `## 尚未验证`（`:31`）

| # | 位置 | bullet | marker | 状态 |
|---:|---|---|---|---|
| 1 | `RELEASE_NOTES_3.9.56.md:35` | 真实 `app.devin.ai` 的 `/billing/status` 抓包（池内无 session token，fixture 来自面板观测值）。 | `[UNVERIFIED]` | 仍缺 |
| 2 | `RELEASE_NOTES_3.9.56.md:36` | 修改后的 release job 真实跑一次（需要 tag）。 | `[UNVERIFIED]` | 仍缺 |
| 3 | `RELEASE_NOTES_3.9.56.md:37` | cosign/minisign 命令与 OCR/SARIF 执行（无密钥/无 provider token）。 | `[UNVERIFIED]` | 仍缺 |

## 3.9.55 — `docs/releases/RELEASE_NOTES_3.9.55.md`

1 个小节 · 2 条：已复核 0 · 仍缺 2 · 已修 0（无 marker 0）

小节 `## 尚未验证`（`:23`）

| # | 位置 | bullet | marker | 状态 |
|---:|---|---|---|---|
| 1 | `RELEASE_NOTES_3.9.55.md:27` | 真实账号池的视觉与慢网络下的分步登录。 | `[UNVERIFIED]` | 仍缺 |
| 2 | `RELEASE_NOTES_3.9.55.md:28` | 屏幕阅读器对 `details` 展开与状态分组的朗读。 | `[UNVERIFIED]` | 仍缺 |

## 3.9.54 — `docs/releases/RELEASE_NOTES_3.9.54.md`

1 个小节 · 3 条：已复核 0 · 仍缺 3 · 已修 0（无 marker 0）

小节 `## 尚未验证`（`:35`）

| # | 位置 | bullet | marker | 状态 |
|---:|---|---|---|---|
| 1 | `RELEASE_NOTES_3.9.54.md:39` | 真实池的批量任务延迟与取消（fake upstream）。 | `[UNVERIFIED]` | 仍缺 |
| 2 | `RELEASE_NOTES_3.9.54.md:40` | 真实 Docker daemon 的 pull/health/rollback（脚本状态机已在 Git Bash 复现）。 | `[UNVERIFIED]` | 仍缺 |
| 3 | `RELEASE_NOTES_3.9.54.md:41` | 1440/390 之外视口与屏幕阅读器。 | `[UNVERIFIED]` | 仍缺 |

## 3.9.53 — `docs/releases/RELEASE_NOTES_3.9.53.md`

1 个小节 · 3 条：已复核 0 · 仍缺 3 · 已修 0（无 marker 0）

小节 `## 尚未验证`（`:110`）

| # | 位置 | bullet | marker | 状态 |
|---:|---|---|---|---|
| 1 | `RELEASE_NOTES_3.9.53.md:114` | `deploy/update.sh` 的 POSIX 集成夹具（12 条在 Windows 上按设计 skip）：真实 pull / 健康门 / 回滚序列。 | `[UNVERIFIED]` | 仍缺 |
| 2 | `RELEASE_NOTES_3.9.53.md:116` | `docker compose config` 校验：本机 Docker CLI 29.7.2 在，但 daemon 未运行，矩阵按设计 跳过并标记。 | `[UNVERIFIED]` | 仍缺 |
| 3 | `RELEASE_NOTES_3.9.53.md:119` | CascadeTurn 在真实 Cascade 上游上的长轮询恢复（回归用脚本化上游）。 | `[UNVERIFIED]` | 仍缺 |

## 3.9.52 — `docs/releases/RELEASE_NOTES_3.9.52.md`

1 个小节 · 3 条：已复核 0 · 仍缺 3 · 已修 0（无 marker 0）

小节 `## 尚未验证`（`:34`）

| # | 位置 | bullet | marker | 状态 |
|---:|---|---|---|---|
| 1 | `RELEASE_NOTES_3.9.52.md:38` | 真实退役 session id 的探针行为（设计 §8-6）。 | `[UNVERIFIED]` | 仍缺 |
| 2 | `RELEASE_NOTES_3.9.52.md:39` | Node 22.13.0 的完整矩阵（策略已声明，矩阵待补）。 | `[UNVERIFIED]` | 仍缺 |
| 3 | `RELEASE_NOTES_3.9.52.md:40` | 真实浏览器上的 reauth 徽章/抽屉视觉。 | `[UNVERIFIED]` | 仍缺 |

## 3.9.51 — `docs/releases/RELEASE_NOTES_3.9.51.md`

1 个小节 · 3 条：已复核 0 · 仍缺 3 · 已修 0（无 marker 0）

小节 `## 尚未验证`（`:37`）

| # | 位置 | bullet | marker | 状态 |
|---:|---|---|---|---|
| 1 | `RELEASE_NOTES_3.9.51.md:41` | 真实邮箱验证码的 `email/complete` → PostAuth（需要 Owner 的收件箱）。 | `[UNVERIFIED]` | 仍缺 |
| 2 | `RELEASE_NOTES_3.9.51.md:42` | 真实 `has_password:true` 账号、Devin 跨 host PostAuth。 | `[UNVERIFIED]` | 仍缺 |
| 3 | `RELEASE_NOTES_3.9.51.md:43` | 真实 `app.devin.ai` 的 daily-usage 响应（fixture 按捕获形状）。 | `[UNVERIFIED]` | 仍缺 |

## 3.9.50 — `docs/releases/RELEASE_NOTES_3.9.50.md`

1 个小节 · 3 条：已复核 0 · 仍缺 3 · 已修 0（无 marker 0）

小节 `## 尚未验证`（`:32`）

| # | 位置 | bullet | marker | 状态 |
|---:|---|---|---|---|
| 1 | `RELEASE_NOTES_3.9.50.md:36` | 真实 ACP 子进程的重试（fake stdio）。 | `[UNVERIFIED]` | 仍缺 |
| 2 | `RELEASE_NOTES_3.9.50.md:37` | 真实浏览器的 1440/390 之外视口。 | `[UNVERIFIED]` | 仍缺 |
| 3 | `RELEASE_NOTES_3.9.50.md:38` | 请求历史只覆盖计费成功，非计费/失败尝试不显示。 | `[UNVERIFIED]` | 仍缺 |

## 3.9.49 — `docs/releases/RELEASE_NOTES_3.9.49.md`

1 个小节 · 3 条：已复核 0 · 仍缺 3 · 已修 0（无 marker 0）

小节 `## 尚未验证`（`:36`）

| # | 位置 | bullet | marker | 状态 |
|---:|---|---|---|---|
| 1 | `RELEASE_NOTES_3.9.49.md:40` | 真实 LS 3.10.67 的 `UpdateWorkspaceTrust`/`prompt_cache_key` 端到端行为（仅二进制字符串与安装验证）。 | `[UNVERIFIED]` | 仍缺 |
| 2 | `RELEASE_NOTES_3.9.49.md:41` | Linux arm64 无上游归档，需 `--file`。 | `[UNVERIFIED]` | 仍缺 |
| 3 | `RELEASE_NOTES_3.9.49.md:42` | 真实上游的 int64 字符串 JSON 响应（描述符 + 解码器验证）。 | `[UNVERIFIED]` | 仍缺 |

## 3.9.48 — `docs/releases/RELEASE_NOTES_3.9.48.md`

1 个小节 · 3 条：已复核 0 · 仍缺 3 · 已修 0（无 marker 0）

小节 `## 尚未验证`（`:44`）

| # | 位置 | bullet | marker | 状态 |
|---:|---|---|---|---|
| 1 | `RELEASE_NOTES_3.9.48.md:48` | 真实邮箱验证码的 `email/complete` 与 PostAuth。 | `[UNVERIFIED]` | 仍缺 |
| 2 | `RELEASE_NOTES_3.9.48.md:49` | 真实上游的预内容 429/503 状态（fake upstream 覆盖）。 | `[UNVERIFIED]` | 仍缺 |
| 3 | `RELEASE_NOTES_3.9.48.md:50` | 真实慢客户端与进程级内存。 | `[UNVERIFIED]` | 仍缺 |

## 3.9.47 — `docs/releases/RELEASE_NOTES_3.9.47.md`

1 个小节 · 2 条：已复核 0 · 仍缺 2 · 已修 0（无 marker 0）

小节 `## 尚未验证`（`:24`）

| # | 位置 | bullet | marker | 状态 |
|---:|---|---|---|---|
| 1 | `RELEASE_NOTES_3.9.47.md:28` | 真实上游的容量预检答案与团队计费 RPC。 | `[UNVERIFIED]` | 仍缺 |
| 2 | `RELEASE_NOTES_3.9.47.md:29` | 真实账号在 1440/390 之外的视口。 | `[UNVERIFIED]` | 仍缺 |

## 3.9.46 — `docs/releases/RELEASE_NOTES_3.9.46.md`

1 个小节 · 1 条：已复核 0 · 仍缺 1 · 已修 0（无 marker 0）

小节 `## 尚未验证`（`:24`）

| # | 位置 | bullet | marker | 状态 |
|---:|---|---|---|---|
| 1 | `RELEASE_NOTES_3.9.46.md:28` | 真实账号在 15 分钟刷新周期后的 HMC 页面（部署后由 `refreshCredits` 自动清除旧值）。 | `[UNVERIFIED]` | 仍缺 |

## 3.9.45 — `docs/releases/RELEASE_NOTES_3.9.45.md`

1 个小节 · 2 条：已复核 0 · 仍缺 2 · 已修 0（无 marker 0）

小节 `## 尚未验证`（`:34`）

| # | 位置 | bullet | marker | 状态 |
|---:|---|---|---|---|
| 1 | `RELEASE_NOTES_3.9.45.md:38` | 真实账号在重做后的账号页上的完整视觉/交互走查（截图使用 fixture key，配额单元多为设计的“获取失败”态）。 | `[UNVERIFIED]` | 仍缺 |
| 2 | `RELEASE_NOTES_3.9.45.md:39` | 真实上游的批量探测/刷新（fake upstream 覆盖路由与失败形状）。 | `[UNVERIFIED]` | 仍缺 |

## 3.9.44 — `docs/releases/RELEASE_NOTES_3.9.44.md`

1 个小节 · 3 条：已复核 0 · 仍缺 3 · 已修 0（无 marker 0）

小节 `## 尚未验证`（`:37`）

| # | 位置 | bullet | marker | 状态 |
|---:|---|---|---|---|
| 1 | `RELEASE_NOTES_3.9.44.md:41` | 真实邮箱验证码的完整 `email/complete` → PostAuth → apiKey。 | `[UNVERIFIED]` | 仍缺 |
| 2 | `RELEASE_NOTES_3.9.44.md:42` | 真实 Devin host 的 `email/{start,complete}` 回退。 | `[UNVERIFIED]` | 仍缺 |
| 3 | `RELEASE_NOTES_3.9.44.md:43` | 进程级内存上限（本版承诺的是队列进度有界，不是 RSS 硬上限）。 | `[UNVERIFIED]` | 仍缺 |

## 3.9.43 — `docs/releases/RELEASE_NOTES_3.9.43.md`

1 个小节 · 3 条：已复核 0 · 仍缺 3 · 已修 0（无 marker 0）

小节 `## 尚未验证`（`:40`）

| # | 位置 | bullet | marker | 状态 |
|---:|---|---|---|---|
| 1 | `RELEASE_NOTES_3.9.43.md:44` | 真实 Devin CLI 的 ACP 工具调用与真实客户端渲染。 | `[UNVERIFIED]` | 仍缺 |
| 2 | `RELEASE_NOTES_3.9.43.md:45` | `/v1/responses` 的 ACP `tool_calls` 输出。 | `[UNVERIFIED]` | 仍缺 |
| 3 | `RELEASE_NOTES_3.9.43.md:46` | 真实浏览器之外的 dashboard 视口（只测 1440/390 两档）。 | `[UNVERIFIED]` | 仍缺 |

## 3.9.42 — `docs/releases/RELEASE_NOTES_3.9.42.md`

1 个小节 · 5 条：已复核 0 · 仍缺 5 · 已修 0（无 marker 0）

小节 `## 尚未验证`（`:91`）

| # | 位置 | bullet | marker | 状态 |
|---:|---|---|---|---|
| 1 | `RELEASE_NOTES_3.9.42.md:95` | 真实慢读 socket（内核缓冲区写满的 `ServerResponse`）未测；写门由受控 `EventEmitter` writable 与真实轮询循环驱动，`res.write === false` 的契约本身是 Node 的，未重新测量。 | `[UNVERIFIED]` | 仍缺 |
| 2 | `RELEASE_NOTES_3.9.42.md:96` | 未观察到真实上游发出前导 BOM；BOM 修复是防御性的。 | `[UNVERIFIED]` | 仍缺 |
| 3 | `RELEASE_NOTES_3.9.42.md:97` | 本版没有 live 上游/账号验收：所有协议用例都用既有 fake-`res` / fake-upstream 形状。 | `[UNVERIFIED]` | 仍缺 |
| 4 | `RELEASE_NOTES_3.9.42.md:98` | legacy `rawGetChatMessage` 的背压仍然缺失（本版范围外，见上）；Messages/Gemini/Responses/Connect 路由不声称端到端背压。 | `[UNVERIFIED]` | 仍缺 |
| 5 | `RELEASE_NOTES_3.9.42.md:99` | 没有 RSS 测量：C2 的承诺是「生产者进度有界」，不是内存硬上限。 | `[UNVERIFIED]` | 仍缺 |

## 3.9.41 — `docs/releases/RELEASE_NOTES_3.9.41.md`

1 个小节 · 6 条：已复核 0 · 仍缺 6 · 已修 0（无 marker 0）

小节 `## 尚未验证`（`:79`）

| # | 位置 | bullet | marker | 状态 |
|---:|---|---|---|---|
| 1 | `RELEASE_NOTES_3.9.41.md:83` | **实际计费 debit**：3,491 是乘数上限，不是账单读数。 | `[UNVERIFIED]` | 仍缺 |
| 2 | `RELEASE_NOTES_3.9.41.md:84` | **图片**：5 个昂贵 selector 的 chat 图片全部失败（4 个本次补测 + opus 既有）；messages 只对 opus 观测到 529，其他四个未重复。 | `[UNVERIFIED]` | 仍缺 |
| 3 | `RELEASE_NOTES_3.9.41.md:85` | **streaming tool deltas**：`gpt-6-astra`/`claude-opus-5-5` 的 live 流式 tool call 已覆盖完整名与完整 args；Gemini 与 Responses 的 split 名均由 fake upstream 覆盖，`output_item.added` 携带完整名。 | `[UNVERIFIED]` | 仍缺 |
| 4 | `RELEASE_NOTES_3.9.41.md:86` | **429/402 停止路径**：本轮没有触发，未验证。 | `[UNVERIFIED]` | 仍缺 |
| 5 | `RELEASE_NOTES_3.9.41.md:87` | **Node 20/22**：版本性失败仍在，发布门只声明 Node 24。 | `[UNVERIFIED]` | 仍缺 |
| 6 | `RELEASE_NOTES_3.9.41.md:88` | **Any2API 集成**：Codex `responses` 直通和 Claude `anthropic` 的 live 冒烟尚未跑；`PATCH-G5.diff` 只是提案，未应用。 | `[UNVERIFIED]` | 仍缺 |

## 3.9.40 — `docs/releases/RELEASE_NOTES_3.9.40.md`

1 个小节 · 3 条：已复核 0 · 仍缺 3 · 已修 0（无 marker 0）

小节 `## 尚未验证`（`:141`）

| # | 位置 | bullet | marker | 状态 |
|---:|---|---|---|---|
| 1 | `RELEASE_NOTES_3.9.40.md:145` | **无 live-account 验收**：本机没有已付费账号；live 套件（`test/devin-connect-relogin-live.test.js`） 未 armed，整个套件按声明跳过。 | `[UNVERIFIED]` | 仍缺 |
| 2 | `RELEASE_NOTES_3.9.40.md:147` | `system:[null]` 的"修复后完整 200"在本机只能验到越过转换器（提交记录本机 529 因 LS 二进制 缺失）；200 由仓库自身 backend seam 的测试钉住，真实账号路径未验。 | `[UNVERIFIED]` | 仍缺 |
| 3 | `RELEASE_NOTES_3.9.40.md:149` | s2-b 的 harness 全量重评分（8/8、exit 0）先是 **WSL** 记录（node v24.21.0，1500 MB cgroup 限内存）， 现已由 **bench 复核**（`hmc`，`runs/master-final`，`74f6c6d`，`GATE_EXIT=0` 且 `sweep_ok=85 sweep_abort=0`，该规格日志 `all 8 mutation(s) behaved as expected; tree clean`）。 本机以手工字节复验 8/8（23 测试全跑），但 `scripts/mutate-verify.mjs` 在本机拒绝运行（POSIX git）。 | `[UNVERIFIED]` | 仍缺 |

## 3.9.39 — `docs/releases/RELEASE_NOTES_3.9.39.md`

1 个小节 · 3 条：已复核 0 · 仍缺 3 · 已修 0（无 marker 0）

小节 `## 尚未验证`（`:72`）

| # | 位置 | bullet | marker | 状态 |
|---:|---|---|---|---|
| 1 | `RELEASE_NOTES_3.9.39.md:76` | **无 live-account 验收**：本轮每个宿主上 `accounts.json` 都是 2 字节的空池。 | `[UNVERIFIED]` | 仍缺 |
| 2 | `RELEASE_NOTES_3.9.39.md:77` | **四个仪器仍未运行**：`WINDSURFAPI_LEAK_TRACE=1`、`DEVIN_CONNECT_DEBUG_META=1`、 `calibrate:devin`、`cascade-survival-probe.mjs`。 | `[UNVERIFIED]` | 仍缺 |
| 3 | `RELEASE_NOTES_3.9.39.md:79` | **`s2-b-frame-assembly` 的突变裁决仍然缺失**：它的突变本身破坏模块加载，harness 按设计拒绝 把这种运行当作证据（拒绝 ≠ 判绿）。 | `[UNVERIFIED]` | 仍缺 |
