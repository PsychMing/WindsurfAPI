# 3.141.592656 验收附录（2026-10-26）

本附录是 `3.141.592656` 的认证记录，与
[`RELEASE_NOTES_3.141.592656.md`](RELEASE_NOTES_3.141.592656.md) 一起构成唯一的不可变验收记录。
它把 **27 行 V 台账逐行绑定到发布提交**，并记录 B01–B05 的实测命令、计数、skip 名单与日志哈希。

- 发布版本：**3.141.592656**
- 发布提交（B01）：本附录随发布提交提交；该提交的父提交是 `12aebfcb`（F2/F3 分支 tip），
  `src/` 与 `c8bfbace` 相同。认证树是紧随其后的 docs-only 提交（tag 目标），其 SHA 由
  `git rev-list -n1 v3.141.592656` 解析；本附录在 tag 树修订中写入发布提交的精确 SHA。
- 上一个已发布 tag：`v3.141.592655` → `c60d746985f0feffe5d29ff13773f4bfbdf9aa5b`。
- 源码基线：`c62b5be7`（D 批与 V 批已合入）；F2/F3 修复提交 `c8bfbace`。
- 台账算术源：`evidence/audit/VERDICT.md:7-16` —— **27 行 = 4 P0 + 18 P1 + 5 P2**。

## 1. V-01…V-27 逐行矩阵（每行恰好一次）

状态词：**关闭** = 该行的具名机制有红先测试/目标套件证据，且发布提交包含它；**边界**列指出
该行原始范围之外、由 D 波另行关闭的调用路径。历史报告保留原文，本表是当前状态。

| V-ID | 严重度 | 修复提交 | 状态 | 证据 | 证明测试 / 边界 |
|---|---|---|---|---|---|
| V-01 | P0 | `bef123c8` | 关闭 | `evidence/FixA01.md` | `test/tool-emulation-salvage-provenance.test.js` |
| V-02 | P0 | `5b932eb3` | 关闭 | `evidence/FixA02.md` | `test/messages-tool-json-validation.test.js` |
| V-03 | P0 | `00c06d01` | 关闭 | `evidence/FixA03.md` | `test/response-store-write-ownership.test.js` |
| V-04 | P0 | `41e196c0` | 关闭 | `evidence/FixA04A05.md`；`evidence/FixD1D6.md` | `test/dashboard-mutation-guard.test.js`；D1 关闭 `/auth/*` 与 forwarded-Host 边界（`test/dashboard-host-boundary.test.js` 9/9） |
| V-05 | P1 | `41e196c0` | 关闭 | `evidence/FixA04A05.md` | `test/langserver-update-integrity.test.js` |
| V-06 | P1 | `5b932eb3` | 关闭 | `evidence/FixA06A07.md`；`evidence/final/FixF2F3.md` | `test/stream-error.test.js`、`test/cascade-poll-truncation-terminal.test.js`；F2 关闭 final-sweep 残余（`test/cascade-final-sweep-terminal.test.js`） |
| V-07 | P1 | `5b932eb3` | 关闭 | `evidence/FixA06A07.md` | `test/chat-tool-choice-parity.test.js` |
| V-08 | P1 | `ae1cbe0a` | 关闭 | `evidence/FixV08V10V12V14.md`；`evidence/FixD8.md` | `test/connect-stream-backpressure-drain.test.js`；D8 关闭 Messages/Gemini verdict+drain 传播 |
| V-09 | P1 | `5b932eb3` | 关闭 | `evidence/FixP03.md` | `test/responses-input-file-connect.test.js` |
| V-10 | P1 | `ae1cbe0a` | 关闭 | `evidence/FixV08V10V12V14.md`；`evidence/FixD2D3D4D5.md` | `test/structured-output-schema.test.js`；D2 关闭 Connect **stream** 校验 |
| V-11 | P1 | `6259b1a5` | 关闭 | `evidence/FixV11.md` | `test/tool-emulation-overlimit.test.js` |
| V-12 | P1 | `ae1cbe0a` | 关闭 | `evidence/FixV08V10V12V14.md` | `test/responses-tool-history-persistence.test.js` |
| V-13 | P1 | `4462021e` | 关闭 | `evidence/FixV13.md`；`evidence/FixD2D3D4D5.md` | `test/cascade-native-history-delta.test.js`；D3 关闭 reuse→fresh 历史回退（3/1/1→3） |
| V-14 | P1 | `ae1cbe0a` | 关闭 | `evidence/FixV08V10V12V14.md` | `test/cascade-completion-controls.test.js` |
| V-15 | P1 | `cb12398e` | 关闭 | `evidence/FixP04.md` | `test/connect-exact-cache.test.js` |
| V-16 | P1 | `faba39d6` | 关闭 | `evidence/FixA16.md` | `test/auth-terminal-states.test.js` |
| V-17 | P1 | `072ce6d6` | 关闭 | `evidence/FixV17V18V26.md` | `test/auth-reserve-inherit.test.js` |
| V-18 | P1 | `072ce6d6` | 关闭 | `evidence/FixV17V18V26.md` | `test/auth-quota-cooldown-monotonic.test.js` |
| V-19 | P1 | `00c06d01` | 关闭 | `evidence/FixA19A20.md` | `test/response-store-atomicity.test.js` |
| V-20 | P1 | `00c06d01` | 关闭 | `evidence/FixA19A20.md` | `test/response-store-hardening.test.js` |
| V-21 | P1 | `17cbff4f` | 关闭 | 提交说明（`fix(dashboard): atomic credentials…`） | `test/dashboard-credentials-route.test.js` |
| V-22 | P1 | `5d603c3d` | 关闭 | `evidence/FixP01.md` | `test/stats-prototype-pollution.test.js` |
| V-23 | P2 | `6667635c` | 关闭 | `evidence/FixV23.md` | `test/response-store-argument-integrity.test.js` |
| V-24 | P2 | `17cbff4f` | 关闭 | 提交说明（同一提交） | `test/windsurf-login-identity.test.js` |
| V-25 | P2 | `17cbff4f` | 关闭 | 提交说明（同一提交） | `test/dashboard-batch-import-redaction.test.js` |
| V-26 | P2 | `072ce6d6` | 关闭 | `evidence/FixV17V18V26.md` | `test/auth-snapshot-epoch.test.js`；delete+re-add ABA 子 claim 未复现，保留 pinned control |
| V-27 | P2 | `d0a7a458`（D4） | 关闭 | `evidence/FixD2D3D4D5.md` §D4 | `test/cache-replay-usage-accounting.test.js` 3/3（红先 3 条：16 vs 8、16 vs 8、8 vs 4） |

