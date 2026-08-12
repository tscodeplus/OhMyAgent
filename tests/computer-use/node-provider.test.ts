import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NodeComputerUseProvider } from '../../src/computer-use/providers/node-provider.js';
import { MimicClient } from '../../src/computer-use/mimic-client.js';
import type { ComputerUseSettings } from '../../src/computer-use/settings.js';
import type { Ctx, Lease } from '../../src/computer-use/types.js';

// ---------------------------------------------------------------------------
// adb mock:mock node:child_process 的 execFile,让真实的 AndroidAdb 逻辑
// (命令顺序、serial 前缀)在测试中执行。execFile 需保持 length=4,
// 否则 util.promisify 会推断不出回调参数位置。
// ---------------------------------------------------------------------------

const { adbExecMock, defaultAdbImpl } = vi.hoisted(() => {
  const defaultAdbImpl = (
    _cmd: string,
    args: string[],
    _opts: unknown,
    cb?: (err: Error | null, stdout: string, stderr: string) => void,
  ) => {
    // dumpsys window keyguard:默认返回"未锁定",让 wakeAndUnlock 通过
    const out = args.includes('keyguard') ? 'isKeyguardShowing=false\n' : '';
    cb?.(null, out, '');
  };
  const adbExecMock = vi.fn(defaultAdbImpl);
  // 模拟真实 execFile 的 promisify 语义:真实 execFile 经 promisify 后
  // resolve {stdout, stderr} 对象;纯 vi.fn 缺 Node 内部符号时 promisify
  // 走通用模式 resolve 字符串,导致 AndroidAdb.exec 解构 stdout 为
  // undefined(读不到 adb 输出)。挂 custom 包装精确复刻对象形状。
  const promisified = (
    path: string,
    fullArgs: string[],
    opts: unknown,
  ): Promise<{ stdout: string; stderr: string }> => {
    return new Promise((resolve, reject) => {
      adbExecMock(path, fullArgs, opts, (err: Error | null, stdout: string, stderr: string) => {
        if (err) reject(err);
        else resolve({ stdout, stderr });
      });
    });
  };
  Object.defineProperty(adbExecMock, Symbol.for('nodejs.util.promisify.custom'), {
    value: promisified,
  });
  return { adbExecMock, defaultAdbImpl };
});

vi.mock('node:child_process', () => ({
  execFile: adbExecMock,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_SETTINGS: ComputerUseSettings = {
  enabled: true,
  provider: 'node',
  ssh: {
    host: '',
    user: '',
    keyPath: '',
    port: 22,
    jumpHost: '',
    display: ':0',
    hostKeyChecking: 'accept-new',
    knownHostsPath: '',
  },
  node: {
    url: 'http://127.0.0.1:8473',
    token: 'test-token',
    adb: { path: 'adb', manageScreen: false },
  },
  allowedApps: [],
  allowedAgents: [],
  approvalWhitelist: [],
  perPlatformProvider: {},
};

const DEFAULT_CTX: Ctx = { sessionPath: '/test', agentId: 'test-agent' };

function createProvider(settings: ComputerUseSettings = BASE_SETTINGS): NodeComputerUseProvider {
  return new NodeComputerUseProvider({ settings });
}

function makeLease(overrides?: Partial<Lease>): Lease {
  return {
    leaseId: 'node-lease-1',
    sessionPath: '/test',
    agentId: 'test-agent',
    providerId: 'node',
    appId: 'com.test.app',
    createdAt: new Date().toISOString(),
    status: 'active',
    allowedActions: ['click_element', 'click_point', 'type_text', 'scroll', 'stop'],
    providerState: { manageScreen: false, url: 'http://127.0.0.1:8473' },
    ...overrides,
  };
}

type FetchMock = ReturnType<typeof vi.fn>;

/**
 * 配置全局 mock fetch:默认 200,信封原样返回。
 * 注意必须原地配置(stubGlobal 在 beforeEach 时已捕获引用),不能重新赋值。
 */
function mockFetch(envelope: unknown, opts?: { status?: number }): void {
  const status = opts?.status ?? 200;
  fetchMock.mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(envelope),
  });
}

/** 解析最近一次 fetch 调用为 { cmd, url, body, headers }。 */
function lastRequest(): { cmd: string; url: string; body: Record<string, unknown>; headers: Record<string, string> } {
  const call = fetchMock.mock.lastCall;
  if (!call) throw new Error('fetch 未被调用');
  const [url, init] = call as [string, RequestInit];
  return {
    cmd: url.split('/').pop() ?? '',
    url,
    body: JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>,
    headers: (init.headers ?? {}) as Record<string, string>,
  };
}

/**
 * 协议语义化 fetch mock:按 mimic 真实协议校验请求体,形状不符返回
 * {ok:false, error},模拟真实 mimic 的报错(by 缺省时 mimic 走坐标分支,
 * 对缺 x 参数抛 "missing or invalid integer argument: x")。
 * 若未来 wire 退化(如 CLICK 只发 {text}),成功路径断言会立即变红,
 * 让 wire 错误不再漏网。
 */
function protocolFetch(): void {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const cmd = String(url).split('/').pop() ?? '';
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    let error: string | undefined;
    if (cmd === 'CLICK') {
      if (!body.by || typeof body.query !== 'string') {
        error = 'missing or invalid integer argument: x';
      }
    } else if (cmd === 'TAP') {
      if (typeof body.x !== 'number' || typeof body.y !== 'number') {
        error = 'missing or invalid integer argument: x';
      }
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(error ? { ok: false, error } : { ok: true, data: {} }),
    };
  });
}

