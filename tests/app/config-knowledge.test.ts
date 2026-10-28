/**
 * The `knowledge:` and `conversation_search:` config blocks, tested in all three
 * mapping directions (MyDocs/KNOWLEDGE_WORKBENCH_PLAN.md §9.1, switch table §6 K2-5).
 *
 * The direction that matters most is the third one: a block the read side
 * understands but `jsConfigToYaml()` cannot write back gets silently erased by
 * the next WebUI settings save, and the layer falls back to defaults without a
 * single error. Hence the round-trip cases below, which also pin the emitted
 * keys to snake_case (the spelling `config.yaml.example` documents).
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, resetConfig } from '../../src/app/config';
import { jsConfigToYaml, yamlToAppConfigRaw } from '../../src/app/config-loader';
import type { AppConfig } from '../../src/app/types.js';

/**
 * The two sections under test, typed through `AppConfig` — which is what makes
 * these assertions fail to compile if the hand-maintained interface ever loses
 * them again (they used to be reachable only through the config schema types).
 */
type KnowledgeConfigSections = Pick<AppConfig, 'knowledge' | 'conversationSearch'>;

const sectionsOf = (config: ReturnType<typeof loadConfig>): KnowledgeConfigSections => ({
  knowledge: config.knowledge,
  conversationSearch: config.conversationSearch,
});

const DOCUMENTED_DEFAULTS = {
  knowledge: {
    enabled: true,
    read: { enabled: true },
    curate: {
      mode: 'nightly',
      shadow: false,
      maxPagesPerRun: 5,
      requireSources: 2,
      minMemoryConfidence: 0.6,
      modelRef: '',
    },
    logRetentionDays: 90,
    inject: { enabled: true, maxPages: 2 },
  },
  conversationSearch: {
    enabled: true,
    autoInjectMaxItems: 2,
  },
};

/** A non-default configuration, used to prove values survive a save. */
const CUSTOM_SECTIONS = {
  knowledge: {
    enabled: true,
    read: { enabled: false },
    curate: {
      mode: 'manual' as const,
      shadow: true,
      maxPagesPerRun: 2,
      requireSources: 3,
      minMemoryConfidence: 0.75,
      modelRef: 'deepseek/deepseek-chat',
    },
    logRetentionDays: 30,
    inject: { enabled: false, maxPages: 1 },
  },
  conversationSearch: {
    enabled: false,
    autoInjectMaxItems: 4,
  },
};

let dir: string;

beforeEach(() => {
  resetConfig();
  dir = mkdtempSync(join(tmpdir(), 'oma-knowledge-config-'));
});

afterEach(() => {
  resetConfig();
  rmSync(dir, { recursive: true, force: true });
});

/** Write a config.yaml and load it through the full loader + schema pipeline. */
function loadYamlConfig(text: string): KnowledgeConfigSections {
  const configPath = join(dir, 'config.yaml');
  writeFileSync(configPath, text, 'utf-8');
  resetConfig();
  return sectionsOf(loadConfig({}, configPath));
}

describe('knowledge config defaults', () => {
  it('resolves an absent block to the documented defaults with the layer off', () => {
    const config = loadYamlConfig('ui_language: en\n');

    // Every key keeps its documented default; only the master switch is off,
    // because a missing section must not switch a new layer on (see the
    // 'absent section' suite below).
    expect(config).toEqual({
      knowledge: { ...DOCUMENTED_DEFAULTS.knowledge, enabled: false },
      conversationSearch: { ...DOCUMENTED_DEFAULTS.conversationSearch, enabled: false },
    });
  });

  it('resolves the same defaults when no config.yaml exists at all', () => {
    // The env-only path skips the loader entirely, so there is no root key whose
    // absence could be read: the schema defaults still apply. Only a YAML load
    // can tell "absent" from "present but empty".
    const config = sectionsOf(loadConfig({ CONFIG_FILE: '' }));

    expect(config).toEqual(DOCUMENTED_DEFAULTS);
  });

  it('completes a partial block with defaults for the missing keys only', () => {
    const config = loadYamlConfig('knowledge:\n  curate:\n    max_pages_per_run: 2\n');

    expect(config.knowledge.curate).toEqual({
      ...DOCUMENTED_DEFAULTS.knowledge.curate,
      maxPagesPerRun: 2,
    });
    expect(config.knowledge.inject).toEqual(DOCUMENTED_DEFAULTS.knowledge.inject);
    // An absent sibling section stays inert rather than picking up its default.
    expect(config.conversationSearch).toEqual({
      ...DOCUMENTED_DEFAULTS.conversationSearch,
      enabled: false,
    });
  });
});

