import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ClipboardCopy,
  Download,
  FilePlus,
  Folder,
  FolderOpen,
  FolderPlus,
  Loader2,
  Pencil,
  RefreshCw,
  Trash2,
  Upload,
  X,
  ArrowLeft,
  Check,
  Home,
  Save,
} from 'lucide-react';
import { apiRequest } from '../../utils/api';
import { useToast } from '../ui/Toast';
import { cn } from '../../lib/utils';
import { copyTextToClipboard } from '../../utils/clipboard';
import { isImeEnterEvent } from '../../utils/ime';
import { getFileIconData } from './fileIcons';
import type { FileTreeNode } from './types';
import Spinner from '../ui/Spinner';
import Button from '../ui/Button';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FlattenedNode {
  node: FileTreeNode;
  depth: number;
  parentPath: string;
}

interface FileContextMenu {
  node: FileTreeNode | null;
  x: number;
  y: number;
}

type InlineEdit =
  | { kind: 'rename'; path: string; currentName: string; depth: number }
  | { kind: 'create'; parentPath: string; type: 'file' | 'directory'; depth: number };

interface PlatformInfo {
  platform: string;
  isWSL: boolean;
  isTermux: boolean;
  suggestedRoots: string[];
  defaultRoot: string;
  currentRoot: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CTX_MENU_W = 180;
const CTX_MENU_H = 200;
const CTX_MENU_MARGIN = 8;

function clampMenuPos(x: number, y: number) {
  return {
    x: Math.max(CTX_MENU_MARGIN, Math.min(x, window.innerWidth - CTX_MENU_W - CTX_MENU_MARGIN)),
    y: Math.max(CTX_MENU_MARGIN, Math.min(y, window.innerHeight - CTX_MENU_H - CTX_MENU_MARGIN)),
  };
}

function flatten(
  nodes: FileTreeNode[],
  expanded: Set<string>,
  depth = 0,
  parentPath = '',
): FlattenedNode[] {
  const out: FlattenedNode[] = [];
  for (const node of nodes) {
    out.push({ node, depth, parentPath });
    if (node.type === 'directory' && expanded.has(node.path) && node.children) {
      out.push(...flatten(node.children, expanded, depth + 1, node.path));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// FilesView
// ---------------------------------------------------------------------------

export default function FilesView() {
  const { t } = useTranslation('common');
  const { showToast } = useToast();

  const [platformInfo, setPlatformInfo] = useState<PlatformInfo | null>(null);
  const [rootPath, setRootPath] = useState('');
  const [customRoot, setCustomRoot] = useState('');
  const [files, setFiles] = useState<FileTreeNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [activePath, setActivePath] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<FileContextMenu | null>(null);
  const [inlineEdit, setInlineEdit] = useState<InlineEdit | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadMenuOpen, setUploadMenuOpen] = useState(false);
  const [rootMenuOpen, setRootMenuOpen] = useState(false);
  const inlineInputRef = useRef<HTMLInputElement>(null);
  const escapePressedRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);

  // File preview state
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState('');
  const [fileOrigContent, setFileOrigContent] = useState('');
  const [fileLoading, setFileLoading] = useState(false);
  const [fileSaving, setFileSaving] = useState(false);
  const [fileError, setFileError] = useState('');

  // Known text file extensions
  const TEXT_EXTS = new Set([
    'txt', 'md', 'mdx', 'yaml', 'yml', 'json', 'jsonc', 'json5', 'xml', 'csv', 'tsv',
    'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'py', 'pyw', 'pyi',
    'rb', 'erb', 'php', 'java', 'kt', 'kts', 'c', 'h', 'cpp', 'hpp', 'cc', 'cs',
    'rs', 'go', 'swift', 'lua', 'r', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
    'css', 'scss', 'sass', 'less', 'html', 'htm', 'vue', 'svelte',
    'sql', 'graphql', 'gql', 'proto', 'toml', 'ini', 'cfg', 'conf', 'log',
    'env', 'lock', 'gitignore', 'editorconfig', 'dockerignore',
  ]);

  const isPreviewable = (name: string): boolean => {
    const ext = name.split('.').pop()?.toLowerCase() || '';
    return TEXT_EXTS.has(ext) || TEXT_EXTS.has(name.toLowerCase());
  };

  // Directory browser state
  const [browserPath, setBrowserPath] = useState('');
  const [browserDirs, setBrowserDirs] = useState<FileTreeNode[]>([]);
  const [browserLoading, setBrowserLoading] = useState(false);
  const [browserHistory, setBrowserHistory] = useState<string[]>([]);

  // ---- Fetch platform info ----
  useEffect(() => {
    apiRequest<PlatformInfo>('/api/files/roots')
      .then((info) => {
        setPlatformInfo(info);
        setRootPath(info.currentRoot);
        setCustomRoot(info.currentRoot);
      })
      .catch(() => showToast(t('files.loadError'), 'error'));
  }, [showToast, t]);

  // ---- Set folder input webkitdirectory ----
  const setFolderInputRef = useCallback((el: HTMLInputElement | null) => {
    folderInputRef.current = el;
    if (el) {
      el.setAttribute('webkitdirectory', '');
      el.setAttribute('directory', '');
    }
  }, []);

  // ---- Dismiss menus on outside click ----
  useEffect(() => {
    if (!uploadMenuOpen && !rootMenuOpen) return;
    const dismiss = () => { setUploadMenuOpen(false); setRootMenuOpen(false); };
    window.addEventListener('click', dismiss);
    return () => window.removeEventListener('click', dismiss);
  }, [uploadMenuOpen, rootMenuOpen]);

  // ---- Fetch file tree ----
  const fetchFiles = useCallback(async () => {
    if (!rootPath) return;
    setLoading(true);
    try {
      const data = await apiRequest<{ root: string; tree: FileTreeNode[] }>(
        `/api/files/tree?root=${encodeURIComponent(rootPath)}`,
      );
      setFiles(data.tree || []);
    } catch {
      showToast(t('files.loadError'), 'error');
    } finally {
      setLoading(false);
    }
  }, [rootPath, showToast, t]);

  useEffect(() => {
    if (rootPath) { void fetchFiles(); }
  }, [rootPath, fetchFiles]);

  // Reset state when root changes
  useEffect(() => {
    setExpanded(new Set());
    setActivePath(null);
    setContextMenu(null);
    setInlineEdit(null);
    setUploadMenuOpen(false);
  }, [rootPath]);

  // ---- Switch root ----
  const handleSwitchRoot = useCallback(async (root?: string) => {
    const newRoot = (root || customRoot.trim());
    if (!newRoot) return;
    try {
      await apiRequest('/api/files/root', {
        method: 'PUT',
        body: JSON.stringify({ root: newRoot }),
      });
      setRootPath(newRoot);
      setCustomRoot(newRoot);
      setRootMenuOpen(false);
    } catch (e) {
      showToast((e as Error).message || t('files.opError'), 'error');
    }
  }, [customRoot, showToast, t]);

  // ---- Directory browser ----
  const fetchBrowserDirs = useCallback(async (dirPath: string) => {
    setBrowserLoading(true);
    setBrowserPath(dirPath);
    try {
      const data = await apiRequest<{ tree: FileTreeNode[] }>(
        `/api/files/tree?root=${encodeURIComponent(dirPath)}`,
      );
      setBrowserDirs(data.tree?.filter((n) => n.type === 'directory') || []);
    } catch {
      setBrowserDirs([]);
    } finally {
      setBrowserLoading(false);
    }
  }, []);

  const openDirBrowser = useCallback(() => {
    const startPath = customRoot || rootPath || platformInfo?.defaultRoot || '/';
    setBrowserHistory([]);
    setRootMenuOpen(true);
    void fetchBrowserDirs(startPath);
  }, [customRoot, rootPath, platformInfo, fetchBrowserDirs]);

  const navigateInto = useCallback((dirPath: string) => {
    setBrowserHistory((prev) => [...prev, browserPath]);
    void fetchBrowserDirs(dirPath);
  }, [browserPath, fetchBrowserDirs]);

  const navigateBack = useCallback(() => {
    setBrowserHistory((prev) => {
      const parent = prev[prev.length - 1];
      if (parent) {
        void fetchBrowserDirs(parent);
        return prev.slice(0, -1);
      }
      return prev;
    });
  }, [fetchBrowserDirs]);

  // ---- File tree helpers ----
  const flat = useMemo(() => flatten(files, expanded), [files, expanded]);

  const toggle = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const collapseAll = useCallback(() => setExpanded(new Set()), []);

  const handleClick = useCallback(
    async (node: FileTreeNode) => {
      setActivePath(node.path);
      if (node.type === 'directory') {
        toggle(node.path);
        return;
      }
      // File — open preview
      if (!isPreviewable(node.name)) {
        setFileError(t('files.binaryFile', { defaultValue: 'Binary file — cannot preview' }));
        setSelectedFile(node.name);
        setFileContent('');
        return;
      }
      setFileError('');
      setFileLoading(true);
      setSelectedFile(node.path);
      try {
        const data = await apiRequest<{ path: string; content: string }>(
          `/api/files/content?path=${encodeURIComponent(node.path)}`,
        );
        setFileContent(data.content);
        setFileOrigContent(data.content);
      } catch (e) {
        setFileError((e as Error).message || t('files.loadError'));
      } finally {
        setFileLoading(false);
      }
    },
    [toggle, t],
  );

  // ---- Context menu ----
  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  const handleContextMenu = useCallback(
    (event: ReactMouseEvent, node: FileTreeNode) => {
      event.preventDefault();
      event.stopPropagation();
      const pos = clampMenuPos(event.clientX, event.clientY);
      setContextMenu({ node, x: pos.x, y: pos.y });
    },
    [],
  );

  const handleBlankContextMenu = useCallback(
    (event: ReactMouseEvent) => {
      if ((event.target as HTMLElement).closest('li')) return;
      event.preventDefault();
      const pos = clampMenuPos(event.clientX, event.clientY);
      setContextMenu({ node: null, x: pos.x, y: pos.y });
    },
    [],
  );

  useEffect(() => {
    if (!contextMenu) return;
    const dismiss = () => closeContextMenu();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') dismiss(); };
    window.addEventListener('click', dismiss);
    window.addEventListener('resize', dismiss);
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', dismiss);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [contextMenu, closeContextMenu]);

  // ---- Inline edit ----
  useEffect(() => {
    if (inlineEdit && inlineInputRef.current) {
      inlineInputRef.current.focus();
      if (inlineEdit.kind === 'rename') {
        const dotIdx = inlineEdit.currentName.lastIndexOf('.');
        const end = dotIdx > 0 ? dotIdx : inlineEdit.currentName.length;
        inlineInputRef.current.setSelectionRange(0, end);
      } else {
        inlineInputRef.current.select();
      }
    }
  }, [inlineEdit]);

  const commitInlineEdit = useCallback(
    async (value: string) => {
      if (!inlineEdit) return;
      const trimmed = value.trim();
      if (!trimmed) { setInlineEdit(null); return; }

      try {
        if (inlineEdit.kind === 'rename') {
          if (trimmed === inlineEdit.currentName) { setInlineEdit(null); return; }
          await apiRequest('/api/files/rename', {
            method: 'PUT',
            body: JSON.stringify({ oldPath: inlineEdit.path, newName: trimmed }),
          });
        } else {
          const parentPath = inlineEdit.parentPath || '';
          await apiRequest('/api/files', {
            method: 'POST',
            body: JSON.stringify({ path: parentPath || undefined, type: inlineEdit.type, name: trimmed }),
          });
          if (parentPath) {
            setExpanded((prev) => { const next = new Set(prev); next.add(parentPath); return next; });
          }
        }
        await fetchFiles();
      } catch (e) {
        showToast((e as Error).message || t('files.opError'), 'error');
      }
      setInlineEdit(null);
    },
    [inlineEdit, fetchFiles, showToast, t],
  );

  const handleInlineKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        if (isImeEnterEvent(e as unknown as KeyboardEvent)) return;
        e.preventDefault();
        commitInlineEdit(e.currentTarget.value);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        escapePressedRef.current = true;
        setInlineEdit(null);
      }
    },
    [commitInlineEdit],
  );

  const handleInlineBlur = useCallback(
    (e: React.FocusEvent<HTMLInputElement>) => {
      if (escapePressedRef.current) { escapePressedRef.current = false; setInlineEdit(null); return; }
      commitInlineEdit(e.currentTarget.value);
    },
    [commitInlineEdit],
  );

  // ---- Actions ----
  const handleNewFile = useCallback((parentPath: string, depth: number) => {
    closeContextMenu();
    if (parentPath) {
      setExpanded((prev) => { const next = new Set(prev); next.add(parentPath); return next; });
    }
    setInlineEdit({ kind: 'create', parentPath, type: 'file', depth });
  }, [closeContextMenu]);

  const handleNewFolder = useCallback((parentPath: string, depth: number) => {
    closeContextMenu();
    if (parentPath) {
      setExpanded((prev) => { const next = new Set(prev); next.add(parentPath); return next; });
    }
    setInlineEdit({ kind: 'create', parentPath, type: 'directory', depth });
  }, [closeContextMenu]);

  const handleRename = useCallback((node: FileTreeNode, depth: number) => {
    closeContextMenu();
    setInlineEdit({ kind: 'rename', path: node.path, currentName: node.name, depth });
  }, [closeContextMenu]);

  const handleDelete = useCallback(async (node: FileTreeNode) => {
    closeContextMenu();
    const msg = node.type === 'directory'
      ? t('files.confirmDeleteDir', { name: node.name, defaultValue: `Delete "${node.name}"? This will delete all contents.` })
      : t('files.confirmDelete', { name: node.name, defaultValue: `Delete "${node.name}"?` });
    if (!window.confirm(msg as string)) return;
    try {
      await apiRequest('/api/files', { method: 'DELETE', body: JSON.stringify({ path: node.path }) });
      await fetchFiles();
    } catch (e) {
      showToast((e as Error).message || t('files.opError'), 'error');
    }
  }, [closeContextMenu, fetchFiles, showToast, t]);

  const handleFileSave = useCallback(async () => {
    if (!selectedFile) return;
    setFileSaving(true);
    try {
      await apiRequest('/api/files/content', {
        method: 'PUT',
        body: JSON.stringify({ path: selectedFile, content: fileContent }),
      });
      setFileOrigContent(fileContent);
      showToast(t('files.fileSaved', { defaultValue: 'Saved' }), 'success');
    } catch (e) {
      showToast((e as Error).message || t('files.opError'), 'error');
    } finally {
      setFileSaving(false);
    }
  }, [selectedFile, fileContent, showToast, t]);

  const handleCopyPath = useCallback((node: FileTreeNode) => {
    closeContextMenu();
    void copyTextToClipboard(node.path);
  }, [closeContextMenu]);

  // ---- Upload ----
  const uploadSelectedFiles = useCallback(async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    const fileArray = Array.from(fileList);
    const relativePaths = fileArray.map((file) => {
      const withDir = file as File & { webkitRelativePath?: string };
      return withDir.webkitRelativePath || file.name;
    });

    const formData = new FormData();
    formData.append('targetPath', '');
    formData.append('relativePaths', JSON.stringify(relativePaths));
    for (const file of fileArray) {
      formData.append('files', file);
    }

    try {
      setUploading(true);
      setUploadMenuOpen(false);
      // Note: FormData upload uses fetch directly since Content-Type must be multipart
      const token = localStorage.getItem('ohmyagent_token');
      const r = await fetch('/api/files/upload', {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: formData,
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({ error: `Upload failed (${r.status})` }));
        throw new Error(err.error || 'Upload failed');
      }
      await fetchFiles();
      showToast(t('files.uploaded', { defaultValue: 'Uploaded' }), 'success');
    } catch (e) {
      showToast((e as Error).message || t('files.opError'), 'error');
    } finally {
      setUploading(false);
    }
  }, [fetchFiles, showToast, t]);

