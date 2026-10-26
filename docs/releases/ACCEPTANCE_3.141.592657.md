# 3.141.592657 验收附录（2026-10-26）

本附录是 `3.141.592657` 的认证记录，与
[`RELEASE_NOTES_3.141.592657.md`](RELEASE_NOTES_3.141.592657.md) 一起构成唯一的不可变验收记录。
它记录 D9 三条供应链控制与 F3 截止边界修复的发布提交、B01–B05 的实测命令、计数、skip 名单与
日志哈希，以及 B06/B07 的发布与部署结果。

- 发布版本：**3.141.592657**
- 发布提交（B01）：**[PENDING — filled at certification commit]**
- 上一个已发布 tag：`v3.141.592656` → `9115ebe7183f9460df8fcce8520a0365f856ba9f`。
- 源码基线：`f6b843fe`（master，D9 三支与 deadline flake 修复已合入）。
- 发布范围：16 个提交 / 43 个文件（`git rev-list --count v3.141.592656..HEAD`；
  `git diff --shortstat v3.141.592656..HEAD` = 4,057 增 / 216 删）。

## 1. D9 供应链控制（本版落地）

| 控制 | 实现 | 证明测试 / 边界 |
|---|---|---|
| BannerLock | `repo-kit.lock.json` 固定 `dwgx/DWGX` commit `0b44ea0168cf04654683812d6d3d7e64e5f3acf8` + 四文件 sha256；`scripts/fetch-repokit.mjs` 在 import 前逐文件校验并失败关闭；`banner.yml` 不再 fetch `main`；42 个 `uses:` 钉 SHA | `test/banner-workflow-pins.test.js`；`evidence/final/BannerLock.md`。锁定字节不等于代码安全，`contents: write` 保留。 |
| DockerSign | release `docker` job 按 digest 用 cosign keyless 签名并发布 `image-digest.txt` + `.sigstore.json`；dashboard Docker OTA 解析 tag→digest、要求等于签名 digest、按 digest pull、校验 `RepoDigests`；`docker:24-cli` digest 固定；所有 compose `up` 加 `--no-build` | `test/docker-self-update.test.js`（48/48）、`test/docker-oneclick-update.test.js`、`test/release-workflow.test.js`、`test/release-signing.test.js`；`evidence/final/DockerSign.md`。真实 GHCR/daemon 在 B06/B07 核对。 |
| SourceAttest | release job 生成并签名 `release-attestation.json`（tag/commit/tree + 5 个资产 sha256）；`/self-update` 与 `update.sh` 在 Git mutation 前校验；默认 `warn`、`required` 可选；`WINDSURFAPI_ATTESTATION_DIR` 支持预置 | `test/release-attestation.test.js`、`test/self-update-attestation.test.js`、`test/release-workflow.test.js`。tag 触发签名不是独立审批；源码 OTA 仍信任 Owner。 |

## 2. F3 截止边界修复

| 项 | 内容 |
|---|---|
| 缺陷 | `throwIfSpent` 只在 `remainingBudgetMs() > 0` 为假时把 phase 失败转为预算停止；整数毫秒截断使最后一 tick 的 timer 触发时仍读出 1–2 ms，原始 gRPC timeout 逃逸为传输错误（账号轮换 / 502），而非 504 deadline |
| 修复 | `src/client.js:1046-1058` 引入 `DEADLINE_TOLERANCE_MS = 5`，最后 5 ms 视为已花完 |
| 红先 / 绿后 | `test/cascade-turn-deadline.test.js` 新增确定性 arm：墙钟 cap 到 `budget-1`，未修代码以 CI 同款 `gRPC unary timeout` 失败，修复后 `upstream_deadline_exceeded`、无 Send、无 step 读取 |
| 突变 | `test/mutations/cascade-final-sweep-deadline.json` 重钉锚点并增加 tolerance-0 臂 |

## 3. 认证执行记录（B01–B05）

