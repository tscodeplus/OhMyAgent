# pi-mono v1.4.0 → v1.5.0 升级实施记录

## 版本信息

| 项目     | 内容                                                                                                                |
| -------- | ------------------------------------------------------------------------------------------------------------------- |
| 日期     | 2026-11-03                                                                                                          |
| 上游仓库 | [pi](https://github.com/earendil-works/pi)                                                                          |
| 源版本   | v1.4.0                                                                                                              |
| 目标版本 | v1.5.0 (commit `f9a26365`)                                                                                          |
| 升级难度 | **中高** — 首个需要**新增 vendored 包**（`pi-schema`）的版本；**TypeBox → pi-schema** 工具参数校验替换；308 commits |

## 上游变更概要

- **新包 `@earendil-works/pi-schema` v1.5.0**：不依赖 eval 的 JSON Schema 校验器（draft 2020-12 / 7，编译为闭包）。
  子路径导出 `./formats`（含 TypeBox formats：date、date_time、duration、email、hostname、idn-\*、uuid…）。
- **pi-ai / pi-agent-core 全面弃用 TypeBox**：`ai/utils/validation.ts` 从 340 行 TypeBox 校验缩到 pi-schema
  `compile(schema, { formats, coerce: true, unresolvedRefs: "reject" })`（弱引用缓存 + JSON Pointer 路径格式化）；
  `utils/typebox-helpers.ts` → `utils/string-enum.ts`；`providers/compat-schema.ts` 815 行重写为 pi-schema builders；
  新增 `providers/schema-builders.ts`。
- **`AgentTool` 泛型放宽**：`AgentTool<TParameters extends object = object>`（原 `extends TSchema`），
  新增 `AgentToolParams<T>` = pi-schema `Static<T>`（`AgentTool<any>` → `any`）；`outputSchema?: object`（原 `TSchema`）。
  —— TypeBox schema 结构上仍是合法 JSON Schema 对象，本项目 61 处 `typebox` 用法无需改动。
- **流式 JSON**：新增 `ai/utils/streaming-json.ts`（559 行）；`utils/openrouter-cost.ts`；`utils/text.ts`。
- **api 层**：anthropic 142 行、bedrock 251 行、openai-completions 124 行、openai-responses-shared 154 行、
  google-shared 61 行、mistral 62 行、constrained-sampling 76 行等重排；`agent/proxy.ts` 改 22 行；
  `agent/types.ts` 24 行（即上面的泛型放宽）。
- **oauth**：`auth/oauth/trusted-url.ts` 新增；github-copilot / kimi-coding / meta / radius 细节修正。
- **mcp**：`oauth/flow.ts`、`oauth/types.ts`、`transports/streamable-http.ts` 小改。
- **agent-loop.ts / agent.ts 上游零变更**（本次无需冲突解决）。

## 升级步骤（实际执行）

1. **vendored 新包**：`packages/schema/src` → `src/pi-mono/schema/`（43 个 .ts，277K）。
2. **路径映射**：`tsconfig.json` 新增
   `@earendil-works/pi-schema` → `./src/pi-mono/schema/index.ts`、
   `@earendil-works/pi-schema/formats` → `./src/pi-mono/schema/formats/index.ts`；
   `vitest.config.ts` + `vitest.smoke.config.ts` 同步加别名（`/formats` 必须在裸名之前）。
   `tsc-alias` 会在产物里重写为相对路径（已验证 `dist/src/pi-mono/ai/utils/validation.js`
   首行 `import { compile } from "../../schema/index.js"`）。
3. **三方合并 4 个补丁文件**（base v1.4.0 / ours / theirs v1.5.0）：
   - `ai/types.ts`：**0 冲突**（上游仅改 Tool 参数类型注释与 telemetry 相关；我们的 `onStreamRetry` 标记 1 处完好）。
   - `agent/types.ts`：**0 冲突**（上游泛型放宽 vs 我们的 5 处扩展成员 —— fallbackModels / maxToolCycles /
     addedToolNames / deferred / stream_retry）。
   - `agent/agent-loop.ts`、`agent/agent.ts`：上游零变更 → 直接保留 HEAD 版本（14 + 6 标记）。
   - `ai/compat.ts`：上游零变更 → 保留 HEAD（1 标记）。
   - **27 个 `OhMyAgent` 标记全部完好**。
4. aisync 整树 ai(204 文件，删 `utils/typebox-helpers.ts`) / agent(6) / mcp(18) / telemetry(8)；
   补丁文件随后从合并结果覆盖回去。
5. import 归一化（静态 `from "…"` + 动态 `import("…")` 的 `.ts`/`.js`）。
   **本次踩坑**：只匹配 `from "…"` / `import("…")` 会漏掉两类说明符 ——
   - **副作用导入**：`import "./providers/images/register-builtins.ts"`（`ai/images.ts:1`，无 `from`）
   - **包装器实参**：`importNodeOnlyApi("./x.ts")` / `importOAuthModule("./x.ts")`
     （`ai/api/*.lazy.ts`、`ai/auth/oauth/load.ts`）

   后果是 `pnpm build` 通过、`tsc` 通过、`tsx` 下 dev server 正常，但 **`node dist/src/index.js`
   启动即 `ERR_MODULE_NOT_FOUND`**（dist 里没有 `.ts`）。正确的归一化是**任何**双引号相对
   说明符结尾的 `.ts`：

   ```bash
   grep -rlE '"[.][.]?/[^"]*\.ts"' src/pi-mono --include="*.ts" \
     | xargs sed -i -E 's/"(\.[^"]*)\.ts"/"\1.js"/g'
   ```

   **校验闸门**：`grep -rnoE '"[.][.]?/[^"]*\.ts"' src/pi-mono --include="*.ts" | wc -l` 必须为 0，
   且必须真的 `node dist/src/index.js` 起一次（不止 `pnpm dev`）—— 只有 dist 会暴露这类漏转。

6. bedrock 两处 `as any`（`middlewareStack.add`）重打。
7. `providers/data` 从 npm tarball `@earendil-works/pi-ai@1.5.0` 重同步（42 JSON）。

## app 侧适配

**零改动**。`AgentTool<TParameters extends object>` 放宽后，`src/tools/**` 的 TypeBox `Type.Object(...)` schema 与
`tool-adapter.ts` 的 zod→TypeBox 映射全部通过类型检查；pi-schema 校验器直接吃 TypeBox 产出的 JSON Schema。

## 验证

- **归一化 diff**：`schema` 包与上游 **逐字节一致**；`ai` 仅 bedrock `as any` / `compat.ts` / `types.ts` 三处 +
  vendored-only `providers/`（generated model 数据）；`agent` 仅 3 个补丁文件；**`mcp` / `telemetry` 逐字节一致**。
- `npx tsc --noEmit` 0 错误（含新 `schema` 树）。
- **判断内核专项 `vitest run tests/judge`：25 文件 / 307 测试通过**。
- `pnpm test` 全量 **337 文件 / 4923 测试通过**（4932 含 skip）。
- `pnpm lint` 0 errors（570 warnings）；`pnpm typecheck:tests` 通过；`pnpm format:check` 通过（`src/pi-mono` 在
  `.prettierignore` 中）。
- `pnpm build` 成功；`dist/src/pi-mono/schema/` 与 `dist/src/pi-mono/ai/utils/validation.js` 齐备。
- **dist 实机启动**：`OHMYAGENT_PORT=9195 node dist/src/index.js` → `/api/health` ok，
  `POST /api/judge/test` `ok:true`（1481ms）。这一步在 review 中首次失败（见步骤 5 的踩坑），
  修复后重跑通过 —— **dev(tsx) 绿不代表 dist 绿**。
- **pi-schema 运行时探针**（TypeBox schema 经 pi-schema 校验）：
  `compile(Type.Object({a: Type.Number()}), {formats, coerce:true, unresolvedRefs:'reject'}).parse({a:'42'})`
  → `{ok:true,value:{a:42}}`；`{a:'nope'}` → 路径化错误 `/a expected number, got string`。
- review 的 3 个只读子代理中 1 路完成（三方合并审计：结论「OD，upstream 内容 100% 保留」），
  另 2 路因工具调用路径错误/上下文耗尽失败；其提出的 2 个 nit（union 闭合符转为 tabs、
  `maxRetries` 注释措辞）已当场修掉。

## 判断内核实弹

- dev server 重启（`5.0.0-beta2`），`/api/health` ok。
- `POST /api/judge/test`：**`ok: true, latencyMs: 2319`**，judgeId `CommandCode-Jev`；
  q1 choice→`code`（p=1）、q2 noul（p=0.98）、q3 score 0.1（c=0.85）—— 三类金样本全部正确。