/** adb exec 收到的参数列表(每个调用一次)。 */
function adbArgsCalls(): string[][] {
  return adbExecMock.mock.calls.map((c) => c[1] as string[]);
}

/** 模块级 fetch mock(beforeEach 里重建并 stubGlobal)。 */
let fetchMock: FetchMock;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('NodeComputerUseProvider', () => {
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    adbExecMock.mockImplementation(defaultAdbImpl);
    adbExecMock.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('getStatus', () => {
    it('url 为空 → unavailable,不发请求', async () => {
      const provider = createProvider({
        ...BASE_SETTINGS,
        node: { url: '', adb: { path: 'adb', manageScreen: false } },
      });

      const status = await provider.getStatus(DEFAULT_CTX);

      expect(status.providerId).toBe('node');
      expect(status.available).toBe(false);
      expect(status.message).toContain('url');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('STATUS 成功且服务开启 → available,并携带 token 头', async () => {
      mockFetch({ ok: true, data: { service_enabled: true } });
      const provider = createProvider();

      const status = await provider.getStatus(DEFAULT_CTX);

      expect(status.available).toBe(true);
      expect(status.message).toBeUndefined();
      const req = lastRequest();
      expect(req.cmd).toBe('STATUS');
      expect(req.body).toEqual({});
      expect(req.headers['x-mimic-token']).toBe('test-token');
    });

    it('STATUS 显示无障碍服务未开启 → unavailable + 可读提示', async () => {
      mockFetch({ ok: true, data: { service_enabled: false } });
      const provider = createProvider();

      const status = await provider.getStatus(DEFAULT_CTX);

      expect(status.available).toBe(false);
      expect(status.message).toContain('无障碍服务未开启');
    });

    it('401 → unavailable + token 无效提示', async () => {
      mockFetch({ ok: false, error: 'unauthorized' }, { status: 401 });
      const provider = createProvider();

      const status = await provider.getStatus(DEFAULT_CTX);

      expect(status.available).toBe(false);
      expect(status.message).toContain('token 无效');
    });

    it('fetch 失败 → unavailable + 连接提示', async () => {
      fetchMock.mockRejectedValue(new TypeError('fetch failed'));
      const provider = createProvider();

      const status = await provider.getStatus(DEFAULT_CTX);

      expect(status.available).toBe(false);
      expect(status.message).toContain('无法连接手机端服务');
      expect(status.message).toContain('http://127.0.0.1:8473');
    });
  });

  describe('listApps', () => {
    it('从树 dump 顶部提取包名/活动名', async () => {
      mockFetch({
        ok: true,
        data: { package: 'com.test.app', activity: 'com.test.app.MainActivity', nodes: [] },
      });
      const provider = createProvider();

      const apps = await provider.listApps(DEFAULT_CTX);

      expect(apps).toHaveLength(1);
      expect(apps[0].appId).toBe('com.test.app');
      expect(apps[0].name).toBe('com.test.app.MainActivity');
      expect(apps[0].running).toBe(true);
    });

    it('树 dump 失败 → 返回 []', async () => {
      fetchMock.mockRejectedValue(new TypeError('fetch failed'));
      const provider = createProvider();

      expect(await provider.listApps(DEFAULT_CTX)).toEqual([]);
    });
  });

  describe('getAppState', () => {
    it('树 JSON → 元素映射(role/label/bounds/elementId)', async () => {
      mockFetch({
        ok: true,
        data: {
          package: 'com.test.app',
          nodes: [
            {
              class: 'android.widget.EditText',
              text: '搜索框',
              id: 'com.test:id/search',
              bounds: [10, 20, 310, 60],
              actions: ['click', 'focus'],
              focused: true,
            },
            {
              class: 'android.widget.Button',
              desc: '发送',
              bounds: { left: 100, top: 100, right: 200, bottom: 140 },
              clickable: true,
            },
            { class: 'android.widget.ImageButton', id: 'com.test:id/back', bounds: { x: 0, y: 0, w: 48, h: 48 } },
            { class: 'android.widget.CheckBox', bounds: [0, 0, 0, 0] },
            { class: 'android.widget.RecyclerView', bounds: [0, 0, 1080, 2400] },
            { class: 'android.widget.ScrollView', bounds: [0, 0, 100, 100] },
            { text: '纯文本节点无 class', bounds: [5, 5, 50, 25] },
            { class: 'com.example.CustomView', center: [540, 1200] },
          ],
        },
      });
      const provider = createProvider();

      const state = await provider.getAppState(DEFAULT_CTX, makeLease());

      expect(state.mode).toBe('accessibility-only');
      expect(state.elements).toHaveLength(8);

      const [search, send, back, check, list, scroll, plain, custom] = state.elements;

      // EditText → textbox,label=text,bounds 数组归一化
      expect(search.role).toBe('textbox');
      expect(search.label).toBe('搜索框');
      expect(search.elementId).toBe('com.test:id/search');
      expect(search.bounds).toEqual({ x: 10, y: 20, width: 300, height: 40 });
      expect(search.enabled).toBe(true);
      expect(search.focused).toBe(true);

      // Button → button,label=contentDescription,无 id/文本 → 索引路径
      expect(send.role).toBe('button');
      expect(send.label).toBe('发送');
      expect(send.elementId).toBe('n1');
      expect(send.bounds).toEqual({ x: 100, y: 100, width: 100, height: 40 });
      expect(send.enabled).toBe(true); // clickable

      // ImageButton → button,x/y/w/h 归一化
      expect(back.role).toBe('button');
      expect(back.bounds).toEqual({ x: 0, y: 0, width: 48, height: 48 });

      expect(check.role).toBe('checkbox');
      expect(list.role).toBe('list');
      expect(scroll.role).toBe('scroll');
      expect(plain.role).toBe('unknown'); // className 缺失 → 兜底

      // 未知 className → 最后一段小写
      expect(custom.role).toBe('customview');
      expect(custom.bounds).toEqual({ x: 540, y: 1200, width: 0, height: 0 }); // 仅 center

      // display 由 bounds 推断最大范围
      expect(state.display.width).toBe(1080);
      expect(state.display.height).toBe(2400);
      expect(state.focusedElementId).toBe('com.test:id/search');
      expect(state.windowTitle).toBe('com.test.app');
    });

    it('非 JSON 响应 → 不 throw,返回空元素', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => '<html>not json</html>',
      });
      const provider = createProvider();

      const state = await provider.getAppState(DEFAULT_CTX, makeLease());

      expect(state.mode).toBe('accessibility-only');
      expect(state.elements).toEqual([]);
      expect(state.display).toEqual({ width: 1080, height: 2400, scaleFactor: 1 });
    });

    it('manageScreen 时 getAppState 先确保常亮(再次 wakeAndUnlock)', async () => {
      mockFetch({ ok: true, data: { nodes: [] } });
      const provider = createProvider({
        ...BASE_SETTINGS,
        node: { url: BASE_SETTINGS.node.url, adb: { path: 'adb', manageScreen: true } },
      });

      await provider.getAppState(DEFAULT_CTX, makeLease());

      const calls = adbArgsCalls();
      expect(calls[0]).toEqual(['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP']);
      expect(calls.at(-1)).toEqual(['shell', 'svc', 'power', 'stayon', 'true']);
    });

    it('树之后调用 SCREENSHOT,裸图片字节 → AppState.screenshot(base64)', async () => {
      // 第一次:DUMP 树;第二次:SCREENSHOT 返回裸 PNG 字节(非 JSON 信封)
      fetchMock
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ ok: true, data: { nodes: [] } }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          arrayBuffer: async () => Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).buffer,
        });
      const provider = createProvider();

      const state = await provider.getAppState(DEFAULT_CTX, makeLease());

      expect(state.screenshot).toEqual({
        type: 'image',
        mimeType: 'image/png',
        data: 'iVBORw0KGgo=',
      });
      // 截图请求在树请求之后发出
      const urls = fetchMock.mock.calls.map((c) => String(c[0]));
      expect(urls).toHaveLength(2);
      expect(urls[0]).toMatch(/\/v1\/DUMP$/);
      expect(urls[1]).toMatch(/\/v1\/SCREENSHOT$/);
    });

    it('SCREENSHOT 失败 → 容忍跳过,screenshot 为空,不 throw', async () => {
      fetchMock
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ ok: true, data: { nodes: [] } }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ ok: false, error: 'screenshot disabled' }),
        });
      const provider = createProvider();

      const state = await provider.getAppState(DEFAULT_CTX, makeLease());

      expect(state.screenshot).toBeUndefined();
      expect(state.elements).toEqual([]);
    });
  });

  describe('performAction', () => {
    it('click_element 输入框(textbox)不走无障碍 CLICK,统一 TAP 坐标聚焦', async () => {
      protocolFetch();
      const provider = createProvider();

      const result = await provider.performAction(DEFAULT_CTX, makeLease(), {
        type: 'click_element',
        elementId: 'input-1',
        snapshotElement: {
          elementId: 'input-1',
          role: 'textbox',
          label: '标题',
          bounds: { x: 84, y: 342, width: 1277, height: 161 },
          enabled: true,
        },
      });

      expect(result.ok).toBe(true);
      const req = lastRequest();
      expect(req.cmd).toBe('TAP');
      expect(req.body).toEqual({ x: 84 + Math.round(1277 / 2), y: 342 + Math.round(161 / 2) });
    });

    it('click_element 优先节点 click(by text),协议形状 {by:text, query},不产生坐标触摸', async () => {
      protocolFetch();
      const provider = createProvider();

      const result = await provider.performAction(DEFAULT_CTX, makeLease(), {
        type: 'click_element',
        elementId: 'btn-1',
        snapshotElement: {
          elementId: 'btn-1',
          role: 'button',
          label: '确认',
          bounds: { x: 0, y: 0, width: 100, height: 50 },
          enabled: true,
        },
      });

      expect(result.ok).toBe(true);
      expect(result.action).toBe('click_element');
      const req = lastRequest();
      expect(req.cmd).toBe('CLICK');
      expect(req.body).toEqual({ by: 'text', query: '确认' });
      expect(req.body.x).toBeUndefined(); // 无坐标 tap
    });

    it('click_element 有 elementId 无 label → click by id(真实 resourceId)', async () => {
      protocolFetch();
      const provider = createProvider();

      const result = await provider.performAction(DEFAULT_CTX, makeLease(), {
        type: 'click_element',
        elementId: 'com.test:id/btn',
        snapshotElement: {
          elementId: 'com.test:id/btn',
          role: 'button',
          bounds: { x: 0, y: 0, width: 100, height: 50 },
          enabled: true,
        },
      });

      expect(result.ok).toBe(true);
      const req = lastRequest();
      expect(req.cmd).toBe('CLICK');
      expect(req.body).toEqual({ by: 'id', query: 'com.test:id/btn' });
    });

    it('click_element by text 未命中(仅 contentDescription 的节点)→ 降级 by desc', async () => {
      // 真机形态:图片按钮 text 为空、label 来自 contentDescription,
      // mimic by:text 报 "no node matched query" → 必须降级 by desc
      fetchMock.mockImplementation(async (url, init) => {
        const cmd = String(url).split('/').pop() ?? '';
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        const noMatch = body.by === 'text' && body.query === '新建笔记';
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify(
              noMatch
                ? { ok: false, error: 'no node matched query' }
                : { ok: true, data: {} },
            ),
        };
      });
      const provider = createProvider();

      const result = await provider.performAction(DEFAULT_CTX, makeLease(), {
        type: 'click_element',
        elementId: 'n3',
        snapshotElement: {
          elementId: 'n3',
          role: 'imageview',
          label: '新建笔记',
          bounds: { x: 1100, y: 2626, width: 212, height: 212 },
          enabled: true,
        },
      });

      expect(result.ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const reqs = fetchMock.mock.calls.map((c) => JSON.parse(String(c[1]?.body ?? '{}')) as Record<string, unknown>);
      expect(reqs[0]).toEqual({ by: 'text', query: '新建笔记' });
      expect(reqs[1]).toEqual({ by: 'desc', query: '新建笔记' });
    });

    it('click_element 伪 id(如 n5)不发 CLICK by:id,走 bounds 中心 tap 兜底', async () => {
      protocolFetch();
      const provider = createProvider();

      const result = await provider.performAction(DEFAULT_CTX, makeLease(), {
        type: 'click_element',
        elementId: 'n5',
        snapshotElement: {
          elementId: 'n5',
          role: 'button',
          bounds: { x: 200, y: 300, width: 100, height: 50 },
          enabled: true,
        },
      });

      expect(result.ok).toBe(true);
      const req = lastRequest();
      expect(req.cmd).toBe('TAP');
      expect(req.body).toEqual({ x: 250, y: 325 });
    });

    it('click_element 无 label 无 elementId → 兜底 tap bounds 中心', async () => {
      protocolFetch();
      const provider = createProvider();

      const result = await provider.performAction(DEFAULT_CTX, makeLease(), {
        type: 'click_element',
        snapshotElement: {
          elementId: 'n0',
          role: 'button',
          bounds: { x: 100, y: 200, width: 80, height: 40 },
          enabled: true,
        },
      });

      expect(result.ok).toBe(true);
      const req = lastRequest();
      expect(req.cmd).toBe('TAP');
      expect(req.body).toEqual({ x: 140, y: 220 });
    });

    it('click_point → 显式坐标 tap', async () => {
      mockFetch({ ok: true, data: {} });
      const provider = createProvider();

      const result = await provider.performAction(DEFAULT_CTX, makeLease(), {
        type: 'click_point',
        x: 100,
        y: 200,
      });

      expect(result.ok).toBe(true);
      const req = lastRequest();
      expect(req.cmd).toBe('TAP');
      expect(req.body).toEqual({ x: 100, y: 200 });
    });

    it('type_text → SET_TEXT 请求体(无 snapshotElement → 聚焦字段)', async () => {
      mockFetch({ ok: true, data: {} });
      const provider = createProvider();

      const result = await provider.performAction(DEFAULT_CTX, makeLease(), {
        type: 'type_text',
        text: 'hello',
      });

      expect(result.ok).toBe(true);
      const req = lastRequest();
      expect(req.cmd).toBe('SET_TEXT');
      expect(req.body).toEqual({ text: 'hello' });
    });

    it('type_text 有 label → SET_TEXT by:text 直接定位', async () => {
      mockFetch({ ok: true, data: {} });
      const provider = createProvider();

      const result = await provider.performAction(DEFAULT_CTX, makeLease(), {
        type: 'type_text',
        text: 'hello',
        snapshotElement: {
          elementId: 'input-1',
          role: 'textbox',
          label: '标题',
          bounds: { x: 0, y: 0, width: 100, height: 40 },
          enabled: true,
        },
      });

      expect(result.ok).toBe(true);
      const req = lastRequest();
      expect(req.cmd).toBe('SET_TEXT');
      expect(req.body).toEqual({ by: 'text', query: '标题', text: 'hello' });
    });

    it('type_text label 未命中 + 匹配第 0 个 EditText → by:class 定位', async () => {
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        const u = String(url);
        if (u.includes('/v1/DUMP')) {
          return {
            ok: true,
            status: 200,
            text: async () =>
              JSON.stringify({
                ok: true,
                data: [
                  { class: 'android.widget.EditText', text: '', bounds: [0, 0, 100, 40] },
                ],
              }),
          };
        }
        if (u.includes('/v1/SET_TEXT')) {
          const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
          if (body.by === 'text') {
            return {
              ok: true,
              status: 200,
              text: async () => JSON.stringify({ ok: false, error: 'no node matched query' }),
            };
          }
          return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, data: {} }) };
        }
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, data: {} }) };
      });
      const provider = createProvider();

      const result = await provider.performAction(DEFAULT_CTX, makeLease(), {
        type: 'type_text',
        text: 'hello',
        snapshotElement: {
          elementId: 'input-1',
          role: 'textbox',
          label: '标题',
          bounds: { x: 0, y: 0, width: 100, height: 40 },
          enabled: true,
        },
      });

      expect(result.ok).toBe(true);
      const calls = fetchMock.mock.calls;
      const setTextCalls = calls.filter((c) => String(c[0]).includes('/v1/SET_TEXT'));
      expect(setTextCalls).toHaveLength(2);
      const lastBody = JSON.parse(String((setTextCalls[1][1] as RequestInit).body)) as Record<string, unknown>;
      expect(lastBody).toEqual({ by: 'class', query: 'android.widget.EditText', text: 'hello' });
    });

    it('type_text 匹配第 2 个 EditText 且文本为空 → TAP + 聚焦字段兜底', async () => {
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        const u = String(url);
        if (u.includes('/v1/DUMP')) {
          return {
            ok: true,
            status: 200,
            text: async () =>
              JSON.stringify({
                ok: true,
                data: [
                  { class: 'android.widget.EditText', text: '标题', bounds: [0, 0, 100, 40] },
                  { class: 'android.widget.EditText', text: '', bounds: [0, 500, 100, 700] },
                ],
              }),
          };
        }
        if (u.includes('/v1/SET_TEXT')) {
          const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
          if (body.by === 'text') {
            return {
              ok: true,
              status: 200,
              text: async () => JSON.stringify({ ok: false, error: 'no node matched query' }),
            };
          }
          return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, data: {} }) };
        }
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, data: {} }) };
      });
      const provider = createProvider();

      const result = await provider.performAction(DEFAULT_CTX, makeLease(), {
        type: 'type_text',
        text: 'hello',
        snapshotElement: {
          elementId: 'n12',
          role: 'textbox',
          label: '',
          bounds: { x: 0, y: 500, width: 100, height: 200 },
          enabled: true,
        },
      });

      expect(result.ok).toBe(true);
      const calls = fetchMock.mock.calls;
      // TAP(聚焦)→ SET_TEXT(聚焦字段)
      const tapCalls = calls.filter((c) => String(c[0]).includes('/v1/TAP'));
      expect(tapCalls).toHaveLength(1);
      expect(JSON.parse(String((tapCalls[0][1] as RequestInit).body))).toEqual({ x: 50, y: 600 });
      const setTextCalls = calls.filter((c) => String(c[0]).includes('/v1/SET_TEXT'));
      const lastBody = JSON.parse(String((setTextCalls[setTextCalls.length - 1][1] as RequestInit).body)) as Record<string, unknown>;
      expect(lastBody).toEqual({ text: 'hello' });
    });

    it('type_text 无 snapshotElement → 用最近点击坐标匹配 EditText', async () => {
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        const u = String(url);
        if (u.includes('/v1/DUMP')) {
          return {
            ok: true,
            status: 200,
            text: async () =>
              JSON.stringify({
                ok: true,
                data: [
                  { class: 'android.widget.EditText', text: '', bounds: [0, 0, 100, 40] },
                  { class: 'android.widget.EditText', text: '', bounds: [0, 500, 100, 700] },
                ],
              }),
          };
        }
        if (u.includes('/v1/SET_TEXT')) {
          const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
          if (body.by === 'class') {
            return {
              ok: true,
              status: 200,
              text: async () => JSON.stringify({ ok: false, error: 'action failed' }),
            };
          }
          return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, data: {} }) };
        }
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, data: {} }) };
      });
      const provider = createProvider();

      // 先 click_point 标题框位置(记录 lastTap),再无元素 type_text
      await provider.performAction(DEFAULT_CTX, makeLease(), {
        type: 'click_point',
        x: 50,
        y: 20,
      });
      fetchMock.mockClear();

      const result = await provider.performAction(DEFAULT_CTX, makeLease(), {
        type: 'type_text',
        text: 'hello',
      });

      expect(result.ok).toBe(true);
      const calls = fetchMock.mock.calls;
      const setTextCalls = calls.filter((c) => String(c[0]).includes('/v1/SET_TEXT'));
      expect(setTextCalls).toHaveLength(2);
      const lastBody = JSON.parse(String((setTextCalls[setTextCalls.length - 1][1] as RequestInit).body)) as Record<string, unknown>;
      expect(lastBody).toEqual({ text: 'hello' });
    });

    it('type_text 阶梯全失败 → 返回错误(聚焦字段路径已废弃,不再 TAP 重试)', async () => {
      // by:text、by:class、聚焦字段全部失败 → 直接报错(WebView 聚焦字段实测必失败)
      let setTextCount = 0;
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        const u = String(url);
        if (u.includes('/v1/DUMP')) {
          return {
            ok: true,
            status: 200,
            text: async () =>
              JSON.stringify({
                ok: true,
                data: [
                  { class: 'android.widget.EditText', text: '', bounds: [0, 0, 100, 40] },
                ],
              }),
          };
        }
        if (u.includes('/v1/SET_TEXT')) {
          setTextCount++;
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ ok: false, error: 'action failed' }),
          };
        }
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, data: {} }) };
      });
      const provider = createProvider();

      const result = await provider.performAction(DEFAULT_CTX, makeLease(), {
        type: 'type_text',
        text: 'hello',
        snapshotElement: {
          elementId: 'input-1',
          role: 'textbox',
          label: '标题',
          bounds: { x: 10, y: 20, width: 100, height: 40 },
          enabled: true,
        },
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain('action failed');
      const calls = fetchMock.mock.calls;
      const tapCalls = calls.filter((c) => String(c[0]).includes('/v1/TAP'));
      expect(tapCalls).toHaveLength(0);
      expect(setTextCount).toBe(3); // by=text + by=class + 聚焦字段
    });

    it('type_text 匹配第 2 个 EditText 且其文本非空(内容框占位符)→ by=text 定位', async () => {
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        const u = String(url);
        if (u.includes('/v1/DUMP')) {
          return {
            ok: true,
            status: 200,
            text: async () =>
              JSON.stringify({
                ok: true,
                data: [
                  { class: 'android.widget.EditText', text: '标题', bounds: [0, 0, 100, 40] },
                  { class: 'android.widget.EditText', text: '\n', bounds: [0, 500, 100, 700] },
                ],
              }),
          };
        }
        if (u.includes('/v1/SET_TEXT')) {
          const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
          if (body.by === 'text' && body.query === '标题') {
            return {
              ok: true,
              status: 200,
              text: async () => JSON.stringify({ ok: false, error: 'no node matched query' }),
            };
          }
          return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, data: {} }) };
        }
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, data: {} }) };
      });
      const provider = createProvider();

      const result = await provider.performAction(DEFAULT_CTX, makeLease(), {
        type: 'type_text',
        text: '0812测试',
        snapshotElement: {
          elementId: 'n12',
          role: 'textbox',
          label: '标题',
          bounds: { x: 0, y: 500, width: 100, height: 200 },
          enabled: true,
        },
      });

      expect(result.ok).toBe(true);
      const calls = fetchMock.mock.calls;
      const setTextCalls = calls.filter((c) => String(c[0]).includes('/v1/SET_TEXT'));
      const lastBody = JSON.parse(String((setTextCalls[setTextCalls.length - 1][1] as RequestInit).body)) as Record<string, unknown>;
      expect(lastBody).toEqual({ by: 'text', query: '\n', text: '0812测试' });
      // 不依赖焦点:by=text 直接定位,不应有 TAP
      const tapCalls = calls.filter((c) => String(c[0]).includes('/v1/TAP'));
      expect(tapCalls).toHaveLength(0);
    });

    it('type_text 阶梯全失败且 TAP 重试仍失败 → 返回错误', async () => {
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        const u = String(url);
        if (u.includes('/v1/DUMP')) {
          return {
            ok: true,
            status: 200,
            text: async () =>
              JSON.stringify({
                ok: true,
                data: [
                  { class: 'android.widget.EditText', text: '', bounds: [0, 0, 100, 40] },
                ],
              }),
          };
        }
        if (u.includes('/v1/SET_TEXT')) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ ok: false, error: 'action failed' }),
          };
        }
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, data: {} }) };
      });
      const provider = createProvider();

      const result = await provider.performAction(DEFAULT_CTX, makeLease(), {
        type: 'type_text',
        text: 'hello',
        snapshotElement: {
          elementId: 'input-1',
          role: 'textbox',
          label: '标题',
          bounds: { x: 10, y: 20, width: 100, height: 40 },
          enabled: true,
        },
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain('action failed');
    });

    it('scroll → SCROLL direction', async () => {
      mockFetch({ ok: true, data: {} });
      const provider = createProvider();

      const result = await provider.performAction(DEFAULT_CTX, makeLease(), {
        type: 'scroll',
        direction: 'up',
      });

      expect(result.ok).toBe(true);
      const req = lastRequest();
      expect(req.cmd).toBe('SCROLL');
      expect(req.body).toEqual({ direction: 'up' });
    });

    it('scroll:SCROLL 不可用 → 兜底坐标 swipe(up = 从下往上)', async () => {
      fetchMock
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ ok: false, error: 'unknown command SCROLL' }),
        })
        .mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true, data: {} }) });
      const provider = createProvider();

      const result = await provider.performAction(DEFAULT_CTX, makeLease(), {
        type: 'scroll',
        direction: 'up',
      });

      expect(result.ok).toBe(true);
      const calls = fetchMock.mock.calls;
      expect(calls).toHaveLength(2);
      expect(String(calls[0][0])).toMatch(/\/v1\/SCROLL$/);
      expect(String(calls[1][0])).toMatch(/\/v1\/SWIPE$/);
      // 默认显示 1080x2400:up = 从 (540,1920) 到 (540,480)
      expect(JSON.parse(String((calls[1][1] as RequestInit).body))).toEqual({
        x: 540,
        y: 1920,
        x2: 540,
        y2: 480,
      });
    });

    it('press_key → 不支持,不发请求', async () => {
      const provider = createProvider();

      const result = await provider.performAction(DEFAULT_CTX, makeLease(), {
        type: 'press_key',
        key: 'Enter',
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain('不受支持');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('401 → {ok:false, error: token 无效}', async () => {
      mockFetch({ ok: false, error: 'unauthorized' }, { status: 401 });
      const provider = createProvider();

      const result = await provider.performAction(DEFAULT_CTX, makeLease(), {
        type: 'click_point',
        x: 10,
        y: 10,
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain('token 无效');
    });
  });

  describe('lease lifecycle + adb 电源/锁屏管理', () => {
    it('manageScreen:createLease 顺序 唤醒→解锁→常亮;releaseLease 逆序 解除常亮→熄屏', async () => {
      const provider = createProvider({
        ...BASE_SETTINGS,
        node: {
          url: BASE_SETTINGS.node.url,
          adb: { path: '/custom/adb', serial: 'emulator-5554', manageScreen: true },
        },
      });

      const lease = await provider.createLease(DEFAULT_CTX, { appId: 'com.test.app' });

      expect(lease.providerId).toBe('node');
      expect(lease.appId).toBe('com.test.app');
      expect(lease.allowedActions).toEqual(['click_element', 'click_point', 'type_text', 'scroll', 'stop']);
      expect(lease.providerState).toEqual({ manageScreen: true, url: 'http://127.0.0.1:8473' });

      // 顺序:KEYCODE_WAKEUP → dismiss-keyguard → keyguard 校验 → stayon true
      const wakeCalls = adbArgsCalls();
      expect(adbExecMock.mock.calls[0][0]).toBe('/custom/adb');
      expect(wakeCalls[0]).toEqual(['-s', 'emulator-5554', 'shell', 'input', 'keyevent', 'KEYCODE_WAKEUP']);
      expect(wakeCalls[1]).toEqual(['-s', 'emulator-5554', 'shell', 'wm', 'dismiss-keyguard']);
      expect(wakeCalls[2]).toEqual(['-s', 'emulator-5554', 'shell', 'dumpsys', 'window', 'keyguard']);
      expect(wakeCalls[3]).toEqual(['-s', 'emulator-5554', 'shell', 'svc', 'power', 'stayon', 'true']);

      // releaseLease 逆序:stayon false → KEYCODE_SLEEP
      adbExecMock.mockClear();
      await provider.releaseLease(DEFAULT_CTX, lease);
      const restoreCalls = adbArgsCalls();
      expect(restoreCalls[0]).toEqual(['-s', 'emulator-5554', 'shell', 'svc', 'power', 'stayon', 'false']);
      expect(restoreCalls[1]).toEqual(['-s', 'emulator-5554', 'shell', 'input', 'keyevent', 'KEYCODE_SLEEP']);
    });

    it('不启用 manageScreen → createLease/releaseLease/stop 均不调用 adb', async () => {
      const provider = createProvider();

      const lease = await provider.createLease(DEFAULT_CTX, { appId: 'com.test.app' });
      await provider.releaseLease(DEFAULT_CTX, lease);
      await provider.stop(DEFAULT_CTX, lease);

      expect(lease.providerState).toEqual({ manageScreen: false, url: 'http://127.0.0.1:8473' });
      expect(adbExecMock).not.toHaveBeenCalled();
    });

    it('wakeAndUnlock 失败 → createLease throw 提示锁屏需手动解锁', async () => {
      const provider = createProvider({
        ...BASE_SETTINGS,
        node: { url: BASE_SETTINGS.node.url, adb: { path: 'adb', manageScreen: true } },
      });
      adbExecMock.mockImplementation((_cmd, _args, _opts, cb) => {
        cb?.(new Error('device offline'), '', '');
      });

      await expect(provider.createLease(DEFAULT_CTX, { appId: 'com.test.app' })).rejects.toThrow('手动解锁');
    });

    it('dismiss-keyguard 失败(密码/图案锁屏)→ createLease throw 可读提示且不重复', async () => {
      const provider = createProvider({
        ...BASE_SETTINGS,
        node: { url: BASE_SETTINGS.node.url, adb: { path: 'adb', manageScreen: true } },
      });
      // 第 1 次(KEYCODE_WAKEUP)成功,第 2 次(dismiss-keyguard)失败
      let callIndex = 0;
      adbExecMock.mockImplementation((_cmd, _args, _opts, cb) => {
        callIndex += 1;
        if (callIndex === 2) cb?.(new Error('failed to dismiss keyguard'), '', '');
        else cb?.(null, '', '');
      });

      await expect(
        provider.createLease(DEFAULT_CTX, { appId: 'com.test.app' }),
      ).rejects.toThrow('无法解除锁屏;若手机设置了密码/图案锁屏,请先手动解锁');
    });

    it('dismiss-keyguard 命令成功但 keyguard 仍在(静默失败)→ 抛手动解锁提示', async () => {
      // 真机形态:密码/图案锁屏时 wm dismiss-keyguard 退出码 0 但不解锁,
      // wakeAndUnlock 必须校验 dumpsys keyguard 实际状态,否则会假装成功
      const provider = createProvider({
        ...BASE_SETTINGS,
        node: { url: BASE_SETTINGS.node.url, adb: { path: 'adb', manageScreen: true } },
      });
      adbExecMock.mockImplementation((_cmd, args, _opts, cb) => {
        const out = args.includes('keyguard') ? 'isKeyguardShowing=true\n' : '';
        cb?.(null, out, '');
      });

      await expect(
        provider.createLease(DEFAULT_CTX, { appId: 'com.test.app' }),
      ).rejects.toThrow('无法解除锁屏;若手机设置了密码/图案锁屏,请先手动解锁');
    });
  });

  describe('MimicClient.screenshot', () => {
    it('screenshot → JSON 信封内 base64 透传', async () => {
      mockFetch({ ok: true, data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwC' });
      const client = new MimicClient({ baseUrl: 'http://127.0.0.1:8473', token: 't' });

      const data = await client.screenshot();

      expect(data).toBe('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwC');
      const req = lastRequest();
      expect(req.cmd).toBe('SCREENSHOT');
      expect(req.body).toEqual({ format: 'png' });
      expect(req.headers['x-mimic-token']).toBe('t');
    });

    it('SCREENSHOT 返回裸图片字节(非 JSON 信封)→ 自动转 base64', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        arrayBuffer: async () => Uint8Array.from([0x89, 0x50, 0x4e, 0x47]).buffer,
      });
      const client = new MimicClient({ baseUrl: 'http://127.0.0.1:8473' });

      await expect(client.screenshot()).resolves.toBe('iVBORw==');
    });

    it('SCREENSHOT 既非 JSON 也无字节可读(空)→ 抛可读错误', async () => {
      fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => '' });
      const client = new MimicClient({ baseUrl: 'http://127.0.0.1:8473' });

      await expect(client.screenshot()).rejects.toThrow('返回格式无法识别');
    });
  });

  describe('MimicClient 协议形状(回归防线)', () => {
    it('clickNode(text) 发送 {by:text, query} 协议形状', async () => {
      protocolFetch();
      const client = new MimicClient({ baseUrl: 'http://127.0.0.1:8473', token: 't' });

      await client.clickNode('确认');

      const req = lastRequest();
      expect(req.cmd).toBe('CLICK');
      expect(req.body).toEqual({ by: 'text', query: '确认' });
      expect(req.body.by).toBe('text');
    });

    it('clickNode(id) 发送 {by:id, query} 协议形状', async () => {
      protocolFetch();
      const client = new MimicClient({ baseUrl: 'http://127.0.0.1:8473' });

      await client.clickNode(undefined, undefined, 'com.test:id/btn');

      const req = lastRequest();
      expect(req.cmd).toBe('CLICK');
      expect(req.body).toEqual({ by: 'id', query: 'com.test:id/btn' });
    });

    it('clickNode(desc) 发送 {by:desc, query} 协议形状(contentDescription 节点)', async () => {
      protocolFetch();
      const client = new MimicClient({ baseUrl: 'http://127.0.0.1:8473' });

      await client.clickNode(undefined, '新建笔记');

      const req = lastRequest();
      expect(req.cmd).toBe('CLICK');
      expect(req.body).toEqual({ by: 'desc', query: '新建笔记' });
    });

    it('协议外形状(CLICK 缺 by/query)→ mock 拒绝并转 MimicError,不再漏网', async () => {
      // mock 按真实 mimic 语义拒绝缺 by 的 CLICK(by 缺省走坐标分支,缺 x 报错)
      fetchMock.mockImplementation(async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        const bad = body.by === undefined || typeof body.query !== 'string';
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify(bad ? { ok: false, error: 'missing or invalid integer argument: x' } : { ok: true, data: {} }),
        };
      });
      const client = new MimicClient({ baseUrl: 'http://127.0.0.1:8473' });
      // 直接发旧版 wire 形状(绕过已修复的 clickNode,模拟历史版本请求)
      const rawRequest = (
        client as unknown as { _request(cmd: string, args: Record<string, unknown>): Promise<unknown> }
      )._request.bind(client);

      await expect(rawRequest('CLICK', { text: '确认' })).rejects.toMatchObject({ kind: 'api' });
    });
  });
});
