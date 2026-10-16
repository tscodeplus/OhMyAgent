# pi-mono v1.2.0 → v1.3.0 升级实施记录

## 版本信息

| 项目     | 内容                                                                             |
| -------- | -------------------------------------------------------------------------------- |
| 日期     | 2026-10-16                                                                       |
| 上游仓库 | [pi](https://github.com/earendil-works/pi)                                       |
| 源版本   | v1.2.0                                                                           |
| 目标版本 | v1.3.0 (commit `71023aec`)                                                       |
| 升级难度 | **低** — agent / mcp / telemetry 均**零变更**；ai 17 个文件，仅 1 个三方合并文件 |

## 上游变更概要（与本 vendored fork 相关）

- **ai**：Anthropic/Bedrock Claude 保留 error tool result 的图片；非 Claude
  模型丢弃 thinking（改为以文本发送的回归修复）；Claude Haiku 5.5 / Opus 5
  支持 `off` thinking level；"The service is temporarily unavailable" 可重试
  （`utils/retry.ts`）；malformed final tool-call 参数报错而非保留前缀
  （`json-parse.ts`）；kimi-coding 回到 Chat Completions；Codex GPT-6.1 Sol
  500K 上下文；Xiaomi MiMo thinking on/off 开关；**删除未用的
  `utils/assistant-message-frame.ts`（-490 行）**；`utils/validation.ts` 增强校验。
- **agent / mcp / telemetry**：零变更。
- **providers/data**：catalog 更新（opencode 免费模型 `jev-1.13-free.baseUrl`
  改为 `https://opencode.ai/inference/v1`，zen v1 路径退役为 inference 路径）。

## 升级步骤（实际执行）

1. **三方合并 1 个文件**：`ai/types.ts`（+5 行上游 delta）→ 0 冲突；ours 侧
   保持 23 行 OhMyAgent 扩展块，theirs 侧零遗漏。
2. aisync 整树替换 ai(199 文件，删除已退役的 `utils/assistant-message-frame.ts`)
   / agent(6)；from HEAD 还原 agent 4 个补丁文件 + `ai/compat.ts`。
3. import 归一化（静态 + **动态 `import("./x.ts")`**，v1.2.0 就踩过）。
4. bedrock `middlewareStack.add` 两处 `as any` 重打（aisync 覆盖问题，
   与 v1.2.0 相同的手工步骤）。
5. `providers/data` 从 npm tarball `@earendil-works/pi-ai@1.3.0` 重同步
   （42 JSON，与 dist 逐字节一致）。

## app 侧适配

- **0 处** —— `SimpleStreamOptions` / classifier 共享层 / judge 协议均未变。

## 验证

- 归一化 diff：仅预期差异（lazy/动态 import 的 `.js` 后缀、bedrock `as any`、
  `compat.ts` marker、`auth/oauth/load.ts` 动态 import）；27 处 `OhMyAgent`
  标记齐全（agent-loop 14 / agent 6 / agent-types 5 / compat 1 / types 1）。
- `npx tsc --noEmit` 0 错误。
- **判断内核专项 `vitest run tests/judge`：25 文件 / 303 测试通过**。
- `pnpm test` 全量 **276 文件 / 4128 测试通过**。
- `eslint` 0 errors；`typecheck:tests` 通过；`format:check` 通过。

## 判断内核实弹

- dev server 重启后 `/api/health` ok（4.3.0-beta1）。
- `POST /api/judge/test`：opencode `jev-1.13-free` 的免费上游仍在服务端故障
  （HTTP 451 `"Upstream request failed: Endpoint is unavailable"` —— 与
  2026-10-15 起持续的 opencode/TypeSafe 侧故障一致，官方
  `https://opencode.ai/v2/docs/console/models/#jev` 端点与文档 payload 已全按
  文档复测，付费 `jev-1.13` 返回 402 Insufficient funds 佐证免费链路故障）。
- 内核 **fail-closed 按设计工作**：961ms 快速失败 → `source:"fallback"`、
  `fallbackReason:"unavailable"`、不阻塞业务。远端恢复后 `/api/judge/test`
  即回 `source:"judge"`（v1.1.0 会话里已有金样本全线成功记录在案）。
