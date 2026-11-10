# pi-mono v1.5.0 → v1.5.1 升级实施记录

## 版本信息

| 项目     | 内容                                                                      |
| -------- | ------------------------------------------------------------------------- |
| 日期     | 2026-11-10                                                                |
| 上游仓库 | [pi](https://github.com/earendil-works/pi)                                |
| 源版本   | v1.5.0                                                                    |
| 目标版本 | v1.5.1 (commit `dd30101cf`, release tag `v1.5.1`)                         |
| 升级难度 | **低** — 单 commit 发布，补丁文件只有 `ai/types.ts` 与 bedrock 被上游改动 |

## 上游变更概要

tag diff 显示 2472 文件 / +265131 −32570，但其中绝大部分是**我们不 vendor 的新包**：
`packages/chord`（1024 文件）、`apps/p2`（884）、`packages/coding-agent`（174）、
`packages/durable`、`packages/env`、`packages/tui`、`apps/p3`。实际涉及的 vendored 包为
**150 文件 / +6991 −472**：

- **pi-ai**（204 → 211 个 .ts）
  - `StreamOptions.disableContinuation?: boolean`（重放/cache warming 不污染会话服务端续接状态），
    `KnownProvider` 新增 `qwen-token-plan-individual-cn`（配套新 provider 与 models 数据）。
  - 新增 `cache-warming.ts`、`api/strict-tool-limits.ts`、`lazy-bedrock-provider.ts`、`lazy-oauth.ts`；
    `index.ts` 只是追加 `export * from "./cache-warming.ts"`（无删除导出）。
  - **strict tool limits**：按 `options.sessionId` 记录是否已触发上限，
    `api/bedrock-converse-stream.ts` 用 `hasExceededStrictToolLimits` / `markStrictToolLimitsExceeded`
    来关闭 preferred strict tools。
  - 重试：`RETRYABLE_PROVIDER_ERROR_PATTERN` 增加 `"cut short after the reply had begun"`
    （Magpie 网关转发的 Anthropic 断流）。
  - 其余为 anthropic / azure / openai-completions / openai-responses / google / mistral 的实现修正。
- **pi-agent-core**：仅 `src/proxy.ts` 改动；`agent-loop.ts` / `agent.ts` / `types.ts` **上游零变更**。
- **pi-mcp**（18 → 28 个 .ts）—— 结构性重构，但**全部为追加式**：
  - 新增 `config.ts`、`input-schema.ts`、`naming.ts`、`output-limit.ts`、
    `transports/{lines,pipe}.ts`、`oauth/{auth-provider,client-settings,loopback,sign-in}.ts`。
  - `transports/stdio.ts` 的 stdout/stderr 缓冲重写为 `JsonRpcLineReader`（`transports/lines.ts`），
    并把进程组清理从 `exit` 改到 `close`（子进程可能比服务端活得久、仍持有管道）。
  - `index.ts` 只新增导出；`package.json` 仅版本号 + `LICENSES` → `THIRD_PARTY_NOTICES` 目录改名。
  - **没有删除或重命名任何既有导出**，因此 app 侧零适配。
- **pi-schema**：仅 `LICENSES` 改名 + 新增 `test/equal.test.ts`，运行时零改动。
- **pi-telemetry**：测试与少量内部实现改动。

## 升级步骤（实际执行）

1. **三方合并**（base v1.5.0 / ours HEAD / theirs v1.5.1，先经 `/tmp/norm.sed` 归一化）：

   | 文件                                | 上游改动                                   | 合并结果                                                             |
   | ----------------------------------- | ------------------------------------------ | -------------------------------------------------------------------- |
   | `ai/types.ts`                       | +8（provider 枚举、`disableContinuation`） | **0 冲突**；我们的 2 处标记（`onStreamRetry`、工具循环守卫字段）完好 |
   | `ai/api/bedrock-converse-stream.ts` | strict-tool-limits 接入                    | **0 冲突**；我们的 2 处 `middlewareStack.add(... as any)` 完好       |
   | `agent/agent-loop.ts`               | 无                                         | 直接保留 HEAD（23 标记）                                             |
   | `agent/agent.ts`                    | 无                                         | 保留 HEAD（6 标记）                                                  |
   | `agent/types.ts`                    | 无                                         | 保留 HEAD（5 标记）                                                  |
   | `ai/compat.ts`                      | 无                                         | 保留 HEAD（1 标记）                                                  |

   合并后把相对导入的 `.js` 后缀补回（`sed -E 's|(from "\.[^"]*)(")|\1.js\2|g'`）。

2. **aisync 整树**：`ai` 210 文件（`ai/utils/oauth` 为 first-party，跳过）、`agent` 6、`mcp` 28、
   `telemetry` 8、`schema` 43；**removed: none**（本次上游没有删文件）。
3. **import 归一化**：`grep -rnoE '"[.][.]?/[^"]*\.ts"' src/pi-mono --include="*.ts" | wc -l`
   `975 → 0`，`.js.js` 0。归一化会覆盖 `api/bedrock-converse-stream.lazy.ts`、`auth/oauth/load.ts`、
   `images.ts` 三处（v1.5.0 修过的副作用导入 / 包装器实参），本次由 sed 统一重做。
   注意 `/tmp/norm.sed` 只处理 `from "…"` 与 `import("…")`，**不覆盖**副作用导入与包装器实参，
   所以归一化 diff 里这三个文件仍会以 `.js` vs `.ts` 的形式出现 —— 属于预期噪声；
   真正的闸门是上面的计数 0 **加** `node dist/src/index.js` 实机启动。
4. `src/pi-mono/VERSION` → `v1.5.1` / `pi-mcp v1.5.1 (embedded, no local patches)`。
5. `providers/data` 从 npm `@earendil-works/pi-ai@1.5.1` 重同步：**42 → 43** 个 JSON
   （新增 `qwen-token-plan-individual-cn.json`），`.manifest.json` 一并更新。

## app 侧适配

**零改动**。pi-mcp 的新增导出没有被使用（先用上游默认行为），`AgentTool` / schema 类型未变，
`disableContinuation` 是可选字段。

## 验证

- **归一化 diff**（vendored vs 上游 v1.5.1）：`mcp` / `telemetry` / `schema` **逐字节一致**；
  `ai` 仅 bedrock（`as any` + strict-tool-limits 合并）、`compat.ts`、`types.ts`、
  `api/bedrock-converse-stream.lazy.ts` / `auth/oauth/load.ts` / `images.ts`（`.js` 归一化）、
  vendored-only `providers/data`、first-party `utils/oauth`；`agent` 仅 3 个补丁文件。
- `grep -rc "OhMyAgent"`：**5 文件 / 37 标记**（agent-loop 23、agent 6、agent/types 5、
  ai/types 2、ai/compat 1）—— 与 `docs/PI_MONO_LOCAL_PATCHES.md` 清单一致。
- `npx tsc --noEmit` / `tsconfig.test.json` / `tsconfig.scripts.json` / `ui/tsconfig.json`：**0 错误**。
- **判断内核 + MCP 专项**：36 文件 / **547** 测试通过。
- `pnpm test` 全量：**348 文件 / 5028 测试通过**（5037 含 skip）。
- `pnpm lint` 0 errors（571 warnings）；`pnpm format:check` 通过。
- `pnpm build` 成功；`dist/src/pi-mono/schema/index.js`、`ai/cache-warming.js` 齐备，
  dist 内 `importNodeOnlyApi("./bedrock-converse-stream.js")` 已是 `.js`。
- **dist 实机启动**（`OHMYAGENT_PORT=9195 node dist/src/index.js`）：`/api/health` ok，
  无 `ERR_MODULE_NOT_FOUND`；`POST /api/judge/test` **`ok:true, latencyMs:1896`**。
- **dev (tsx) 实机**：`/api/health` `{"ok":true,"version":"5.0.1"}`；
  `POST /api/judge/test` **`ok:true, latencyMs:1435`**，judgeId `CommandCode-Jev`，
  q1 choice→`code`（p=1）、q2 noul（p=0.98）、q3 score 0.11（c=0.85）—— 三类金样本全对。

## 备注

- v1.5.1 的发布说明强调的新能力（`disableContinuation`、cache warming、strict tool limits）
  都是上游内部/可选功能，本项目暂不主动使用；已随 vendored 树可用。
- pi-mcp 的 `pipe` 传输与新 OAuth 工具函数为后续 MCP 能力（进程内管道、独立登录流程）留了接口，
  但 `src/mcp/` 现有实现无需迁移。