  // ---- Download ZIP ----
  const handleDownloadZip = useCallback(async () => {
    try {
      const url = `/api/files/download-zip?path=${encodeURIComponent(rootPath)}`;
      const token = localStorage.getItem('ohmyagent_token');
      const anchor = document.createElement('a');
      anchor.href = token ? `${url}&token=${encodeURIComponent(token)}` : url;
      anchor.download = 'download.zip';
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
    } catch (e) {
      showToast((e as Error).message || t('files.opError'), 'error');
    }
  }, [rootPath, showToast, t]);

  // ---- Download file ----
  const handleDownloadFile = useCallback((event: ReactMouseEvent | null, node: FileTreeNode) => {
    event?.stopPropagation();
    const url = `/api/files/download?path=${encodeURIComponent(node.path)}`;
    const token = localStorage.getItem('ohmyagent_token');
    const anchor = document.createElement('a');
    anchor.href = token ? `${url}&token=${encodeURIComponent(token)}` : url;
    anchor.download = node.name;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
  }, []);

  const handleDeleteActive = useCallback(() => {
    if (!activePath) return;
    const active = flat.find((f) => f.node.path === activePath);
    if (active) handleDelete(active.node);
  }, [activePath, flat, handleDelete]);

  // ---- Depth lookup ----
  const depthByPath = useMemo(() => {
    const map = new Map<string, number>();
    for (const { node, depth } of flat) map.set(node.path, depth);
    return map;
  }, [flat]);

