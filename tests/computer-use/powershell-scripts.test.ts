import { describe, expect, it } from 'vitest';
import {
  psListWindows,
  psTakeScreenshot,
  wrapPowerShell,
} from '../../src/computer-use/powershell-scripts';

describe('Windows PowerShell computer-use scripts', () => {
  it('psListWindows enumerates processes with a main window title', () => {
    const script = psListWindows();

    expect(script).toContain('Get-Process');
    expect(script).toContain('MainWindowTitle');
    expect(script).toContain('APP|');
  });

  it('psTakeScreenshot escapes backslashes in the output path', () => {
    const script = psTakeScreenshot('C:\\Windows\\Temp\\cua_test.png');

    expect(script).toContain("'C:\\\\Windows\\\\Temp\\\\cua_test.png'");
    expect(script).toContain('CopyFromScreen');
    expect(script).toContain('ImageFormat]::Png');
  });

  it('wrapPowerShell base64-encodes the script as UTF-16LE for -EncodedCommand', () => {
    const encoded = wrapPowerShell('Write-Output "hi"');

    expect(encoded.startsWith('powershell.exe -NoProfile -NonInteractive -EncodedCommand ')).toBe(
      true,
    );
    const b64 = encoded.slice(encoded.lastIndexOf(' ') + 1);
    const decoded = Buffer.from(b64, 'base64').toString('utf16le');
    expect(decoded).toContain("$ProgressPreference = 'SilentlyContinue';");
    expect(decoded).toContain('Write-Output "hi"');
  });
});
