/**
 * Shell tool abort behavior — /stop must kill the running command instead
 * of letting it run to the exec timeout (M2).
 */

import { describe, it, expect } from 'vitest';
import { createShellToolDefinition } from '../../../src/tools/builtins/shell/definition.js';

function makeCtx(overrides: Record<string, unknown> = {}) {
  return { cwd: process.cwd(), services: {}, policyScope: {} as any, ...overrides } as any;
}

function resultText(result: { content: unknown[] }): string {
  return (result.content as any[]).map((b: any) => b.text ?? '').join('');
}

describe('createShellToolDefinition signal handling', () => {
  it('kills a running command when the abort signal fires', async () => {
    const def = createShellToolDefinition({ timeoutMs: 60000 });
    const controller = new AbortController();
    const start = Date.now();
    const promise = def.execute(
      { command: 'node -e "setTimeout(() => {}, 30000)"' },
      makeCtx({ signal: controller.signal }),
    );
    setTimeout(() => controller.abort(), 150);
    const result = await promise;
    const elapsed = Date.now() - start;

    // Aborted well before the 60s exec timeout
    expect(elapsed).toBeLessThan(10000);
    expect(resultText(result)).toMatch(/超时|timed|abort/i);
  });

  it('fails fast when the signal is already aborted before execution', async () => {
    const def = createShellToolDefinition({ timeoutMs: 60000 });
    const controller = new AbortController();
    controller.abort();
    const result = await def.execute(
      { command: 'node -e "setTimeout(() => {}, 30000)"' },
      makeCtx({ signal: controller.signal }),
    );
    expect(resultText(result)).toMatch(/超时|timed|abort/i);
  });
});
