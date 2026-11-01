/**
 * The `notes.capture.*` numbers must be live, not boot-time.
 *
 * `createNotesServices` used to close over the bootstrap `AppConfig` object, so every
 * `getConfig()` call re-read the *same* values. A changed `body_max_chars` therefore
 * kept using the old one — which is indistinguishable from the setting being ignored,
 * because that is what it was. The window tests cover the arithmetic; this covers the
 * wiring, which is the half that fails silently.
 */

import { describe, it, expect, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/memory/db.js';
import { createNotesServices } from '../../src/app/composers/notes-services.js';
import { configEventBus } from '../../src/app/config-event-bus.js';
import type { AppConfig } from '../../src/app/types.js';

const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as never;

function notesConfig(bodyMaxChars: number, maxNotes: number): AppConfig {
  return {
    notes: {
      enabled: true,
      capture: { bodyMaxChars, maxNotesPerCapture: maxNotes, modelRef: '' },
      draft: { ttlDays: 14 },
      logRetentionDays: 90,
    },
  } as unknown as AppConfig;
}

describe('notes services / config wiring', () => {
  let db: Database.Database | undefined;
  const unsubscribes: Array<() => void> = [];

  afterEach(() => {
    db?.close();
    db = undefined;
    // The bus is a process-wide singleton; a leaked handler would fire into a closed
    // database on the next test's reload.
    while (unsubscribes.length > 0) unsubscribes.pop()?.();
  });

  it('re-reads the capture numbers after a reload', async () => {
    db = openDatabase(':memory:');
    const services = createNotesServices({
      config: notesConfig(1200, 3),
      db,
      logger,
      auxConfig: { modelRef: 'test/model' } as never,
    });
    if (!services.notesService) throw new Error('notes service did not start');

    // The old value is what a capture would use right now: 1200 chars, 3 notes.
    expect(services.readRuntimeConfig?.().bodyMaxChars).toBe(1200);

    await configEventBus.emit(notesConfig(2400, 1));

    // Reach the live config the way the pipeline does: through the service's own
    // accessor, so this asserts the wiring rather than a copy of the logic.
    const live = services.readRuntimeConfig?.();
    expect(live?.bodyMaxChars).toBe(2400);
    expect(live?.maxNotesPerCapture).toBe(1);
  });
});