  // ---- Inline input helpers ----
  const findInsertIndex = (parentPath: string): number => {
    if (!parentPath) return flat.length;
    const parentIdx = flat.findIndex((f) => f.node.path === parentPath);
    if (parentIdx === -1) return flat.length;
    const parentDepth = flat[parentIdx].depth;
    let i = parentIdx + 1;
    while (i < flat.length && flat[i].depth > parentDepth) i++;
    return i;
  };

  const renderInlineInput = (depth: number) => (
    <li
      key="__inline_edit__"
      style={{ marginLeft: `${depth * 20}px` }}
      className="flex items-center gap-2 rounded-md px-1.5 py-0.5"
    >
      <span className="w-3.5" />
      {inlineEdit?.kind === 'create' && inlineEdit.type === 'directory' ? (
        <Folder className="h-3.5 w-3.5 shrink-0 text-neutral-500 dark:text-neutral-400" strokeWidth={1.75} />
      ) : inlineEdit?.kind === 'create' ? (
        <FilePlus className="h-3.5 w-3.5 shrink-0 text-neutral-500 dark:text-neutral-400" strokeWidth={1.75} />
      ) : null}
      <input
        ref={inlineInputRef}
        defaultValue={inlineEdit?.kind === 'rename' ? inlineEdit.currentName : ''}
        onKeyDown={handleInlineKeyDown}
        onBlur={handleInlineBlur}
        className={cn(
          'min-w-0 flex-1 rounded border px-1.5 py-0.5 text-[13px] outline-none',
          'border-blue-400 bg-white text-neutral-900 focus:ring-1 focus:ring-blue-400',
          'dark:border-blue-500 dark:bg-neutral-900 dark:text-neutral-100',
        )}
      />
    </li>
  );

