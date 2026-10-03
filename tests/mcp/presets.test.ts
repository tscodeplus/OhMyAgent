/**
 * Shape validation for the built-in MCP preset catalogue
 * (MyDocs/MCP_INTEGRATION_DESIGN.md §13.3).
 *
 * The catalogue is consumed verbatim by `GET /api/mcp/presets` and rendered by
 * the install form, so a malformed entry is a broken one-click install.
 */

import { describe, expect, it } from 'vitest';
import { getMcpPreset, listMcpPresets, MCP_PRESETS } from '../../src/mcp/presets.js';
import { MCP_SERVER_NAME_PATTERN } from '../../src/mcp/config.js';

const REQUIRED_PRESET_IDS = ['filesystem', 'git', 'fetch', 'memory', 'sequential_thinking', 'time'];

describe('MCP preset catalogue', () => {
  it('covers every requested server', () => {
    for (const id of REQUIRED_PRESET_IDS) {
      expect(getMcpPreset(id), `missing preset "${id}"`).toBeDefined();
    }
  });

  it('has unique, config-valid ids', () => {
    const ids = MCP_PRESETS.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      // The id doubles as the suggested mcp.servers key.
      expect(id).toMatch(MCP_SERVER_NAME_PATTERN);
    }
  });

  it('describes every preset in one non-empty line', () => {
    for (const preset of MCP_PRESETS) {
      expect(preset.name.trim()).not.toBe('');
      expect(preset.description.trim()).not.toBe('');
      expect(preset.description).not.toContain('\n');
    }
  });

  it('is a valid transport: stdio with a bare command, or http with a url', () => {
    for (const preset of MCP_PRESETS) {
      if (preset.transport === 'stdio') {
        expect(preset.command, preset.id).toBeTruthy();
        // A single executable — never a shell string.
        expect(preset.command).not.toContain(' ');
        expect(preset.url, preset.id).toBeUndefined();
      } else {
        expect(preset.url, preset.id).toMatch(/^https?:\/\//);
        expect(preset.command, preset.id).toBeUndefined();
        expect(preset.args, preset.id).toBeUndefined();
      }
      for (const arg of preset.args ?? []) {
        expect(typeof arg).toBe('string');
        expect(arg).not.toBe('');
      }
    }
  });

  it('suggests a valid exposure and links to https documentation', () => {
    for (const preset of MCP_PRESETS) {
      expect(['direct', 'deferred', 'hidden']).toContain(preset.exposure);
      expect(preset.docsUrl).toMatch(/^https:\/\//);
    }
  });

  it('gives every env var a name, a hint and a required flag', () => {
    for (const preset of MCP_PRESETS) {
      const keys = preset.env.map((variable) => variable.key);
      expect(new Set(keys).size).toBe(keys.length);
      for (const variable of preset.env) {
        expect(variable.key).toMatch(/^[A-Z][A-Z0-9_]*$/);
        expect(variable.hint.trim()).not.toBe('');
        expect(typeof variable.required).toBe('boolean');
      }
    }
  });

  it('offers at least one preset whose env var must be filled in', () => {
    const required = MCP_PRESETS.flatMap((preset) =>
      preset.env.filter((variable) => variable.required),
    );
    expect(required.length).toBeGreaterThan(0);
    expect(required.some((variable) => variable.secret === true)).toBe(true);
  });

  it('does not pre-download anything: commands stay npx/uvx based', () => {
    for (const preset of MCP_PRESETS) {
      expect(['npx', 'uvx']).toContain(preset.command);
    }
  });

  it('is immutable and hands out copies', () => {
    expect(Object.isFrozen(MCP_PRESETS)).toBe(true);
    for (const preset of MCP_PRESETS) {
      expect(Object.isFrozen(preset)).toBe(true);
      expect(Object.isFrozen(preset.env)).toBe(true);
    }
    const copy = listMcpPresets();
    expect(copy).toEqual([...MCP_PRESETS]);
    expect(copy).not.toBe(MCP_PRESETS);
  });

  it('returns undefined for an unknown id', () => {
    expect(getMcpPreset('not-a-preset')).toBeUndefined();
  });
});
