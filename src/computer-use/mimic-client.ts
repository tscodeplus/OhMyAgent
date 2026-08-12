// src/computer-use/mimic-client.ts
//
// HTTP client for the mimic Android accessibility-service REST API.
// mimic(github.com/khimaros/mimic)在手机端(默认 127.0.0.1:8473)暴露一个
// token 门禁的 REST 服务:POST /v1/<cmd>,JSON 请求体,token 经
// x-mimic-token 头(或 ?token= 查询参数)携带,响应信封为 { ok, error?, data? }。
//
// 命令:DUMP/FIND/TAP/CLICK/SET_TEXT/SCROLL/SWIPE/GLOBAL/LAUNCH/
// SCREENSHOT/STATUS。树节点字段在不同 mimic 版本间差异较大(desc/
// contentDescription、id/resourceId、bounds 数组或对象等),这里统一做
// 容错归一化,所有字段访问走安全取值、缺字段给默认值。

import type { Logger } from 'pino';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MimicNodeBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** 归一化后的无障碍树节点(容错映射 mimic 各版本的输出差异)。 */
export interface MimicNode {
  text?: string;
  contentDescription?: string;
  resourceId?: string;
  className?: string;
  bounds?: MimicNodeBounds;
  clickable?: boolean;
  focusable?: boolean;
  enabled?: boolean;
  focused?: boolean;
  actions?: string[];
  children?: MimicNode[];
}

export interface MimicTree {
  /** 归一化后的节点列表(tree 格式含 children 嵌套;flat 格式为平铺)。 */
  elements: MimicNode[];
  /** 原始响应 data,供调用方做尽力而为的字段探测。 */
  raw?: unknown;
}

export interface MimicClientOptions {
  baseUrl: string;
  token?: string;
  logger?: Logger;
  /** 单次请求超时(ms)。默认 10000。 */
  timeoutMs?: number;
}

export type MimicErrorKind = 'auth' | 'connection' | 'http' | 'api';

export class MimicError extends Error {
  readonly kind: MimicErrorKind;
  readonly status?: number;
  readonly apiError?: string;

  constructor(
    kind: MimicErrorKind,
    message: string,
    opts?: { status?: number; apiError?: string; cause?: unknown },
  ) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'MimicError';
    this.kind = kind;
    this.status = opts?.status;
    this.apiError = opts?.apiError;
  }
}

export function isMimicError(err: unknown): err is MimicError {
  return err instanceof MimicError;
}

// ---------------------------------------------------------------------------
// 容错归一化 helpers
// ---------------------------------------------------------------------------