计数核对：P0 = 4 行（V-01…V-04）；P1 = 18 行（V-05…V-22）；P2 = 5 行（V-23…V-27）；
合计 27 行。**没有 19 个 P1**；V-23/24/25/26 是 P2。

## 2. D 波跟进（D1–D10）

| 行 | 状态 | 证据 / 边界 |
|---|---|---|
| D1 | 关闭（已测边界） | `evidence/FixD1D6.md`；`test/dashboard-host-boundary.test.js` 9/9。密码保护的远程部署未被断言匿名可达。 |
| D2 | 关闭 | `evidence/FixD2D3D4D5.md`；`test/structured-output-schema.test.js` 12/12。 |
| D3 | 关闭 | 同上；`test/cascade-native-history-delta.test.js` 4/4。 |
| D4 | 关闭（= V-27） | 同上；`test/cache-replay-usage-accounting.test.js` 3/3。 |
| D5 | 关闭 | 同上；`test/cascade-generator-offset.test.js` 5/5。 |
| D6 | 关闭（hermetic） | `evidence/FixD1D6.md`；真实 Docker/registry/重启/部署仍 `[UNVERIFIED]`。 |
| D7 | 关闭（G1–G4） | `evidence/FixD7.md`；`test/s2-b-grpc.test.js` 18/18（红先 7 fail）。真实 LS 兼容性 `[UNVERIFIED]`。 |
| D8 | 关闭（受控 socket） | `evidence/FixD8.md`；目标套件 179/179（红先 4+3 fail）。真实 TCP/客户端 `[UNVERIFIED]`。 |
| D9 | **仅设计，开放风险** | `evidence/D9-TRUST-DESIGN.md`；Policy T 未实现，按本版发布策略非阻塞。 |
| D10 | 关闭（指定修正） | `evidence/FixD10.md`；docs guard 47/47；README 措辞、32 个前缀外开关、P3 清理留给后续。 |

## 3. F2 / F3 关闭记录

