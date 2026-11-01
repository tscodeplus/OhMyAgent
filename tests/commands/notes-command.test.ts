import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { handleCommand } from '../../src/commands/command-handler.js';
import type { CommandDeps } from '../../src/commands/command-handler.js';
import { i18n } from '../../src/i18n/index.js';
import { changeI18nLocale } from '../../src/i18n/i18n-service.js';
import { truncate } from '../../src/shared/truncation.js';
import type { CaptureRequest, CaptureResult } from '../../src/notes/service-contract.js';

/**
 * `/note` and `/notes` — the IM entry to the notes layer (plan §11).
 *
 * These tests sit on the seam the command handler owns: what it asks `capture`
 * for, and what it says back. The capture pipeline itself is covered by
 * `tests/notes/capture.test.ts`; duplicating it here would only assert that the
 * mock was called twice.
 */

function makeDeps(): CommandDeps {
  return {
    agentService: {
      abort: vi.fn(async () => {}),
      isRunning: vi.fn(() => false),
      reset: vi.fn(() => true),
      destroyRuntime: vi.fn(() => true),
      rejectPendingApprovals: vi.fn(() => 0),
      resolveFirstPendingApproval: vi.fn(() => false),
      resolveAllPendingApprovals: vi.fn(() => 0),
      rejectPendingQuestions: vi.fn(() => 0),
      resolveUserQuestion: vi.fn(() => false),
      resolveFirstPendingQuestion: vi.fn(() => false),
      steer: vi.fn(() => true),
      followUp: vi.fn(async () => true),
      swapCard: vi.fn(async () => true),
      onNextAgentEnd: vi.fn(),
      setSessionAgentId: vi.fn(),
    },
  };
}

function okResult(titles: string[], duplicates: Array<[string, 'draft' | 'active']> = []) {
  return {
    ok: true,
    captureId: 'cap_1',
    notes: titles.map((title) => ({ id: `nt_${title}`, title })),
    duplicates: duplicates.map(([title, status]) => ({
      title,
      existingId: `nt_${title}`,
      status,
    })),
    redacted: 0,
    droppedRecaps: 0,
  } as unknown as CaptureResult;
}

/** A CommandDeps with a fake capture; the fake records what it was asked for. */
function depsWith(capture: (request: CaptureRequest) => Promise<CaptureResult>): CommandDeps {
  return { ...makeDeps(), notes: { capture } };
}

/**
 * The reply copy is asserted in Chinese, so the tests that read it pin the
 * locale explicitly — the suite boots with `en` (tests/setup.ts), and a
 * locale-dependent assertion that silently passes in whichever language the
 * previous test left behind proves nothing.
 */
async function useLocale(locale: 'zh-CN' | 'en') {
  await changeI18nLocale(locale);
}