function asRecord(v: unknown): Record<string, unknown> {
  return v != null && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

function toNumber(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

function toBoolean(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return undefined;
}

function str(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  // 只过滤空字符串,保留原始值 —— 占位符 '\n'(小米笔记内容框)等
  // 空白文本也是有效定位依据(by=text 精确匹配需要原样)。
  return v.length > 0 ? v : undefined;
}

/**
 * 从任意形状的矩形描述中提取 {left,top,right,bottom}:
 * - 数组 [l, t, r, b]
 * - 对象 {left,top,right,bottom} / {x,y,width,height} / {x,y,w,h}
 * - 仅 center [cx, cy](部分版本无 bounds 只有 center)
 */
function tryRect(v: unknown): MimicNodeBounds | undefined {
  if (Array.isArray(v)) {
    const [l, t, r, b] = v.map(toNumber);
    if (l != null && t != null && r != null && b != null) {
      return { left: l, top: t, right: r, bottom: b };
    }
    return undefined;
  }
  const rec = asRecord(v);
  const left = toNumber(rec.left) ?? toNumber(rec.leftX);
  const top = toNumber(rec.top) ?? toNumber(rec.topY);
  const right = toNumber(rec.right) ?? toNumber(rec.rightX);
  const bottom = toNumber(rec.bottom) ?? toNumber(rec.bottomY);
  if (left != null && top != null && right != null && bottom != null) {
    return { left, top, right, bottom };
  }
  const x = toNumber(rec.x);
  const y = toNumber(rec.y);
  const w = toNumber(rec.width) ?? toNumber(rec.w);
  const h = toNumber(rec.height) ?? toNumber(rec.h);
  if (x != null && y != null && w != null && h != null) {
    return { left: x, top: y, right: x + w, bottom: y + h };
  }
  if (Array.isArray(rec.center)) {
    const [cx, cy] = rec.center.map(toNumber);
    if (cx != null && cy != null) {
      return { left: cx, top: cy, right: cx, bottom: cy };
    }
  }
  return undefined;
}

/** 节点可能自带 bounds 对象,也可能字段直接平铺在节点顶层。 */
function normalizeBounds(raw: Record<string, unknown>): MimicNodeBounds | undefined {
  return tryRect(raw.bounds) ?? tryRect(raw);
}

function normalizeNode(raw: unknown): MimicNode | null {
  const rec = asRecord(raw);
  const bounds = normalizeBounds(rec);
  const childrenRaw = Array.isArray(rec.children)
    ? rec.children
    : Array.isArray(rec.nodes)
      ? rec.nodes
      : [];
  const children = childrenRaw
    .map(normalizeNode)
    .filter((n): n is MimicNode => n != null);
  const actionsRaw = Array.isArray(rec.actions)
    ? rec.actions
    : Array.isArray(rec.actionList)
      ? rec.actionList
      : [];
  const actions = actionsRaw.length > 0
    ? actionsRaw.filter((a): a is string => typeof a === 'string')
    : undefined;

  const text = str(rec.text);
  const contentDescription = str(rec.desc) ?? str(rec.contentDescription) ?? str(rec.content_desc);
  const resourceId = str(rec.id) ?? str(rec.resourceId) ?? str(rec.resource_id);
  const className = str(rec.class) ?? str(rec.className) ?? str(rec.clazz);

  // 全空节点(无任何可识别字段)跳过
  if (
    text == null &&
    contentDescription == null &&
    resourceId == null &&
    className == null &&
    bounds == null &&
    actions == null &&
    children.length === 0
  ) {
    return null;
  }

  return {
    text,
    contentDescription,
    resourceId,
    className,
    bounds,
    clickable: toBoolean(rec.clickable),
    focusable: toBoolean(rec.focusable),
    enabled: toBoolean(rec.enabled),
    focused: toBoolean(rec.focused) ?? toBoolean(rec.isFocused),
    actions,
    children: children.length > 0 ? children : undefined,
  };
}

function flattenNodes(nodes: MimicNode[]): MimicNode[] {
  const out: MimicNode[] = [];
  for (const node of nodes) {
    out.push(node);
    if (node.children) out.push(...flattenNodes(node.children));
  }
  return out;
}

/** 响应 data 可能是数组、{nodes:[]}、{tree:[]}、{elements:[]} 等形状。 */
function normalizeTreeData(data: unknown): MimicNode[] {
  const rec = asRecord(data);
  const nodesRaw = Array.isArray(data)
    ? data
    : Array.isArray(rec.nodes)
      ? rec.nodes
      : Array.isArray(rec.tree)
        ? rec.tree
        : Array.isArray(rec.elements)
          ? rec.elements
          : Array.isArray(rec.children)
            ? rec.children
            : [];
  return flattenNodes(nodesRaw.map(normalizeNode).filter((n): n is MimicNode => n != null));
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

interface MimicEnvelope {
  ok: boolean;
  error?: string;
  data?: unknown;
}

export class MimicClient {
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly logger?: Logger;
  private readonly timeoutMs: number;

  constructor(options: MimicClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.token = options.token || undefined;
    this.logger = options.logger;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  /**
   * POST /v1/<cmd>。非 2xx / 信封 ok=false / 连接失败 / 超时均抛 MimicError。
   * 非 JSON 响应(旧版本或代理页)不抛,按原始文本透传,便于调用方容错;
   * binary 模式(如 SCREENSHOT 返回裸图片字节)下非 JSON 响应转 base64 返回。
   */
  private async _request(
    cmd: string,
    args: Record<string, unknown> = {},
    opts: { binary?: boolean } = {},
  ): Promise<MimicEnvelope> {
    const url = `${this.baseUrl}/v1/${cmd}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let res: Response;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(this.token ? { 'x-mimic-token': this.token } : {}),
          },
          body: JSON.stringify(args),
          signal: controller.signal,
        });
      } catch (err) {
        if (isAbortError(err)) {
          throw new MimicError('connection', `mimic 请求超时(${this.timeoutMs}ms):${url}`, { cause: err });
        }
        throw new MimicError(
          'connection',
          `无法连接 mimic 服务(${url}):${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }

      if (!res.ok) {
        if (res.status === 401) {
          throw new MimicError('auth', 'mimic 认证失败(HTTP 401):token 无效或未配置', { status: 401 });
        }
        if (res.status === 403) {
          throw new MimicError('http', 'mimic 拒绝访问(HTTP 403)', { status: 403 });
        }
        if (res.status === 404) {
          throw new MimicError('http', `mimic 接口不存在(HTTP 404):${cmd}`, { status: 404 });
        }
        throw new MimicError('http', `mimic 请求失败(HTTP ${res.status})`, { status: res.status });
      }

      // 先读原始字节(裸图片等二进制响应经 text() 会损坏),
      // mock 响应只提供 text() 时降级编码,保证兼容。
      const buf =
        typeof res.arrayBuffer === 'function'
          ? await res.arrayBuffer()
          : new TextEncoder().encode(await res.text()).buffer;
      const text = new TextDecoder().decode(buf);
      let parsed: unknown;
      if (text.trim()) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = undefined;
        }
      }
      if (parsed === undefined) {
        // 非 JSON 响应:binary 模式把原始字节转 base64,否则按原始文本透传
        return opts.binary
          ? { ok: true, data: Buffer.from(buf).toString('base64') }
          : { ok: true, data: text };
      }
      const env = asRecord(parsed);
      const envError = str(env.error);
      if (env.ok === false || envError != null) {
        throw new MimicError('api', `mimic ${cmd} 失败:${envError ?? '未知错误'}`, {
          apiError: envError,
        });
      }
      return { ok: true, error: envError, data: env.data };
    } finally {
      clearTimeout(timer);
    }
  }

  /** 轻量探测:树 dump(flat + interactive 最小载荷),供 getStatus 使用。 */
  async ping(): Promise<void> {
    await this.getTree({ format: 'flat', filter: 'interactive' });
  }

  /**
   * 树 dump。opts 与 mimic 的 DUMP 参数对应;格式兼容差异见文件头注释。
   */
  async getTree(opts: {
    format?: 'tree' | 'flat' | 'compact';
    filter?: 'interactive' | 'text' | 'visible' | 'all';
    by?: 'text' | 'id' | 'class' | 'desc';
    query?: string;
    maxDepth?: number;
    packageName?: string;
  } = {}): Promise<MimicTree> {
    const args: Record<string, unknown> = {};
    if (opts.format) args.format = opts.format;
    if (opts.filter) args.filter = opts.filter;
    if (opts.by) args.by = opts.by;
    if (opts.query) args.query = opts.query;
    if (opts.maxDepth != null) args.max_depth = opts.maxDepth;
    if (opts.packageName) args.package = opts.packageName;
    const env = await this._request('DUMP', args);
    return { elements: normalizeTreeData(env.data), raw: env.data };
  }

  /** 按坐标 tap(仅 click_point 显式坐标与 click_element 兜底使用)。 */
  async tap(x: number, y: number): Promise<void> {
    await this._request('TAP', { x: Math.round(x), y: Math.round(y) });
  }

  /**
   * 按文本 / contentDescription / resource-id 点击无障碍节点(主路径,
   * 不注入触摸)。优先级 text → desc → id。mimic 协议要求显式 by/query
   * (by 缺省时 mimic 走坐标分支,对缺 x 参数抛 "missing or invalid
   * integer argument: x");desc 用于 text 属性为空、只有
   * contentDescription 的节点(图片按钮等)。
   */
  async clickNode(text?: string, desc?: string, id?: string): Promise<void> {
    if (text) {
      await this._request('CLICK', { by: 'text', query: text });
      return;
    }
    if (desc) {
      await this._request('CLICK', { by: 'desc', query: desc });
      return;
    }
    if (id) {
      await this._request('CLICK', { by: 'id', query: id });
      return;
    }
    throw new MimicError('api', 'clickNode 需要 text/desc/id');
  }

  /** 文本输入:无 by/query 时作用于当前聚焦字段。 */
  async setText(text: string): Promise<void> {
    await this._request('SET_TEXT', { text });
  }

  /**
   * 文本输入:按 by/query 直接定位目标节点,不依赖"当前聚焦字段"。
   * WebView 输入框(小米笔记等)对坐标 TAP/无障碍 CLICK 的聚焦都不可靠,
   * 显式定位(SET_TEXT {by,query,text})是稳定路径。
   */
  async setTextByQuery(
    by: 'text' | 'id' | 'class' | 'desc',
    query: string,
    text: string,
  ): Promise<void> {
    await this._request('SET_TEXT', { by, query, text });
  }

  /** 滚动。direction: up/down/left/right;带 query 时滚动直到节点出现。 */
  async scroll(
    direction: 'up' | 'down' | 'left' | 'right',
    opts?: { query?: string; steps?: number },
  ): Promise<void> {
    const args: Record<string, unknown> = { direction };
    if (opts?.query) args.query = opts.query;
    if (opts?.steps != null) args.steps = opts.steps;
    await this._request('SCROLL', args);
  }

  /** 坐标滑动(SCROLL 不可用时的兜底;方向换算由调用方完成)。 */
  async swipe(x1: number, y1: number, x2: number, y2: number, durationMs?: number): Promise<void> {
    const args: Record<string, unknown> = {
      x: Math.round(x1),
      y: Math.round(y1),
      x2: Math.round(x2),
      y2: Math.round(y2),
    };
    if (durationMs != null) args.duration = durationMs;
    await this._request('SWIPE', args);
  }

  /** 全局导航(back/home/recents/notifications 经 GLOBAL + nav 实现)。 */
  async globalNav(nav: 'back' | 'home' | 'recents' | 'notifications'): Promise<void> {
    await this._request('GLOBAL', { nav });
  }

  async back(): Promise<void> {
    await this.globalNav('back');
  }

  async home(): Promise<void> {
    await this.globalNav('home');
  }

  async recents(): Promise<void> {
    await this.globalNav('recents');
  }

  async notifications(): Promise<void> {
    await this.globalNav('notifications');
  }

  /**
   * 截图,返回 base64(png)。mimic 的 SCREENSHOT 返回裸图片字节(非 JSON 信封),
   * binary 模式直接把原始字节转 base64;部分版本返回 JSON base64 字符串,
   * 两种形状都兼容。
   */
  async screenshot(format: 'png' | 'jpeg' = 'png'): Promise<string> {
    const env = await this._request('SCREENSHOT', { format }, { binary: true });
    if (typeof env.data === 'string' && env.data.length > 0) {
      return env.data;
    }
    // 部分版本可能嵌套 { data: base64 }
    const nested = asRecord(env.data);
    const nestedData = typeof nested.data === 'string' ? nested.data : undefined;
    if (nestedData && nestedData.length > 0) {
      return nestedData;
    }
    throw new MimicError('api', 'mimic SCREENSHOT 返回格式无法识别');
  }

  /** 服务端状态(版本/无障碍服务开关等),供诊断使用。 */
  async status(): Promise<unknown> {
    const env = await this._request('STATUS');
    return env.data;
  }

}
