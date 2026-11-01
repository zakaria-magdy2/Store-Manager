/**
 * Structural equality that is safe for financial value objects.
 *
 * `JSON.stringify` cannot serialize `bigint` and throws, which would make any
 * BigInt-based value object (such as `Money`) impossible to compare generically.
 * This implementation compares primitives, bigints, dates, arrays, and plain
 * objects without stringification.
 */
function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }
  if (typeof left === 'bigint' || typeof right === 'bigint') {
    return typeof left === 'bigint' && typeof right === 'bigint' && left === right;
  }
  if (left instanceof Date || right instanceof Date) {
    return left instanceof Date && right instanceof Date && left.getTime() === right.getTime();
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((value, index) => deepEqual(value, right[index]));
  }
  if (left !== null && right !== null && typeof left === 'object' && typeof right === 'object') {
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const leftKeys = Object.keys(leftRecord);
    const rightKeys = Object.keys(rightRecord);
    if (leftKeys.length !== rightKeys.length) {
      return false;
    }
    return leftKeys.every((key) => deepEqual(leftRecord[key], rightRecord[key]));
  }
  return false;
}

export abstract class ValueObject<T> {
  protected readonly props: T;

  constructor(props: T) {
    this.props = Object.freeze(props);
  }

  public equals(vo?: ValueObject<T>): boolean {
    if (vo === null || vo === undefined) {
      return false;
    }
    if (vo.props === undefined) {
      return false;
    }
    return deepEqual(this.props, vo.props);
  }
}
