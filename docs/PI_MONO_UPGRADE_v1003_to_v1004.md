# pi-mono v1.0.3 → v1.0.4 升级实施记录

## 版本信息

| 项目     | 内容                                                                              |
| -------- | --------------------------------------------------------------------------------- |
| 日期     | 2026-10-06                                                                        |
| 上游仓库 | [pi](https://github.com/earendil-works/pi)                                        |
| 源版本   | v1.0.3（同日升级）                                                                |
| 目标版本 | v1.0.4（2026-10-05 发布）                                                         |
| 升级难度 | **极低** — 纯补丁版，共 3 个源码文件 + 2 个模型目录 JSON，无 Breaking、无依赖变化 |

## 上游变更概要

- **ai / `utils/retry.ts`**：把 `The pending stream has been canceled` 加入可重试
  错误串（Bedrock SDK 5 分钟 HTTP/2 会话超时导致流被取消后自动重试，`#10379`）。
- **mcp / `oauth/flow.ts` + `oauth/types.ts`**（MCP SEP-837）：动态客户端注册时按
  redirect URI 推导并携带 OpenID Connect `application_type` —— 存在 loopback http
  或自定义 scheme 回调时发 `native`，否则 `web`。否则 OIDC 服务器默认按 `web`
  处理、直接拒绝 loopback http 回调，导致本地 MCP 服务器 OAuth 注册失败。
  `clientMetadata.application_type` 显式指定时仍然优先。
- agent / telemetry：零变化。

## 升级步骤（实际执行）

1. 直接覆盖 3 个上游变更文件（均无本地补丁）：`ai/utils/retry.ts`、
   `mcp/oauth/flow.ts`、`mcp/oauth/types.ts`；随后 `.ts` → `.js` 导入归一化。
2. `providers/data` 从 `@earendil-works/pi-ai@1.0.4` tarball 重同步
   （`.manifest.json`、`openrouter.json`、`vercel-ai-gateway.json` 有上游更新）。
3. 依赖：无变化。`VERSION` → `v1.0.4 / pi-mcp v1.0.4 (embedded, no local patches)`。

## 验证

- 归一化 diff：vendored vs 上游 v1.0.4 仅剩 5 个 ai 补丁文件 + 4 个 agent 补丁文件；
  **mcp 包与上游逐字节一致**（本版无本地补丁，整树纯净）
- 本地补丁盘点：**5 文件 / 27 处 `OhMyAgent` 标记** 不变
- `npx tsc --noEmit` 0 错误；`pnpm test` **244 文件 / 3788 通过**（4 skipped）；
  `pnpm lint` 0 errors / 557 warnings（既有类）；`pnpm format:check` 通过

## 遗留 / 注意

- 若本地 MCP OAuth 服务器此前因 loopback 回调被 OIDC 拒绝，本版修复后重试即可；
  如需显式指定，仍可在 `config.yaml` 的 `clientMetadata` 里设 `application_type`。
- Bedrock 用户在长流（>5 分钟）上偶发的 `pending stream has been canceled` 现在会自动重试。
