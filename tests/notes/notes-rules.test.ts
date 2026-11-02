/**
 * The pure half of the notes layer: title canonicalisation, the scope read rule,
 * the recap gate, redaction, window resolution and distillation validation.
 *
 * These are the rules that decide *what a note is allowed to become*, so they are
 * tested directly rather than through the service: a broken recap gate turns
 * every capture into a transcript, and a scope rule that drifts silently leaks a
 * group chat's notes into the person's library.
 */

import { describe, it, expect } from 'vitest';
import { normalizeTag, normalizeTags, normalizeTitle, slugify } from '../../src/notes/canonical.js';
import { channelScopeKey, defaultScope, readableScopeSql } from '../../src/notes/scope.js';
import { isRecap, jaccard, ngramSet } from '../../src/notes/recap.js';
import { redactSecrets } from '../../src/notes/redact.js';
import { estimateTokens, renderWindowPrompt, resolveWindow } from '../../src/notes/window.js';
import { parseDistillResponse } from '../../src/notes/distill.js';
import { ftsFacetTokens } from '../../src/notes/facets.js';
import type { Message } from '../../src/memory/repositories/message-repository.js';

function message(
  id: string,
  role: string,
  content: string,
  createdAt: number,
  metadata: string | null = null,
): Message {
  return {
    id,
    session_id: 's',
    role,
    content,
    tool_call_id: null,
    created_at: String(createdAt),
    metadata,
  };
}

describe('canonical', () => {
  it('folds case, spaces and hyphens into one title key', () => {
    expect(normalizeTitle('Termux 换源')).toBe(normalizeTitle('termux-换源'));
    expect(normalizeTitle('Vitest 单文件迭代！')).toBe(normalizeTitle('vitest单文件迭代'));
  });

  it('keeps dots and slashes, which are part of names', () => {
    expect(normalizeTitle('Node.js')).toBe('node.js');
    expect(normalizeTitle('a/b')).toBe('a/b');
  });

  it('normalises tags to bare kebab-case words', () => {
    expect(normalizeTag('  #Testing ')).toBe('testing');
    expect(normalizeTag('feishu card')).toBe('feishu-card');
  });

  it('de-duplicates tags and caps the list at six', () => {
    expect(normalizeTags(['a', 'A', 'b', 'c', 'd', 'e', 'f', 'g'])).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
      'f',
    ]);
  });

  it('produces a filename slug distinct from the comparison key', () => {
    expect(slugify('vitest 单文件迭代')).toBe('vitest-单文件迭代');
  });
});

describe('scope', () => {
  it('returns no filter for an unscoped caller', () => {
    expect(readableScopeSql(null)).toBeNull();
  });

  it('matches the four-way rule with one param per supplied level', () => {
    const filter = readableScopeSql({
      projectId: 'p1',
      channelKey: 'feishu:oc_1',
      sessionId: 's1',
    });
    expect(filter?.params).toEqual(['p1', 'feishu:oc_1', 's1']);
    expect(filter?.sql).toContain("n.scope = 'user'");
    expect(filter?.sql).toContain("n.scope = 'channel' AND n.scope_key = ?");
  });

  it('omits levels the caller has no context for, never the user level', () => {
    const filter = readableScopeSql({ sessionId: 's1' });
    expect(filter?.params).toEqual(['s1']);
    expect(filter?.sql.startsWith("(n.scope = 'user'")).toBe(true);
  });

  it('defaults a group chat to the channel scope and a project chat to the project', () => {
    expect(
      defaultScope({ channel: 'feishu', isGroupChat: true, chatId: 'oc_1', projectId: 'p1' }),
    ).toEqual({ scope: 'channel', scopeKey: 'feishu:oc_1' });
    expect(defaultScope({ channel: 'webui', projectId: 'p1' })).toEqual({
      scope: 'project',
      scopeKey: 'p1',
    });
    expect(defaultScope({ channel: 'feishu', chatId: 'oc_p2p' })).toEqual({
      scope: 'user',
      scopeKey: '',
    });
  });

  it('never infers the session scope', () => {
    expect(defaultScope({ sessionId: 's1', channel: 'feishu' }).scope).toBe('user');
    expect(channelScopeKey('telegram', '123')).toBe('telegram:123');
  });
});

