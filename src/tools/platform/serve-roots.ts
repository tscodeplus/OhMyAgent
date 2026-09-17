// src/tools/platform/serve-roots.ts
//
// 文件服务允许根 —— webui_send_media 工具与 /api/files/serve|download
// 端点共用同一份基础列表,保证"工具能生成的 serve URL 端点一定能提供",
// 避免出现"发送成功但无法预览"(工具允许 os.homedir(),端点只认
// file_root 时,C:\Users\... 下文件会 403 Path traversal denied)。
//
// 端点侧在此基础之上再追加 webui.file_root 与图片/视频生成输出目录
// (见 files-routes.ts 的 computeServeAllowedRoots)。

import { homedir, tmpdir } from 'node:os';

/** 基础允许根:网关工作目录、系统临时目录、用户主目录。 */
export function toolAllowedRoots(): string[] {
  // tmpdir(), not the literal '/tmp': on Windows '/tmp' is a drive-relative
  // path that never holds the temp files the gateway writes (see the same fix
  // in public-download-routes.ts).
  return [process.cwd(), tmpdir(), homedir()];
}
