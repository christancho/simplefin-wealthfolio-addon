import { KEY_PREFIX } from '../constants';

/** The host restricts storage keys to this charset and 128 characters. */
const ALLOWED = /[^A-Za-z0-9_.:-]/g;
const MAX_KEY_LENGTH = 128;

export function storageKey(...parts: string[]): string {
  const key = [KEY_PREFIX, ...parts].join('.').replace(ALLOWED, '_');

  if (key.length > MAX_KEY_LENGTH) {
    throw new Error(
      `storage key "${key.slice(0, 32)}..." is ${key.length} chars; the host limit is ${MAX_KEY_LENGTH}`,
    );
  }

  return key;
}