/**
 * Absence is not the same as an empty block. A whole optional layer must stay
 * off while its section is missing — the rule `mcp:` and `judge:` already
 * follow — otherwise upgrading the code would register tools, schedule the
 * curation job and start injecting context for every existing install.
 * Presence of the block is the opt-in, so an explicit block that omits
 * `enabled:` keeps the schema's `enabled: true` default.
 */
describe('absent section means the layer is inert', () => {
  const OFF_KNOWLEDGE = { ...DOCUMENTED_DEFAULTS.knowledge, enabled: false };
  const OFF_CONVERSATION_SEARCH = { ...DOCUMENTED_DEFAULTS.conversationSearch, enabled: false };

  it('leaves knowledge off when the section is absent', () => {
    expect(loadYamlConfig('ui_language: en\n').knowledge).toEqual(OFF_KNOWLEDGE);
  });

  it('leaves conversation_search off when the section is absent', () => {
    expect(loadYamlConfig('ui_language: en\n').conversationSearch).toEqual(OFF_CONVERSATION_SEARCH);
  });

  it('enables knowledge when the block is written without an enabled key', () => {
    const config = loadYamlConfig('knowledge:\n  inject:\n    max_pages: 1\n');

    expect(config.knowledge.enabled).toBe(true);
    expect(config.knowledge.inject).toEqual({ enabled: true, maxPages: 1 });
    // Opting into one section does not switch the other one on.
    expect(config.conversationSearch).toEqual(OFF_CONVERSATION_SEARCH);
  });

  it('enables conversation_search when the block is written without an enabled key', () => {
    const config = loadYamlConfig('conversation_search:\n  auto_inject_max_items: 3\n');

    expect(config.conversationSearch).toEqual({
      ...OFF_CONVERSATION_SEARCH,
      enabled: true,
      autoInjectMaxItems: 3,
    });
    expect(config.knowledge).toEqual(OFF_KNOWLEDGE);
  });

  it('honors an explicit knowledge enabled: false', () => {
    expect(loadYamlConfig('knowledge:\n  enabled: false\n').knowledge).toEqual(OFF_KNOWLEDGE);
  });

  it('honors an explicit conversation_search enabled: false', () => {
    expect(loadYamlConfig('conversation_search:\n  enabled: false\n').conversationSearch).toEqual(
      OFF_CONVERSATION_SEARCH,
    );
  });

  it('treats a bare `knowledge:` key with no value as absent, not as an opt-in', () => {
    // YAML parses the key to null; `knowledge: {}` is the empty opt-in.
    expect(loadYamlConfig('knowledge:\n').knowledge).toEqual(OFF_KNOWLEDGE);
  });
});

describe('knowledge config parsing', () => {
  it('maps a hand-written snake_case block onto the camelCase config', () => {
    const config = loadYamlConfig(`
knowledge:
  enabled: true
  read:
    enabled: false
  curate:
    mode: manual
    shadow: true
    max_pages_per_run: 2
    require_sources: 3
    min_memory_confidence: 0.75
    model_ref: deepseek/deepseek-chat
  log_retention_days: 30
  inject:
    enabled: false
    max_pages: 1

conversation_search:
  enabled: false
  auto_inject_max_items: 4
`);

    expect(config).toEqual(CUSTOM_SECTIONS);
  });

  it('accepts the camelCase spelling a WebUI save writes', () => {
    const config = loadYamlConfig(`
knowledge:
  curate:
    mode: off
    maxPagesPerRun: 3
    requireSources: 1
    minMemoryConfidence: 0.2
    modelRef: mimo/mimo-v2.5
  logRetentionDays: 0
  inject:
    maxPages: 0
conversationSearch:
  enabled: false
  autoInjectMaxItems: 0
`);

    expect(config.knowledge.curate).toEqual({
      ...DOCUMENTED_DEFAULTS.knowledge.curate,
      mode: 'off',
      maxPagesPerRun: 3,
      requireSources: 1,
      minMemoryConfidence: 0.2,
      modelRef: 'mimo/mimo-v2.5',
    });
    expect(config.knowledge.logRetentionDays).toBe(0);
    expect(config.knowledge.inject).toEqual({ enabled: true, maxPages: 0 });
    expect(config.conversationSearch).toEqual({
      enabled: false,
      autoInjectMaxItems: 0,
    });
  });

  it('treats an empty section as "all defaults"', () => {
    const config = loadYamlConfig('knowledge: {}\nconversation_search: {}\n');

    expect(config).toEqual(DOCUMENTED_DEFAULTS);
  });
});

