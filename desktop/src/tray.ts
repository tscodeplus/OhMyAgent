import { Tray, Menu, nativeImage, BrowserWindow, app, shell, Notification } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerManager } from './server-manager.js';
import { getDesktopConfig } from './config.js';
import { getAppUpdater } from './updater.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let tray: Tray | null = null;

export interface TrayOptions {
  mainWindow: BrowserWindow;
  serverManager: ServerManager | null;
}

/**
 * Create the system tray icon and context menu.
 * Must be called after app.whenReady().
 */
export function createTray(options: TrayOptions): Tray {
  // Build tray icon path
  // assets/ is packed inside app.asar (via electron-builder "files"), not in
  // extraResources. Use __dirname (which is dist/ inside the asar) to resolve
  // the path for both dev and production.
  const assetsDir = path.join(__dirname, '..', 'assets');

  const iconPath = path.join(assetsDir, 'tray-icon.png');
  const trayIcon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });

  tray = new Tray(trayIcon);
  tray.setToolTip('OhMyAgent');

  // Build context menu
  const updateMenu = () => {
    const config = getDesktopConfig();
    const gatewayConfig = config.getGatewayConfig();
    const isRemote = gatewayConfig.mode === 'remote' && !!gatewayConfig.remoteUrl;

    let statusLabel: string;
    if (isRemote) {
      statusLabel = `远程网关: ${gatewayConfig.remoteUrl}`;
    } else if (options.serverManager) {
      const status = options.serverManager.getStatus();
      statusLabel = status === 'running'
        ? '服务状态: ● 运行中'
        : status === 'error'
          ? '服务状态: ● 异常'
          : '服务状态: ● 已停止';
    } else {
      statusLabel = '服务状态: ● 已停止';
    }

    const menuTemplate: Electron.MenuItemConstructorOptions[] = [
      {
        label: '显示/隐藏窗口',
        click: () => {
          const win = options.mainWindow;
          if (win.isVisible() && !win.isMinimized()) {
            win.hide();
          } else {
            win.show();
            win.focus();
          }
        },
      },
      { type: 'separator' },
      {
        label: statusLabel,
        enabled: false,
      },
    ];

    // Only show restart service in local mode (restarts embedded server)
    if (!isRemote) {
      menuTemplate.push({
        label: '重启服务',
        click: () => {
          const n = new Notification({
            title: 'OhMyAgent',
            body: '正在重启服务...',
          });
          n.show();
          setTimeout(() => {
            app.relaunch();
            app.exit(0);
          }, 300);
        },
      });
    }

    menuTemplate.push(
      { type: 'separator' },
      {
        label: '打开数据目录',
        click: () => shell.openPath(app.getPath('userData')),
      },
      {
        label: '打开日志',
        click: () => {
          const logDir = path.join(app.getPath('userData'), 'logs');
          shell.openPath(logDir);
        },
      },
      { type: 'separator' },
      {
        label: '开机自启',
        type: 'checkbox',
        checked: config.get('autoStart'),
        click: (menuItem) => {
          const enable = menuItem.checked;
          config.set('autoStart', enable);
          app.setLoginItemSettings({
            openAtLogin: enable,
            path: app.getPath('exe'),
            args: ['--hidden'],
          });
        },
      },
      {
        label: '关闭到托盘',
        type: 'checkbox',
        checked: config.get('closeToTray'),
        click: (menuItem) => {
          config.set('closeToTray', menuItem.checked);
        },
      },
      { type: 'separator' },
      {
        label: '检查更新',
        click: () => {
          getAppUpdater().checkForUpdates();
        },
      },
      { type: 'separator' },
      {
        label: '重启应用',
        click: () => {
          setTimeout(() => {
            app.relaunch();
            app.exit(0);
          }, 200);
        },
      },
      {
        label: '退出',
        click: () => {
          app.quit();
        },
      },
    );

    const contextMenu = Menu.buildFromTemplate(menuTemplate);

    tray!.setContextMenu(contextMenu);
  };

  // Build initial menu
  updateMenu();

  // Rebuild menu each time it's about to show (to reflect live status/config changes)
  tray.on('right-click', () => updateMenu());

  // Left-click toggles window visibility
  tray.on('click', () => {
    const win = options.mainWindow;
    if (win.isVisible() && !win.isMinimized()) {
      win.hide();
    } else {
      win.show();
      win.focus();
    }
  });

  return tray;
}

/**
 * Destroy the tray (called on app quit).
 */
export function destroyTray(): void {
  if (tray) {
    tray.destroy();
    tray = null;
  }
}