| 行 | 红先（未修源码） | 修复后 | 证据 |
|---|---|---|---|
| F2 / B00a | `test/cascade-final-sweep-terminal.test.js` 9 tests / 4 pass / 5 fail；`idle_empty` vs `idle_done`，路由 502 在已发文本之后 | 与 F3 合计 18/18 | `src/cascade-turn.js:287-320`、`src/client.js:2046-2092,2097,561-587`；`evidence/final/FixF2F3.md` |
| F3 / B00b | `test/cascade-turn-deadline.test.js` 8 tests / 3 pass / 5 fail；120 ms 预算在 400 ms Send 后 464 ms，StartCascade 465 ms，warmup 越界，恢复 467 ms，claim 770 ms | 18/18；快 Send/重试 Send/长输出控制臂绿 | `src/client.js:1028-1052,1054-1079,1134-1155,1320-1369,1399-1403,1476-1486,1554-1592`；`src/handlers/chat.js:6854-6857,6965,8762` |
| 突变 | `test/mutations/cascade-final-sweep-deadline.json` 7 条：5 捕获 + 2 条声明等价 survivor | 全量 sweep 见 §4 | 同上 |

## 4. 认证执行记录（B01–B05）

**本节在 tag 树修订中写入实测计数与日志哈希。** 命令均在发布提交（B01）上执行，使用
`node --import ./test/setup-env.mjs`（禁止裸 `node --test`）；Windows 主机为 `dwgx`，Linux 为
`hmc`（Debian 13，12 vCPU）。日志目录 `evidence/final/logs/`（`*.log` 被 gitignore，哈希记录在本表）。

| 行 | 命令 / 环境 | 结果 | 日志 |
|---|---|---|---|
| B02 | HMC Node `v22.23.4`（`/root/node22matrix-360/node-v22.23.4-linux-x64/bin/node`）`npm run test:release` | 待 §4 修订 | 待 §4 修订 |
| B03 | `node scripts/mutation-sweep.mjs`（97 份 spec） | 待 §4 修订 | 待 §4 修订 |
| B04a | Windows `GATE_INERT_SKIP_PATHS="…" npm run gate` | 待 §4 修订 | 待 §4 修订 |
| B04b | HMC Node `v24.21.0` `npm run test:release` | 待 §4 修订 | 待 §4 修订 |
| B04c | wire：`WIRE_BASE_TREE=<clean external c60d7469> WIRE_BASE_TAG=v3.141.592655 WIRE_BASE_SHA=c60d746985f0feffe5d29ff13773f4bfbdf9aa5b node --import ./test/setup-env.mjs --test --test-reporter=tap test/wire-byte-identity.test.js` | **270/270 byte-identical，0 expected diffs，0 unexpected**（发布树预跑） | 待 §4 修订 |
| B05 | `node --import ./test/setup-env.mjs --test test/docs-consistency-guard.test.js` | 待 §4 修订 | 待 §4 修订 |

## 5. 残差与 `[UNVERIFIED]` 边界

以下不是「已认证」，不得在发布说明或部署验收中写成已完成：

- **真实上游 / 真实 LS**：没有用真实付费账号、真实 LS gRPC 或真实 Claude/Codex/Devin 客户端
  复验 V/D 波与 F2/F3；Cascade live 矩阵仍 `[UNVERIFIED]`。
- **真实 Docker / 部署 / 回滚**：D6 是 fake Docker/git；没有 registry pull、daemon recreate、
  真实重启或生产部署。生产 `:18999` 未作为测试目标；B07 的备份/部署/回滚演练未执行。
- **D9**：Policy T 仅设计；OTA/镜像/banner 的签名与信任链未实现，按当前策略接受风险。
- **P3 清理**：`DIRECTION.md` 明确延后；README 模型计数/双 API 表述、63 个死 i18n key、
  32 个前缀外 env switch 等是已知文档债。
- **Node 下限**：只跑 22.23.4 与 24.21.0；`>=22.13.0` floor 本身未实测。
- **托管 CI / 发布产物**：tag、release workflow、cosign/资产核验（B06）与生产部署（B07）
  必须在 tag 后另行执行；本附录不代表它们已经发生。

## 6. 台账对账

`evidence/ACCEPTANCE-20261026.md` 与 `evidence/REQUIREMENTS-LEDGER.md` 中以下旧陈述已被本附录
取代，并在同一认证提交中加了日期化对账标记：V-27「未修」；V-10/V-13/V-08/D1 的开放边界；
「96-spec mutation sweep pending」；「master 2598299e / 3.141.592656 不存在」的版本真相。
历史报告保留原文，但不得再把它们当作当前状态引用。
