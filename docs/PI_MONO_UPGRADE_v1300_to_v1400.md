# pi-mono v1.3.0 → v1.4.0 升级实施记录

## 版本信息

| 项目     | 内容                                                                                                                      |
| -------- | ------------------------------------------------------------------------------------------------------------------------- |
| 日期     | 2026-10-23                                                                                                                |
| 上游仓库 | [pi](https://github.com/earendil-works/pi)                                                                                |
| 源版本   | v1.3.0                                                                                                                    |
| 目标版本 | v1.4.0 (commit `4a080252`)                                                                                                |
| 升级难度 | **中** — 首次出现 agent 补丁文件三方合并冲突（identity 功能与本项目 fallback 结构交叠）+ judge 协议层 `detectCompat` 适配 |

## 上游变更概要

- **新特性 — Client Identity**（ai+agent）：请求身份/Provider 归属（`utils/identity.ts`、
  `PI_ATTRIBUTION`、`mergeClientIdentity`、`ProviderRequestOptions.identity`、
  `Agent.identity` + `DEFAULT_AGENT_IDENTITY`）。
- **新特性 — System One 图片输入**：`SystemOneTransport` 新增
  `detectCompat(model): { imageInput, sendImageOptInHeader }`（assets /
  images / state-image-urls）；`ClassifierContext.images` 全线打通
  （typesafe / cloudflare-workers-ai / llama-cpp）。
- **telemetryContext → telemetry: TelemetrySpan**（ProviderRequestOptions 改名换代）。
- `pi-user-agent.ts` 删除（并入 identity）；重试匹配优化（standalone status code、
  Codex CLI 断流）；ChatGPT Business workspace 限额；Codex 被拒模型剔除；
  OpenRouter decision models compat；models.ts / transcript / overflow / validation 更新。
- **telemetry 包大改**（memory/metrics/render/testing conformance）。
- **mcp 零变更**。

## 升级步骤（实际执行）

1. **三方合并 3 个补丁文件**（base v1.3.0 / ours / theirs v1.4.0，导入后缀已归一化）：
   - `ai/types.ts`：0 冲突（+`SystemOneCompat` re-export、`identity`、
     `telemetry: TelemetrySpan`、`import type ClientIdentity`）。
   - `agent/agent.ts`：0 冲突（`identity` 选项 + `DEFAULT_AGENT_IDENTITY` 注释）。
   - `agent/agent-loop.ts`：**1 处冲突** —— theirs 把 `identity: mergeClientIdentity(...)`
     写进我们的 fallback attempts 结构里。手工解：保留 ours fallback 循环头，
     在**我们的** `streamFunction(model, llmContext, {...})` 调用里插入同一行
     `identity: mergeClientIdentity(DEFAULT_AGENT_IDENTITY, config.identity),`
     （imports 与 `DEFAULT_AGENT_IDENTITY` 常量由合并自动吸收）。14 处
     `OhMyAgent` 标记完好。
2. aisync 整树 ai(201 文件，删 `utils/pi-user-agent.ts`) / agent(6) / mcp(18) /
   telemetry(8)；from HEAD 还原 `agent/types.ts`、`agent/index.ts`（上游未动 +
   本地补丁）、`ai/compat.ts`。
3. import 归一化（静态 + 动态 `.ts`），bedrock 两处 `as any` 重打。
4. `providers/data` 从 npm tarball `@earendil-works/pi-ai@1.4.0` 重同步（42 JSON）。

## app 侧适配（1 处）

- **`src/judge/protocol-map.ts`**：v1.4.0 `SystemOneTransport` 要求
  `detectCompat(model)`。custom relay judge（`typesafe` / `http` 两线协议）
  无法靠 provider id 判别 → 复刻上游 typesafe 传输的 host 检测
  （`openrouter.ai` host 或 `openrouter` provider → `state-image-urls` +
  无 opt-in 头；否则 `assets` + `TypeSafe-Danger-Zone-Images` 头）。
  两个 relay transport 均挂同一 `detectRelayCompat` helper（纯文本判定不触发）。

## 验证（含判断内核）

- 归一化 diff：ai 侧仅 bedrock `as any` 与 vendored-only `providers/`
  目录（generated models 数据）差异 = 预期；agent 3 补丁文件差异 + identity
  行 indent 层符合我们的 fallback 结构。
- `npx tsc --noEmit` 0 错误。
- **判断内核专项 `vitest run tests/judge`：25 文件 / 307 测试通过**（contract 全绿,
  覆盖了新 `detectCompat` 形状）。
- `pnpm test` 全量 **277 文件 / 4150 测试通过**（4159 含 skip）。
- `eslint` 0 errors；`typecheck:tests` 通过；`format:check` 通过。

## 判断内核实弹（恢复正常！）

- dev server 重启（4.3.0），`/api/health` ok。
- `POST /api/judge/test`： **`ok: true, latencyMs: 836`** —— opencode 在
  `https://opencode.ai/inference/systemone/v1/systemone`（2026-10-16 已 pin 的
  官方端点 + `withOpencodeSystemOneEndpoint`）服务恢复了。三类金样本答案全部
  正确：q1 choice→code (p≈0.999)、q2 noul (p≈0.9997)、q3 score 0.016
  (c≈0.976)。判定自 2026-10-08 后再次实弹全绿。
