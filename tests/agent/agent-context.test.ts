/**
 * Per-session turn context: the task hint read by the judged decision points
 * and the recent-turn ring the tool.risk state builds on.
 */

import { describe, expect, it } from 'vitest';
import {
  clearTurnContext,
  getRecentUserTurns,
  getTurnTaskHint,
  MAX_RECENT_USER_TURNS,
  setTurnTaskHint,
} from '../../src/agent/agent-context.js';

describe('turn task hints', () => {
  it('keeps the latest turn and the last few turns alongside it', () => {
    for (const turn of ['one', 'two', 'three', 'four', 'five', 'six']) {
      setTurnTaskHint('session-turns', turn);
    }
    expect(getTurnTaskHint('session-turns')).toBe('six');
    // Oldest dropped, newest last — the tool.risk state wants recent evidence.
    expect(getRecentUserTurns('session-turns')).toEqual(['three', 'four', 'five', 'six']);
    expect(getRecentUserTurns('session-turns')).toHaveLength(MAX_RECENT_USER_TURNS);
  });

  it('hands out a copy, so a caller cannot mutate the store', () => {
    setTurnTaskHint('session-copy', 'only turn');
    const turns = getRecentUserTurns('session-copy');
    turns.push('injected');
    expect(getRecentUserTurns('session-copy')).toEqual(['only turn']);
  });

  it('unknown session → empty history, no hint', () => {
    expect(getRecentUserTurns('never-seen')).toEqual([]);
    expect(getTurnTaskHint('never-seen')).toBeUndefined();
  });

  it('clearTurnContext drops the hint and the history together', () => {
    setTurnTaskHint('session-clear', 'first');
    setTurnTaskHint('session-clear', 'second');
    clearTurnContext('session-clear');
    expect(getTurnTaskHint('session-clear')).toBeUndefined();
    expect(getRecentUserTurns('session-clear')).toEqual([]);
    // A later turn starts a fresh history instead of inheriting the old one.
    setTurnTaskHint('session-clear', 'third');
    expect(getRecentUserTurns('session-clear')).toEqual(['third']);
  });
});
