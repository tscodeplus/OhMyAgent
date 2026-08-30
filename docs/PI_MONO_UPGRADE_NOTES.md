# pi-mono 升级注意事项

供将来每次 `src/pi-mono/` 升级时快速排查的要点。

## 1. `providers/data/*.json` 绝不可凭 `git diff` 判定是否变更

### 问题
升级时观察 `git diff v0.8x.y v0.8x.z -- packages/ai/src/`，发现
`packages/ai/src/providers/data/` 目录**没有任何文件**被列为 changed。
误以为该目录无更新，从而跳过数据同步。

### 根因

1. 上游仓库 `packages/ai/src/providers/data/*.json` 是**生成产物**，在
   `packages/ai/.gitignore` 中被忽略（发布时通过 `npm run generate-models`
   生成），因此**从未进入上游 git**，任何 `git diff` 对它们都为空。
2. 这些 JSON 只有在 `npm publish` 时才被**重新生成并打入 npm tarball**
   (`dist/providers/data/*.json`)。发布脚本会抓取各 provider 在线模型列表
   (OpenRouter / models.dev / 各家官方接口)，所以一个 patch 版本发布后的
   JSON 可能与上一个版本相差几十个模型。
3. **本仓库不同** — `docs/PI_MONO_UPGRADE_v0821_to_v0841.md` 及
   `PI_MONO_UPGRADE_v0841_to_v0843.md` 记录的升级惯例是：
   把 npm pack 的 JSON **提交到 git**，让 `src/pi-mono/ai/providers/data/`
   成为本仓库真正追踪的目录。

### 常见后果
- release notes 明明说「added X model to the catalog」，升级完默认模型
  选择器却看不到该模型，除非点击「获取模型列表」（即 live fetch）。
- 视觉/推理模型（如 `deepseek-v4-flash-vision-exp`、云模型 `thinkingLevelMap`）
  仅存在发布包 JSON，源文件无此模型 → 默认目录缺失。

## 2. 修复步骤（每次 `ai/` 包升级后必做）

```bash
# 1. 下载发布包，不是从 git tag 复制 data
cd /tmp && npm pack @earendil-works/pi-ai@<TARGET_VERSION> --silent
tar xzf earendil-works-pi-ai-<TARGET_VERSION>.tgz
# 2. 比对本地与发布包生成目录
diff -rq package/dist/providers/data/ src/pi-mono/ai/providers/data/
# 3. 覆盖整个目录（含 .manifest.json），再 .ts→.js 归一化（仅 src/*.ts，需要对 data 不适用）
cp package/dist/providers/data/. src/pi-mono/ai/providers/data/
```

覆盖后：
- `grep` 目标 model id 于 `data/<provider>.json`
- 运行时校验：`getModels('<provider>')`（见 `src/pi-mono/ai/compat.ts`）
  应返回含该模型的列表。
- 重新 build + test。

## 3. 速查 — v0.84.4 实证

- `deepseek.json` 新增 `deepseek-v4-flash-vision-exp`
  （`generate-models.ts` 硬编码，`generate-models` 在发布时写入）
- `openrouter.json` 等 24 个 JSON 发布时在线刷新
  （新模型增、下线模型删、OpenRouter `thinkingLevelMap`、
  Cloudflare workers-ai 透传镜像等）
- 其他 14 个 JSON 与 v0.84.3 逐字节一致