**本节记录实测计数与日志哈希。** 命令均在发布提交（B01）上执行，使用
`node --import ./test/setup-env.mjs`（禁止裸 `node --test`）；Windows 主机为 `dwgx`，Linux 为
`hmc`（Debian 13，12 vCPU）。日志目录 `evidence/final/logs/`（`*.log` 被 gitignore，哈希记录在本表）。

| 行 | 命令 / 环境 | 结果 | 日志 |
|---|---|---|---|
| B02 | HMC Node `v22.23.4`（`/root/node22matrix-360/node-v22.23.4-linux-x64/bin/node`）`npm run test:release` | [PENDING] | [PENDING] |
| B03 | `node scripts/mutation-sweep.mjs`（97 份 spec，HMC，Node `v24.21.0`） | [PENDING] | [PENDING] |
| B04a | Windows `GATE_INERT_SKIP_PATHS="test/wire-byte-identity.test.js;test/devin-connect-relogin-live.test.js;test/mutate-verify-harness.test.js;test/self-update-untracked-safety.test.js;test/detach-soak.test.js;test/detach-ls-pool-pressure.test.js" npm run gate` | [PENDING] | [PENDING] |
| B04b | HMC Node `v24.21.0` `npm run test:release` | [PENDING] | [PENDING] |
| B04c | wire：`WIRE_BASE_TREE=/opt/windsurf-wire-base-9115ebe7 WIRE_BASE_TAG=v3.141.592656 WIRE_BASE_SHA=9115ebe7183f9460df8fcce8520a0365f856ba9f WIRE_BASE_REQUIRED=1 node --import ./test/setup-env.mjs --test --test-reporter=tap test/wire-byte-identity.test.js` | [PENDING] | [PENDING] |
| B05 | `node --import ./test/setup-env.mjs --test test/docs-consistency-guard.test.js` | [PENDING] | [PENDING] |

## 4. 发布与部署记录（B06–B07）

| 行 | 内容 | 结果 |
|---|---|---|
| B06 | annotated tag `v3.141.592657` → 发布提交；push master + tag；release workflow；资产 14 个；cosign 验签 | [PENDING] |
| B07 | HMC `/opt/windsurf-api` 部署、时间戳备份、stage/prod smoke、rollback drill | [PENDING] |

## 5. 残差与 `[UNVERIFIED]` 边界

以下不是「已认证」，不得在发布说明或部署验收中写成已完成：

- **D9 不是全部关闭**：源码 OTA 与所有 release 签名最终仍信任单个 Owner 的 tag/账号权限；tag
  触发的 cosign 不是独立审批。`WINDSURFAPI_UPDATE_ATTESTATION=warn` 是默认值，老安装可在没有
  attestation 时继续升级。`deploy/update.sh` 的 Docker 路径仍按 tag/镜像引用更新，不在 dashboard
  的 digest gate 内。
- **Docker 实网签名**：hermetic 测试覆盖逻辑；真实 GHCR push、cosign 签名、daemon digest 校验与
  rollback 由 B06/B07 记录，不在 B02–B05 的认证内。
- **真实上游 / 真实 LS / 真实客户端**：没有用真实付费账号、真实 LS gRPC 或真实 Claude/Codex/
  Devin 客户端复验；Cascade live 矩阵仍 `[UNVERIFIED]`。
- **真实 Docker / 部署 / 回滚**：D6 是 fake Docker/git；B07 只覆盖 HMC 源码树部署，不覆盖 Docker
  registry pull / daemon recreate / Docker rollback。
- **P3 清理**：`DIRECTION.md` 明确延后；README 模型计数/双 API 表述、63 个死 i18n key、32 个
  前缀外 env switch 等仍是已知文档债。
- **Node 下限**：只跑 22.23.4 与 24.21.0；`>=22.13.0` floor 本身未实测。
- **托管 CI / 发布产物**：B06/B07 必须另行执行；本附录在 B01–B05 阶段不代表它们已经发生。
