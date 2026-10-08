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
});