describe('knowledge config round trip (jsConfigToYaml)', () => {
  it('writes the block back as snake_case instead of dropping it', () => {
    const yaml = jsConfigToYaml(CUSTOM_SECTIONS, {}) as Record<string, any>;

    expect(yaml.knowledge).toEqual({
      enabled: true,
      read: { enabled: false },
      curate: {
        mode: 'manual',
        shadow: true,
        max_pages_per_run: 2,
        require_sources: 3,
        min_memory_confidence: 0.75,
        model_ref: 'deepseek/deepseek-chat',
      },
      log_retention_days: 30,
      inject: { enabled: false, max_pages: 1 },
    });
    // No camelCase key leaks into the file the user edits.
    expect(yaml.knowledge.curate.maxPagesPerRun).toBeUndefined();
    expect(yaml.knowledge.logRetentionDays).toBeUndefined();
    expect(yaml.conversation_search).toEqual({
      enabled: false,
      auto_inject_max_items: 4,
    });
    expect(yaml.conversationSearch).toBeUndefined();
  });

  it('survives a save-and-reload cycle unchanged', () => {
    const yaml = jsConfigToYaml(CUSTOM_SECTIONS, {});

    // What the WebUI writes is what the loader reads back on the next boot.
    // Note this case alone cannot catch a missing `jsConfigToYaml` case: the
    // default passthrough writes camelCase, which the loader also accepts. The
    // snake_case assertions above are what pin the file's shape.
    const raw = yamlToAppConfigRaw(yaml);
    expect(raw.knowledge).toEqual(CUSTOM_SECTIONS.knowledge);
    expect(raw.conversationSearch).toEqual(CUSTOM_SECTIONS.conversationSearch);
  });

  it('merges into the existing section so a hand-written key is not erased', () => {
    const yaml = jsConfigToYaml(
      { knowledge: { curate: { shadow: true } } },
      { knowledge: { curate: { mode: 'off', max_pages_per_run: 9 }, custom_future_key: 1 } },
    ) as Record<string, any>;

    expect(yaml.knowledge.curate).toEqual({ mode: 'off', max_pages_per_run: 9, shadow: true });
    expect(yaml.knowledge.custom_future_key).toBe(1);
  });

  it('leaves the block alone when a save touches other sections', () => {
    // deepMerge() keeps keys absent from the returned object, so a save that
    // does not mention `knowledge` cannot delete it.
    const yaml = jsConfigToYaml({ showToolCalls: true }, {});

    expect(yaml.knowledge).toBeUndefined();
    expect(yaml.conversation_search).toBeUndefined();
  });
});

describe('knowledge config validation', () => {
  it('rejects a curate.mode outside off|manual|nightly, naming the key', () => {
    expect(() => loadYamlConfig('knowledge:\n  curate:\n    mode: sometimes\n')).toThrow(
      /knowledge\.curate\.mode/,
    );
  });

  it('rejects a negative max_pages_per_run, naming the key', () => {
    // The loader has already mapped the key to camelCase by the time the schema
    // rejects the value, so the message names the AppConfig spelling.
    expect(() => loadYamlConfig('knowledge:\n  curate:\n    max_pages_per_run: -1\n')).toThrow(
      /knowledge\.curate\.maxPagesPerRun/,
    );
  });

  it('rejects a non-boolean flag instead of silently defaulting it', () => {
    expect(() => loadYamlConfig('knowledge:\n  curate:\n    shadow: "yes"\n')).toThrow(
      /knowledge\.curate\.shadow/,
    );
  });

  it('rejects an out-of-range min_memory_confidence and a zero source threshold', () => {
    expect(() => loadYamlConfig('knowledge:\n  curate:\n    min_memory_confidence: 1.5\n')).toThrow(
      /knowledge\.curate\.minMemoryConfidence/,
    );
    expect(() => loadYamlConfig('knowledge:\n  curate:\n    require_sources: 0\n')).toThrow(
      /knowledge\.curate\.requireSources/,
    );
  });
});

/**
 * Keys that shipped as documentation but had no reader are gone: a switch that
 * does nothing is worse than no switch. An existing `config.yaml` still carrying
 * them must load (they are stripped, not rejected), so an upgrade cannot fail on
 * a key the upgrade itself removed — and, just as importantly, the stale key must
 * not reappear in the parsed config where it would look like a working setting.
 */
describe('removed keys stay removed', () => {
  it('drops write-only keys left in an existing config.yaml', () => {
    const config = loadYamlConfig(`
knowledge:
  curate:
    trigger_on_share: false
  export:
    enabled: true
    dir: /tmp/knowledge
conversation_search:
  neighborhood: 2
  auto_inject_max_chars: 320
`);

    expect(config.knowledge).toEqual(DOCUMENTED_DEFAULTS.knowledge);
    expect(config.conversationSearch).toEqual(DOCUMENTED_DEFAULTS.conversationSearch);
  });
});
