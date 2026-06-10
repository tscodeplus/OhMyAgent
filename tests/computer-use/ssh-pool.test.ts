import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SSHPool, SSHExitError, SSHTimeoutError } from '../../src/computer-use/transports/ssh-pool.js';
import type { SSHPoolConfig } from '../../src/computer-use/transports/ssh-pool.js';
import { spawn } from 'child_process';
import { EventEmitter } from 'events';

vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

function createMockProcess(
  stdout: string,
  stderr: string,
  exitCode: number,
  delayMs: number = 0,
  emitCloseOnKill: boolean = false,
) {
  const emitter = new EventEmitter() as any;
  emitter.stdout = new EventEmitter();
  emitter.stderr = new EventEmitter();
  emitter.kill = vi.fn(() => {
    if (emitCloseOnKill) {
      emitter.emit('close', exitCode);
    }
  });

  if (delayMs >= 0) {
    setTimeout(() => {
      emitter.stdout.emit('data', Buffer.from(stdout));
      emitter.stderr.emit('data', Buffer.from(stderr));
      emitter.emit('close', exitCode);
    }, delayMs);
  }

  return emitter;
}

function createPool(config?: Partial<SSHPoolConfig>): SSHPool {
  return new SSHPool(
    {
      host: 'test-host',
      user: 'test-user',
      keyPath: '/tmp/test-key',
      keepAliveIntervalMs: -1, // disable heartbeat
      ...config,
    },
    undefined,
  );
}

describe('SSHPool', () => {
  let pool: SSHPool | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    // Default mock: successful process
    (spawn as any).mockImplementation(() => createMockProcess('', '', 0, 0));
    pool = undefined;
  });

  afterEach(async () => {
    // Reset mock before destroy to avoid hanging (important for timeout test)
    (spawn as any).mockReset();
    (spawn as any).mockImplementation(() => createMockProcess('', '', 0, 0));
    if (pool) {
      await pool.destroy().catch(() => {});
    }
  });

  // -----------------------------------------------------------------------
  // exec
  // -----------------------------------------------------------------------

  it('exec success', async () => {
    pool = createPool();
    (spawn as any).mockImplementation(() => createMockProcess('hello', '', 0, 0));

    const result = await pool.exec('echo hello');

    expect(result.stdout).toBe('hello');
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('exec failure with retry', async () => {
    pool = createPool({ retryCount: 1 });
    (spawn as any).mockImplementation(() => createMockProcess('', 'error msg', 1, 0));

    await expect(pool.exec('false')).rejects.toThrow(SSHExitError);
    // retryCount=1 means 1 retry → 2 total spawn calls (initial + 1 retry)
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('exec failure no retry for fatal codes', async () => {
    pool = createPool({ retryCount: 3 });
    (spawn as any).mockImplementation(() => createMockProcess('', 'connection refused', 255, 0));

    await expect(pool.exec('somecommand')).rejects.toThrow(SSHExitError);
    // exitCode 255 is fatal — should NOT retry
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('command timeout', async () => {
    pool = createPool({ commandTimeoutMs: 100 });

    // Process that never emits close naturally,
    // but emits close when killed by the spawnSSH timeout handler
    const emitter = new EventEmitter() as any;
    emitter.stdout = new EventEmitter();
    emitter.stderr = new EventEmitter();
    emitter.kill = vi.fn(() => {
      emitter.emit('close', null);
    });
    (spawn as any).mockImplementation(() => emitter);

    await expect(pool.exec('sleep 100')).rejects.toThrow(SSHTimeoutError);
    expect(emitter.kill).toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // SSH args
  // -----------------------------------------------------------------------

  it('SSH args construction', async () => {
    pool = createPool({ port: 2222 });
    (spawn as any).mockImplementation(() => createMockProcess('ok', '', 0, 0));

    await pool.exec('echo test');

    const callArgs = (spawn as any).mock.calls[0];
    expect(callArgs[0]).toBe('ssh');

    const sshArgs: string[] = callArgs[1];
    expect(sshArgs).toContain('-i');
    expect(sshArgs).toContain('/tmp/test-key');
    expect(sshArgs).toContain('-p');
    expect(sshArgs).toContain('2222');
    expect(sshArgs).toContain('-o');
    // ControlMaster arguments
    const controlMasterIdx = sshArgs.indexOf('ControlMaster=auto');
    expect(controlMasterIdx).toBeGreaterThanOrEqual(0);
    expect(sshArgs[controlMasterIdx - 1]).toBe('-o');
    // ControlPath
    const controlPathIdx = sshArgs.findIndex(a => a.startsWith('ControlPath='));
    expect(controlPathIdx).toBeGreaterThanOrEqual(0);
    expect(sshArgs[controlPathIdx - 1]).toBe('-o');
    // user@host
    const userHostIdx = sshArgs.indexOf('test-user@test-host');
    expect(userHostIdx).toBeGreaterThanOrEqual(0);
    // Command should be the last argument
    expect(sshArgs[sshArgs.length - 1]).toContain('echo test');
  });

  // -----------------------------------------------------------------------
  // DISPLAY injection
  // -----------------------------------------------------------------------

  it('DISPLAY env injection', async () => {
    pool = createPool({ display: ':9' });
    (spawn as any).mockImplementation(() => createMockProcess('ok', '', 0, 0));

    await pool.exec('xdotool getactivewindow getwindowname');

    const sshArgs: string[] = (spawn as any).mock.calls[0][1];
    const lastArg = sshArgs[sshArgs.length - 1];
    expect(lastArg).toContain('DISPLAY=:9');
    expect(lastArg).toContain('xdotool getactivewindow getwindowname');
  });

  it('rejects unsafe DISPLAY values', () => {
    expect(() => createPool({ display: ':0; rm -rf /' })).toThrow('Invalid SSH DISPLAY value');
  });

  // -----------------------------------------------------------------------
  // healthCheck
  // -----------------------------------------------------------------------

  it('healthCheck reachable', async () => {
    pool = createPool();
    const stdout = '/usr/bin/xdotool\n/usr/bin/scrot\nOK';
    (spawn as any).mockImplementation(() => createMockProcess(stdout, '', 0, 0));

    const result = await pool.healthCheck();

    expect(result.reachable).toBe(true);
    expect(result.deps.xdotool).toBe(true);
    expect(result.deps.scrot).toBe(true);
  });

  it('healthCheck unreachable', async () => {
    pool = createPool();
    (spawn as any).mockImplementation(() => createMockProcess('', 'error', 1, 0));

    const result = await pool.healthCheck();

    expect(result.reachable).toBe(false);
    expect(result.deps.xdotool).toBe(false);
    expect(result.deps.scrot).toBe(false);
  });
});
