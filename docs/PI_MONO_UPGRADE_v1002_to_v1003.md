# pi-mono v1.0.2 → v1.0.3 升级实施记录

## 版本信息

| 项目     | 内容                                                                                                                         |
| -------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 日期     | 2026-10-06                                                                                                                   |
| 上游仓库 | [pi](https://github.com/earendil-works/pi)                                                                                   |
| 源版本   | v1.0.2（同日升级）                                                                                                           |
| 目标版本 | v1.0.3（2026-10-05 发布）                                                                                                    |
| 升级难度 | **低** — `agent` / `telemetry` / `mcp` 源码零变化；`ai` 包 7 个文件。1 个 Breaking（Azure provider slug 改名），app 侧零改动 |

## 上游变更概要（ai 包）

- **Breaking — Azure provider 改名**：`azure-openai-responses` → `azure`（`#9714`）。
  **注意：改的是 provider slug，不是 api id** —— `azure-openai-responses` 这个
  **api id** 与 `AZURE_OPENAI_*` 环境变量都保持不变。本项目 app 引用的全部是
  api id（`src/utils/base-url.ts` 的 `OPENAI_COMPAT_APIS`、WebUI 模型编辑器的
  `knownApis` 列表），因此无需改动。
- Azure provider 新增 Chat Completions 支持（Foundry 部署），内置目录加入
  DeepSeek V4 Pro；`AZURE_OPENAI_DEPLOYMENT_NAME_MAP` 与 `azureDeploymentName`
  对两种 api 都生效。新增 `api/azure-openai-config.ts`（共享 Azure 端点/部署解析）。
- 修复：请求或模型目录刷新在 token refresh 进行中被取消/取代时，OAuth 凭证被作废 ——
  已开始的 refresh 现在会完成并持久化轮换出的新 refresh token。
- 删除文件：`providers/azure-openai-responses.ts`、`providers/azure-openai-responses.models.ts`
  （并入 `providers/azure.ts` / `azure.models.ts`）。

## 升级步骤（实际执行）

1. `git merge-file` 三方合并 `ai/types.ts`（ours = v1.0.2 vendored + 本地补丁，
   theirs = u1.0.3）—— **0 冲突**（上游仅 ProviderId 联合类型改名 + 新增
   `azure-openai-config` 导入，与本地 `onStreamRetry` 补丁区不相交）。
2. `aisync.mjs /tmp/pi-1.0.3/packages/ai/src src/pi-mono/ai` 整树替换，随后：
   - 还原 4 个上游未动的补丁文件（`compat.ts`、`openai-codex-responses.ts`、
     `xai.ts`、`bedrock-converse-stream.ts`）；
   - 放回合并产物 `types.ts`；
   - 手动删除上游已移除的 `providers/azure-openai-responses{,.models}.ts`。
3. `.ts` → `.js` 导入归一化（标准 4 条 sed + 合并产物相对导入补 `.js`）。
4. `providers/data` 从 `@earendil-works/pi-ai@1.0.3` npm tarball 重同步
   （43 个文件，新增 `azure.json`；`azure-openai-responses.json` 由上游保留）。
5. 依赖：无变化（`@anthropic-ai/sdk` 0.129.0 延续）。
6. `VERSION` → `v1.0.3` / `pi-mcp v1.0.2 (embedded, no local patches)`。

## 验证

- `npx tsc --noEmit` — 0 错误；`pnpm lint` 0 errors；`pnpm format:check` 通过
- `pnpm test` — **244 文件 / 3788 通过**（4 skipped，无失败）
- 归一化 diff：vendored vs 上游 v1.0.3 仅剩 5 个 ai 补丁文件 + 4 个 agent 补丁文件；
  mcp 与上游逐字节一致
- 本地补丁盘点：**5 文件 / 27 处 `OhMyAgent` 标记** 不变
- 运行时（tsx 直调 compat）：
  - `getProviders()` → 42，含 `azure`，不含旧 slug `azure-openai-responses`
  - `getModels('azure')` → 45；`getModel('azure','gpt-5-mini')` 可解析
  - 旧 provider slug 不再解析（符合上游 breaking 变更；本项目从未使用该 slug）

## 遗留 / 注意

- 若用户在自定义模型里配置过 `provider: azure-openai-responses`，需改为
  `azure`（本项目 config.yaml 与数据库检查均无此用法）。
- Azure token-refresh 持久化修复对走 OAuth 的 Azure 部署是行为改进，无需配置。
