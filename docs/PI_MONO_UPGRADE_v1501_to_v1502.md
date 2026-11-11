# pi-mono v1.5.1 → v1.5.2 升级实施记录

## 版本信息

| 项目     | 内容                                                                               |
| -------- | ---------------------------------------------------------------------------------- |
| 日期     | 2026-11-11                                                                         |
| 上游仓库 | [pi](https://github.com/earendil-works/pi)                                         |
| 源版本   | v1.5.1                                                                             |
| 目标版本 | v1.5.2 (commit `b4afdddf4`, release tag `v1.5.2`)                                  |
| 升级难度 | **极低** — vendored 包内只有 **2 行源码改动**；其余是未 vendor 的 `packages/chord` |

## 上游变更概要

tag diff 里实际与 vendored 包相关的只有 12 个文件 / +25 −11，其中源码 **2 行**：

| 文件                                        | 改动                                                                                               |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `packages/ai/src/api/anthropic-messages.ts` | `claudeCodeVersion` `2.1.280` → **`2.1.322`**（stealth 模式伪装 Claude Code 的 user-agent 版本号） |
| `packages/ai/src/utils/version.ts`          | `PI_AI_VERSION` → `1.5.2`                                                                          |

其余为各包 `package.json` 版本号与 `CHANGELOG.md`。`packages/chord` 有大量改动（`keyed` 成员
的 rekey 语义、`HostKeyed`/`KeyOfMember` 类型等），但该项目**不 vendor**，与 OhMyAgent 无关。

**模型数据有实质更新**：`providers/data` 的 `opencode.json`（+701B）、`radius.json`（+647B）、
`meta.json`（+637B）内容变化，`.manifest.json` 的 `generatedAt`/`structureHash` 全部更新。

## 升级步骤（实际执行）

1. **aisync 整树**：`ai` 210 / `agent` 6 / `mcp` 28 / `telemetry` 8 / `schema` 43，removed: none。
2. **恢复 5 个补丁文件**。上游本次未改其中任何一个，直接从 HEAD 取回：

   ```bash
   git checkout -- src/pi-mono/agent/agent-loop.ts src/pi-mono/agent/agent.ts \
     src/pi-mono/agent/types.ts src/pi-mono/ai/compat.ts \
     src/pi-mono/ai/types.ts src/pi-mono/ai/api/bedrock-converse-stream.ts
   ```

   **踩坑**：`ai/types.ts` 与 `ai/api/bedrock-converse-stream.ts` 也是补丁文件，容易被漏掉
   （第一次只恢复了 4 个，标记数从 37 掉到 35）。**标记计数闸门就是为这种漏恢复准备的**：

   ```bash
   grep -rho "OhMyAgent" src/pi-mono --include="*.ts" | wc -l   # 必须 37
   ```

3. import 归一化：`grep -rnoE '"[.][.]?/[^"]*\.ts"' src/pi-mono --include="*.ts" | wc -l` `1010 → 0`，
   `.js.js` 0。
4. `src/pi-mono/VERSION` → `v1.5.2` / `pi-mcp v1.5.2 (embedded, no local patches)`。
5. `providers/data` 从 npm `@earendil-works/pi-ai@1.5.2` 重同步（44 个文件：43 JSON + `.manifest.json`）。

## app 侧适配

**零改动**。v1.5.1 的「新增能力核对」结论原样成立（见 `docs/PI_MONO_UPGRADE_v1500_to_v1501.md`），
本次没有任何新增能力或 API 变化。

## 验证

- **归一化 diff**（vendored vs 上游 v1.5.2）：`mcp` / `telemetry` / `schema` **逐字节一致**；
  `ai` 仅 bedrock / `compat.ts` / `types.ts` / 三个纯 `.js` 归一化文件 / `providers/data` /
  `utils/oauth`；`agent` 仅 3 个补丁文件。
- `grep -rc "OhMyAgent"`：**5 文件 / 37 标记**（agent-loop 23、agent 6、agent/types 5、
  ai/types 2、ai/compat 1）。
- tsc（src / tests / scripts / ui）：**0 错误**。
- **判断内核 + MCP 专项**：36 文件 / **547** 测试通过。
- `pnpm test` 全量：**348 文件 / 5028 测试通过**（5037 含 skip）。
- `pnpm lint` 0 errors（571 warnings）；`pnpm format:check` 通过。
- `pnpm build` 成功；产物中 `claudeCodeVersion = "2.1.322"`、`PI_AI_VERSION = "1.5.2"`。
- **dist 实机**：`/api/health` ok，无 `ERR_MODULE_NOT_FOUND`；
  `POST /api/judge/test` **`ok:true, latencyMs:3161`**。
- **dev 实机**：`/api/health` `5.0.1`；`POST /api/judge/test` **`ok:true, latencyMs:2240`**，
  judgeId `CommandCode-Jev`，q1 p=1 / q2 0.98 / q3 0.09（c=0.85）—— 三类金样本全对。

## 备注

- 本次拉取遇到 GitHub 到本机的间歇性 TLS 失败（`SSL routines::unexpected eof` /
  `Recv failure: Connection was reset`）。`ls-remote` 与 `fetch` 都靠重试循环成功；
  拉取后 `git rev-parse v1.5.2` 应为 `b4afdddf44e059c67ccf5097e5317d913521b470`。
- 该版本没有新增/删除任何 vendored 文件，也没有 `providers/data` 之外的数据变化。
