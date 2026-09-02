import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { UiaClient } from '../../../src/computer-use/win-uia/uia-client.js';

// ---------------------------------------------------------------------------
// Fake powershell.exe child process
// ---------------------------------------------------------------------------

interface FakeChild {
  proc: EventEmitter;
  stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
  spawned: ReturnType<typeof vi.fn>;
  sentLines: string[];
  emitStdout: (line: string) => void;
  emitExit: (code: number | null) => void;
}

const spawned = vi.fn();
let fake: FakeChild;

function makeFakeChild(): FakeChild {
  // The child must BE an EventEmitter (spread { ...proc } would drop the
  // prototype methods the client relies on: on/emit).
  const proc = new EventEmitter() as unknown as FakeChild['proc'] & FakeChild;
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const sentLines: string[] = [];
  proc.stdin = {
    write: vi.fn((line: string) => {
      sentLines.push(line);
    }),
    end: vi.fn(),
  };
  proc.stdout = stdout;
  proc.stderr = stderr;
  proc.kill = vi.fn(() => {
    proc.emit('exit', null, 'SIGTERM');
  });
  (proc as FakeChild).sentLines = sentLines;
  (proc as FakeChild).emitStdout = (line: string) =>
    stdout.emit('data', Buffer.from(line + '\n', 'utf8'));
  (proc as FakeChild).emitExit = (code: number | null) => proc.emit('exit', code, null);
  return proc as unknown as FakeChild;
}

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => {
    fake = makeFakeChild();
    spawned(fake);
    return fake;
  }),
}));

// Never touch the real Windows filesystem in tests.
vi.mock('../../../src/computer-use/win-uia/win-uia-scripts.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/computer-use/win-uia/win-uia-scripts.js')>();
  return { ...actual, writeUiaServerScript: vi.fn() };
});

// ---------------------------------------------------------------------------

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
// Poll-based handshake checks run on a 5ms timer; give them time to fire.
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('UiaClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('spawns powershell.exe with the server script and waits for handshake', async () => {
    const client = new UiaClient();
    const p = client.request('ping');
    await tick();
    // No command sent before handshake
    expect(fake.sentLines).toHaveLength(0);

    fake.emitStdout('CUAREADY 1');
    await wait(20);
    expect(fake.sentLines).toHaveLength(1);
    const msg = JSON.parse(fake.sentLines[0]);
    expect(msg.cmd).toBe('ping');
    expect(typeof msg.id).toBe('number');

    fake.emitStdout(JSON.stringify({ id: msg.id, ok: true, result: { pong: true } }));
    const res = await p;
    expect(res).toEqual({ ok: true, result: { pong: true } });
  });

  /** Warm the client up: issue a request that spawns the process, handshake,
   *  then complete it so later assertions start from a clean state. */
  async function warmUp(client: UiaClient): Promise<void> {
    const warm = client.request('ping');
    await tick();
    fake.emitStdout('CUAREADY 1');
    await wait(20);
    const wm = JSON.parse(fake.sentLines[0]);
    fake.emitStdout(JSON.stringify({ id: wm.id, ok: true, result: {} }));
    await warm;
    fake.sentLines.length = 0;
  }

  it('serializes requests FIFO (second waits for first response)', async () => {
    const client = new UiaClient();
    await warmUp(client);

    const p1 = client.request('click-element', { elementId: 'a' });
    const p2 = client.request('type-text', { text: 'b' });
    await tick();
    // Only the first request was written before its response
    expect(fake.sentLines).toHaveLength(1);

    const m1 = JSON.parse(fake.sentLines[0]);
    fake.emitStdout(JSON.stringify({ id: m1.id, ok: true, result: {} }));
    await p1;
    await tick();
    expect(fake.sentLines).toHaveLength(2);
    const m2 = JSON.parse(fake.sentLines[1]);
    expect(m2.cmd).toBe('type-text');

    fake.emitStdout(JSON.stringify({ id: m2.id, ok: true, result: {} }));
    await p2;
  });

  it('restarts with backoff on crash and rejects pending requests', async () => {
    const client = new UiaClient();
    await warmUp(client);

    const p = client.request('get-app-state');
    await tick();
    fake.emitExit(1);
    const res = await p;
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error.code).toBe('SERVER_CRASHED');

    // Backoff restart: second spawn after the first restart delay
    await new Promise((r) => setTimeout(r, 600));
    expect(spawned).toHaveBeenCalledTimes(2);
  });

  it('times out a handshake that never arrives, restarts, and rejects the request', async () => {
    const client = new UiaClient({ handshakeTimeoutMs: 60 });
    const p = client.request('ping');
    await tick();
    // Spawned but no CUAREADY: after the handshake timeout the request must
    // fail (not hang) and the server is restarted with backoff.
    const res = await p;
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error.code).toBe('SERVER_CRASHED');
    await new Promise((r) => setTimeout(r, 600));
    expect(spawned).toHaveBeenCalledTimes(2);
  });

  it('does not auto-restart after an idle EXIT; respawns lazily on next request', async () => {
    const client = new UiaClient();
    await warmUp(client);
    spawned.mockClear();

    fake.emitStdout('EXIT');
    fake.emitExit(0);
    await tick();
    // Idle exit must NOT trigger the crash-restart path (no backoff restart).
    await new Promise((r) => setTimeout(r, 600));
    expect(spawned).not.toHaveBeenCalled();

    // The next request spawns a fresh server and resumes normal operation.
    const p = client.request('ping');
    await tick();
    expect(spawned).toHaveBeenCalledTimes(1);
    fake.emitStdout('CUAREADY 1');
    await wait(20);
    expect(fake.sentLines.length).toBeGreaterThan(0);
    const msg = JSON.parse(fake.sentLines[0]);
    fake.emitStdout(JSON.stringify({ id: msg.id, ok: true, result: {} }));
    await p;
  });

  it('kills an idle server client-side without restart; respawns lazily on next request', async () => {
    const client = new UiaClient({ idleTimeoutMs: 60 });
    await warmUp(client);
    spawned.mockClear();

    // Idle longer than the timeout, then issue a request: the client must
    // reclaim the idle server (kill, no backoff restart) and spawn fresh.
    await new Promise((r) => setTimeout(r, 120));
    const idleChild = fake; // the request kills this child, then spawns a new one
    const p = client.request('ping');
    await tick();
    expect(idleChild.kill).toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 600));
    // No auto-restart happened on its own — only the request's lazy respawn.
    expect(spawned).toHaveBeenCalledTimes(1);

    fake.emitStdout('CUAREADY 1');
    await wait(20);
    expect(fake.sentLines.length).toBeGreaterThan(0);
    const msg = JSON.parse(fake.sentLines[0]);
    fake.emitStdout(JSON.stringify({ id: msg.id, ok: true, result: {} }));
    await p;
  });

  it('stop() kills the child and rejects in-flight requests', async () => {
    const client = new UiaClient();
    fake.emitStdout('CUAREADY 1');
    await wait(20);

    const p = client.request('scroll');
    await tick();
    await client.stop();
    const res = await p;
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error.code).toBe('SERVER_STOPPED');
    expect(fake.kill).toHaveBeenCalled();
  });

  it('stop() is idempotent and no new requests spawn a process after stop', async () => {
    const client = new UiaClient();
    await client.stop();
    await client.stop();
    const res = await client.request('ping');
    expect(res.ok).toBe(false);
    expect(spawned).not.toHaveBeenCalled();
  });
});
