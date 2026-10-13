# pi-mono v1.1.0 → v1.2.0 升级实施记录

## 版本信息

| 项目     | 内容                                                                    |
| -------- | ----------------------------------------------------------------------- |
| 日期     | 2026-10-13                                                              |
| 上游仓库 | [pi](https://github.com/earendil-works/pi)                              |
| 源版本   | v1.1.0                                                                  |
| 目标版本 | v1.2.0 (2026-10, commit `06a46693`)                                     |
| 升级难度 | **低** — agent 零变更；ai 10 个文件 + mcp 6 个文件；仅 1 个三方合并文件 |

## 上游变更概要（与本 vendored fork 相关）

- **ai — types.ts 大重构**：compat/thinking 相关类型（`ThinkingLevel*`、
  `ChatTemplateKwargValue`、`ThinkingTokenBudgetField`、各 provider `*Compat`）
  拆出到新文件 `providers/compat-schema.ts` + `providers/model-schema.ts`，
  types.ts 里 re-export 保持兼容（-388 行，但 `SimpleStreamOptions`
  —— 我们 `onStreamRetry` 补丁的挂点 —— 留在原地）。
- **ai — 新增**：`providers/compat-schema.ts`（629 行新文件）、
  `providers/model-schema.ts`、OpenRouter 用户模型接口（`openrouter-api.ts`）、
  `.lazy.ts` 惰性加载文件（anthropic-messages / azure-openai-responses /
  bedrock-converse-stream）。
- **ai — 修复**："The upstream provider returned an error" 可重试（`utils/retry.ts`）；
  Anthropic strict tool limits 失败时回落（`anthropic-messages.ts`，±115 行）。
- **mcp**：工具 `structuredContent` 接受任意 JSON 值；被取消的 HTTP 请求
  在授权刷新后不再重试（`streamable-http.ts`）；OAuth errors/flow 小改。
- **telemetry**：仅 CHANGELOG + package.json 版本。
- **agent**：**零变更** —— 5 个补丁文件无需任何合并工作，直接从 HEAD 还原。

## 升级步骤（实际执行）

1. **三方合并 1 个文件**：`ai/types.ts`（ours = v1.1.0+`onStreamRetry` 补丁，
   base = v1.1.0，theirs = v1.2.0）→ `git merge-file` **0 冲突**；归一化 diff
   校验 ours 侧仅多出 23 行 OhMyAgent 扩展块，theirs 侧零遗漏。
2. aisync 整树替换 ai(200 文件)/agent(6)/mcp(18)/telemetry(6)，
   删除零项；从 HEAD 还原 agent 4 个补丁文件 + `ai/compat.ts`。
3. **import 归一化**（本次踩到的 v1.2.0 新坑）：
   - 静态/`.lazy.ts` 里 `import("./x.ts")` **动态 import** 也必须转 `.js`
     （tsc 管线 dist 无 `.ts` 文件，运行时会挂）——本次补了
     `importNodeOnlyApi` / `importOAuthModule` 参数的转换；
   - 顶层 `import(".../openrouter-images.ts").then(...)` 同理。
4. **bedrock `as any` 补丁重新落上**：aisync 用上游副本盖掉了 committed 版本，
   2 处 `middlewareStack.add(middleware as any, ...)` 重打。
5. 删除无主 0 行文件 `src/pi-mono/ai/xai.ts`（未 tracked、无引用，历史遗留）；
   `ai/utils/oauth/`（第一方 legacy OAuth 兼容层，被 aisync 排除）保留。
6. `providers/data` 从 npm tarball `@earendil-works/pi-ai@1.2.0`
   重同步（42 JSON + manifest；`azure-openai-responses.json` 移除与 slug 改名收尾一致）。

## app 侧适配

- **0 处** —— `SimpleStreamOptions` 与 classifier 共享层接口未变，
  `src/judge/protocol-map.ts` 等 business 代码无需改动。

## 验证

- 归一化 diff：仅 agent 4 补丁文件 + `ai/compat.ts` + `ai/types.ts` 差异（预期）；
  `mcp` / `telemetry` 与上游逐字节一致；27 处 `OhMyAgent` 标记齐全。
- `npx tsc --noEmit` 0 错误。
- **判断内核专项 `vitest run tests/judge`：25 文件 / 303 测试通过**（较 v1.1.0
  +1 文件/+16 测试，来自团队新增），含全部 7 个 provider contract 测试。
- `pnpm test` 全量 **276 文件 / 4128 测试通过**（4137 含 skip）。
- `eslint` 0 errors；`pnpm typecheck:tests` 通过；`format:check` 通过。
- dev server 重启后 `/api/health` ok（version 4.3.0-beta1）。

## 判断内核实弹（远端故障插曲）

`POST /api/judge/test` 首测回退 `judge fallback (unavailable)`；直连探测
`https://opencode.ai/zen/v1/systemone` 确认是 **opencode 服务端 500 故障**
（"Upstream request failed: Endpoint is unavailable"，~11s 响应 > 项目
`judge.timeout_ms=4000`），与升级无关（同 key、同 wire 的匿名请求同错）。
内核的 **fail-closed 语义按设计工作**：4s 超时 → `source: "fallback"`、
`fallbackReason: "unavailable"`、ledger 留痕、不阻塞业务。
待远端恢复后重测即回 `source: "judge"`。

## 遗留 / 注意

- 今后升级如遇 **动态 import 字符串带 .ts 后缀**（lazy / wrapper 参数），
  需与静态 import 一并转换。
- `pnpm build` 后 dist 侧无需处理 lazy 文件（tsc emit 产出 `.js`）。
