/**
 * The `notes:` section's numbers and switches, across all three mapping directions.
 *
 * A key that the read side understands but `jsConfigToYaml` cannot write back is
 * silently erased by the next WebUI save — the "looks applied, nothing changed"
 * failure this project has already paid for once. So every new key gets an assertion
 * here *and* in the other direction.
 */

import { describe, it, expect } from 'vitest';
import { notesSectionSchema } from '../../src/app/config.js';
import { jsConfigToYaml, yamlToAppConfigRaw } from '../../src/app/config-loader.js';
import {
  BODY_MAX_DEFAULT,
  MAX_NOTES_DEFAULT,
  SESSION_ROWS_DEFAULT,
  SESSION_ROWS_MAX,
  SESSION_ROWS_MIN,
} from '../../src/notes/output-budget.js';

describe('notes config schema', () => {
  it('defaults to a body cap that can hold two aspects of one subject', () => {
    const parsed = notesSectionSchema.parse({});
    expect(parsed.capture.bodyMaxChars).toBe(BODY_MAX_DEFAULT);
    expect(parsed.capture.maxNotesPerCapture).toBe(MAX_NOTES_DEFAULT);
    expect(parsed.ball.show).toBe(true);
  });

  it('defaults the session read cap to 2000 rows and refuses absurd values', () => {
    // 2000 rows of mostly-short IM messages is comfortably inside any modern model;
    // an over-cap session is head+tail sampled, never silently cut. Below 50 a
    // "session" window is a suffix wearing the word "session".
    expect(notesSectionSchema.parse({}).capture.sessionRows).toBe(SESSION_ROWS_DEFAULT);
    expect(notesSectionSchema.safeParse({ capture: { sessionRows: 10 } }).success).toBe(false);
    expect(
      notesSectionSchema.safeParse({ capture: { sessionRows: SESSION_ROWS_MAX + 1 } }).success,
    ).toBe(false);
    expect(
      notesSectionSchema.safeParse({ capture: { sessionRows: SESSION_ROWS_MIN } }).success,
    ).toBe(true);
  });

  it('has no "0 = unlimited" body cap', () => {
    // `maxNotesPerCapture: 0` already means "capture off" in this same block, and the
    // real ceiling is the model's output budget: 0 here would be a promise only the
    // truncation path could break, reported as invalid_json.
    expect(notesSectionSchema.safeParse({ capture: { bodyMaxChars: 0 } }).success).toBe(false);
    expect(notesSectionSchema.safeParse({ capture: { bodyMaxChars: 100 } }).success).toBe(false);
    expect(notesSectionSchema.safeParse({ capture: { bodyMaxChars: 4001 } }).success).toBe(false);
    expect(notesSectionSchema.safeParse({ capture: { bodyMaxChars: 4000 } }).success).toBe(true);
  });

  it('leaves the output budget unset by default, so the gateway decides', () => {
    // A budget we compute is a guess about the model; a wrong guess cuts the JSON
    // mid-object and is reported as `invalid_json`, i.e. blamed on the model.
    expect(notesSectionSchema.parse({}).capture.maxOutputTokens).toBeUndefined();
  });

  it('accepts any positive output budget, because a constant no longer defines it', () => {
    const result = notesSectionSchema.safeParse({
      capture: { bodyMaxChars: 1200, maxNotesPerCapture: 3, maxOutputTokens: 500 },
    });
    expect(result.success).toBe(true);
    expect(notesSectionSchema.safeParse({ capture: { maxOutputTokens: 0 } }).success).toBe(false);
  });
});

describe('notes config mapping', () => {
  it('reads the new keys out of YAML', () => {
    const raw = yamlToAppConfigRaw({
      provider: { primary: 'openai/gpt-4o', api_key: 'sk-test' },
      notes: {
        enabled: true,
        capture: { body_max_chars: 1600, max_output_tokens: 5000, session_rows: 1500 },
        ball: { show: false },
      },
    });
    const notes = raw.notes as Record<string, any>;
    expect(notes.capture.bodyMaxChars).toBe(1600);
    expect(notes.capture.maxOutputTokens).toBe(5000);
    expect(notes.capture.sessionRows).toBe(1500);
    expect(notes.ball.show).toBe(false);
  });

  it('omits the output budget when the file does not state it, so nothing caps the call', () => {
    const raw = yamlToAppConfigRaw({
      provider: { primary: 'openai/gpt-4o', api_key: 'sk-test' },
      notes: { enabled: true, capture: { body_max_chars: 900 } },
    });
    const notes = raw.notes as Record<string, any>;
    expect(notes.capture.bodyMaxChars).toBe(900);
    expect(notes.capture.maxOutputTokens).toBeUndefined();
  });

  it('writes the new keys back as snake_case instead of dropping them', () => {
    const yaml = jsConfigToYaml(
      {
        notes: {
          capture: { bodyMaxChars: 1500, maxOutputTokens: 6000, sessionRows: 1200 },
          ball: { show: false },
        },
      },
      {},
    );
    const notes = yaml.notes as Record<string, any>;
    expect(notes.capture).toMatchObject({
      body_max_chars: 1500,
      max_output_tokens: 6000,
      session_rows: 1200,
    });
    expect(notes.ball).toEqual({ show: false });
  });

  it('reads the request-shape keys out of YAML', () => {
    const raw = yamlToAppConfigRaw({
      provider: { primary: 'openai/gpt-4o', api_key: 'sk-test' },
      notes: {
        enabled: true,
        capture: { thinking: 'off', temperature: 0.1 },
      },
    });
    const notes = raw.notes as Record<string, any>;
    expect(notes.capture.thinking).toBe('off');
    expect(notes.capture.temperature).toBe(0.1);
  });

  it('defaults the capture request shape to inherit / 0.2', () => {
    const parsed = notesSectionSchema.parse({});
    expect(parsed.capture.thinking).toBe('inherit');
    expect(parsed.capture.temperature).toBe(0.2);
  });

  it('writes thinking and temperature back as plain keys', () => {
    const yaml = jsConfigToYaml({ notes: { capture: { thinking: 'off', temperature: 0.4 } } }, {});
    const notes = yaml.notes as Record<string, any>;
    expect(notes.capture).toMatchObject({ thinking: 'off', temperature: 0.4 });
  });

  it('keeps unrelated keys of the section when writing the ball switch', () => {
    const yaml = jsConfigToYaml(
      { notes: { ball: { show: true } } },
      { notes: { enabled: true, capture: { model_ref: 'x/y' } } },
    );
    const notes = yaml.notes as Record<string, any>;
    expect(notes.ball).toEqual({ show: true });
    expect(notes.capture.model_ref).toBe('x/y');
  });
});