describe('/note and /notes', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await useLocale('zh-CN');
  });

  afterAll(async () => {
    await useLocale('en');
  });

  // ── What it asks capture for ──

  it('treats /note and /notes as the same command', async () => {
    const capture = vi.fn(async (_request: CaptureRequest) => okResult(['a']));
    const deps = depsWith(capture);

    const singular = await handleCommand('/note', 's1', deps);
    const plural = await handleCommand('/notes', 's1', deps);
    const shouted = await handleCommand('/NOTES', 's1', deps);

    expect(capture).toHaveBeenCalledTimes(3);
    for (const result of [singular, plural, shouted]) {
      expect(result).not.toBeNull();
      expect(result!.reply).toBeTruthy();
      expect(result!.forwardText).toBeUndefined();
    }
    // Not just "both reach the same handler": the requests are identical, so the
    // two spellings cannot drift into different defaults later.
    const [first, second, third] = capture.mock.calls.map((call) => call[0]);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });

  it('recognises the Telegram group form `/note@bot`', async () => {
    const capture = vi.fn(async () => okResult(['a']));
    const result = await handleCommand('/note@ohmyagent_bot 整理成一条', 's1', depsWith(capture));

    // A group command only arrives when the bot is @-mentioned, and Telegram puts
    // that mention in the same token — so an unstripped suffix means the command
    // is silently the worst of both: delivered, and then ignored.
    expect(capture).toHaveBeenCalledWith(expect.objectContaining({ instruction: '整理成一条' }));
    expect(result!.reply).toBeTruthy();
  });

  it('keeps `@` inside an instruction intact', async () => {
    const capture = vi.fn(async () => okResult(['a']));
    await handleCommand('/note 把 @张三 的那段整理出来', 's1', depsWith(capture));

    // Only the command token is normalised; an instruction is the user's words.
    expect(capture).toHaveBeenCalledWith(
      expect.objectContaining({ instruction: '把 @张三 的那段整理出来' }),
    );
  });

  it('captures the conversation, not one exchange', async () => {
    const capture = vi.fn(async () => okResult(['a']));
    await handleCommand('/note', 'chat-42', depsWith(capture));

    // `recent` is the whole point: `/note` in a chat means "this conversation".
    // `turn` would silently answer a narrower question than the one asked.
    expect(capture).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'chat-42', mode: 'recent' }),
    );
  });

  it('passes the trailing text as the instruction', async () => {
    const capture = vi.fn(async () => okResult(['a']));
    await handleCommand('/note 把你的最终建议做成笔记', 's1', depsWith(capture));

    expect(capture).toHaveBeenCalledWith(
      expect.objectContaining({ instruction: '把你的最终建议做成笔记' }),
    );
  });

  it('omits the instruction when the command stands alone', async () => {
    const capture = vi.fn(async () => okResult(['a']));
    await handleCommand('/note', 's1', depsWith(capture));

    // `undefined`, not `''`: capture treats a present-but-empty instruction as
    // "the user asked for something", which widens the window and disables the
    // recap gate — the opposite of the bare-command reading.
    expect(capture).toHaveBeenCalledWith(expect.objectContaining({ instruction: undefined }));
  });

  it('clamps an over-long instruction to the route limit', async () => {
    const capture = vi.fn(async (_request: CaptureRequest) => okResult(['a']));
    await handleCommand(`/note ${'x'.repeat(900)}`, 's1', depsWith(capture));

    const request = capture.mock.calls[0]![0];
    expect(request.instruction!.length).toBeLessThanOrEqual(500);
    expect(request.instruction).toBe(truncate('x'.repeat(900), 500));
  });

  it('forwards the chat type so a group lands in the channel scope', async () => {
    const capture = vi.fn(async () => okResult(['a']));
    await handleCommand('/note', 's1', depsWith(capture), undefined, undefined, {
      chatType: 'group',
      channel: 'telegram',
    });

    expect(capture).toHaveBeenCalledWith(expect.objectContaining({ chatType: 'group' }));
  });

  it('records the human as the actor while origin stays agent', async () => {
    const capture = vi.fn(async () => okResult(['a']));
    await handleCommand('/note', 's1', depsWith(capture));

    // `actor` is who asked; `origin: 'agent'` (set by the pipeline) is who wrote
    // it, and that is what keeps the draft in the review queue.
    expect(capture).toHaveBeenCalledWith(expect.objectContaining({ actor: 'user' }));
  });

  // ── What it says back ──

  it('lists the drafts it created', async () => {
    const result = await handleCommand(
      '/note',
      's1',
      depsWith(async () => okResult(['男单世界排名前3', '女单世界排名前3'])),
    );

    const reply = result!.reply!;
    expect(reply).toContain('2');
    expect(reply).toContain('· 男单世界排名前3');
    expect(reply).toContain('· 女单世界排名前3');
    // The gate is the whole layer; a reply that does not say "not yet a note"
    // would let a user believe the capture was the approval.
    expect(reply).toContain('批准');
  });

  it('reports duplicates with the status of the row that owns the title', async () => {
    const result = await handleCommand(
      '/note',
      's1',
      depsWith(async () =>
        okResult(
          ['新笔记'],
          [
            ['旧草稿', 'draft'],
            ['旧笔记', 'active'],
          ],
        ),
      ),
    );

    const reply = result!.reply!;
    expect(reply).toContain('旧草稿（草稿箱）');
    expect(reply).toContain('旧笔记（已是笔记）');
    expect(reply).toContain('新笔记');
  });

  it('says "already exists" instead of "nothing found" when every title is taken', async () => {
    const result = await handleCommand(
      '/note',
      's1',
      depsWith(async () => ({
        ok: false,
        code: 'duplicate',
        captureId: 'cap_1',
        message: 'that note already exists',
        duplicates: [{ title: 'Ubuntu LTS', existingId: 'nt_1', status: 'active' }],
      })),
    );

    const reply = result!.reply!;
    expect(reply).toContain('Ubuntu LTS');
    expect(reply).toContain('已是笔记');
    // "Already have it" and "nothing worth keeping" are different answers, and
    // only the second one needs a retry with a better instruction.
    expect(reply).not.toContain(i18n.t('commands:note.noNotesHint'));
  });

  it('hints at the instruction form when nothing was worth keeping', async () => {
    const result = await handleCommand(
      '/note',
      's1',
      depsWith(async () => ({
        ok: false,
        code: 'no_notes',
        captureId: 'cap_1',
        message: 'nothing worth keeping',
      })),
    );

    const reply = result!.reply!;
    expect(reply).toContain(i18n.t('commands:note.noNotes'));
    expect(reply).toContain('/note');
  });

  it('gives every failure code its own sentence', async () => {
    const codes = ['empty_window', 'model_failed', 'invalid', 'no_session', 'disabled'] as const;
    const replies = new Set<string>();

    for (const code of codes) {
      const result = await handleCommand(
        '/note',
        's1',
        depsWith(async () => ({ ok: false, code, message: `msg for ${code}` })),
      );
      const reply = result!.reply!;
      // A raw i18n key means the dictionary is missing an entry.
      expect(reply).not.toMatch(/^commands:/);
      expect(reply.length).toBeGreaterThan(0);
      replies.add(reply);
    }

    // Five codes, five different sentences: collapsing them would tell a user
    // whose database is full to "try again in a moment".
    expect(replies.size).toBe(codes.length);
  });

  it('replies instead of forwarding when the layer is switched off', async () => {
    const deps = makeDeps(); // no `notes` dep = notes.enabled false
    const result = await handleCommand('/note 整理一下', 's1', deps);

    // Returning null would hand `/note 整理一下` to the model as a question.
    expect(result).not.toBeNull();
    expect(result!.reply).toBe(i18n.t('commands:note.disabled'));
    expect(result!.forwardText).toBeUndefined();
  });

  it('survives a capture that throws', async () => {
    const result = await handleCommand(
      '/note',
      's1',
      depsWith(async () => {
        throw new Error('database is locked');
      }),
    );

    expect(result!.reply).toContain('database is locked');
    expect(result!.reply).not.toMatch(/^commands:/);
  });

  it('speaks English when the locale is English', async () => {
    await useLocale('en');
    const result = await handleCommand(
      '/note',
      's1',
      depsWith(async () => okResult(['a note'])),
    );
    const reply = result!.reply!;

    // A key missing from the en dictionary would render Chinese, not the key
    // name (fallbackLng), which is exactly the drift that goes unnoticed.
    expect(reply).toContain('draft');
    expect(reply).toContain('· a note');
    expect(reply).not.toMatch(/[一-鿿]/);
  });

  it('does not leak the command into the agent as forwardText on success', async () => {
    const result = await handleCommand(
      '/note',
      's1',
      depsWith(async () => okResult(['a'])),
    );
    expect(result!.forwardText).toBeUndefined();
  });
});