describe('recap gate', () => {
  const windowText = [
    '用户：vitest 全量跑太慢，怎么只跑改过的？我现在每次改一个文件都要等七十秒，而且并行跑两个 session 的时候机器直接卡住。',
    '助手：改动少于 3 个文件时只跑那一个：npx vitest run tests/agent。并发跑会互相拖慢，因为 vitest 每个 worker 都会起自己的进程池，两个 session 同时跑就是双份进程池在抢同样的核。',
  ].join('\n');

  it('scores identical text as a perfect match', () => {
    expect(jaccard(ngramSet('abc def'), ngramSet('abc def'))).toBe(1);
  });

  it('drops a body that restates the window', () => {
    const verdict = isRecap({ body: windowText, tags: [], windowText });
    expect(verdict.recap).toBe(true);
    expect(verdict.score).toBeGreaterThan(0.9);
  });

  it('keeps a real note: own words, and tagged', () => {
    const body =
      '改动少于 3 个文件时只跑那个文件，因为全量跑会让并发 worker 互相抢 CPU。\n\n```bash\nnpx vitest run tests/agent\n```';
    expect(isRecap({ body, tags: ['testing'], windowText }).recap).toBe(false);
    // Same body without tags is still not a recap: it is not word-for-word.
    expect(isRecap({ body, tags: [], windowText }).recap).toBe(false);
  });

  it('exempts short bodies, which cannot be summarising a long window', () => {
    expect(isRecap({ body: '短笔记一句', tags: [], windowText }).recap).toBe(false);
  });
});

describe('redaction', () => {
  it('hides provider keys but keeps a readable prefix', () => {
    const { text, count } = redactSecrets('export KEY=sk-abcdefghijklmnopqrstuvwxyz012345');
    expect(count).toBe(1);
    expect(text).toContain('sk-«redacted:');
    expect(text).not.toContain('abcdefghijklmnop');
  });

  it('hides bearer tokens and PEM bodies', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----';
    const { text } = redactSecrets(`Authorization: Bearer abcdefghijklmnop\n${pem}`);
    expect(text).not.toContain('abcdefghijklmnop');
    expect(text).not.toContain('MIIEow');
  });

  it('keeps the key name of a password assignment and drops the value', () => {
    const { text } = redactSecrets('password=hunter2hunter2');
    expect(text).toBe('password=«redacted»');
  });

  it('hides a long unbroken base64 run', () => {
    const secret = 'A'.repeat(48);
    const { text, count } = redactSecrets(`token ${secret} end`);
    expect(count).toBe(1);
    expect(text).not.toContain(secret);
  });

  it('leaves ordinary prose alone', () => {
    const prose = 'Termux 里 pnpm install 要加 --no-optional，否则装不上原生模块。';
    expect(redactSecrets(prose)).toEqual({ text: prose, count: 0 });
  });

  it('is idempotent', () => {
    const once = redactSecrets('key=sk-abcdefghijklmnopqrstuvwx').text;
    expect(redactSecrets(once)).toEqual({ text: once, count: 0 });
  });
});

describe('window', () => {
  const history = [
    message('m1', 'user', '第一个问题', 1),
    message('m2', 'assistant', '第一个回答', 2),
    message('m3', 'user', '第二个问题', 3),
    message(
      'm4',
      'assistant',
      '',
      4,
      JSON.stringify({
        tool_calls: [{ function: { name: 'shell', arguments: '{"command":"ls"}' } }],
      }),
    ),
    message('m5', 'tool', '文件列表…', 5),
    message('m6', 'assistant', '第二个回答', 6),
  ];

  it('reads one exchange by default', () => {
    const window = resolveWindow(history, { sessionId: 's', mode: 'turn' });
    expect(window.messageIds).toEqual(['m3', 'm6']);
  });

  it('does not read tool output by default', () => {
    const window = resolveWindow(history, { sessionId: 's', mode: 'recent', turns: 5 });
    expect(window.messages.some((item) => item.content.includes('文件列表'))).toBe(false);
    expect(window.messages.every((item) => item.id !== 'm4')).toBe(true);
  });

  it('renders one line per tool call when asked, still without the result', () => {
    const window = resolveWindow(history, {
      sessionId: 's',
      mode: 'recent',
      turns: 5,
      includeTools: 'args',
    });
    const toolLine = window.messages.find((item) => item.id === 'm4');
    expect(toolLine?.content).toBe('[tool] shell({"command":"ls"})');
    expect(window.messages.some((item) => item.content.includes('文件列表'))).toBe(false);
  });

  it('trims the oldest messages to a stated character cap, never the last exchange', () => {
    const long = [
      message('a1', 'user', 'x'.repeat(20000), 1),
      message('a2', 'assistant', 'y'.repeat(20000), 2),
      message('a3', 'user', '短问题', 3),
      message('a4', 'assistant', '短回答', 4),
    ];
    const window = resolveWindow(long, {
      sessionId: 's',
      mode: 'recent',
      turns: 2,
      charBudget: 100,
    });
    expect(window.messageIds).toEqual(['a3', 'a4']);
    expect(window.droppedMessages).toBe(2);
  });

  it('rejects a selection from another session and reports why', () => {
    const window = resolveWindow(history, {
      sessionId: 's',
      mode: 'selection',
      messageIds: ['not-here'],
    });
    expect(window.error).toBe('selection_outside_session');
  });

  it('captures verbatim text with no citable message id', () => {
    const window = resolveWindow(history, { sessionId: 's', mode: 'text', text: '这行是我说的' });
    expect(window.messageIds).toEqual([]);
    expect(window.lastUserMessage?.content).toBe('第二个问题');
  });

  it('estimates CJK more expensively than latin', () => {
    expect(estimateTokens('中文四字')).toBeGreaterThan(estimateTokens('abcd'));
  });

  it('labels roles so the model treats the window as material', () => {
    const window = resolveWindow(history, { sessionId: 's', mode: 'turn' });
    expect(renderWindowPrompt(window.messages)).toContain('[m3] user:');
  });
});

