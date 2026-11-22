# pi-mono v1.5.2 → v1.6.0 升级实施记录

## 版本信息

| 项目     | 内容                                                                           |
| -------- | ------------------------------------------------------------------------------ |
| 日期     | 2026-11-21                                                                     |
| 上游仓库 | [pi](https://github.com/earendil-works/pi)                                     |
| 源版本   | v1.5.2                                                                         |
| 目标版本 | v1.6.0 (commit `faac58588`)                                                    |
| 升级难度 | **中** — 首个需要**升级 npm 依赖**的版本；`agent-loop.ts` 上游有改动需三方合并 |

## 上游变更概要

vendored 包 81 文件 / +1663 −484，其中源码 20 个文件。要点：

- **pi-ai**
  - 新模型：GPT-6.2 Astra / Sol（OpenAI、Azure、Codex，含官方定价与长上下文档位）、
    `qwen4-max-preview`、`deepseek-v4.1-flash`；Qwen Token Plan 换新网关，新增按套餐的 API key 环境变量。
  - Google 适配器支持自定义 `fetch`；升级 `@google/genai` 后关闭其自动续接（收到 `CONTINUATION`
    以 `length` 结束回合）。
  - OpenAI Responses / Azure / Codex 新增 `openai_input_transformations` 诊断（重放时被 API 丢弃的
    reasoning 项及原因）。
  - **Anthropic message threads 默认放宽**：任何 baseUrl 位于 `api.anthropic.com` 的 provider（不再限定
    provider === `anthropic`）。
  - **`openai-completions` 的 `developer` 角色只发给 `api.openai.com`**，其余主机（含 Azure、OpenRouter）
    改发 `system`；`compat.supportsDeveloperRole` 可覆盖。
  - **重试增强**（对网关有实际价值）：裸 socket 错误码 `ECONNRESET`/`ECONNABORTED`/`ECONNREFUSED`/
    `ETIMEDOUT`/`EPIPE`、`connection reset by peer`、`Connection closed.`、
    Codex WebSocket 60 分钟连接上限。
  - Codex：`maxTokens` 现在发 `max_output_tokens`；GPT-6.2 系统提示改走首个 `developer` 输入项以修复
    提示缓存；思考档位变化改为 `configuration_update` 输入项。
  - 修复 strict constrained sampling 对无 `type` 节点的误用；修复 Anthropic 非 strict 工具 schema 丢掉
    根 `additionalProperties`；Mistral Large 4 不再收到 strict 工具。
  - 移除未使用的 `mapStopReasonString` 导出（`api/google-shared`）。
- **pi-agent-core**：只改 `agent-loop.ts` —— abort 语义收敛（#9986）：`prepareToolCall`、`runToolCall`
  **先检查 `signal.aborted`**，直接返回 "Operation aborted" 错误结果，且不再在批量执行循环里 `break`，
  保证每个工具调用都有结果行。
- **pi-mcp**：新增 `mcpServerSummary(description, instructions)`（系统提示用的一行摘要，追加式导出）。
- **pi-schema / pi-telemetry**：仅版本号与 CHANGELOG。

## 升级步骤（实际执行）

1. **三方合并 `agent/agent-loop.ts`**（base v1.5.2 / ours HEAD / theirs v1.6.0）：**0 冲突**，
   合并后 23 个标记完好；上游的 abort 语义与我们的工具循环守卫/粘性 fallback 结构共存。
2. **aisync 整树**：`ai` 210 / `agent` 6 / `mcp` 28 / `telemetry` 8 / `schema` 43，removed: none。
3. **恢复 5 个补丁文件**（上游本次只改了 `agent-loop.ts`，已用合并结果；其余从 HEAD 取回）：
   `agent/agent.ts`、`agent/types.ts`、`ai/compat.ts`、`ai/types.ts`、`ai/api/bedrock-converse-stream.ts`
   （含 2 处 `as any`）。
4. **import 归一化**：`975 → 0`，`.js.js` 0。
   本次新增一个坑：`agent-loop.ts` 里有一处**动态 import 的 type 位置**
   `import("../ai/utils/event-stream").AssistantMessageEventStream`，归一化把它变成无扩展名后
   `tsc` 报 TS2835，并**连锁**出 5 条 `AssistantMessage | null` 不匹配的假错误
   （类型解析失败 → `event` 退化为 `any` → 无法收窄 `partialMessage`）。
   归一化/恢复时要把 `import("…")` 一并补 `.js`，不要只处理 `from "…"`。
5. **npm 依赖升级**（`package.json` + `pnpm-lock.yaml`）：

   | 包              | 旧      | 新          | 原因                                                                       |
   | --------------- | ------- | ----------- | -------------------------------------------------------------------------- |
   | `openai`        | 7.19.0  | **7.59.0**  | `openai-responses-shared` 使用 `Response.input_transformations`（新类型）  |
   | `@google/genai` | ^2.21.0 | **^2.32.0** | `GenerateContentConfig.automaticContinuation`、`FinishReason.CONTINUATION` |

   `@anthropic-ai/sdk ^0.129.0`、`@aws-sdk/client-bedrock-runtime ^3.1127.0`、
   `@smithy/node-http-handler ^4.12.1`、`partial-json ^0.1.7` 已满足上游要求，未动。

6. `src/pi-mono/VERSION` → `v1.6.0` / `pi-mcp v1.6.0`。
7. `providers/data` 从 npm `@earendil-works/pi-ai@1.6.0` 重同步（44 个文件；33 个内容变化）。

## app 侧适配

代码零改动，**但需要依赖升级**（见步骤 5）——这是本系列升级里第一次 app 侧必须动 `package.json`。
理由：上游 1.6.0 的 provider 适配器直接使用新版 SDK 的类型/字段，旧版本会在 `tsc` 阶段报错，
运行时也可能发不出新字段。

行为层面的三处变化对我们是正面的、无需配置：

- 重试覆盖面变宽（socket 错误码/连接关闭/WebSocket 上限）→ 网关断流恢复更稳；
- `openai-completions` 非 `api.openai.com` 主机改发 `system` 角色 → 对 opencode/commandcode 等中继更兼容；
- Anthropic threads 只对 `api.anthropic.com` 生效，我们的 opencode 固定域名不受影响。

`mcpServerSummary` 暂不使用：`src/mcp/` 已有自己的服务器描述与系统提示拼装。

## 验证

- **归一化 diff**（vendored vs 上游）：`mcp` / `telemetry` / `schema` **逐字节一致**；
  `ai` 仅 bedrock（`as any`）/ `compat.ts` / `types.ts` / 三个纯 `.js` 归一化文件 /
  `providers/data` / `utils/oauth`；`agent` 仅 3 个补丁文件。
- 标记：**5 文件 / 37 标记**（agent-loop 23、agent 6、agent/types 5、ai/types 2、ai/compat 1）。
- tsc（src / tests / scripts / ui）：**0 错误**（依赖升级前有 10 个错误，全部来自旧 SDK 类型）。
- **judge + mcp + agent 专项**：67 文件 / **1061** 测试通过。
- `pnpm test` 全量：**348 文件 / 5028 测试通过**（5037 含 skip）。
- `pnpm lint` 0 errors（571 warnings）；`pnpm format:check` 通过。
- `pnpm build` 成功；**dist 实机**：health ok、无 `ERR_MODULE_NOT_FOUND`、
  `POST /api/judge/test` **`ok:true, latencyMs:3909`**。
- **dev 实机**：health `5.0.1`；judge **`ok:true, latencyMs:4852`**，`CommandCode-Jev`，
  q1 p=1 / q2 0.98 / q3 0.10（c=0.85）—— 三类金样本全对。

## 备注

- GitHub 到本机的连接仍有间歇性 TLS 失败；`clone` / `fetch` 均靠重试循环完成。
  本次校验点：`v1.6.0 = faac585884ae2c013a6b1400f3e9e77f10b34bac`。
- 升级后 judge 延迟比 1.5.2（约 2.2s）高，属于上游远端波动，`ok:true` 与三类金样本均正常。