  const menuItemClass = cn(
    'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12px] transition-colors',
    'text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800',
  );
  const menuIconClass = 'h-3.5 w-3.5 shrink-0 text-neutral-500 dark:text-neutral-400';

  // ---- Render ----
  if (!platformInfo) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-white dark:bg-neutral-950">
      {/* ---- Root Selector ---- */}
      <div className="shrink-0 border-b border-neutral-200 dark:border-neutral-800">
        <div className="flex items-center gap-1.5 sm:gap-2 px-3 sm:px-6 py-2">
          <span className="text-[12px] font-medium text-neutral-500 dark:text-neutral-400 shrink-0">
            {t('files.rootDir')}:
          </span>
          <input
            type="text"
            value={customRoot}
            onChange={(e) => setCustomRoot(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleSwitchRoot(); }}
            placeholder={t('files.customPath') as string}
            className="min-w-0 flex-1 rounded-md border border-neutral-200 bg-white px-2 py-1 text-[13px] text-neutral-700 placeholder:text-neutral-400 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200 font-mono"
          />
          <div className="relative">
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); openDirBrowser(); }}
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-neutral-600 transition hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-900"
              title={t('files.switchRoot') as string}
            >
              <FolderOpen className="h-3.5 w-3.5" strokeWidth={1.75} />
            </button>
            {rootMenuOpen && (
              <div
                className="absolute right-0 top-8 z-20 w-80 rounded-lg border border-neutral-200 bg-white shadow-xl dark:border-neutral-700 dark:bg-neutral-950"
                onClick={(e) => e.stopPropagation()}
              >
                {/* Browser header */}
                <div className="flex items-center gap-1 border-b border-neutral-100 px-2 py-1.5 dark:border-neutral-800">
                  <button
                    type="button"
                    onClick={navigateBack}
                    disabled={browserHistory.length === 0}
                    className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-neutral-500 transition hover:bg-neutral-100 disabled:opacity-30 dark:text-neutral-400 dark:hover:bg-neutral-800"
                    title={t('files.navigateUp', { defaultValue: 'Go up' }) as string}
                  >
                    <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.75} />
                  </button>
                  <span className="min-w-0 flex-1 truncate text-[12px] font-mono text-neutral-600 dark:text-neutral-300 px-1">
                    {browserPath}
                  </span>
                  <button
                    type="button"
                    onClick={() => { setCustomRoot(browserPath); handleSwitchRoot(browserPath); }}
                    className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md bg-neutral-900 px-2 text-[11px] font-medium text-white transition hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
                  >
                    <Check className="h-3 w-3" strokeWidth={2} />
                    {t('files.select', { defaultValue: 'Select' })}
                  </button>
                </div>
                {/* Browser body */}
                <div className="max-h-64 overflow-y-auto py-1">
                  {browserLoading ? (
                    <div className="flex items-center justify-center py-6">
                      <Loader2 className="h-4 w-4 animate-spin text-neutral-400" strokeWidth={1.75} />
                    </div>
                  ) : browserDirs.length === 0 ? (
                    <p className="py-4 text-center text-[12px] text-neutral-400 dark:text-neutral-500">
                      {t('files.noDirs', { defaultValue: 'No subdirectories' })}
                    </p>
                  ) : (
                    browserDirs.map((d) => (
                      <button
                        key={d.path}
                        type="button"
                        onClick={() => navigateInto(d.path)}
                        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-neutral-700 transition hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
                      >
                        <Folder className="h-3.5 w-3.5 shrink-0 text-neutral-400" strokeWidth={1.75} />
                        <span className="min-w-0 truncate">{d.name}</span>
                      </button>
                    ))
                  )}
                </div>
                {/* Quick roots */}
                <div className="border-t border-neutral-100 dark:border-neutral-800 px-2 py-1.5">
                  <div className="flex flex-wrap gap-1">
                    {platformInfo.suggestedRoots.slice(0, 4).map((r) => (
                      <button
                        key={r}
                        type="button"
                        onClick={() => { setCustomRoot(r); handleSwitchRoot(r); }}
                        className="inline-flex items-center gap-1 rounded-md border border-neutral-200 px-2 py-0.5 text-[11px] text-neutral-500 transition hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800"
                      >
                        <Home className="h-3 w-3" strokeWidth={1.75} />
                        {r.split('/').pop() || r}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ---- Toolbar ---- */}
      <div className="flex shrink-0 items-center gap-0.5 sm:gap-1 flex-wrap border-b border-neutral-200 px-2 sm:px-3 py-1 dark:border-neutral-800">
        <button
          type="button"
          onClick={() => handleNewFile(rootPath, 0)}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-600 transition hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-900"
          title={t('files.newFile') as string}
        >
          <FilePlus className="h-3.5 w-3.5" strokeWidth={1.75} />
        </button>
        <button
          type="button"
          onClick={() => handleNewFolder(rootPath, 0)}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-600 transition hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-900"
          title={t('files.newFolder') as string}
        >
          <FolderPlus className="h-3.5 w-3.5" strokeWidth={1.75} />
        </button>

        {/* Upload dropdown */}
        <div className="relative">
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setUploadMenuOpen((o) => !o); }}
            disabled={uploading}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-600 transition hover:bg-neutral-100 disabled:opacity-50 dark:text-neutral-300 dark:hover:bg-neutral-900"
            title={t('files.upload') as string}
          >
            {uploading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} />
            ) : (
              <Upload className="h-3.5 w-3.5" strokeWidth={1.75} />
            )}
          </button>
          {uploadMenuOpen && (
            <div className="absolute left-0 top-8 z-20 w-36 rounded-md border border-neutral-200 bg-white py-1 text-[12px] shadow-lg dark:border-neutral-800 dark:bg-neutral-950">
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); setUploadMenuOpen(false); fileInputRef.current?.click(); }}
                className="block w-full px-3 py-1.5 text-left text-neutral-700 hover:bg-neutral-100 dark:text-neutral-200 dark:hover:bg-neutral-900"
              >
                {t('files.uploadFiles')}
              </button>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); setUploadMenuOpen(false); folderInputRef.current?.click(); }}
                className="block w-full px-3 py-1.5 text-left text-neutral-700 hover:bg-neutral-100 dark:text-neutral-200 dark:hover:bg-neutral-900"
              >
                {t('files.uploadFolder')}
              </button>
            </div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => { void uploadSelectedFiles(e.currentTarget.files); e.currentTarget.value = ''; }}
          />
          <input
            ref={setFolderInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => { void uploadSelectedFiles(e.currentTarget.files); e.currentTarget.value = ''; }}
          />
        </div>

        <button
          type="button"
          onClick={handleDownloadZip}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-600 transition hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-900"
          title={t('files.downloadZip') as string}
        >
          <Download className="h-3.5 w-3.5" strokeWidth={1.75} />
        </button>
        <button
          type="button"
          onClick={handleDeleteActive}
          disabled={!activePath}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-600 transition hover:bg-neutral-100 disabled:opacity-40 dark:text-neutral-300 dark:hover:bg-neutral-900"
          title={t('files.deleteSelected') as string}
        >
          <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
        </button>
        <button
          type="button"
          onClick={fetchFiles}
          disabled={loading}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-600 transition hover:bg-neutral-100 disabled:opacity-50 dark:text-neutral-300 dark:hover:bg-neutral-900"
          title={t('files.refresh') as string}
        >
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} strokeWidth={1.75} />
        </button>
        <button
          type="button"
          onClick={collapseAll}
          disabled={expanded.size === 0}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-600 transition hover:bg-neutral-100 disabled:opacity-40 dark:text-neutral-300 dark:hover:bg-neutral-900"
          title={t('files.collapseAll') as string}
        >
          <ChevronsDownUp className="h-3.5 w-3.5" strokeWidth={1.75} />
        </button>
      </div>

      {/* ---- Body: Tree + Preview ---- */}
      <div className="min-h-0 flex-1 flex max-sm:flex-col">
        {/* File Tree — stacks on mobile, split on desktop */}
        <div
          className={`min-h-0 overflow-y-auto py-2 text-[13px] ${selectedFile ? 'w-1/2 max-sm:w-full border-r max-sm:border-r-0 max-sm:border-b border-neutral-200 dark:border-neutral-800 max-sm:flex-[0_0_40%]' : 'flex-1'}`}
          onContextMenu={handleBlankContextMenu}
        >
          {loading && files.length === 0 ? (
            <div className="flex items-center justify-center gap-2 py-6 text-neutral-500 dark:text-neutral-400">
              <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} />
              <span>{t('common.loading')}</span>
            </div>
          ) : flat.length === 0 ? (
            <div className="py-6 text-center text-neutral-500 dark:text-neutral-400">
              {t('files.empty')}
            </div>
          ) : (
            <ul className="space-y-0.5 px-4">
              {flat.map(({ node, depth }, idx) => {
                const isDir = node.type === 'directory';
                const isOpen = isDir && expanded.has(node.path);
                const isActive = activePath === node.path;
                const isRenaming = inlineEdit?.kind === 'rename' && inlineEdit.path === node.path;

                let Icon = Folder;
                let color = 'text-neutral-500 dark:text-neutral-400';
                if (isDir) {
                  Icon = isOpen ? FolderOpen : Folder;
                } else {
                  const iconData = getFileIconData(node.name);
                  Icon = iconData.icon;
                  color = iconData.color;
                }

                const showCreateAfter =
                  inlineEdit?.kind === 'create' &&
                  findInsertIndex(inlineEdit.parentPath) === idx + 1;

                return (
                  <li key={node.path} onContextMenu={(e) => handleContextMenu(e, node)}>
                    {isRenaming ? (
                      <div style={{ marginLeft: `${depth * 20}px` }} className="flex items-center gap-2 rounded-md px-1.5 py-0.5">
                        {isDir ? (
                          <ChevronRight className="h-3.5 w-3.5 text-neutral-500 dark:text-neutral-400" strokeWidth={1.75} />
                        ) : (
                          <span className="w-3.5" />
                        )}
                        <Icon className={cn('h-3.5 w-3.5 shrink-0', color)} strokeWidth={1.75} />
                        <input
                          ref={inlineInputRef}
                          defaultValue={inlineEdit!.kind === 'rename' ? inlineEdit!.currentName : ''}
                          onKeyDown={handleInlineKeyDown}
                          onBlur={handleInlineBlur}
                          className={cn(
                            'min-w-0 flex-1 rounded border px-1.5 py-0.5 text-[13px] outline-none',
                            'border-blue-400 bg-white text-neutral-900 focus:ring-1 focus:ring-blue-400',
                            'dark:border-blue-500 dark:bg-neutral-900 dark:text-neutral-100',
                          )}
                        />
                      </div>
                    ) : (
                      <div
                        onClick={() => { void handleClick(node); }}
                        style={{ marginLeft: `${depth * 20}px` }}
                        className={cn(
                          'group/row flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 transition-colors',
                          isActive
                            ? 'bg-neutral-100 dark:bg-neutral-900'
                            : 'hover:bg-neutral-50 dark:hover:bg-neutral-900/60',
                        )}
                      >
                        {isDir ? (
                          isOpen ? (
                            <ChevronDown className="h-3.5 w-3.5 text-neutral-500 dark:text-neutral-400" strokeWidth={1.75} />
                          ) : (
                            <ChevronRight className="h-3.5 w-3.5 text-neutral-500 dark:text-neutral-400" strokeWidth={1.75} />
                          )
                        ) : (
                          <span className="w-3.5" />
                        )}
                        <Icon className={cn('h-3.5 w-3.5 shrink-0', color)} strokeWidth={1.75} />
                        <span className={cn(
                          'min-w-0 flex-1 truncate',
                          isActive ? 'font-medium text-neutral-900 dark:text-neutral-100' : 'text-neutral-700 dark:text-neutral-300',
                        )}>
                          {node.name}
                        </span>
                        {!isDir && (
                          <button
                            type="button"
                            onClick={(e) => handleDownloadFile(e, node)}
                            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-neutral-500 opacity-0 transition group-hover/row:opacity-100 hover:bg-neutral-200 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
                            title={t('files.download') as string}
                          >
                            <Download className="h-3.5 w-3.5" strokeWidth={1.75} />
                          </button>
                        )}
                      </div>
                    )}
                    {showCreateAfter ? renderInlineInput(inlineEdit.depth) : null}
                  </li>
                );
              })}
              {inlineEdit?.kind === 'create' && flat.length === 0 ? renderInlineInput(inlineEdit.depth) : null}
            </ul>
          )}
        </div>

        {/* File Preview / Editor — full-width on mobile */}
        {selectedFile && (
          <div className="flex w-1/2 max-sm:w-full min-h-0 flex-col max-sm:flex-1">
            <div className="flex shrink-0 items-center justify-between border-b border-neutral-200 px-4 py-2 dark:border-neutral-800">
              <div className="min-w-0 flex-1">
                <h3 className="truncate text-[13px] font-medium text-neutral-900 dark:text-neutral-100">
                  {selectedFile.split('/').pop()}
                </h3>
                <p className="truncate text-[11px] text-neutral-400 dark:text-neutral-500 font-mono">
                  {selectedFile}
                </p>
              </div>
              <button
                type="button"
                onClick={() => { setSelectedFile(null); setFileContent(''); setFileError(''); }}
                className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800 ml-2"
              >
                <X className="h-3.5 w-3.5" strokeWidth={1.75} />
              </button>
            </div>
            {fileError ? (
              <div className="flex flex-1 items-center justify-center text-[13px] text-neutral-500 dark:text-neutral-400 px-4">
                {fileError}
              </div>
            ) : fileLoading ? (
              <div className="flex flex-1 items-center justify-center">
                <Spinner />
              </div>
            ) : (
              <>
                <div className="min-h-0 flex-1 overflow-hidden p-4">
                  <textarea
                    value={fileContent}
                    onChange={(e) => setFileContent(e.target.value)}
                    className="w-full h-full resize-none rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-400 focus:outline-none dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100 font-mono"
                  />
                </div>
                <div className="flex shrink-0 items-center justify-end gap-2 border-t border-neutral-200 px-4 py-2 dark:border-neutral-800">
                  {fileContent !== fileOrigContent && (
                    <Button variant="ghost" size="sm" onClick={() => setFileContent(fileOrigContent)}>
                      {t('skills.revert')}
                    </Button>
                  )}
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => { void handleFileSave(); }}
                    loading={fileSaving}
                    disabled={fileContent === fileOrigContent}
                  >
                    <Save className="h-3.5 w-3.5" strokeWidth={1.75} />
                    <span>{t('skills.save')}</span>
                  </Button>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* ---- Context Menu ---- */}
      {contextMenu && (
        <div
          role="menu"
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
          className={cn(
            'fixed z-50 w-44 rounded-lg border bg-white p-1 shadow-lg',
            'border-neutral-200 dark:border-neutral-700 dark:bg-neutral-900',
          )}
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          {contextMenu.node ? (
            <>
              {contextMenu.node.type === 'directory' ? (
                <>
                  <button type="button" role="menuitem"
                    onClick={() => handleNewFile(contextMenu.node!.path, (depthByPath.get(contextMenu.node!.path) ?? 0) + 1)}
                    className={menuItemClass}>
                    <FilePlus className={menuIconClass} strokeWidth={1.75} />
                    {t('files.newFile')}
                  </button>
                  <button type="button" role="menuitem"
                    onClick={() => handleNewFolder(contextMenu.node!.path, (depthByPath.get(contextMenu.node!.path) ?? 0) + 1)}
                    className={menuItemClass}>
                    <FolderPlus className={menuIconClass} strokeWidth={1.75} />
                    {t('files.newFolder')}
                  </button>
                  <div className="my-1 border-t border-neutral-100 dark:border-neutral-800" />
                </>
              ) : (
                <button type="button" role="menuitem"
                  onClick={() => handleDownloadFile(null, contextMenu.node!)}
                  className={menuItemClass}>
                  <Download className={menuIconClass} strokeWidth={1.75} />
                  {t('files.download')}
                </button>
              )}
              <button type="button" role="menuitem"
                onClick={() => handleRename(contextMenu.node!, depthByPath.get(contextMenu.node!.path) ?? 0)}
                className={menuItemClass}>
                <Pencil className={menuIconClass} strokeWidth={1.75} />
                {t('files.rename')}
              </button>
              <button type="button" role="menuitem"
                onClick={() => handleCopyPath(contextMenu.node!)}
                className={menuItemClass}>
                <ClipboardCopy className={menuIconClass} strokeWidth={1.75} />
                {t('files.copyPath')}
              </button>
              <div className="my-1 border-t border-neutral-100 dark:border-neutral-800" />
              <button type="button" role="menuitem"
                onClick={() => handleDelete(contextMenu.node!)}
                className={cn(menuItemClass, 'text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/30')}>
                <Trash2 className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
                {t('files.delete')}
              </button>
            </>
          ) : (
            <>
              <button type="button" role="menuitem" onClick={() => handleNewFile(rootPath, 0)} className={menuItemClass}>
                <FilePlus className={menuIconClass} strokeWidth={1.75} />
                {t('files.newFile')}
              </button>
              <button type="button" role="menuitem" onClick={() => handleNewFolder(rootPath, 0)} className={menuItemClass}>
                <FolderPlus className={menuIconClass} strokeWidth={1.75} />
                {t('files.newFolder')}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
