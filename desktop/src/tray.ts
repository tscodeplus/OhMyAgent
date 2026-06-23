import { Tray, Menu, nativeImage, BrowserWindow, app, shell, Notification } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerManager } from './server-manager.js';
import { getDesktopConfig } from './config.js';
import { getAppUpdater } from './updater.js';
import { getT, interpolate } from './i18n.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let tray: Tray | null = null;
let currentUpdateMenu: (() => void) | null = null;

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
      statusLabel = interpolate(getT().tray.remoteGateway, { url: gatewayConfig.remoteUrl });
    } else if (options.serverManager) {
      const status = options.serverManager.getStatus();
      statusLabel = status === 'running'
        ? getT().tray.serviceStatusRunning
        : status === 'error'
          ? getT().tray.serviceStatusError
          : getT().tray.serviceStatusStopped;
    } else {
      statusLabel = getT().tray.serviceStatusStopped;
    }

    const menuTemplate: Electron.MenuItemConstructorOptions[] = [
      {
        label: getT().tray.showHide,
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
        label: getT().tray.restartService,
        click: () => {
          const n = new Notification({
            title: 'OhMyAgent',
            body: getT().tray.restarting,
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
        label: getT().tray.openDataDir,
        click: () => shell.openPath(app.getPath('userData')),
      },
      {
        label: getT().tray.openLogs,
        click: () => {
          const logDir = path.join(app.getPath('userData'), 'logs');
          shell.openPath(logDir);
        },
      },
      { type: 'separator' },
      {
        label: getT().tray.autoStart,
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
        label: getT().tray.closeToTray,
        type: 'checkbox',
        checked: config.get('closeToTray'),
        click: (menuItem) => {
          config.set('closeToTray', menuItem.checked);
        },
      },
      { type: 'separator' },
      {
        label: getT().tray.checkUpdates,
        click: () => {
          getAppUpdater().checkForUpdatesFromTray();
        },
      },
      { type: 'separator' },
      {
        label: getT().tray.restartApp,
        click: () => {
          setTimeout(() => {
            app.relaunch();
            app.exit(0);
          }, 200);
        },
      },
      {
        label: getT().tray.quit,
        click: () => {
          app.quit();
        },
      },
    );

    const contextMenu = Menu.buildFromTemplate(menuTemplate);

    tray!.setContextMenu(contextMenu);
  };

  // Save a reference so external code can trigger a rebuild (e.g., language change)
  currentUpdateMenu = updateMenu;

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
 * Rebuild the tray context menu immediately (e.g., after language change).
 * Safe to call before the tray is created — does nothing.
 */
export function rebuildTrayMenu(): void {
  if (currentUpdateMenu) {
    currentUpdateMenu();
  }
}

/**
 * Destroy the tray (called on app quit).
 */
export function destroyTray(): void {
  if (tray) {
    tray.destroy();
    tray = null;
  }
  currentUpdateMenu = null;
}
