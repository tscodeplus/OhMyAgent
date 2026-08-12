// src/computer-use/providers/node-provider.ts
//
// NodeComputerUseProvider —— Android 无障碍优先(node)平台线:
// 交互层走手机端 mimic 无障碍服务 APK 的 HTTP REST 接口(不注入触摸,
// click 走无障碍节点事件),adb 仅做电源/锁屏管理(唤醒/常亮/恢复,可选启用)。
//
// 依赖 settings.node.url(必填)与 settings.node.token / settings.node.adb(可选)。

import type { ComputerUseProvider } from '../provider-contract.js';
import { normalizeComputerProviderCapabilities } from '../provider-contract.js';
import type {
  Ctx,
  ProviderStatus,
  AppInfo,
  Lease,
  Target,
  AppState,
  UIElement,
  Action,
  ActionResult,
} from '../types.js';
import type { ComputerUseSettings } from '../settings.js';
import { computerUseError } from '../errors.js';
import { MimicClient, MimicError, type MimicNode } from '../mimic-client.js';
import { AndroidAdb } from '../android-adb.js';
import type { Logger } from 'pino';

const DEFAULT_DISPLAY = { width: 1080, height: 2400 };

/** className → role 映射表(TS 侧,吸收 Android/mimic 各版本差异)。 */
const CLASS_TO_ROLE: Array<[RegExp, string]> = [
  [/EditText/, 'textbox'],
  [/TextView/, 'text'],
  [/Button/, 'button'],
  [/ImageButton/, 'button'],
  [/CheckBox|CheckedTextView/, 'checkbox'],
  [/RadioButton/, 'radio'],
  [/Switch/, 'switch'],
  [/Spinner/, 'combobox'],
  [/ScrollView|NestedScrollView/, 'scroll'],
  [/RecyclerView|ListView/, 'list'],
  [/Toolbar|ActionBar/, 'toolbar'],
  [/LinearLayout|FrameLayout|RelativeLayout|ConstraintLayout/, 'group'],
];

function roleFromClass(className?: string): string {
  if (!className) return 'unknown';
  for (const [re, role] of CLASS_TO_ROLE) {
    if (re.test(className)) return role;
  }
  // 兜底:取最后一段小写,如 android.widget.ProgressBar → progressbar
  const last = className.split('.').pop() ?? className;
  return last.toLowerCase() || 'unknown';
}

