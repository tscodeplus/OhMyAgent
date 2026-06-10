// src/computer-use/errors.ts

export const COMPUTER_USE_ERRORS = {
  DISABLED: 'Computer Use is globally disabled',
  LEASE_NOT_FOUND: 'No active computer lease',
  LEASE_RELEASED: 'Computer lease has been released',
  STALE_SNAPSHOT: 'Snapshot is stale',
  CAPABILITY_UNSUPPORTED: 'Provider does not support this action',
  ACTION_BLOCKED_BY_POLICY: 'Action blocked by lease policy',
  ACTION_REQUIRES_FOREGROUND: 'Action requires foreground input',
  ACTION_REQUIRES_INPUT_INJECTION_APPROVAL: 'Action requires explicit input-injection approval',
  APP_APPROVAL_REQUIRED: 'App requires approval before control',
  PROVIDER_UNAVAILABLE: 'Provider is not available on this platform',
  PROVIDER_CRASHED: 'Provider daemon crashed or returned invalid data',
  TARGET_NOT_FOUND: 'Target element not found in snapshot',
} as const;

export type ComputerUseErrorCode = keyof typeof COMPUTER_USE_ERRORS;

export interface ComputerUseError extends Error {
  code: ComputerUseErrorCode;
  detail?: Record<string, unknown>;
}

export function computerUseError(
  code: ComputerUseErrorCode,
  message: string,
  detail?: Record<string, unknown>,
): ComputerUseError {
  const err = new Error(message) as ComputerUseError;
  err.name = 'ComputerUseError';
  err.code = code;
  if (detail) err.detail = detail;
  return err;
}
