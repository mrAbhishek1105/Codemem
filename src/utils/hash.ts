import { createHash } from 'crypto';

/** Fast content hash for change detection (first 16 hex chars of SHA-256) */
export function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex').slice(0, 16);
}

/** Hash a string to a stable short key (for cache keys, etc.) */
export function hashString(input: string): string {
  return createHash('sha256').update(input, 'utf-8').digest('hex').slice(0, 32);
}