describe('distill validation', () => {
  const allowed = ['m1', 'm2'];

  it('keeps a well-formed note', () => {
    const outcome = parseDistillResponse(
      JSON.stringify({
        notes: [
          {
            title: 'vitest 单文件迭代',
            summary: '只跑改动的文件',
            body: 'npx vitest run tests/agent',
            fields: [{ key: 'command', value: 'npx vitest run tests/agent', mono: true }],
            tags: ['#Testing', 'pitfall'],
            evidence: ['m2'],
            confidence: 1.7,
          },
        ],
      }),
      allowed,
    );
    expect(outcome.notes).toHaveLength(1);
    expect(outcome.notes[0].tags).toEqual(['testing', 'pitfall']);
    expect(outcome.notes[0].fields).toEqual([
      { key: 'command', value: 'npx vitest run tests/agent', mono: true },
    ]);
    expect(outcome.notes[0].confidence).toBe(1);
  });

  it('keeps free-form field keys with the mono flag the model chose', () => {
    // The per-kind slot whitelist is gone (v36): a slot nobody whitelisted — the
    // model's own `symptom` — used to be dropped at validation, stored never,
    // shown never. Keys are free now; `mono` is the model's call, not a key list.
    const outcome = parseDistillResponse(
      JSON.stringify({
        notes: [
          {
            title: 't',
            summary: 's',
            body: 'b',
            evidence: ['m1'],
            fields: [
              { key: 'Symptom', value: '端口被占用' },
              { key: 'fix', value: 'fuser -k 9191/tcp', mono: true },
            ],
          },
        ],
      }),
      allowed,
    );
    expect(outcome.notes[0].fields).toEqual([
      { key: 'symptom', value: '端口被占用', mono: false },
      { key: 'fix', value: 'fuser -k 9191/tcp', mono: true },
    ]);
  });

  it('accepts the legacy object fields form as non-mono slots', () => {
    // A model that saw an older prompt may still answer `"fields":{"command":...}`.
    // Tolerated rather than rejected: content over shape, same as it always was.
    const outcome = parseDistillResponse(
      JSON.stringify({
        notes: [
          {
            title: 't',
            summary: 's',
            body: 'b',
            evidence: ['m1'],
            fields: { command: 'pnpm test' },
          },
        ],
      }),
      allowed,
    );
    expect(outcome.notes[0].fields).toEqual([{ key: 'command', value: 'pnpm test', mono: false }]);
  });

  it('caps fields at six and drops empty slots', () => {
    const fields = Array.from({ length: 9 }, (_, index) => ({
      key: `k${index}`,
      value: index === 3 ? '   ' : `v${index}`,
    }));
    const outcome = parseDistillResponse(
      JSON.stringify({
        notes: [{ title: 't', summary: 's', body: 'b', evidence: ['m1'], fields }],
      }),
      allowed,
    );
    expect(outcome.notes[0].fields.map((field) => field.key)).toEqual([
      'k0',
      'k1',
      'k2',
      'k4',
      'k5',
      'k6',
    ]);
  });

  describe('reported scope', () => {
    const scoped = (evidence: string[], scope: unknown) =>
      JSON.stringify({
        scope,
        notes: [{ title: 't', summary: 's', body: 'b', evidence }],
      });

    it('rejects a note that cites a message older than the brief allowed', () => {
      // "只整理最近 3 轮": the model reported the number, so the window turns it into the
      // ids it covers. A citation from outside is out of scope, not merely out of window.
      const outcome = parseDistillResponse(
        scoped(['m1'], { turns: 1 }),
        allowed,
        1200,
        () => new Set(['m2']),
      );

      expect(outcome.notes).toHaveLength(0);
      expect(outcome.rejected[0].reason).toBe('evidence_outside_scope');
      expect(outcome.scope).toEqual({ turns: 1 });
    });

    it('keeps a note that stays inside the reported scope', () => {
      const outcome = parseDistillResponse(
        scoped(['m2'], { turns: 1 }),
        allowed,
        1200,
        () => new Set(['m2']),
      );

      expect(outcome.notes).toHaveLength(1);
      expect(outcome.scope).toEqual({ turns: 1 });
    });

    it('does not enforce anything when the model reports no scope', () => {
      const outcome = parseDistillResponse(
        scoped(['m1'], undefined),
        allowed,
        1200,
        () => new Set(['m2']),
      );

      expect(outcome.notes).toHaveLength(1);
      expect(outcome.scope).toBeUndefined();
    });

    it('ignores a scope whose number could not come from a window', () => {
      // Clamping would be worse than ignoring: a scope of 0 or 999 turns would reject
      // good notes by accident rather than simply not narrowing.
      const outcome = parseDistillResponse(
        scoped(['m1'], { turns: 999 }),
        allowed,
        1200,
        () => new Set(['m2']),
      );
      expect(outcome.scope).toBeUndefined();
      expect(outcome.notes).toHaveLength(1);
    });

    it('reads a string number, because models quote them', () => {
      const outcome = parseDistillResponse(
        scoped(['m2'], { turns: '2' }),
        allowed,
        1200,
        () => new Set(['m2']),
      );
      expect(outcome.scope).toEqual({ turns: 2 });
    });
  });

  it('drops a note citing an id outside the window', () => {
    const outcome = parseDistillResponse(
      JSON.stringify({
        notes: [
          {
            title: 't',
            summary: 's',
            body: 'b',
            evidence: ['m9'],
          },
        ],
      }),
      allowed,
    );
    expect(outcome.notes).toHaveLength(0);
    expect(outcome.rejected[0].reason).toBe('evidence_outside_window');
  });

  it('drops a note with no evidence at all', () => {
    const outcome = parseDistillResponse(
      JSON.stringify({ notes: [{ title: 't', summary: 's', body: 'b' }] }),
      allowed,
    );
    expect(outcome.rejected[0].reason).toBe('no_evidence');
  });

  it('ignores a kind field an older prompt asked for', () => {
    // `kind` is deleted (v36); a model answering a cached old prompt with one is
    // neither rejected nor stored — the aspect dimension is a tag now, and the
    // note's content does not depend on the label.
    const outcome = parseDistillResponse(
      JSON.stringify({
        notes: [{ kind: '命令', title: 't', summary: 's', body: 'b', evidence: ['m1'] }],
      }),
      allowed,
    );
    expect(outcome.rejected).toEqual([]);
    expect(outcome.notes[0].title).toBe('t');
    expect('kind' in outcome.notes[0]).toBe(false);
  });

  it('reports unparseable output as invalid_json', () => {
    const outcome = parseDistillResponse('sorry, I cannot', allowed);
    expect(outcome.notes).toHaveLength(0);
    expect(outcome.rejected[0].reason).toBe('invalid_json');
  });

  it('accepts a fenced JSON block', () => {
    const outcome = parseDistillResponse(
      '```json\n{"notes":[{"title":"t","summary":"s","body":"b","evidence":["m1"]}]}\n```',
      allowed,
    );
    expect(outcome.notes).toHaveLength(1);
  });

  it('trims an over-long body instead of dropping the note', () => {
    const outcome = parseDistillResponse(
      JSON.stringify({
        notes: [
          {
            title: 't',
            summary: 's',
            body: 'x'.repeat(2000),
            evidence: ['m1'],
          },
        ],
      }),
      allowed,
    );
    // The default cap, not the old hard-coded 600: one note now carries the aspects
    // that used to become separate rows (see `notes.capture.bodyMaxChars`).
    expect(outcome.notes[0].body).toHaveLength(1200);
    expect(outcome.rejected.some((item) => item.reason === 'too_long')).toBe(true);
  });

  it('honours a configured body cap', () => {
    const payload = JSON.stringify({
      notes: [
        {
          title: 't',
          summary: 's',
          body: 'x'.repeat(2000),
          evidence: ['m1'],
        },
      ],
    });
    const outcome = parseDistillResponse(payload, allowed, 2000);
    // 2000 chars fit under a 2000-char cap, so nothing is trimmed and nothing is
    // reported — the validator and the prompt read the same number.
    expect(outcome.notes[0].body).toHaveLength(2000);
    expect(outcome.rejected.some((item) => item.reason === 'too_long')).toBe(false);
  });
});

describe('facets', () => {
  it('adds channel aliases so a Chinese search finds a feishu note', () => {
    expect(ftsFacetTokens({ origin: 'agent', channel: 'feishu' })).toContain('飞书');
  });

  it('includes the project name when there is one', () => {
    expect(
      ftsFacetTokens({ origin: 'user', channel: 'webui', projectName: 'OhMyAgent' }),
    ).toContain('OhMyAgent');
  });
});
