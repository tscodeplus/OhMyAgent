// src/computer-use/android-adb.ts
//
// adb 电源/锁屏管理 —— 仅做唤醒/常亮/熄屏,不参与交互
// (交互层走手机端 mimic 无障碍服务 APK 的 REST 接口,不注入触摸)。
//
// 注意:有密码的锁屏无法自动解锁(Android 安全边界),dismiss-keyguard
// 只对无密码锁屏有效;失败时忽略并提示。
//
// 不启用 manageScreen 时,这些方法不会被 provider 调用。

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Logger } from 'pino';

const execFileAsync = promisify(execFile);

export interface AndroidAdbOptions {
  /** adb 命令或绝对路径,默认 'adb' */
  path?: string;
  /** 多设备时的序列号 */
  serial?: string;
  logger?: Logger;
}

export class AndroidAdb {
  private readonly path: string;
  private readonly serial?: string;
  private readonly logger?: Logger;

  constructor(options: AndroidAdbOptions = {}) {
    this.path = options.path || 'adb';
    this.serial = options.serial;
    this.logger = options.logger;
  }

  /**
   * 执行 adb 命令(序列号存在时自动前置 -s <serial>),
   * 同步等待输出,失败抛可读错误。
   */
  async exec(args: string[]): Promise<string> {
    const fullArgs = this.serial ? ['-s', this.serial, ...args] : args;
    try {
      const { stdout, stderr } = await execFileAsync(this.path, fullArgs, {
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
      });
      if (stderr) {
        this.logger?.debug({ stderr }, 'adb stderr');
      }
      return stdout;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`adb 命令失败:${this.path} ${fullArgs.join(' ')} — ${detail}`);
    }
  }

  /** 唤醒屏幕 → 解锁无密码锁屏 → 保持常亮。 */
  async wakeAndUnlock(): Promise<void> {
    await this.exec(['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP']);
    try {
      await this.exec(['shell', 'wm', 'dismiss-keyguard']);
    } catch (err) {
      // 有密码锁屏无法自动解锁(Android 安全边界)—— 抛可读错误,
      // 由上层(createLease 的 catch)转成对用户的提示
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`无法解除锁屏;若手机设置了密码/图案锁屏,请先手动解锁(${detail})`);
    }
    // 命令成功 ≠ 解锁成功:密码/图案锁屏时 dismiss-keyguard 常静默失败
    // (退出码 0 但 keyguard 仍在),校验实际状态后仍锁定则提示手动解锁
    const keyguard = await this.exec(['shell', 'dumpsys', 'window', 'keyguard']);
    if (/isKeyguardShowing(=|:\s*)true/.test(keyguard)) {
      throw new Error('无法解除锁屏;若手机设置了密码/图案锁屏,请先手动解锁');
    }
    await this.exec(['shell', 'svc', 'power', 'stayon', 'true']);
  }

  /** 恢复:解除常亮 → 熄屏。 */
  async restoreScreen(): Promise<void> {
    await this.exec(['shell', 'svc', 'power', 'stayon', 'false']);
    await this.exec(['shell', 'input', 'keyevent', 'KEYCODE_SLEEP']);
  }
}
