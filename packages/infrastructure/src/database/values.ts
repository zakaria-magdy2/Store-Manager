/**
 * SQLite stores 64-bit integers. better-sqlite3 returns them as JavaScript
 * numbers for safe ranges, while Kysely types them as bigint. Normalize every
 * persisted integer at the infrastructure boundary so domain code always sees
 * exact bigint values.
 */
export function toBigInt(value: bigint | number | string): bigint {
  if (typeof value === 'bigint') {
    return value;
  }
  return BigInt(value);
}
