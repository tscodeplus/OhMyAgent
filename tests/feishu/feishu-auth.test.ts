import { describe, it, expect } from 'vitest';
import { createHash, createCipheriv, randomBytes } from 'node:crypto';
import {
  verifyToken,
  verifySignature,
  decryptEvent,
  verifyEventToken,
  verifyEventSignature,
  processEventBody,
  isTimestampFresh,
  authenticateEvent,
} from '../../extensions/channel-feishu/feishu-auth.js';

// ─── verifyToken ───

describe('verifyToken', () => {
  it('returns true when tokens match', () => {
    expect(verifyToken('abc123', 'abc123')).toBe(true);
  });

  it('returns false when tokens do not match', () => {
    expect(verifyToken('abc123', 'def456')).toBe(false);
  });

  it('returns false for empty token vs non-empty expected', () => {
    expect(verifyToken('', 'abc')).toBe(false);
  });

  it('returns true for two empty strings', () => {
    expect(verifyToken('', '')).toBe(true);
  });

  it('is case-sensitive', () => {
    expect(verifyToken('ABC', 'abc')).toBe(false);
  });
});

// ─── verifySignature ───

describe('verifySignature', () => {
  const encryptKey = 'test-encrypt-key';
  const timestamp = '1234567890';
  const nonce = 'abcdef';

  function computeExpected(body: string): string {
    const content = timestamp + nonce + encryptKey + body;
    return createHash('sha256').update(content).digest('hex');
  }

  it('returns true for a valid signature', () => {
    const body = '{"key":"value"}';
    const signature = computeExpected(body);
    expect(verifySignature(body, timestamp, nonce, signature, encryptKey)).toBe(true);
  });

  it('returns false for an invalid signature', () => {
    const body = '{"key":"value"}';
    expect(verifySignature(body, timestamp, nonce, 'wrong-sig', encryptKey)).toBe(false);
  });

  it('returns false when body is tampered', () => {
    const body = '{"key":"value"}';
    const signature = computeExpected(body);
    expect(verifySignature('{"key":"tampered"}', timestamp, nonce, signature, encryptKey)).toBe(false);
  });

  it('returns false when timestamp changes', () => {
    const body = '{"key":"value"}';
    const signature = computeExpected(body);
    expect(verifySignature(body, '9999999999', nonce, signature, encryptKey)).toBe(false);
  });

  it('returns false when nonce changes', () => {
    const body = '{"key":"value"}';
    const signature = computeExpected(body);
    expect(verifySignature(body, timestamp, 'ZZZZZZ', signature, encryptKey)).toBe(false);
  });

  it('returns false when encrypt key changes', () => {
    const body = '{"key":"value"}';
    const signature = computeExpected(body);
    expect(verifySignature(body, timestamp, nonce, signature, 'other-key')).toBe(false);
  });

  it('handles empty body', () => {
    const body = '';
    const signature = computeExpected(body);
    expect(verifySignature(body, timestamp, nonce, signature, encryptKey)).toBe(true);
  });

  it('handles empty encrypt key', () => {
    const body = 'hello';
    const content = timestamp + nonce + '' + body;
    const signature = createHash('sha256').update(content).digest('hex');
    expect(verifySignature(body, timestamp, nonce, signature, '')).toBe(true);
  });
});

// ─── decryptEvent ───

