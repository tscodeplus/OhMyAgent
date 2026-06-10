# pi-mono v0.72.0 → v0.72.1 升级记录

## 升级概览

| 项目 | 内容 |
|------|------|
| 日期 | 2026-05-03 |
| 上游仓库 | [pi-mono](https://github.com/badlogic/pi-mono) |
| 源版本 | v0.72.0 (commit `196226b`) |
| 目标版本 | v0.72.1 (commit `036bde0`) |
| 嵌入目录 | `src/pi-mono/` |
| 测试结果 | 55 test files, 772 tests — 全部通过 |

## v0.72.1 上游变更清单

本次是小版本更新，共 4 个提交，25 个文件变更（大部分为非源码文件），实际 AI/Agent 层只涉及 4 个文件。

### Agent 层 (packages/agent/src/)

| 文件 | 变更内容 |
|------|---------|
| `agent.ts` | 默认 transport 从 `"sse"` 改为 `"auto"`（第 204 行） |

### AI 层 (packages/ai/src/)

| 文件 | 变更内容 |
|------|---------|
| `models.generated.ts` | 模型定价和上下文窗口数据更新 |
| `providers/openai-codex-responses.ts` | 默认 transport 从 `"sse"` 改为 `"auto"`；`useCachedContext` 判断也适配 `"auto"` 模式 |
| `providers/simple-options.ts` | 透传 `transport` 选项到下游 |

### 变更动机

Codex transport 选项修复（fix #4083）：当使用 `"auto"` transport 时，Codex 客户端应自动选择最优传输方式（websocket-cached 或 sse），但 v0.72.0 中 `"auto"` 未被正确处理。此修复使 `"auto"` 模式能正确启用 websocket-cached 上下文缓存。

## 升级步骤

### 1. 获取上游源码

```bash
git clone --depth 1 --branch v0.72.1 https://github.com/badlogic/pi-mono.git /tmp/pi-mono-v0721-src
git clone --depth 1 --branch v0.72.0 https://github.com/badlogic/pi-mono.git /tmp/pi-mono-v0720-src
```

### 2. 对比差异

```bash
diff -rq /tmp/pi-mono-v0720-src/packages/agent/src/ /tmp/pi-mono-v0721-src/packages/agent/src/
diff -rq /tmp/pi-mono-v0720-src/packages/ai/src/ /tmp/pi-mono-v0721-src/packages/ai/src/
```

### 3. 文件分类

#### 直接覆盖（本地无修改）

| 文件 | 说明 |
|------|------|
| `ai/models.generated.ts` | 模型数据更新，本地无修改 |
| `ai/providers/openai-codex-responses.ts` | Codex transport 修复，本地无修改 |
| `ai/providers/simple-options.ts` | transport 选项透传，本地无修改 |

#### 需要合并（本地有修改）

| 文件 | 本地修改 | 上游变更 | 处理方式 |
|------|---------|---------|---------|
| `agent/agent.ts` | `fallbackModels` 属性（4 处） | 默认 transport `"sse"` → `"auto"`（1 行） | 单行替换 |

### 4. 合并操作

**agent/agent.ts** — 仅改一行：

```
- this.transport = options.transport ?? "sse";
+ this.transport = options.transport ?? "auto";
```

与本地 `fallbackModels` 修改无冲突，互不影响。

### 5. 编译验证

```bash
pnpm build   # tsc 编译，确保无类型错误
```

### 6. 运行测试

```bash
pnpm test:ai
```

## 本地修改清单（升级后保留）

所有本地修改不受影响：

| 文件 | 功能 | 用途 |
|------|------|------|
| `agent/agent.ts` | `fallbackModels` 属性 | 主模型失败时自动切换到备用模型 |
| `agent/types.ts` | `fallbackModels` in `AgentLoopConfig` | 传递 fallback 配置到 agent loop |
| `agent/agent-loop.ts` | 移除 `isLastModel` 条件 + 错误日志 | 所有 fallback 模型的 delta 事件都发送给客户端 |
| `ai/models.ts` | `registerModel()` | 运行时注册自定义模型（custom_providers.yaml） |
| `src/provider/mimo-provider.ts` | 整个文件 | 自定义 MiMo provider |

## 版本记录

升级后在 `src/pi-mono/VERSION` 中记录当前版本号，下次升级时参考此文件确定源版本。CLAUDE.md 中的版本引用同步更新。
