# v3.10.0

大版本：**detached cache P1（默认关）+ 四个 P2 修复**、**账号页 P2**、**SEC 三项**、**#245**、**smoke 137 flows**、**真实 Docker one-click E2E**。没有协议兼容性破坏。

## detached cache P1（`WINDSURFAPI_CASCADE_DETACH=1`，默认关，需 `CASCADE_TURN=1`）

- 惰性恢复：快照 v2（`generatorOffset`/`sawActive`/`usageByStep`/`consumedThrough`）、registry CAS/TTL/容量上限、请求级租约、两个计费陷阱（offset-0 过度计费、`acct === null` 少计）。
- soak（假上游、真实 handler；`DETACH_SOAK=1` 显式开启，默认套件跳过，因为 SOAK-2 真等 120s TTL）：10 次 detach/resume、120s TTL、caps、abort×3、3 次 claim 竞态、账号删除/drain，**9/9 PASS**；mutation 表 **12 caught + 1 documented equivalent**。
- Review 后的四个 P2 已修：拒绝的 admission 不再先删旧 entry；resume 租约在同步异常下释放并结束响应；resume-miss 清 `reuseEntry`；`lookup` 不驱逐 claimed entry。
- **默认关**：设计 §7.4 的 gate 1/5/6 未满足（两周计数、维护者签字、live 60s soak），go/no-go = **NO-GO**。

## 账号页 P2

- 调色板：11 个 provider 色块改主题 token（两主题 ≥3:1）；残留 accent/slate 块全部 token 化。
- 尺度：`--space-*`/`--fs-*`/`--radius-xs`，账号页/登录 modal/用量面板统一；44px 行高由 `--acct-row-pad-y` 固定。
- 服务端排序（配额/最后使用 + 余额/错误数），`aria-sort`，localStorage 记忆，翻页重置选择；`编辑名称`（PATCH label 即 email，UI 动词如实）。
- 新增 `check:ui`（scale + contrast）与 mutation 检查；582/582 相关测试、54/54 截图断言。

## SEC

- 空白 dashboard 密码在设置时拒绝（trim 后长度；存 trim 值），8 个空格不再能设成永不匹配的密码。
- Windows ACL 覆盖 `runtime-config.json`（含明文 API key）与 `proxy.json`，与 `accounts.json` 同一路径。
- nginx access log 去掉 `$http_referer`（Referer 本身可携带 `?key=`），`?key=` 文档同步纠正；`$uri`-only 测试保持。
- SEC-04/05 仍为 PARTIAL：未签名发布（只有 SHA256SUMS）、无历史 secret 扫描。

## #245

`UserStatus <ref>: teams_tier=<raw enum> mapped=<tierName> plan="<plan>"`，不改变 tier 判定。

## smoke / Docker

- smoke matrix **137 flows / 24 families**（+13）：fleet job 生命周期、KPI 划分与余额去重、ACU 有符号余额（从服务端 HTML 取格式化函数）、detach off/on、docs guard、登录步骤。
- 顺带修 `startFleetJob` 的 P1：`selectTargets(op, ids)` 参数错位导致显式选择被忽略、扫全池。
- 抽屉里的 `overageBalance` 改用 `fmtCreditBalance`（`-$0.10`，不再 `$-0.1000`）。
- **真实 Docker 29.8.2 E2E**（独立项目/端口）：首次 build、pull→up→health、坏镜像自动回滚、无 `down -v`/`volume rm`，4/4 PASS；生产 18999 未动。

## 工程与门禁

- 合入分支：`fix/sec-310` `1dae047`、`fix/ui-p2` `b0c2b27`、`test/detach-soak-patches` `6a2e40c`、`test/smoke-expand` `2715b61`、`fix/detach-p2` `5cd6271`。
- Windows/Linux/gate/mutation/wire：见发布提交与 CI。

## 尚未验证

- `[UNVERIFIED]` detach 默认开启（NO-GO 未变）；真实 Cascade 上游 resume。
- `[UNVERIFIED]` 真实 Enterprise 的 `teams_tier`；签名发布（cosign/minisign）与历史 secret 扫描。
