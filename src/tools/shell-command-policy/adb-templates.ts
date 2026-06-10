// src/tools/shell-command-policy/adb-templates.ts
//
// ADB command templates for risk classification.

import type { AdbTemplate } from './types.js';

export const ADB_TEMPLATES: AdbTemplate[] = [
  // low risk
  { pattern: 'adb devices', patternType: 'exact', risk: 'low', description: 'List connected Android devices' },
  { pattern: 'adb shell getprop', patternType: 'prefix', risk: 'low', description: 'Get device properties' },
  { pattern: 'adb shell ls', patternType: 'prefix', risk: 'low', description: 'List files on device' },
  { pattern: 'adb shell cat', patternType: 'prefix', risk: 'low', description: 'Read file contents on device' },
  { pattern: 'adb shell df', patternType: 'prefix', risk: 'low', description: 'Show disk usage on device' },
  { pattern: 'adb shell screencap', patternType: 'prefix', risk: 'low', description: 'Capture device screenshot to device storage' },
  { pattern: 'adb exec-out screencap', patternType: 'prefix', risk: 'low', description: 'Capture device screenshot to stdout' },
  { pattern: 'adb shell uptime', patternType: 'exact', risk: 'low', description: 'Show device uptime' },
  { pattern: 'adb version', patternType: 'exact', risk: 'low', description: 'Show ADB version' },
  // medium risk
  { pattern: 'adb shell pm list', patternType: 'prefix', risk: 'medium', description: 'List packages on device' },
  { pattern: 'adb shell dumpsys', patternType: 'prefix', risk: 'medium', description: 'Dump system service info' },
  { pattern: 'adb shell settings get', patternType: 'prefix', risk: 'medium', description: 'Get device settings' },
  { pattern: 'adb shell input', patternType: 'prefix', risk: 'medium', description: 'Send input events to device' },
  { pattern: 'adb shell am start', patternType: 'prefix', risk: 'medium', description: 'Start an Android activity' },
  { pattern: 'adb pull', patternType: 'prefix', risk: 'medium', description: 'Pull file from device' },
  { pattern: 'adb push', patternType: 'prefix', risk: 'medium', description: 'Push file to device' },
  // high risk
  { pattern: 'adb install', patternType: 'prefix', risk: 'high', description: 'Install an APK on device' },
  { pattern: 'adb uninstall', patternType: 'prefix', risk: 'high', description: 'Uninstall package via adb' },
  { pattern: 'adb shell pm uninstall', patternType: 'prefix', risk: 'high', description: 'Uninstall package from device' },
  { pattern: 'adb shell rm', patternType: 'prefix', risk: 'high', description: 'Remove file from device' },
  { pattern: 'adb root', patternType: 'exact', risk: 'high', description: 'Restart adb with root privileges' },
  { pattern: 'adb shell su', patternType: 'prefix', risk: 'high', description: 'Run shell commands as root on device' },
];