describe('decryptEvent', () => {
  // Helper: encrypt a plaintext using the same algorithm as Feishu uses
  function encryptPayload(plaintext: string, encryptKey: string): string {
    const key = createHash('sha256').update(encryptKey).digest();
    const iv = randomBytes(16);
    const cipher = createCipheriv('aes-256-cbc', key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
    return Buffer.concat([iv, encrypted]).toString('base64');
  }

  it('decrypts a known plaintext correctly', () => {
    const encryptKey = 'my-secret-key';
    const plaintext = JSON.stringify({ event_id: 'ev1', event_type: 'test' });
    const encrypted = encryptPayload(plaintext, encryptKey);

    const result = decryptEvent(encrypted, encryptKey);
    expect(result).toBe(plaintext);
  });

  it('round-trips complex JSON', () => {
    const encryptKey = 'another-key';
    const data = {
      schema: '2.0',
      header: {
        event_id: 'ev123',
        event_type: 'im.message.receive_v1',
        create_time: '1700000000',
        token: 'tok',
        app_id: 'app1',
        tenant_key: 'tenant1',
      },
      event: { message: { content: 'hello world' } },
    };
    const plaintext = JSON.stringify(data);
    const encrypted = encryptPayload(plaintext, encryptKey);

    const result = decryptEvent(encrypted, encryptKey);
    expect(JSON.parse(result)).toEqual(data);
  });

  it('throws with wrong encrypt key', () => {
    const encryptKey = 'correct-key';
    const plaintext = '{"test": true}';
    const encrypted = encryptPayload(plaintext, encryptKey);

    expect(() => decryptEvent(encrypted, 'wrong-key')).toThrow();
  });

  it('handles empty plaintext', () => {
    const encryptKey = 'key';
    const plaintext = '';
    const encrypted = encryptPayload(plaintext, encryptKey);

    const result = decryptEvent(encrypted, encryptKey);
    expect(result).toBe('');
  });

  it('handles large payload', () => {
    const encryptKey = 'key';
    const plaintext = 'x'.repeat(10000);
    const encrypted = encryptPayload(plaintext, encryptKey);

    const result = decryptEvent(encrypted, encryptKey);
    expect(result).toBe(plaintext);
  });

  it('throws on invalid base64', () => {
    expect(() => decryptEvent('!!!invalid-base64!!!', 'key')).toThrow();
  });
});

// ─── verifyEventToken ───

describe('verifyEventToken', () => {
  it('returns true when tokens match', () => {
    expect(verifyEventToken({ token: 'abc' }, { verificationToken: 'abc' })).toBe(true);
  });

  it('returns false when tokens do not match', () => {
    expect(verifyEventToken({ token: 'abc' }, { verificationToken: 'xyz' })).toBe(false);
  });

  it('returns false (fail-closed) when no verification token is configured', () => {
    // Security: an unconfigured gateway must NOT accept arbitrary tokens.
    expect(verifyEventToken({ token: 'abc' }, {})).toBe(false);
  });

  it('returns false when body has no token', () => {
    expect(verifyEventToken({}, { verificationToken: 'abc' })).toBe(false);
  });
});

// ─── verifyEventSignature ───

describe('verifyEventSignature', () => {
  it('returns true for a valid event signature', () => {
    const config = { encryptKey: 'key123' };
    const body = 'raw body';
    const timestamp = '111';
    const nonce = '222';
    const content = timestamp + nonce + config.encryptKey + body;
    const signature = createHash('sha256').update(content).digest('hex');

    expect(verifyEventSignature(body, timestamp, nonce, signature, config)).toBe(true);
  });

  it('returns false when no encrypt key is configured', () => {
    expect(verifyEventSignature('body', 'ts', 'nonce', 'sig', {})).toBe(false);
  });
});

// ─── processEventBody ───

describe('processEventBody', () => {
  function encryptPayload(plaintext: string, encryptKey: string): string {
    const key = createHash('sha256').update(encryptKey).digest();
    const iv = randomBytes(16);
    const cipher = createCipheriv('aes-256-cbc', key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
    return Buffer.concat([iv, encrypted]).toString('base64');
  }

  it('returns event when no encryption', () => {
    const body = { event: { msg: 'hello' } };
    const result = processEventBody(body, {});
    expect(result).toEqual({ msg: 'hello' });
  });

  it('decrypts encrypted event', () => {
    const encryptKey = 'test-key';
    const event = { event_id: 'ev1', data: 'secret' };
    const encrypted = encryptPayload(JSON.stringify(event), encryptKey);

    const body = { encrypt: encrypted };
    const result = processEventBody(body, { encryptKey });
    expect(result).toEqual(event);
  });

  it('throws on wrong key during decryption', () => {
    const encryptKey = 'correct';
    const encrypted = encryptPayload('{"test":true}', encryptKey);

    const body = { encrypt: encrypted };
    expect(() => processEventBody(body, { encryptKey: 'wrong' })).toThrow();
  });

  it('returns body as-is when no event and no encrypt', () => {
    const result = processEventBody({ foo: 'bar' } as any, {});
    expect(result).toEqual({ foo: 'bar' });
  });
});

// ─── isTimestampFresh ───

describe('isTimestampFresh', () => {
  it('accepts a current timestamp (seconds)', () => {
    const nowSec = String(Math.floor(Date.now() / 1000));
    expect(isTimestampFresh(nowSec)).toBe(true);
  });

  it('rejects a stale timestamp outside the window', () => {
    const oldSec = String(Math.floor(Date.now() / 1000) - 10 * 60);
    expect(isTimestampFresh(oldSec)).toBe(false);
  });

  it('rejects a far-future timestamp', () => {
    const futureSec = String(Math.floor(Date.now() / 1000) + 10 * 60);
    expect(isTimestampFresh(futureSec)).toBe(false);
  });

  it('rejects non-numeric / empty input', () => {
    expect(isTimestampFresh('not-a-number')).toBe(false);
    expect(isTimestampFresh('')).toBe(false);
    expect(isTimestampFresh('0')).toBe(false);
  });
});

// ─── authenticateEvent ───

describe('authenticateEvent', () => {
  const encryptKey = 'auth-key';
  const nonce = 'n0nce';

  function sign(body: string, timestamp: string): string {
    return createHash('sha256')
      .update(timestamp + nonce + encryptKey + body)
      .digest('hex');
  }

  it('rejects when no credentials are configured', () => {
    const res = authenticateEvent({ rawBody: '{}', parsedBody: {} }, {});
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('no-credentials');
  });

  it('accepts a valid signed + fresh request', () => {
    const rawBody = '{"x":1}';
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = sign(rawBody, timestamp);
    const res = authenticateEvent(
      { rawBody, timestamp, nonce, signature },
      { encryptKey },
    );
    expect(res.ok).toBe(true);
  });

  it('rejects a stale signed request (replay)', () => {
    const rawBody = '{"x":1}';
    const timestamp = String(Math.floor(Date.now() / 1000) - 10 * 60);
    const signature = sign(rawBody, timestamp);
    const res = authenticateEvent(
      { rawBody, timestamp, nonce, signature },
      { encryptKey },
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('stale-timestamp');
  });

  it('rejects a tampered body', () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = sign('{"x":1}', timestamp);
    const res = authenticateEvent(
      { rawBody: '{"x":2}', timestamp, nonce, signature },
      { encryptKey },
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('bad-signature');
  });

  it('rejects when signature headers are missing in encrypted mode', () => {
    const res = authenticateEvent(
      { rawBody: '{"x":1}', parsedBody: { token: 'whatever' } },
      { encryptKey },
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('missing-signature');
  });

  it('accepts a valid token in token-only mode', () => {
    const res = authenticateEvent(
      { parsedBody: { token: 'good' } },
      { verificationToken: 'good' },
    );
    expect(res.ok).toBe(true);
  });

  it('rejects a bad token in token-only mode', () => {
    const res = authenticateEvent(
      { parsedBody: { token: 'bad' } },
      { verificationToken: 'good' },
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('bad-token');
  });
});
