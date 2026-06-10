import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { aesEncrypt, aesDecrypt, paddedSize } from '../../extensions/channel-wechat/wechat-crypto.js';

// A 16-byte raw key, expressed in the two accepted base64 forms.
const RAW_KEY = Buffer.from('0123456789abcdef', 'ascii'); // exactly 16 bytes
const KEY_RAW_B64 = RAW_KEY.toString('base64'); // base64 of 16 raw bytes
// base64 of a 32-char hex string that decodes to 16 bytes
const HEX_32 = RAW_KEY.toString('hex'); // 32 hex chars
const KEY_HEX_B64 = Buffer.from(HEX_32, 'ascii').toString('base64');

describe('wechat-crypto — AES-128-ECB round trip', () => {
  it('decrypt(encrypt(x)) === x for the raw-bytes key form', () => {
    const plaintext = Buffer.from('hello iLink media payload', 'utf-8');
    const encrypted = aesEncrypt(plaintext, KEY_RAW_B64);
    const decrypted = aesDecrypt(encrypted, KEY_RAW_B64);
    expect(decrypted.equals(plaintext)).toBe(true);
  });

  it('decrypt(encrypt(x)) === x for the 32-hex-char key form', () => {
    const plaintext = Buffer.from('another payload', 'utf-8');
    const encrypted = aesEncrypt(plaintext, KEY_HEX_B64);
    const decrypted = aesDecrypt(encrypted, KEY_HEX_B64);
    expect(decrypted.equals(plaintext)).toBe(true);
  });

  it('both key forms decode to the same key (interoperable ciphertext)', () => {
    const plaintext = Buffer.from('cross-form', 'utf-8');
    const encryptedRaw = aesEncrypt(plaintext, KEY_RAW_B64);
    // Ciphertext produced with raw-form key decrypts with hex-form key.
    const decrypted = aesDecrypt(encryptedRaw, KEY_HEX_B64);
    expect(decrypted.equals(plaintext)).toBe(true);
  });

  it('round-trips an empty buffer (PKCS7 pads to one full block)', () => {
    const encrypted = aesEncrypt(Buffer.alloc(0), KEY_RAW_B64);
    expect(encrypted.length).toBe(16);
    expect(aesDecrypt(encrypted, KEY_RAW_B64).length).toBe(0);
  });

  it('round-trips data spanning multiple blocks', () => {
    const plaintext = crypto.randomBytes(100);
    const encrypted = aesEncrypt(plaintext, KEY_RAW_B64);
    expect(encrypted.length).toBe(paddedSize(100));
    expect(aesDecrypt(encrypted, KEY_RAW_B64).equals(plaintext)).toBe(true);
  });

  it('produces ciphertext padded to a 16-byte multiple', () => {
    for (const size of [1, 15, 16, 17, 31, 32]) {
      const encrypted = aesEncrypt(crypto.randomBytes(size), KEY_RAW_B64);
      expect(encrypted.length % 16).toBe(0);
      expect(encrypted.length).toBe(paddedSize(size));
    }
  });
});

describe('wechat-crypto — key validation', () => {
  it('rejects a key whose decoded length is neither 16 nor 32', () => {
    const badKey = Buffer.from('too-short', 'ascii').toString('base64'); // 9 bytes
    expect(() => aesEncrypt(Buffer.from('x'), badKey)).toThrow(/Invalid aes_key length/);
  });

  it('rejects a 32-byte key that is not valid hex', () => {
    const notHex = Buffer.from('zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz', 'ascii').toString('base64');
    expect(() => aesDecrypt(Buffer.alloc(16), notHex)).toThrow(/Invalid aes_key length/);
  });
});

describe('wechat-crypto — paddedSize', () => {
  it('always adds 1-16 bytes of padding (PKCS7 invariant)', () => {
    expect(paddedSize(0)).toBe(16);
    expect(paddedSize(1)).toBe(16);
    expect(paddedSize(15)).toBe(16);
    expect(paddedSize(16)).toBe(32); // full block already → adds a whole pad block
    expect(paddedSize(17)).toBe(32);
  });
});
