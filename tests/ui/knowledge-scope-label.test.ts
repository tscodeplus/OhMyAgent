import { describe, it, expect } from 'vitest';
import { compactScopeLabel } from '../../ui/src/components/knowledge/scope-label';

/**
 * The console prints a page's scope beside its status. The stored value is an
 * address composed by `memory/knowledge/scope.ts` (`channel:<chatId>`,
 * `channel:session:<id>`, `session:<id>`), so the label is the only thing that
 * decides whether a reviewer reads a page's origin at a glance or decrypts it.
 *
 * `global` is not a case here: it has a translated label instead, because it
 * means "everyone can read this" rather than naming a chat.
 */
describe('compactScopeLabel', () => {
  it('splits a channel scope into channel and chat', () => {
    expect(compactScopeLabel('feishu:oc_1')).toBe('feishu · oc_1');
  });

  it('keeps every segment of a session scope, in order', () => {
    expect(compactScopeLabel('telegram:session:s1')).toBe('telegram · session · s1');
    expect(compactScopeLabel('session:s1')).toBe('session · s1');
  });

  it('leaves a value with no separator alone and drops empty segments', () => {
    expect(compactScopeLabel('global')).toBe('global');
    expect(compactScopeLabel('feishu::oc_1')).toBe('feishu · oc_1');
  });
});
