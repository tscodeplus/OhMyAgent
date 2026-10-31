/**
 * `extractJson` is shared by every LLM-response parser, so its failure mode is
 * silent: the caller sees "invalid JSON" and discards a good answer.
 *
 * The case that shipped broken: a note's `body` carries its own code fence (a
 * `command` note is a fence by definition), the fence was tried before the
 * outermost object, and the fence's contents were returned as "the JSON".
 */

import { describe, expect, it } from 'vitest';
import { extractJson } from '../../src/memory/json-utils.js';

describe('extractJson', () => {
  it('returns a whole response that is already an object', () => {
    expect(extractJson('{"notes":[]}')).toBe('{"notes":[]}');
  });

  it('keeps a code fence that lives inside a JSON string instead of promoting it', () => {
    const response = JSON.stringify({
      notes: [{ body: '```bash\nlsof -i :9191\n```\n' }],
    });
    const found = extractJson(response);
    expect(found).toBe(response);
    expect(JSON.parse(found as string).notes[0].body).toContain('lsof');
  });

  it('finds the object behind a sentence of preamble', () => {
    expect(extractJson('Sure, here it is: {"a":1} hope that helps')).toBe('{"a":1}');
  });

  it('finds an object inside a fence when prose follows the fence', () => {
    const found = extractJson('Here:\n```json\n{"a":1}\n```\nAnything else?');
    expect(found).toBe('{"a":1}');
  });

  it('skips a fence that is not JSON and prefers a later parsable object', () => {
    // The fence here wraps prose, so returning it would guarantee a parse failure.
    expect(extractJson('```bash\nls -la\n```\n{"a":1}')).toBe('{"a":1}');
  });

  it('returns null when there is nothing JSON-like', () => {
    expect(extractJson('no json at all')).toBeNull();
    expect(extractJson('[1,2,3]')).toBeNull();
  });
});
