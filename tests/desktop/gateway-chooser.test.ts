import { describe, expect, it } from 'vitest';
import { renderChooser } from '../../desktop/sidecar/src/gateway-chooser.js';
import type { DesktopConfig } from '../../desktop/sidecar/src/config.js';

const config: DesktopConfig = {
  closeToTray: true,
  autoStart: false,
  theme: 'system',
  firstRunDone: false,
  gateway: { mode: 'remote', remoteUrl: '', remoteToken: '' },
};

describe('gateway chooser HTML escaping', () => {
  it('keeps URL, token, and error input out of executable HTML/markup contexts', () => {
    const hostile = `';\\\\\n</script><script>window.compromised=true</script>`;
    const html = renderChooser(config, {
      initialUrl: hostile,
      initialToken: hostile,
      error: hostile,
    });

    expect(html).toContain('const initialState =');
    expect(html).toContain(String.raw`\u003c/script\u003e`);
    expect(html).not.toContain('</script><script>window.compromised=true</script>');
    expect(html).toContain('errBanner.textContent = initialState.error');
    expect(html).not.toContain('errBanner.innerHTML');
  });

  it('tests a remote gateway through the sidecar, never with a page-side fetch', () => {
    // A page-side fetch of the remote gateway is cross-origin and needs an
    // OPTIONS preflight; a gateway that challenges OPTIONS rejects it and the
    // token gets blamed for a preflight it never sent. The probe runs in Node.
    const html = renderChooser(config, {});
    expect(html).toContain('window.electronAPI.testGateway(');
    expect(html).not.toContain("fetch(rawUrl+'/api/auth/verify'");
    expect(html).not.toContain("fetch(rawUrl+'/api/health'");
  });
});
