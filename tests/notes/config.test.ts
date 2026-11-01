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
  deriveMaxOutputTokens,
} from '../../src/notes/output-budget.js';

describe('notes config schema', () => {
  it('defaults to a body cap that can hold two aspects of one subject', () => {
    const parsed = notesSectionSchema.parse({});
    expect(parsed.capture.bodyMaxChars).toBe(BODY_MAX_DEFAULT);
    expect(parsed.capture.maxNotesPerCapture).toBe(MAX_NOTES_DEFAULT);
    expect(parsed.ball.show).toBe(true);
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

  it('rejects an output budget below what the body cap needs', () => {
    const result = notesSectionSchema.safeParse({
      capture: { bodyMaxChars: 1200, maxNotesPerCapture: 3, maxOutputTokens: 500 },
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const issue = result.error.issues.find(
      (item) => item.path.join('.') === 'capture.maxOutputTokens',
    );
    expect(issue?.message).toContain(String(deriveMaxOutputTokens(1200, 3)));
  });

  it('accepts an output budget with headroom', () => {
    const required = deriveMaxOutputTokens(1200, 3);
    const result = notesSectionSchema.safeParse({
      capture: { bodyMaxChars: 1200, maxNotesPerCapture: 3, maxOutputTokens: required + 500 },
    });
    expect(result.success).toBe(true);
  });
});

describe('deriveMaxOutputTokens', () => {
  it('scales with the cap and the number of notes', () => {
    expect(deriveMaxOutputTokens(1200, 1)).toBe(1600);
    expect(deriveMaxOutputTokens(1200, 3)).toBe(4000);
    // Clamped: a slow flash model refuses an 8000-token request long before it would
    // honour 4000 x 3 x 2 bodies.
    expect(deriveMaxOutputTokens(4000, 3)).toBe(8000);
    // Floor: a tiny body cap still needs room for the response envelope.
    expect(deriveMaxOutputTokens(200, 0)).toBe(1200);
  });
});

describe('notes config mapping', () => {
  it('reads the new keys out of YAML', () => {
    const raw = yamlToAppConfigRaw({
      provider: { primary: 'openai/gpt-4o', api_key: 'sk-test' },
      notes: {
        enabled: true,
        capture: { body_max_chars: 1600, max_output_tokens: 5000 },
        ball: { show: false },
      },
    });
    const notes = raw.notes as Record<string, any>;
    expect(notes.capture.bodyMaxChars).toBe(1600);
    expect(notes.capture.maxOutputTokens).toBe(5000);
    expect(notes.ball.show).toBe(false);
  });

  it('omits the output budget when the file does not state it, so it stays derived', () => {
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
          capture: { bodyMaxChars: 1500, maxOutputTokens: 6000 },
          ball: { show: false },
        },
      },
      {},
    );
    const notes = yaml.notes as Record<string, any>;
    expect(notes.capture).toMatchObject({ body_max_chars: 1500, max_output_tokens: 6000 });
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