function asRecord(v: unknown): Record<string, unknown> {
  return v != null && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

/**
 * elementId 是否为"无 resourceId/文本时的索引伪 id"(n0, n1, ...)。
 * 伪 id 不是真实 resourceId,发给 mimic 的 CLICK by:id 必然失败,
 * 应走 bounds 中心 tap 兜底。
 */
function isPseudoElementId(id: string | undefined): boolean {
  return !!id && /^n\d+$/.test(id);
}

/** 尽力而为的深层字段探测(树 dump 的包名/活动名等)。 */
function deepPick(root: unknown, keys: string[]): unknown {
  if (root == null) return undefined;
  const rec = asRecord(root);
  for (const key of keys) {
    const v = rec[key];
    if (typeof v === 'string' && v.trim()) return v;
  }
  for (const wrapper of ['data', 'result', 'payload']) {
    const v = rec[wrapper];
    if (v != null && typeof v === 'object') {
      const found = deepPick(v, keys);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/** scroll 兜底为坐标 swipe 时,把方向换算成起止点(相对显示尺寸)。 */
function swipePoints(direction: 'up' | 'down' | 'left' | 'right', display: { width: number; height: number }): [number, number, number, number] {
  const { width, height } = display;
  const cx = Math.round(width / 2);
  const cy = Math.round(height / 2);
  switch (direction) {
    case 'up':
      return [cx, Math.round(height * 0.8), cx, Math.round(height * 0.2)];
    case 'down':
      return [cx, Math.round(height * 0.2), cx, Math.round(height * 0.8)];
    case 'left':
      return [Math.round(width * 0.8), cy, Math.round(width * 0.2), cy];
    case 'right':
      return [Math.round(width * 0.2), cy, Math.round(width * 0.8), cy];
  }
}

/** 把 MimicError/未知错误映射为可读提示。 */
function mimicErrorMessage(err: unknown, url: string): string {
  if (err instanceof MimicError) {
    switch (err.kind) {
      case 'auth':
        return '手机端 token 无效';
      case 'connection':
        return `无法连接手机端服务(${url}),请确认 APK 已开启无障碍服务且网络可达`;
      case 'api':
        if (err.apiError && /accessibility|无障碍|enabled/i.test(err.apiError)) {
          return `手机端无障碍服务未开启:${err.apiError}`;
        }
        return err.message;
      default:
        return err.message;
    }
  }
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class NodeComputerUseProvider implements ComputerUseProvider {
  readonly providerId = 'node';
  readonly capabilities = normalizeComputerProviderCapabilities({
    platform: 'linux',
    observationModes: ['vision-native', 'accessibility-only'],
    screenshot: true,
    accessibilityTree: true,
    elementActions: 'semantic',
    elementDoubleClick: false,
    backgroundControl: 'full',
    pointClick: 'allowed',
    drag: 'unsupported',
    textInput: 'semantic',
    keyboardInput: 'foreground',
    requiresForegroundForInput: false,
    nativeCursor: false,
    isolated: false,
    supportsFocusApp: false,
    supportsCloseApp: false,
  });

  private readonly settings: ComputerUseSettings;
  private readonly logger?: Logger;
  private readonly client: MimicClient;
  private readonly adb: AndroidAdb;
  /** getAppState 推断的显示尺寸,供 scroll 的 swipe 兜底使用。 */
  private _display = DEFAULT_DISPLAY;

  constructor(options: { settings: ComputerUseSettings; logger?: Logger }) {
    this.settings = options.settings;
    this.logger = options.logger;
    const node = this.settings.node;
    this.client = new MimicClient({
      baseUrl: node.url,
      token: node.token || undefined,
      logger: options.logger,
    });
    this.adb = new AndroidAdb({
      path: node.adb?.path || 'adb',
      serial: node.adb?.serial || undefined,
      logger: options.logger,
    });
  }

  private get _url(): string {
    return this.settings.node.url;
  }

  private get _manageScreen(): boolean {
    return this.settings.node.adb?.manageScreen === true;
  }

  private _assertConfigured(): void {
    if (!this._url) {
      throw computerUseError('PROVIDER_UNAVAILABLE', 'node provider 未配置 computerUse.node.url');
    }
  }

  // -----------------------------------------------------------------------
  // Status
  // -----------------------------------------------------------------------

  async getStatus(_ctx: Ctx): Promise<ProviderStatus> {
    if (!this._url) {
      return {
        providerId: 'node',
        available: false,
        permissions: [],
        message: 'computerUse.node.url 未配置',
      };
    }
    try {
      // STATUS 轻量探测(全量 DUMP 过重);顺带把"无障碍服务未开启"透出
      const data = asRecord(await this.client.status());
      const serviceEnabled =
        data.service_enabled ??
        data.serviceEnabled ??
        data.accessibility_enabled ??
        data.accessibilityEnabled ??
        data.enabled;
      if (serviceEnabled === false || serviceEnabled === 'false') {
        return {
          providerId: 'node',
          available: false,
          permissions: [],
          message: '手机端无障碍服务未开启,请先在系统设置中开启 mimic 的无障碍服务',
        };
      }
      return { providerId: 'node', available: true, permissions: [] };
    } catch (err) {
      return {
        providerId: 'node',
        available: false,
        permissions: [],
        message: mimicErrorMessage(err, this._url),
      };
    }
  }

  // -----------------------------------------------------------------------
  // Application listing
  // -----------------------------------------------------------------------

  async listApps(_ctx: Ctx): Promise<AppInfo[]> {
    if (!this._url) return [];
    try {
      // 尽力而为:树 dump 顶部包名/活动名
      const tree = await this.client.getTree({ format: 'flat', filter: 'interactive' });
      const pkg = deepPick(tree.raw, ['package', 'packageName', 'pkg', 'package_name']);
      const activity = deepPick(tree.raw, ['activity', 'activityName', 'windowTitle', 'title']);
      const root = tree.elements[0];
      const appId =
        (typeof pkg === 'string' && pkg ? pkg : undefined) ??
        (root?.className ? `app.${roleFromClass(root.className)}` : '');
      if (!appId) return [];
      const name =
        (typeof activity === 'string' && activity ? activity : undefined) ??
        (typeof pkg === 'string' && pkg ? pkg : undefined) ??
        root?.className ??
        appId;
      return [
        {
          appId,
          name,
          running: true,
          windows: [{ windowId: appId, title: name }],
        },
      ];
    } catch (err) {
      this.logger?.warn({ err }, 'node provider listApps failed');
      return [];
    }
  }

  // -----------------------------------------------------------------------
  // Lease lifecycle
  // -----------------------------------------------------------------------

  async createLease(ctx: Ctx, target: Target): Promise<Lease> {
    this._assertConfigured();
    if (this._manageScreen) {
      try {
        await this.adb.wakeAndUnlock();
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        this.logger?.warn({ err }, 'wakeAndUnlock failed');
        // dismiss-keyguard 失败时 android-adb 已带"手动解锁"提示,避免重复
        throw detail.includes('手动解锁')
          ? new Error(detail)
          : new Error(`无法唤醒手机屏幕(${detail});若有密码锁屏请先手动解锁`);
      }
    }
    return {
      leaseId: `node-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      sessionPath: ctx.sessionPath ?? '',
      agentId: ctx.agentId ?? '',
      providerId: 'node',
      appId: target.appId ?? target.appName ?? 'unknown',
      windowId: target.windowId,
      createdAt: new Date().toISOString(),
      status: 'active',
      allowedActions: ['click_element', 'click_point', 'type_text', 'scroll', 'stop'],
      providerState: { manageScreen: this._manageScreen, url: this._url },
    };
  }

  async releaseLease(_ctx: Ctx, _lease: Lease): Promise<void> {
    await this._restoreIfManaged();
  }

  async stop(_ctx: Ctx, _lease: Lease): Promise<void> {
    await this._restoreIfManaged();
  }

  private async _restoreIfManaged(): Promise<void> {
    if (!this._manageScreen) return;
    try {
      await this.adb.restoreScreen();
    } catch (err) {
      this.logger?.warn({ err }, 'restoreScreen failed');
    }
  }

  // -----------------------------------------------------------------------
  // App state
  // -----------------------------------------------------------------------

  async getAppState(_ctx: Ctx, _lease: Lease): Promise<AppState> {
    this._assertConfigured();
    if (this._manageScreen) {
      try {
        // 确保常亮
        await this.adb.wakeAndUnlock();
      } catch (err) {
        this.logger?.warn({ err }, 'keep screen awake failed');
      }
    }
    // filter=text:interactive/visible 会过滤掉输入框(EditText),导致模型
    // 视野里没有输入框、无法语义定位(2026-08-12 实机验证)。
    const tree = await this.client.getTree({ format: 'tree', filter: 'text' });
    const elements = tree.elements.map((node, i) => this._toUIElement(node, i));

    // display:用节点 bounds 推断最大范围,缺省 1080x2400
    const maxRight = elements.reduce((m, e) => Math.max(m, e.bounds.x + e.bounds.width), 0);
    const maxBottom = elements.reduce((m, e) => Math.max(m, e.bounds.y + e.bounds.height), 0);
    if (maxRight > 0 && maxBottom > 0) {
      this._display = { width: maxRight, height: maxBottom };
    }

    // 截图在树之后调用(独立请求,失败容忍):截图只是观测辅助,不应拖慢主路径
    let screenshot: AppState['screenshot'];
    try {
      const data = await this.client.screenshot();
      screenshot = { type: 'image', mimeType: 'image/png', data };
    } catch (err) {
      this.logger?.warn({ err }, 'node provider screenshot failed, skip');
    }

    const focused = elements.find((e) => e.focused);
    const windowTitleRaw = deepPick(tree.raw, ['windowTitle', 'title', 'activity', 'package']);
    return {
      mode: 'accessibility-only',
      screenshot,
      display: { width: this._display.width, height: this._display.height, scaleFactor: 1 },
      focusedElementId: focused?.elementId,
      windowTitle: typeof windowTitleRaw === 'string' ? windowTitleRaw : undefined,
      elements,
    };
  }

  /** MimicNode → UIElement 归一化。 */
  private _toUIElement(node: MimicNode, index: number): UIElement {
    const b = node.bounds;
    return {
      // 稳定 id:resourceId → 文本 → 索引路径
      elementId: node.resourceId || node.text || `n${index}`,
      role: roleFromClass(node.className),
      label: node.text || node.contentDescription,
      bounds: b
        ? {
            x: b.left,
            y: b.top,
            width: Math.max(0, b.right - b.left),
            height: Math.max(0, b.bottom - b.top),
          }
        : { x: 0, y: 0, width: 0, height: 0 },
      enabled: node.enabled ?? node.clickable ?? node.focusable ?? true,
      focused: node.focused ?? false,
      actions: node.actions,
    };
  }

  // -----------------------------------------------------------------------
  // Action execution
  // -----------------------------------------------------------------------

  /** 最近一次坐标点击(session 隔离):type_text 无 snapshotElement 时,
   *  模型"先点击再输入"的模式依赖它定位目标输入框(焦点不可靠)。 */
  private readonly _lastTaps = new Map<string, { x: number; y: number }>();

  private _rememberTap(ctx: Ctx, x: number, y: number): void {
    this._lastTaps.set(ctx.sessionPath ?? 'default', { x: Math.round(x), y: Math.round(y) });
  }

  async performAction(ctx: Ctx, _lease: Lease, action: Action): Promise<ActionResult> {
    this._assertConfigured();
    try {
      switch (action.type) {
        case 'click_element':
          return await this._clickElement(ctx, action);
        case 'click_point':
          return await this._clickPoint(ctx, action);
        case 'type_text':
          return await this._typeText(ctx, action);
        case 'scroll':
          return await this._scroll(action);
        case 'press_key':
          // mimic 的 REST 协议无按键事件接口;键盘输入仅限前台文本输入
          return {
            ok: false,
            action: action.type,
            error: 'press_key 不受支持:mimic 无按键事件接口',
          };
        case 'stop':
          return { ok: true, action: action.type };
        default:
          return { ok: false, action: action.type, error: `不支持的动作:${action.type}` };
      }
    } catch (err) {
      return { ok: false, action: action.type, error: mimicErrorMessage(err, this._url) };
    }
  }

  /**
   * 输入框类元素(EditText → role 'textbox')。实测:无障碍 CLICK 在
   * WebView 输入框(小米笔记等)上不产生输入焦点,后续 SET_TEXT 会报
   * "action failed";坐标 TAP 对原生与 WebView 输入框的聚焦都可靠。
   */
  private _isTextBoxElement(el: UIElement): boolean {
    return /textbox/i.test(el.role ?? '');
  }

  /**
   * click_element 主路径:无障碍节点 click(by text → desc → id),不注入
   * 触摸;坐标 tap 仅作兜底(伪 id、无 label 元素、textbox 输入框)。
   * label 可能来自 text 或 contentDescription:mimic 的 by:text 只匹配
   * text 属性,desc 兜底覆盖只有 contentDescription 的节点(图片按钮等)。
   */
  private async _clickElement(ctx: Ctx, action: Action): Promise<ActionResult> {
    const el = action.snapshotElement;
    // 输入框统一坐标 TAP 聚焦(无障碍 CLICK 对 WebView EditText 不聚焦)
    if (el?.bounds && (el.bounds.width > 0 || el.bounds.height > 0) && this._isTextBoxElement(el)) {
      const x = el.bounds.x + el.bounds.width / 2;
      const y = el.bounds.y + el.bounds.height / 2;
      await this.client.tap(x, y);
      this._rememberTap(ctx, x, y);
      return { ok: true, action: 'click_element' };
    }
    if (el?.label) {
      try {
        await this._clickByLabel(el.label);
      } catch (err) {
        if (!(err instanceof MimicError) || err.kind !== 'api') throw err;
        // text/desc 均未命中 → 真实 resourceId 或坐标 tap 兜底
        if (action.elementId && !isPseudoElementId(action.elementId)) {
          await this.client.clickNode(undefined, undefined, action.elementId);
          return { ok: true, action: 'click_element' };
        }
        throw err;
      }
      return { ok: true, action: 'click_element' };
    }
    if (action.elementId && !isPseudoElementId(action.elementId)) {
      await this.client.clickNode(undefined, undefined, action.elementId);
      return { ok: true, action: 'click_element' };
    }
    if (!el) {
      return { ok: false, action: 'click_element', error: 'click_element 缺少元素信息' };
    }
    // 伪 id(如 n5)不是真实 resourceId,CLICK by:id 必然失败 → bounds 中心 tap
    const x = el.bounds.x + el.bounds.width / 2;
    const y = el.bounds.y + el.bounds.height / 2;
    await this.client.tap(x, y);
    this._rememberTap(ctx, x, y);
    return { ok: true, action: 'click_element' };
  }

  /** click_point:显式坐标 tap(显式请求,允许)。 */
  private async _clickPoint(ctx: Ctx, action: Action): Promise<ActionResult> {
    if (action.x == null || action.y == null) {
      return { ok: false, action: 'click_point', error: 'click_point 缺少坐标' };
    }
    await this.client.tap(action.x, action.y);
    this._rememberTap(ctx, action.x, action.y);
    return { ok: true, action: 'click_point' };
  }

  /**
   * 按 label 点击,text 未命中时降级 by desc(同一 label 可能来自
   * contentDescription,如图片按钮)。仅处理 API 业务失败,不吞连接错误。
   */
  private async _clickByLabel(label: string): Promise<void> {
    try {
      await this.client.clickNode(label);
    } catch (err) {
      if (!(err instanceof MimicError) || err.kind !== 'api') throw err;
      await this.client.clickNode(undefined, label);
    }
  }

  /**
   * 实时 DUMP 树,按中心坐标距离匹配最近的 EditText 序号
   * (树序,与 mimic by=class 取第一个的语义对应)。
   * filter=text 才能看到输入框(interactive/visible 会过滤 EditText);
   * 返回 -1 = 无法匹配 / DUMP 失败。
   */
  private async _locateEditTextIndex(
    cx: number,
    cy: number,
  ): Promise<{ index: number; edits: MimicNode[] }> {
    try {
      const tree = await this.client.getTree({ format: 'flat', filter: 'text' });
      const edits = tree.elements.filter((n) => (n.className ?? '').includes('EditText'));
      if (edits.length === 0) return { index: -1, edits };
      let best = -1;
      let bestDist = Infinity;
      for (let i = 0; i < edits.length; i++) {
        const b = edits[i]!.bounds;
        if (!b) continue;
        const ecx = (b.left + b.right) / 2;
        const ecy = (b.top + b.bottom) / 2;
        const d = (ecx - cx) ** 2 + (ecy - cy) ** 2;
        if (d < bestDist) {
          bestDist = d;
          best = i;
        }
      }
      return { index: best, edits };
    } catch {
      return { index: -1, edits: [] };
    }
  }

  /**
   * type_text 可靠性阶梯(2026-08-12 实机验证重写):
   * mimic 的 filter=interactive/visible 会过滤掉输入框(EditText),
   * 只有 filter=text/all 能看到;聚焦字段 SET_TEXT 对 WebView 输入框
   * (小米笔记)必失败 —— 定位必须用显式 by:text/by:class,且不依赖焦点。
   * 实测:by=class(第 0 个 EditText)无焦点直接成功;内容框 by=text
   * 用其当前文本(占位符 '\n' 或已写入内容)同样成功。
   *   1. snapshotElement.label → SET_TEXT {by:'text'} 直接定位
   *   2. 实时 DUMP(filter=text)按快照 bounds 中心/最近点击坐标匹配
   *      EditText:第 0 个 → SET_TEXT {by:'class'}(无需焦点);
   *      其他 → SET_TEXT {by:'text'} 用该框当前文本
   *   3. 兜底:当前聚焦字段(TAP 聚焦后的原生输入框可能有效)
   */
  private async _typeText(ctx: Ctx, action: Action): Promise<ActionResult> {
    if (!action.text) {
      return { ok: false, action: 'type_text', error: 'type_text 缺少文本' };
    }
    const el = action.snapshotElement;
    const center =
      el?.bounds && (el.bounds.width > 0 || el.bounds.height > 0)
        ? { x: el.bounds.x + el.bounds.width / 2, y: el.bounds.y + el.bounds.height / 2 }
        : undefined;

    // 1) by=text 直接定位(label 是占位符/当前文本时最可靠)
    if (el?.label) {
      try {
        await this.client.setTextByQuery('text', el.label, action.text);
        return { ok: true, action: 'type_text' };
      } catch (err) {
        if (!(err instanceof MimicError) || err.kind !== 'api') throw err;
        // 未命中(占位符被写入替换等),继续阶梯
      }
    }

    // 2) 实时 DUMP 匹配 EditText:快照 bounds 中心,无元素时用最近点击
    //    坐标(模型"先点后输"模式)
    const probe = center ?? this._lastTaps.get(ctx.sessionPath ?? 'default');
    if (probe) {
      const { index, edits } = await this._locateEditTextIndex(probe.x, probe.y);
      const target = index >= 0 && edits[index] ? edits[index] : undefined;
      if (target) {
        const ok = await this._typeTextByEdit(target, index, action, center);
        if (ok) return ok;
      }
    }

    // 3) 当前聚焦字段(最终兜底;WebView 输入框上实测不可靠)
    try {
      await this.client.setText(action.text);
      return { ok: true, action: 'type_text' };
    } catch (err) {
      if (!(err instanceof MimicError) || err.kind !== 'api') throw err;
      return { ok: false, action: 'type_text', error: mimicErrorMessage(err, this._url) };
    }
  }

  /**
   * 按匹配到的 EditText 分发:
   * 第 0 个(标题框/唯一输入框)→ by=class 定位,无需焦点(实测可靠);
   * 其他(内容区)→ by=text 用该框当前文本(占位符 '\n' 或已写入内容),
   *          文本为空时 TAP 中心 + 聚焦字段兜底(原生输入框可能有效)。
   * 返回 null 表示未命中,继续阶梯。
   */
  private async _typeTextByEdit(
    target: MimicNode,
    index: number,
    action: Action,
    center?: { x: number; y: number },
  ): Promise<ActionResult | null> {
    const text = action.text;
    if (!text) return null;
    if (index === 0) {
      try {
        await this.client.setTextByQuery('class', 'android.widget.EditText', text);
        return { ok: true, action: 'type_text' };
      } catch (err) {
        if (!(err instanceof MimicError) || err.kind !== 'api') throw err;
        return null;
      }
    }
    // 非第 0 个:优先用该框当前文本定位(不依赖焦点)
    if (target.text) {
      try {
        await this.client.setTextByQuery('text', target.text, text);
        return { ok: true, action: 'type_text' };
      } catch (err) {
        if (!(err instanceof MimicError) || err.kind !== 'api') throw err;
      }
    }
    // 兜底:TAP 中心聚焦 + 聚焦字段
    if (center) {
      try {
        await this.client.tap(center.x, center.y);
        await this.client.setText(text);
        return { ok: true, action: 'type_text' };
      } catch (err) {
        if (!(err instanceof MimicError) || err.kind !== 'api') throw err;
      }
    }
    return null;
  }

  /** scroll:优先 mimic SCROLL;接口不可用时兜底为坐标 swipe。 */
  private async _scroll(action: Action): Promise<ActionResult> {
    const direction = action.direction ?? 'down';
    const el = action.snapshotElement;
    try {
      await this.client.scroll(direction, el?.label ? { query: el.label } : undefined);
      return { ok: true, action: 'scroll' };
    } catch (err) {
      // SCROLL 接口不可用(业务 ok:false 或 HTTP 404 等)→ 坐标 swipe 兜底。
      // up 的坐标换算见 swipePoints(从下往上)。
      if (err instanceof MimicError && (err.kind === 'api' || err.kind === 'http')) {
        await this.client.swipe(...swipePoints(direction, this._display));
        return { ok: true, action: 'scroll' };
      }
      throw err;
    }
  }
}
