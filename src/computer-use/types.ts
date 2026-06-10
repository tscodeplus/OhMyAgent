// src/computer-use/types.ts

/** Context passed through all Provider methods */
export interface Ctx {
  sessionPath?: string;
  agentId?: string;
  model?: {
    provider: string;
    id: string;
    input: ('text' | 'image' | 'audio')[];
  };
  accessMode?: string;     // 'operate' | 'read-only'
  providerId?: string;
}

export interface ProviderStatus {
  providerId: string;
  available: boolean;
  permissions: { name: string; granted: boolean }[];
  message?: string;
}

export interface AppInfo {
  appId: string;
  name: string;
  pid?: number;
  running?: boolean;
  windows: WindowInfo[];
}

export interface WindowInfo {
  windowId: string;
  title: string;
  bounds?: { x: number; y: number; width: number; height: number };
  isOnScreen?: boolean;
  onCurrentSpace?: boolean;
}

export interface ComputerUseCapabilities {
  platform: 'linux' | 'win32' | 'darwin' | 'sandbox';
  observationModes: ('vision-native' | 'accessibility-only')[];
  screenshot: boolean;
  accessibilityTree: boolean;
  elementActions: boolean | 'semantic' | 'focused' | 'pidScoped';
  elementDoubleClick: boolean;
  backgroundControl: 'none' | 'partial' | 'full';
  pointClick: 'unsupported' | 'requiresForeground' | 'allowed';
  drag: 'unsupported' | 'requiresForeground' | 'allowed';
  textInput: 'unsupported' | 'semantic' | 'foreground' | 'pidScoped';
  keyboardInput: 'unsupported' | 'foreground' | 'pidScoped';
  requiresForegroundForInput: boolean;
  nativeCursor: boolean;
  /** true = fully isolated (mock/sandbox), skips app approval check */
  isolated: boolean;
  /** Whether the provider supports focus_app (bring existing window to foreground). */
  supportsFocusApp: boolean;
  /** Whether the provider supports close_app (terminate app by name). */
  supportsCloseApp: boolean;
}

export interface AppState {
  mode: 'vision-native' | 'accessibility-only';
  screenshot?: {
    type: 'image';
    mimeType: string;
    data: string;           // base64
  };
  display: {
    width: number;
    height: number;
    scaleFactor?: number;
    originalWidth?: number;
    originalHeight?: number;
  };
  elements: UIElement[];
  focusedElementId?: string;
  windowTitle?: string;
}

export interface UIElement {
  elementId: string;
  role: string;             // button, textbox, menu, window, link, combobox, ...
  label?: string;
  value?: string;
  description?: string;
  bounds: { x: number; y: number; width: number; height: number };
  enabled: boolean;
  focused?: boolean;
  actions?: string[];       // AXPress, AXOpen, AXShowDefaultUI, ...
}

export type ActionType =
  | 'click_element'
  | 'double_click'
  | 'click_point'
  | 'type_text'
  | 'press_key'
  | 'scroll'
  | 'drag'
  | 'perform_secondary_action'
  | 'stop';

export interface Action {
  type: ActionType;
  elementId?: string;
  x?: number;
  y?: number;
  text?: string;
  key?: string;
  direction?: 'up' | 'down' | 'left' | 'right';
  amount?: number;
  snapshotId?: string;
  snapshotElement?: UIElement;
}

export interface ActionResult {
  ok: boolean;
  action: ActionType;
  error?: string;
}

export interface Lease {
  leaseId: string;
  sessionPath: string;
  agentId: string;
  providerId: string;
  appId: string;
  windowId?: string;
  createdAt: string;
  expiresAt?: string;
  status: 'active' | 'released' | 'stopping';
  allowedActions: ActionType[];
  providerState: Record<string, unknown>;
  lastSnapshotId?: string;
}

export interface Target {
  appId?: string;
  appName?: string;
  pid?: number;
  processId?: number;
  windowId?: string;
  providerId?: string;
  /** If true, only focus an already-running app without launching it. */
  activateOnly?: boolean;
}
