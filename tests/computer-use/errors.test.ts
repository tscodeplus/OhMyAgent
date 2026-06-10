import { describe, it, expect } from 'vitest';
import { computerUseError, COMPUTER_USE_ERRORS } from '../../src/computer-use/errors';
import type { ComputerUseErrorCode } from '../../src/computer-use/errors';

describe('computerUseError', () => {
  const errorCodes = Object.keys(COMPUTER_USE_ERRORS) as ComputerUseErrorCode[];

  describe('creates error with correct properties for each code', () => {
    it.each(errorCodes)('%s', (code) => {
      const message = COMPUTER_USE_ERRORS[code];
      const error = computerUseError(code, message);

      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe('ComputerUseError');
      expect(error.code).toBe(code);
      expect(error.message).toBe(message);
    });
  });

  describe('detail parameter', () => {
    it('attaches detail when provided', () => {
      const error = computerUseError('DISABLED', 'test', { reason: 'foo' });
      expect(error.detail).toBeDefined();
      expect(error.detail!.reason).toBe('foo');
    });

    it('leaves detail undefined when not provided', () => {
      const error = computerUseError('DISABLED', 'test');
      expect(error.detail).toBeUndefined();
    });
  });
});
