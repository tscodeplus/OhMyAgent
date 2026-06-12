# 上游版本追踪

记录本项目对应的上游 [agency-agents](https://github.com/msitarzewski/agency-agents) 版本，方便同步更新。

## 当前基线

- **上游仓库**: https://github.com/msitarzewski/agency-agents
- **对应 commit**: `783f6a7` (2026-04-12)
- **上游智能体总数**: 184（不含 `strategy/` 16 个运营文档）

## 翻译覆盖

| 分类 | 上游数量 | 已翻译/已映射 | 覆盖率 |
|------|----------|---------------|--------|
| academic | 5 | 5 | 100% |
| design | 8 | 8 | 100% |
| engineering | 29 | 29 | 100% |
| finance | 5 | 5 | 100% |
| game-development | 20 | 20 | 100% |
| marketing | 30 | 30 | 100% |
| paid-media | 7 | 7 | 100% |
| product | 5 | 5 | 100% |
| project-management | 6 | 6 | 100% |
| sales | 8 | 8 | 100% |
| spatial-computing | 6 | 6 | 100% |
| specialized | 41 | 41 | 100% |
| support | 6 | 6 | 100% |
| testing | 8 | 8 | 100% |
| **总计** | **184** | **184** | **100%** |

> `strategy/` 目录是运营文档（playbooks / runbooks / 协作模板），上下游内容一致，不计入智能体覆盖率。

### 上下游路径差异（已映射）

下列 4 个上游 agent 在本地以不同文件名存在，已映射不算缺失：

| 上游路径 | 本地路径 |
|---------|---------|
| `marketing/marketing-bilibili-content-strategist.md` | `marketing/marketing-bilibili-strategist.md` |
| `specialized/customer-service.md` | `support/support-support-responder.md`（拆分） |
| `specialized/sales-outreach.md` | `sales/sales-outbound-strategist.md` |
| `specialized/supply-chain-strategist.md` | `support/support-supply-chain-strategist.md` |

## 中国市场原创智能体

本项目除翻译外，新增 49+ 个针对中国市场原创的智能体（小红书/抖音/微信/B站/快手/微博/飞书/钉钉/百度SEO/政务ToG/医疗合规/高考志愿/留学规划/Qt 上位机/养殖档案核对等）。

完整列表见 [AGENT-LIST.md](./AGENT-LIST.md) 中标记为 `原创` 的条目。

## 本地额外目录

下列目录在上游不存在，是本项目针对中国市场新建的部门：

- `hr/` — 招聘专家、绩效管理专家（2 个）
- `legal/` — 合同审查专家、制度文件撰写专家（2 个）
- `supply-chain/` — 库存预测/供应商评估/物流路线优化（3 个）

## 同步说明

- 跟踪上游 `main` 分支
- 新增的上游智能体会逐步翻译
- 上游如果有大的结构调整（目录重命名等），一周内同步
- 上游版本号每次同步后由维护者更新本文件
