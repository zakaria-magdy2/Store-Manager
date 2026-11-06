export interface BarcodeScannerOptions {
  /** Maximum gap between scanner keystrokes, in milliseconds. */
  maxInterKeyDelayMs?: number;
  /** Minimum barcode length to ignore ordinary typing. */
  minLength?: number;
  suffixes?: readonly string[];
}

/** Parses keyboard-wedge scanner input without depending on a browser or UI framework. */
export class BarcodeScannerListener {
  private buffer = '';
  private lastInputAt = 0;
  private readonly maxInterKeyDelayMs: number;
  private readonly minLength: number;
  private readonly suffixes: ReadonlySet<string>;

  public constructor(
    private readonly onBarcode: (barcode: string) => void,
    options: BarcodeScannerOptions = {},
  ) {
    this.maxInterKeyDelayMs = options.maxInterKeyDelayMs ?? 50;
    this.minLength = options.minLength ?? 3;
    this.suffixes = new Set(options.suffixes ?? ['Enter', 'Tab']);
    if (this.maxInterKeyDelayMs <= 0 || this.minLength <= 0) {
      throw new RangeError('Scanner timing and minimum length must be positive');
    }
  }

  /** Feed one key value and timestamp; returns true when a barcode was emitted. */
  public feed(key: string, timestamp = Date.now()): boolean {
    if (this.lastInputAt !== 0 && timestamp - this.lastInputAt > this.maxInterKeyDelayMs) {
      this.buffer = '';
    }
    this.lastInputAt = timestamp;

    if (this.suffixes.has(key)) {
      return this.flush();
    }
    if (key === 'Backspace') {
      this.buffer = this.buffer.slice(0, -1);
      return false;
    }
    if (key.length === 1 && !/[\r\n\t]/.test(key)) {
      this.buffer += key;
    }
    return false;
  }

  public reset(): void {
    this.buffer = '';
    this.lastInputAt = 0;
  }

  private flush(): boolean {
    const barcode = this.buffer.trim();
    this.reset();
    if (barcode.length < this.minLength) return false;
    this.onBarcode(barcode);
    return true;
  }
}
