/**
 * The sender whitelist is enforced by every channel; this table is the rule
 * all four must agree on. `allowedUsers: []` in particular means "open", not
 * "nobody" — a channel that read it the other way would lock every sender out
 * (or, inverted, a non-empty list read as open would admit strangers).
 */

import { describe, it, expect } from 'vitest';
import { isSenderAllowed, hasSenderWhitelist } from '../../src/shared/access-control.js';

describe('isSenderAllowed', () => {
  it.each([
    // [allowedUsers, senderId, expected]
    [[], 'ou_anyone', true], // empty list = open gateway
    [undefined, 'ou_anyone', true],
    [[], undefined, true],
    [['ou_admin'], 'ou_admin', true],
    [['ou_admin', 'ou_second'], 'ou_second', true],
    [['ou_admin'], 'ou_intruder', false],
    [['ou_admin'], undefined, false], // unknown sender never matches
    [['ou_admin'], '', false],
    [[''], 'ou_admin', false], // a list holding only "" admits nobody
    [[''], '', false],
  ])('allowedUsers=%s sender=%s ⇒ %s', (allowedUsers, senderId, expected) => {
    expect(isSenderAllowed(allowedUsers, senderId)).toBe(expected);
  });
});

describe('hasSenderWhitelist', () => {
  it.each([
    [[], false],
    [undefined, false],
    [['ou_admin'], true],
  ])('allowedUsers=%s ⇒ %s', (allowedUsers, expected) => {
    expect(hasSenderWhitelist(allowedUsers)).toBe(expected);
  });

  it('agrees with isSenderAllowed about who is unrestricted', () => {
    for (const list of [[], undefined] as const) {
      expect(hasSenderWhitelist(list)).toBe(false);
      expect(isSenderAllowed(list, 'anyone')).toBe(true);
    }
    for (const list of [['ou_a'], ['']] as const) {
      expect(hasSenderWhitelist(list)).toBe(true);
    }
  });
});
