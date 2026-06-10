<p align="center">
  <h1 align="center">OhMyAgent</h1>
  <p align="center"><strong>长于记忆。精于理解。忠于边界。</strong></p>
  <p align="center">
    <a href="README.md">English</a>
  </p>
</p>

---

OhMyAgent 是一个以记忆系统为核心的自托管 AI Agent 网关。与那些每次会话都失忆的 Agent 不同，OhMyAgent 为你构建持久化、可检索的知识库——同时内置审批引擎，尊重你的边界。

支持 Termux (Android)、Windows、macOS 和 Linux。轻量、省 Token、速度快。

## 为什么选择 OhMyAgent？

| | OhMyAgent |
|---|---|
| 🧠 **真正的记忆** | SQLite + better-sqlite3 + sqlite-vec 向量相似度 + FTS5 BM25 全文检索 + LLM 驱动自动摘要 + DreamCycle 夜间维护 — Agent 真正了解你是谁 |
| 🛡️ **审批门控** | 策略引擎，工具执行前逐条审批，路径级文件访问控制，可配置的工具可见性等级（minimal / standard / advanced / full） |
| 💸 **省 Token** | 分层上下文、渐进式技能加载、按需工具搜索 |
| 🪶 **轻量** | 单进程，嵌入式框架，手机就能跑 |
| 📲 **到处能跑** | Android Termux、Windows、macOS、Linux、Docker、Electron 桌面应用 |
| 🖥️ **桌面应用** | Electron 托盘应用 — 本地网关或远程连接 |

## 快速开始

### 桌面应用

从 [Releases](https://github.com/tscodeplus/OhMyAgent/releases) 页面下载适用于 Windows、macOS 和 Linux 的预编译安装包。

桌面应用可以作为**本地网关**（服务+界面合二为一）运行，或连接到**远程网关**。

### 一键安装

```bash
# Linux / macOS / Termux
curl -fsSL https://raw.githubusercontent.com/tscodeplus/OhMyAgent/main/install.sh | bash

# Windows (PowerShell)
iwr -Uri "https://raw.githubusercontent.com/tscodeplus/OhMyAgent/main/install.ps1" | iex
```

脚本会自动检测环境、安装依赖，并交互式引导你完成配置。完成后自动启动服务。

<details>
<summary>手动安装（如果你想自己掌控每一步）</summary>

### 环境要求

- **Node.js** >= 20
- **pnpm**（推荐）
- **C++ 编译工具链**（gcc/clang + make）— 用于编译原生扩展（`better-sqlite3` 和 `sqlite-vec`）。大多数常见平台有预编译二进制；如果安装时出现编译错误，请安装 `build-essential`（Linux）、Xcode Command Line Tools（macOS）或 Visual Studio Build Tools（Windows）。

### 安装与运行

```bash
git clone https://github.com/tscodeplus/OhMyAgent.git
cd OhMyAgent
pnpm install

cp config.yaml.example config.yaml
cp .env.example .env
```

**最小 `.env` 配置：**

```bash
PI_AI_API_KEY=你的API密钥        # 必填
WEBUI_TOKEN=你选的密码              # 建议设置
```

```bash
pnpm dev
```

浏览器打开 `http://localhost:9191/webui`，用你的 `WEBUI_TOKEN` 登录。

</details>

## 核心特性

### 🧠 真正记得住的记忆

记忆系统是 OhMyAgent 的核心，不是附加功能：

- **混合检索** — 向量相似度（sqlite-vec cosine + vec 搜索）结合 FTS5 BM25 全文搜索和词条侧挂索引（term sidecar），通过 RRF 或覆盖率融合算法合并排序
- **LLM 驱动摘要** — 增量会话摘要提取偏好和关键事实，压缩对话历史而不丢失信息
- **DreamCycle 夜间维护** — 8 阶段后台作业：清理孤立记录、重建实体链接、重新提取实体、场景聚类、过期记忆清理、补全缺失向量、淘汰缓存
- **场景聚类** — 按 scope + 时间窗口将记忆聚类为结构化 Markdown 文档，支持长期叙事回忆
- **实体图谱扩展** — 基于正则表达式的实体提取构建 `memory_links` 图谱；检索时遍历你未主动查询的相关记忆
- **记忆卫生** — 自动清理临时事实和任务，同时无限期保留偏好和摘要
- **人格蒸馏** — 后台从累积记忆中提取用户画像，让 Agent 形成稳定的"你是谁"的认知
- **多池召回** — current / shared / other-agent 三池加权评分，支持时间衰减和置信度重排序
- **向量缓存** — SHA256 内容寻址缓存 + LRU 淘汰策略，避免重复查询浪费 Embedding API 调用

结果：Agent 随时间推移真正了解你是谁。

### 🛡️ 忠于边界

每次工具执行都经过**策略引擎**审查：

```
Agent 决策 → 策略检查 → 审批门控 → 执行（或拒绝）
```

- Shell 命令需要明确审批（支持白名单）
- 文件访问有路径限制和审计
- 每个技能、每个工具、每个会话可自定义审批流程

### 💸 设计即省 Token

以降低 LLM 成本为核心设计目标：

- **分层上下文** — 仅相关内容进入提示词，基础开销控制在极低水平
- **渐进式技能加载** — 技能默认仅加载名称（约 20 tokens/个），触发时才加载完整内容
- **按需工具搜索** — 可延迟工具通过正则匹配激活，不注入每个请求

### 📡 多渠道支持

一个 Agent，所有消息应用：**飞书（Lark）** 深度集成 CardKit 2.0 流式卡片，**Telegram**、**微信**、**QQ**，以及 **Cron 定时调度**。

### 🖥️ 灵活部署

| 模式 | 描述 |
|---|---|
| CLI / 服务 | `pnpm dev` — 最小体积，任何能跑 Node.js 的地方都能跑 |
| WebUI | 完整聊天界面 `http://host:port/webui` |
| 桌面应用 | Electron 托盘应用 — 关闭到托盘、开机自启 |
| 本地网关 | 服务+界面打包在一个桌面窗口 |
| 远程网关 | 桌面应用连接远程服务器 |
| Android (Termux) | 原生运行 — 手机就是服务器 |

## 架构

```
消息 (飞书 / Telegram / 微信 / QQ)
        ↓
   技能路由 ──→ 记忆检索 (SQLite + sqlite-vec)
        ↓          ↓
   上下文组装 ←──────┘
        ↓
   Agent (pi) ──→ 工具策略门控
        ↓                    ↓
   LLM 调用 ←── 工具执行（含审批）
        ↓
   流式响应 ──→ 渠道回复
```

## 参考与致谢

OhMyAgent 基于 [pi](https://github.com/earendil-works/pi)（原名 pi-mono，MIT © Mario Zechner）构建，这是一个嵌入式多供应商 AI Agent 框架。

设计灵感来源于 [OpenClaw](https://github.com/openclaw/openclaw) 和 [Hermes Agent](https://github.com/NousResearch/hermes-agent) —— 两个开创性的开源 AI Agent 项目。

## 开源协议

[MIT](https://opensource.org/licenses/MIT) — 详见 [LICENSE](LICENSE)。

---

<p align="center">
  <a href="README.md">🇺🇸 English Documentation</a>
</p>
