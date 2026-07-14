# pi-mono v0.80.3 → v0.80.6 升级实施记录

## 版本信息

| 项目 | 内容 |
|------|------|
| 日期 | 2026-07-14 |
| 上游仓库 | [pi](https://github.com/earendil-works/pi) |
| 源版本 | v0.80.3 |
| 目标版本 | v0.80.6 |
| 升级难度 | **中等** — 新增 harness 子系统（17 个文件），多个 provider 模型目录更新，zstd 请求压缩，定价层级支持 |

## 上游变更清单（3 个版本累积）

### 新增子系统

| 组件 | 文件数 | 说明 |
|------|--------|------|
| `agent/harness/` | 17 | AgentHarness 编排器、session 持久化（JSONL + 内存）、compaction 引擎、分支摘要、skills/prompt-template 加载器、ExecutionEnv 抽象 |
| `agent/node.ts` | 1 | Node.js harness 入口点 |

### AI 层变更

| 变更 | 说明 |
|------|------|
| 新 `openai-completions.lazy.ts` | OpenAI Completions API 懒加载包装器 |
| zstd 请求压缩 | Codex responses 端点支持 zstd 压缩请求体 |
| `ModelCost` 新增 `tiers` | 请求级定价层级支持 |
| `openai-codex-responses.ts` | Codex WebSocket 连接限制检测、header 超时、OAuth 凭据类型适配 |
| `utils/estimate.ts` | token 估算重构 |
| `utils/retry.ts` | 重试逻辑增强 |
| `utils/overflow.ts` | 溢出处理 |
| `utils/validation.ts` | 类型验证增强 |

### Provider 模型目录更新

| Provider | 变更类型 |
|----------|----------|
| `openrouter.models.ts` | 大量模型更新（含 "max" thinking level、tiered pricing） |
| `vercel-ai-gateway.models.ts` | 模型更新 + tier 定价 |
| `zai.models.ts` / `zai-coding-cn.models.ts` | 新增 "max" thinking level |
| `openai.models.ts` | 新增 tier 定价数据 |
| `opencode.models.ts` / `opencode-go.models.ts` | 模型更新 + "max" thinking level |
| `anthropic.models.ts` | 模型列表更新 |
| `amazon-bedrock.models.ts` | 模型列表更新 |
| `cerebras.models.ts` | 模型更新 |
| `cloudflare-ai-gateway.models.ts` | 模型更新 |
| `deepseek.models.ts` | 模型更新 |
| `fireworks.models.ts` | 模型更新 |
| `github-copilot.models.ts` | 模型更新 |
| `huggingface.models.ts` | 模型更新 |
| `mistral.models.ts` | 模型更新 |
| `nvidia.models.ts` | 模型更新 |
| `together.models.ts` | 模型更新 |
| `xai.models.ts` | 模型更新 |
| `xiaomi-token-plan-*.models.ts` | 模型更新 |
| `azure-openai-responses.models.ts` | 模型更新 |

### 修复

- Anthropic reasoning tokens 提取（`output_tokens_details.thinking_tokens`）
- `simple-options.ts`：新增 `clampMaxTokensToContext`
- OAuth 流程增强（device-code、github-copilot）

## 本地修改处理

### 保留应用（8 处）

| 编号 | 文件 | 修改内容 |
|------|------|----------|
| M1 | `agent/index.ts` | 剥离 harness 导出，仅保留 Agent、agent-loop、proxy、types 核心 API |
| M2 | `agent/types.ts` | 新增 `fallbackModels`（回退模型列表）、`deferred`（延迟工具标记） |
| M3 | `agent/agent.ts` | 新增 `fallbackModels` + `ohmyagent_agentName`；统一 `prepareNextTurn` 签名（移除 `prepareNextTurnWithContext`） |
| M4 | `agent/agent-loop.ts` | 回退模型重试循环、`compactToolsForPrompt`（过滤 `deferred` 工具）、累计缓存统计；移除 `failToolCallsFromTruncatedMessage` |
| M5 | `ai/compat.ts` | 自定义 `getModel`（优先自定义注册表 → 内置目录 → 动态回退）；新增 `registerModel`、`isSameModel` |
| M6 | `ai/types.ts` | 简化 `Model.cost` 为内联类型（保留 `tiers?` 兼容性以避免生成文件编译错误） |
| M7 | `ai/models.ts` | 简化 `calculateCost`（跳过 tier 定价逻辑，使用基准费率）；保留 "max" thinking level 支持 |
| M8 | `ai/api/mistral-conversations.ts` | `promptCacheKey` 类型断言 `(payload as any)` 修复 |

### 删除的文件

| 文件/目录 | 原因 |
|-----------|------|
| `agent/harness/` (17 文件) | 与 OhMyAgent 现有系统功能重叠，且 `messages.ts` 的 `declare module` 扩展了 `CustomAgentMessages` 接口，新增的 `BashExecutionMessage` 缺少 `content` 字段会导致 `compress.ts` 类型错误 |
| `agent/node.ts` | 依赖 harness，无 harness 则无意义 |

### 未集成 Harness 的原因

1. **类型冲突**：harness 的 `messages.ts` 通过 `declare module` 向 `CustomAgentMessages` 注册 `BashExecutionMessage`（无 `content` 字段），会破坏 `compress.ts` 对 `AgentMessage.content` 的遍历访问
2. **功能重叠**：OhMyAgent 已有成熟的 compaction、session/memory、skills、tools 系统，与 harness 功能高度重叠
3. **依赖增加**：harness 的 `skills.ts` 依赖 `ignore` npm 包；`prompt-templates.ts` 依赖 `yaml`
4. **架构差异**：harness 面向 pi coding-agent 的独立 CLI 应用设计，OhMyAgent 是多通道网关，架构方向不同

如果后续需要引入 harness 的部分组件，建议逐个评估：
- **低风险可复用**：`utils/truncate.ts`（通用截断逻辑）、`session/uuid.ts`（时间排序 UUID v7）
- **需适配**：`compaction/`（需要将 LLM 调用适配到项目的 aux 模型调用模式）
- **不适合**：`messages.ts`（CustomAgentMessages 扩展方式冲突）

### 已内置上游（无需重新应用）

- `ProviderEnv` 类型 — 上游已内置
- `cacheWrite1h` 提取 — 上游已内置
- OAuth 优雅失败 — 上游已内置
- `provider-env.ts` — 上游已内置
- ProviderEnv 参数注入 — 上游已内置

## 升级步骤

### 1. 获取上游 v0.80.6 源码

```bash
curl -sL --retry 3 -o /tmp/pi-v0.80.6.tar.gz \
  "https://github.com/earendil-works/pi/archive/refs/tags/v0.80.6.tar.gz"
tar xzf /tmp/pi-v0.80.6.tar.gz -C /tmp/
```

### 2. 替换源文件

```bash
# 清空并复制 agent 层
rm -rf src/pi-mono/agent/*
cp pi-0.80.6/packages/agent/src/*.ts src/pi-mono/agent/
cp -r pi-0.80.6/packages/agent/src/harness src/pi-mono/agent/

# 清空并复制 AI 层
rm -rf src/pi-mono/ai/*
cp pi-0.80.6/packages/ai/src/*.ts src/pi-mono/ai/
cp -r pi-0.80.6/packages/ai/src/{api,auth,providers,utils} src/pi-mono/ai/
```

### 3. 全局扩展名修正

```bash
# 静态导入
find src/pi-mono -name "*.ts" -exec sed -i 's/from "\([^"]*\)\.ts"/from "\1.js"/g' {} +
# 动态导入
find src/pi-mono -name "*.ts" -exec sed -i 's/import("\([^"]*\)\.ts")/import("\1.js")/g' {} +
# declare module 引用
# 手动检查: grep -rn "\.ts\"" src/pi-mono/
```

### 4. 删除 harness 目录

```bash
rm -rf src/pi-mono/agent/harness
rm -f src/pi-mono/agent/node.ts
```

### 5. 重新应用本地修改

参见上方"保留应用"表格（M1-M8），逐一应用修改。

### 6. 类型兼容性调整

- `ai/types.ts`：`Model.cost` 保留 `tiers?` 可选字段（避免生成模型文件编译错误）
- `ai/types.ts` + `agent/types.ts`：`ThinkingLevel` 保留 `"max"`
- `agent/agent-loop.ts`：显式导入 `Tool` 类型
- `ai/api/openai-codex-responses.ts`：`sseBody` 类型断言为 `string | Uint8Array`

### 7. 验证

```bash
pnpm build      # 编译通过
pnpm test:ai    # 158 文件、2294 测试全部通过
```

## 回滚方法

```bash
git checkout HEAD~2 -- src/pi-mono/
pnpm build
```
