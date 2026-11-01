/**
 * A discriminated union representing either a successful value (Ok) or a failure (Err).
 * Uses explicit `| undefined` on internal fields to satisfy `exactOptionalPropertyTypes`.
 */
export class Result<T, E = Error> {
  public readonly isSuccess: boolean;
  public readonly isFailure: boolean;

  // Declared as `T | undefined` / `E | undefined` so that `exactOptionalPropertyTypes`
  // is satisfied — the fields may genuinely hold `undefined` before being set.
  private readonly _value: T | undefined;
  private readonly _error: E | undefined;

  private constructor(isSuccess: boolean, error: E | undefined, value: T | undefined) {
    if (isSuccess && error !== undefined) {
      throw new Error('InvalidOperation: A result cannot be successful and contain an error');
    }
    if (!isSuccess && error === undefined) {
      throw new Error('InvalidOperation: A failing result must contain an error');
    }

    this.isSuccess = isSuccess;
    this.isFailure = !isSuccess;
    this._value = value;
    this._error = error;
  }

  public getValue(): T {
    if (!this.isSuccess) {
      throw new Error(`Cannot retrieve value from a failed result: ${String(this._error)}`);
    }
    // Safe: constructor guarantees _value is set when isSuccess === true
    return this._value as T;
  }

  public getError(): E {
    if (this.isSuccess) {
      throw new Error('Cannot retrieve error from a successful result');
    }
    // Safe: constructor guarantees _error is set when isSuccess === false
    return this._error as E;
  }

  public static ok<U>(value: U): Result<U, never>;
  public static ok(): Result<void, never>;
  public static ok<U>(value?: U): Result<U | void, never> {
    return new Result<U | void, never>(true, undefined, value);
  }

  public static fail<F>(error: F): Result<never, F> {
    return new Result<never, F>(false, error, undefined);
  }
}
