import { describe, expect, it } from 'vitest';
import {
  psFocusApp,
  psLaunchApp,
  psSendKeys,
} from '../../src/computer-use/powershell-scripts';

describe('Windows PowerShell computer-use scripts', () => {
  it('types text via clipboard paste so Unicode text is sent literally', () => {
    const script = psSendKeys("你好it's ok");

    expect(script).toContain("[System.Windows.Forms.Clipboard]::SetText('你好it''s ok')");
    expect(script).toContain("[System.Windows.Forms.SendKeys]::SendWait('^v')");
    expect(script).not.toContain("SendWait('你好");
  });

  it('does not use Alt-key focus fallback when launching or focusing apps', () => {
    expect(psLaunchApp('notepad')).not.toContain('keybd_event');
    expect(psLaunchApp('notepad')).not.toContain('AltKey');
    expect(psFocusApp('notepad')).not.toContain('keybd_event');
    expect(psFocusApp('notepad')).not.toContain('AltKey');
  });

  it('guards empty launch window handles before calling Win32 focus APIs', () => {
    const script = psLaunchApp('notepad');

    expect(script).toContain('$null -ne $hwnd -and $hwnd -ne [IntPtr]::Zero');
    expect(script).toContain('launch_fallback_hwnd');
  });
});
