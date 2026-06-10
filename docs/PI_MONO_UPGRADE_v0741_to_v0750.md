# pi-mono v0.74.1 → v0.75.0 升级文档

## 版本信息

| 项目 | 内容 |
|------|------|
| 日期 | 2026-05-18 |
| 上游仓库 | [pi](https://github.com/earendil-works/pi) |
| 源版本 | v0.74.1 (commit `8e57ba7`) |
| 目标版本 | v0.75.0 |
| 上游变更文件数 | 2 个源文件（均无冲突） |
| 升级难度 | **低** — 无 Agent 层变更，无新增文件，无本地修改冲突 |

## 上游变更清单

### Agent 层

**无源文件变更。** 仅 `package.json` 和 `CHANGELOG.md` 的版本号和 Node.js 最低版本要求更新。

### AI 层 — 修改文件

| 文件 | 变更行数 | 变更内容 | 与本地修改冲突？ |
|------|---------|---------|:---:|
| `models.generated.ts` | 142 | 模型目录更新（GitHub Copilot 推理级别修正 + OpenAI Codex 模型阵容刷新） | 否 |
| `providers/simple-options.ts` | 12 | 修复：模型 maxTokens 覆盖完整上下文窗口时，cap 为 32000 以避免无效的 provider 请求 | 否 |

#### `models.generated.ts` 详情

1. **GitHub Copilot GPT 模型推理元数据修正**（7 个模型）：`thinkingLevelMap` 补充 `"minimal":"low"` 映射，修复 minimal thinking 设置下启用受支持的 low 模式（issue #4622）。

2. **OpenAI Codex 模型阵容更新**：移除 `gpt-5.1`/`gpt-5.1-codex-max`/`gpt-5.1-codex`，新增 `gpt-5.2`/`gpt-5.2-codex-max`/`gpt-5.2-codex` 等新模型（issue #4603）。

#### `simple-options.ts` 详情

修复默认输出 token 请求逻辑（issue #4614）：
```typescript
// 新增常量
const DEFAULT_MAX_OUTPUT_TOKENS = 32000;
const CONTEXT_WINDOW_OUTPUT_TOLERANCE = 1024;

// 修改 buildBaseOptions 中的 maxTokens 计算
// 旧：model.maxTokens > 0 ? model.maxTokens : undefined
// 新：当 model.maxTokens >= contextWindow - 1024 时，cap 为 32000
```

### coding-agent / tui / web-ui 变更

不嵌入，与项目无关。内容包括：
- Node.js 最低版本提升至 22.19.0
- 压缩摘要修复（使用自定义 stream 函数）
- 系统提示词边界改用 XML 标签
- npm 包安装路径修复
- Mistral fetch/proxy 修复

## 升级步骤

### Step 1: 直接覆盖（2 个文件）

从 v0.75.0 源码复制到 `src/pi-mono/`：

```
ai/models.generated.ts            — 142 行模型更新
ai/providers/simple-options.ts    — 12 行输出 token 修复
```

### Step 2: 更新版本标记

```bash
echo "v0.75.0" > src/pi-mono/VERSION
```

`CLAUDE.md`：`v0.74.1` → `v0.75.0`。

### Step 3: 编译验证

```bash
pnpm build
```

### Step 4: 测试验证

```bash
pnpm test:ai
```

### Step 5: 提交

```bash
git add -A
git commit -m "feat: upgrade embedded pi-mono from v0.74.1 to v0.75.0"
```

## 本地修改状态

| 文件 | 修改点 | v0.75.0 状态 |
|------|--------|:---:|
| `agent/agent.ts` | `fallbackModels` 属性 (4 处) | 无上游变更 — 不受影响 |
| `agent/agent-loop.ts` | fallback 循环 + delta 事件 + 错误日志 | 无上游变更 — 不受影响 |
| `agent/types.ts` | `fallbackModels` in AgentLoopConfig | 无上游变更 — 不受影响 |
| `ai/models.ts` | `registerModel()` | 无上游变更 — 不受影响 |
| `ai/api-registry.ts` | `registerApiProvider()` | 无上游变更 — 不受影响 |
| `ai/bedrock-provider.ts` | Bedrock 模块声明 | 无上游变更 — 不受影响 |
| `ai/stream.ts` | `stream()` 函数 | 无上游变更 — 不受影响 |
| `ai/oauth.ts` | OAuth 支持 | 无上游变更 — 不受影响 |

## 验收清单

- [ ] `grep -rn "fallbackModels\|registerModel" src/pi-mono/` — 本地修改完整
- [ ] `pnpm build` — 编译通过
- [ ] `pnpm test:ai` — 全量测试无新增失败
- [ ] `grep -rn "@mariozechner" src/ tests/ --include="*.ts"` — 无旧包名残留
- [ ] `cat src/pi-mono/VERSION` — 显示 v0.75.0
