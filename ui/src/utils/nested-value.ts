/**
 * Immutably set a deeply nested value on an object using a dot-separated path.
 * Returns a new object; the original is not mutated.
 */
export function setNestedValue<T extends Record<string, unknown> | null>(
  obj: T,
  path: string,
  value: unknown,
): T {
  if (!obj) return obj;
  const keys = path.split('.');
  const result: Record<string, unknown> = { ...obj };
  let current: Record<string, unknown> = result;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i]!;
    const existing = current[key];
    current[key] = {
      ...(typeof existing === 'object' && existing !== null && !Array.isArray(existing)
        ? (existing as Record<string, unknown>)
        : {}),
    };
    current = current[key] as Record<string, unknown>;
  }
  const lastKey = keys[keys.length - 1]!;
  current[lastKey] = value;
  return result as T;
}
