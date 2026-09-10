import { describe, it, expect } from 'vitest';
import { buildMergeSystemPrompt, type MergeConfig } from '../../src/memory/memory-merge.js';

describe('buildMergeSystemPrompt language adaptation (TDAM v0.3.6 pattern)', () => {
  it('includes the configured language for non-Auto outputLanguage', () => {
    const prompt = buildMergeSystemPrompt('Simplified Chinese');
    expect(prompt).toContain('Write the merged content in Simplified Chinese.');
    expect(prompt).toContain('Merge the following existing knowledge');
    expect(prompt).toContain('{"mergedContent":"merged text"}');
  });

  it('defers to the existing memory language under Auto', () => {
    const prompt = buildMergeSystemPrompt('Auto');
    expect(prompt).toContain('same language as the CURRENT text');
  });

  it('defers to the existing memory language when outputLanguage is unset', () => {
    const prompt = buildMergeSystemPrompt(undefined);
    expect(prompt).toContain('same language as the CURRENT text');
  });

  it('MergeConfig accepts an optional outputLanguage field', () => {
    const config: MergeConfig = {
      mergeThreshold: 0.85,
      outputLanguage: 'English',
      logger: { warn() {}, info() {}, error() {}, debug() {} } as never,
    };
    expect(config.outputLanguage).toBe('English');
  });
});
