import { useState, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Bot, User, Download, X, Zap } from 'lucide-react';
import type { Message } from '../../types/session';
import ToolCallCard from './ToolCallCard';
import ApprovalCard, { type ApprovalDecision } from './ApprovalCard';
import { apiRequest } from '../../utils/api';
import { isElectron, getElectronAPI } from '../../utils/env';
import { useToast } from '../ui/Toast';

interface MessageBubbleProps {
  message: Message;
}

export default function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.role === 'user';
  const isAssistant = message.role === 'assistant';
  const footer = message.footer;
  const { showToast } = useToast();
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  // Track images that need file-access approval
  const [approvalStates, setApprovalStates] = useState<Record<string, {
    approvalId: string;
    path: string;
    status: 'pending' | 'approved' | 'rejected';
  }>>({});

  const handleDownload = useCallback(async (url: string, filename: string) => {
    if (isElectron()) {
      const api = getElectronAPI();
      if (!api) return;
      // Desktop Bridge: download directly from the local filesystem
      if (url.startsWith('/desktop-bridge-download')) {
        const q = new URL(url, window.location.origin).searchParams;
        const filePath = q.get('path') || '';
        if (!filePath) { showToast('无效的文件路径', 'error'); return; }
        const result = await api.saveLocalFile(filePath, filename);
        if (result?.ok) {
          showToast('文件已保存', 'success');
        } else if (result?.error !== 'cancelled') {
          showToast('保存失败', 'error');
        }
      } else {
        const result = await api.saveFileFromUrl(url, filename);
        if (result?.ok) {
          showToast('文件已保存', 'success');
        } else if (result?.error !== 'cancelled') {
          showToast('保存失败', 'error');
        }
      }
    } else {
      // WebUI: use browser download via temporary anchor.
      // Append ?download=1 to serve URLs so the server sends
      // Content-Disposition: attachment with the real filename.
      let downloadUrl = url;
      if (url.includes('/api/files/serve') && !url.includes('download=1')) {
        downloadUrl = url.includes('?') ? `${url}&download=1` : `${url}?download=1`;
      }
      const a = document.createElement('a');
      a.href = downloadUrl;
      if (filename && !downloadUrl.includes('download=1')) {
        a.download = filename;
      }
      a.click();
    }
  }, [showToast]);

  // Custom markdown rendering: desktop-bridge links → download buttons, images → constrained size
  const markdownComponents = {
    img: ({ src, alt, ...props }: any) => {
      // Extract real filename from serve URL for download
      const imgFilename = (() => {
        try {
          const u = new URL(src, window.location.origin);
          const pathParam = u.searchParams.get('path');
          if (pathParam) return pathParam.split('/').pop() || alt || 'image.png';
        } catch {}
        return alt || 'image.png';
      })();
      return (
        <div className="relative group max-w-[240px]">
          <button
            onClick={() => src && setLightboxUrl(src)}
            className="block w-full rounded-lg overflow-hidden border border-neutral-200 dark:border-neutral-700 hover:opacity-90 transition-opacity cursor-pointer"
          >
            <img
              src={src}
              alt={alt || 'Image'}
              className="w-full h-auto object-cover"
              loading="lazy"
              {...props}
            />
          </button>
          {/* Download button — bottom-right corner, visible on hover */}
          <button
            onClick={(e) => { e.stopPropagation(); handleDownload(src, imgFilename); }}
            className="absolute bottom-2 right-2 flex items-center gap-1 px-2 py-1 rounded-lg bg-black/60 hover:bg-black/80 text-white text-xs opacity-0 group-hover:opacity-100 transition-opacity"
          >
            <Download size={12} />
            <span>保存</span>
          </button>
        </div>
      );
    },
    a: ({ href, children, ...props }: any) => {
      if (href && href.startsWith('/desktop-bridge-download')) {
        try {
          const q = new URL(href, window.location.origin).searchParams;
          const filePath = q.get('path') || '';
          const fileName = q.get('name') || String(children ?? 'download');
          return (
            <button
              onClick={(e) => { e.preventDefault(); handleDownload(href, fileName); }}
              className="inline-flex items-center gap-1.5 rounded-lg border border-blue-200 dark:border-blue-800 px-2.5 py-1 text-sm text-blue-700 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-900/30 transition-colors"
            >
              <Download size={14} />
              <span>{children}</span>
            </button>
          );
        } catch {}
      }
      // Serve/download URLs → render as download button with real filename
      if (href && (href.includes('/api/files/serve') || href.includes('/api/files/download'))) {
        const fileName = (() => {
          try {
            const u = new URL(href, window.location.origin);
            const pathParam = u.searchParams.get('path');
            if (pathParam) return pathParam.split('/').pop() || String(children ?? 'download');
          } catch {}
          return String(children ?? 'download');
        })();
        return (
          <button
            onClick={(e) => { e.preventDefault(); handleDownload(href, fileName); }}
            className="inline-flex items-center gap-1.5 rounded-lg border border-blue-200 dark:border-blue-800 px-2.5 py-1 text-sm text-blue-700 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-900/30 transition-colors"
          >
            <Download size={14} />
            <span>{children}</span>
          </button>
        );
      }
      return <a href={href} target="_blank" rel="noopener noreferrer" {...props}>{children}</a>;
    },
  };

  async function handleImageError(imgUrl: string) {
    // Check if the serve endpoint wants approval
    try {
      const resp = await fetch(imgUrl);
      if (resp.status === 403) {
        const data = await resp.json().catch(() => null);
        if (data?.needsApproval) {
          setApprovalStates(prev => ({
            ...prev,
            [imgUrl]: { approvalId: data.approvalId, path: data.path, status: 'pending' },
          }));
        }
      }
    } catch { /* ignore fetch errors */ }
  }

  async function handleApprove(imgUrl: string) {
    const state = approvalStates[imgUrl];
    if (!state) return;
    try {
      const resp = await apiRequest('/api/files/approve-serve', {
        method: 'POST',
        body: JSON.stringify({ approvalId: state.approvalId, decision: 'approve' }),
      });
      if ((resp as any).ok) {
        setApprovalStates(prev => ({ ...prev, [imgUrl]: { ...state, status: 'approved' } }));
      }
    } catch { /* ignore */ }
  }

  function handleReject(imgUrl: string) {
    const state = approvalStates[imgUrl];
    if (!state) return;
    apiRequest('/api/files/approve-serve', {
      method: 'POST',
      body: JSON.stringify({ approvalId: state.approvalId, decision: 'reject' }),
    }).catch(() => {});
    setApprovalStates(prev => ({ ...prev, [imgUrl]: { ...state, status: 'rejected' } }));
  }

  function formatElapsed(ms: number): string {
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
  }

  function formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  return (
    <div className={`flex gap-3 ${isUser ? 'flex-row-reverse' : ''}`}>
      {/* Avatar */}
      <div
        className={`shrink-0 flex h-7 w-7 items-center justify-center rounded-full mt-0.5 ${
          isUser
            ? 'bg-neutral-200 text-neutral-600 dark:bg-neutral-700 dark:text-neutral-300'
            : 'bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400'
        }`}
      >
        {isUser ? <User size={13} strokeWidth={1.75} /> : <Bot size={13} strokeWidth={1.75} />}
      </div>

      {/* Content */}
      <div className={`flex-1 min-w-0 ${isUser ? 'flex flex-col items-end' : ''}`}>
        <div
          className={`rounded-xl px-3 sm:px-4 py-2 sm:py-2.5 text-sm leading-relaxed ${
            isUser
              ? 'bg-neutral-100 text-neutral-900 max-w-[85%] sm:max-w-[80%] dark:bg-neutral-800 dark:text-neutral-100'
              : 'text-neutral-800 dark:text-neutral-200'
          }`}
        >
          {isAssistant ? (
            message.segments && message.segments.length > 0 ? (
              // Render segments in chronological order so tool calls appear
              // interleaved with text rather than all at the bottom.
              <div className="space-y-2">
                {message.segments.map((seg, i) =>
                  seg.type === 'text' ? (
                    <div key={i} className="markdown-content">
                      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{seg.content || ''}</ReactMarkdown>
                    </div>
                  ) : seg.type === 'tool_call' && seg.toolCall ? (
                    <ToolCallCard key={seg.toolCall.id} toolCall={seg.toolCall} />
                  ) : seg.type === 'skill' ? (
                    <div key={`skill-${i}`} className="flex items-center gap-2 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 px-3 py-2 text-sm">
                      <Zap size={14} className="text-amber-500 dark:text-amber-400 shrink-0" />
                      <span className="text-neutral-700 dark:text-neutral-200">技能激活：<strong>{seg.name}</strong></span>
                    </div>
                  ) : seg.type === 'media' && seg.media ? (
                    <div key={`media-${i}`} className="my-1">
                      {seg.media.type === 'image' ? (
                        <button
                          onClick={() => setLightboxUrl(seg.media!.url)}
                          className="block max-w-[240px] rounded-lg overflow-hidden border border-neutral-200 dark:border-neutral-700 hover:opacity-90 transition-opacity cursor-pointer"
                        >
                          <img
                            src={seg.media.url}
                            alt={seg.media.alt || seg.media.name || 'Image'}
                            className="w-full h-auto object-cover"
                            loading="lazy"
                          />
                        </button>
                      ) : seg.media.type === 'video' ? (
                        <video
                          src={seg.media.url}
                          controls
                          className="max-w-full rounded-lg border border-neutral-200 dark:border-neutral-700"
                          style={{ maxHeight: '300px' }}
                        />
                      ) : (
                        <button
                          onClick={() => handleDownload(seg.media!.url, seg.media!.name || 'download')}
                          className="inline-flex items-center gap-2 rounded-lg border border-neutral-200 dark:border-neutral-700 px-3 py-2 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors group"
                        >
                          <Download size={14} className="text-neutral-400 group-hover:text-neutral-600 dark:group-hover:text-neutral-300" />
                          <span className="text-neutral-700 dark:text-neutral-300">{seg.media.name}</span>
                          {seg.media.size != null && (
                            <span className="text-neutral-400 dark:text-neutral-500 text-xs">{formatFileSize(seg.media.size)}</span>
                          )}
                        </button>
                      )}
                    </div>
                  ) : null,
                )}
              </div>
            ) : (
              // Legacy rendering: all text first, then tool cards at the bottom.
              // Used for API-fetched history which doesn't have segments.
              <>
                <div className="markdown-content">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{message.content}</ReactMarkdown>
                </div>
                {message.tool_calls && message.tool_calls.length > 0 && (
                  <div className="mt-2 space-y-2 w-full">
                    {message.tool_calls.map((tc) => (
                      <ToolCallCard key={tc.id} toolCall={tc} />
                    ))}
                  </div>
                )}
              </>
            )
          ) : (
            <div className="markdown-content">
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{message.content}</ReactMarkdown>
            </div>
          )}
        </div>

        {/* Generated images — fallback: extract from markdown content at render time.
            Skip for user messages — ReactMarkdown already renders images inline. */}
        {!isUser && (() => {
          const extracted: { url: string; alt?: string }[] = message.images || [];
          if (extracted.length === 0 && message.content) {
            // Extract images from markdown content as fallback
            const imgRegex = /!\[([^\]]*)\]\(([^)\s]+)\)/g;
            let m: RegExpExecArray | null;
            while ((m = imgRegex.exec(message.content)) !== null) {
              extracted.push({ alt: m[1] || undefined, url: m[2] });
            }
          }
          if (extracted.length === 0) return null;
          return (
          <div className="mt-2 flex flex-wrap gap-2">
            {extracted.map((img, i) => {
              const approval = approvalStates[img.url];
              const needsApproval = approval?.status === 'pending';
              const wasRejected = approval?.status === 'rejected';
              const imgKey = approval?.status === 'approved' ? `${img.url}-approved` : img.url;
              // Extract filename from URL (e.g. /api/files/serve?path=foo.png → foo.png)
              const imgFilename = (() => {
                try {
                  const u = new URL(img.url, window.location.origin);
                  const pathParam = u.searchParams.get('path');
                  if (pathParam) return pathParam.split('/').pop() || `image-${i + 1}.png`;
                  const pathname = u.pathname;
                  const name = pathname.split('/').pop();
                  if (name && name !== 'serve') return name;
                } catch {}
                return img.alt || `image-${i + 1}.png`;
              })();
              return (
                <div key={i} className="flex flex-col gap-1">
                  <div className="relative group">
                    <button
                      onClick={() => !needsApproval && !wasRejected && setLightboxUrl(img.url)}
                      className={`block max-w-[240px] rounded-lg overflow-hidden border border-neutral-200 dark:border-neutral-700 hover:opacity-90 transition-opacity ${needsApproval || wasRejected ? 'cursor-default opacity-50' : 'cursor-pointer'}`}
                    >
                      {wasRejected ? (
                        <div className="w-[240px] h-[120px] flex items-center justify-center bg-neutral-100 dark:bg-neutral-800 text-sm text-neutral-500">
                          Access denied
                        </div>
                      ) : (
                        <img
                          key={imgKey}
                          src={img.url}
                          alt={img.alt || 'Generated image'}
                          className="w-full h-auto object-cover"
                          loading="lazy"
                          onError={() => handleImageError(img.url)}
                        />
                      )}
                    </button>
                    {/* Download button — bottom-right corner, visible on hover */}
                    <button
                      onClick={(e) => { e.stopPropagation(); handleDownload(img.url, imgFilename); }}
                      className="absolute bottom-2 right-2 flex items-center gap-1 px-2 py-1 rounded-lg bg-black/60 hover:bg-black/80 text-white text-xs opacity-0 group-hover:opacity-100 transition-opacity"
                      title="下载图片"
                    >
                      <Download size={12} />
                      <span>保存</span>
                    </button>
                  </div>
                  {needsApproval && (
                    <div className="flex gap-1">
                      <button
                        onClick={() => handleApprove(img.url)}
                        className="text-xs px-2 py-1 rounded bg-blue-600 text-white hover:bg-blue-700"
                      >
                        Approve
                      </button>
                      <button
                        onClick={() => handleReject(img.url)}
                        className="text-xs px-2 py-1 rounded bg-neutral-200 dark:bg-neutral-700 text-neutral-600 dark:text-neutral-300 hover:bg-neutral-300 dark:hover:bg-neutral-600"
                      >
                        Reject
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          );
        })()}

        {/* Generated files */}
        {message.files && message.files.length > 0 && (
          <div className="mt-2 space-y-1">
            {message.files.map((file, i) => {
              // If path is already a URL (e.g. /api/files/serve?path=...), use it directly
              // with ?download=1 to force download with original filename.
              // Otherwise wrap it in /api/files/download.
              const isServeUrl = file.path.startsWith('/api/files/');
              const href = isServeUrl
                ? (file.path.includes('?') ? `${file.path}&download=1` : `${file.path}?download=1`)
                : `/api/files/download?path=${encodeURIComponent(file.path)}`;
              return (
              <button
                key={i}
                onClick={() => handleDownload(href, file.name)}
                className="inline-flex items-center gap-2 rounded-lg border border-neutral-200 dark:border-neutral-700 px-3 py-2 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors group"
              >
                <Download size={14} className="text-neutral-400 group-hover:text-neutral-600 dark:group-hover:text-neutral-300" />
                <span className="text-neutral-700 dark:text-neutral-300">{file.name}</span>
                {file.size != null && (
                  <span className="text-neutral-400 dark:text-neutral-500 text-xs">{formatFileSize(file.size)}</span>
                )}
              </button>
              );
            })}
          </div>
        )}

        {message.approval && (
          <div className="mt-2 w-full">
            <ApprovalCard
              approvalId={message.approval.approvalId}
              toolName={message.approval.command.length > 50
                ? message.approval.command.slice(0, 50) + '...'
                : message.approval.command}
              commandText={message.approval.command}
              riskLevel={message.approval.risk}
              reason={message.approval.reason || ''}
              initialStatus={message.approval.status}
              timeoutReason={message.approval.timeoutReason}
              onResolve={async (id, decision: ApprovalDecision) => {
                try {
                  await apiRequest(`/api/approvals/${id}/resolve`, {
                    method: 'POST',
                    body: JSON.stringify({ decision }),
                  });
                } catch (err) {
                  console.error('Failed to resolve approval:', err);
                }
              }}
            />
          </div>
        )}

        {/* Footer — matches Feishu buildCompletedCard format:
            agentName · 已完成 · 耗时 xs · model · ↓ in ↑ out · 缓存命中 xx% */}
        {/* Image lightbox */}
        {lightboxUrl && (
          <div
            className="fixed inset-0 z-[300] flex items-center justify-center bg-black/80 p-4 cursor-pointer"
            onClick={() => setLightboxUrl(null)}
          >
            <button
              className="absolute top-4 right-4 rounded-full bg-white/10 p-2 hover:bg-white/20 transition-colors"
              onClick={() => setLightboxUrl(null)}
            >
              <X size={20} className="text-white" />
            </button>
            <img
              src={lightboxUrl}
              alt="Preview"
              className="max-w-full max-h-[90vh] object-contain rounded-lg"
              onClick={(e) => e.stopPropagation()}
            />
          </div>
        )}

        {isAssistant && (
          <div className="mt-1 px-1 text-[11px] text-neutral-400 dark:text-neutral-500">
            {(() => {
              const parts: string[] = [];
              if (footer?.agentName) parts.push(footer.agentName);
              if (footer?.completed) parts.push('已完成');
              if (footer?.elapsed != null) parts.push(`耗时 ${formatElapsed(footer.elapsed)}`);
              if (footer?.model) parts.push(footer.model);
              if (footer?.showUsage && footer?.usage) {
                const inputTokens = (footer.usage.input ?? 0) + (footer.usage.cacheRead ?? 0) + (footer.usage.cacheWrite ?? 0);
                parts.push(`↓${inputTokens} ↑${footer.usage.output ?? 0}`);
              }
              if (footer?.showCacheHitRate && footer?.usage) {
                const promptTokens = (footer.usage.input ?? 0) + (footer.usage.cacheRead ?? 0) + (footer.usage.cacheWrite ?? 0);
                if (promptTokens > 0) {
                  const rate = ((footer.usage.cacheRead ?? 0) / promptTokens * 100).toFixed(1);
                  parts.push(`缓存命中 ${rate}%`);
                }
              }
              return parts.join(' · ');
            })()}
          </div>
        )}
      </div>
    </div>
  );
}
