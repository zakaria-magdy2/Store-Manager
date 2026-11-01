import { ValueObject } from '../common/value-object.base.js';
import type { CurrencyConfig } from './currency.js';
import { getCurrency } from './currency.js';
import { CurrencyMismatchError, InvalidMoneyError } from '../common/errors.js';

export interface MoneyProps {
  amount: bigint;
  currency: CurrencyConfig;
}

export interface MoneySerialized {
  amount: string;
  currency: string;
  decimals: number;
  formatted: string;
}

export type RoundingMode = 'HALF_EVEN' | 'HALF_UP';

export class Money extends ValueObject<MoneyProps> {
  private constructor(props: MoneyProps) {
    super(props);
  }

  public get amount(): bigint {
    return this.props.amount;
  }

  public get currency(): CurrencyConfig {
    return this.props.currency;
  }

  public static fromMinor(amount: bigint | number, currencyOrCode: CurrencyConfig | string): Money {
    const currency = typeof currencyOrCode === 'string' ? getCurrency(currencyOrCode) : currencyOrCode;
    // eslint-disable-next-line no-restricted-syntax -- Math.trunc is safe here: we are AT the Money boundary, converting an external number input into BigInt minor units. All internal arithmetic uses BigInt only.
    const bigintAmount = typeof amount === 'number' ? BigInt(Math.trunc(amount)) : amount;
    return new Money({ amount: bigintAmount, currency });
  }

  public static fromDecimal(decimalStr: string, currencyOrCode: CurrencyConfig | string): Money {
    const currency = typeof currencyOrCode === 'string' ? getCurrency(currencyOrCode) : currencyOrCode;
    const trimmed = decimalStr.trim();
    if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
      throw new InvalidMoneyError(`Invalid monetary decimal string: '${decimalStr}'`);
    }

    const isNegative = trimmed.startsWith('-');
    const cleanStr = isNegative ? trimmed.slice(1) : trimmed;
    const parts = cleanStr.split('.');
    const integerPart = parts[0] ?? '0';
    const fractionalPart = parts[1] ?? '';

    // Scale to the currency's decimal places
    const paddedFraction = fractionalPart.padEnd(currency.decimalPlaces, '0').slice(0, currency.decimalPlaces);
    const combinedStr = integerPart + paddedFraction;
    const rawBigInt = BigInt(combinedStr);
    const finalAmount = isNegative ? -rawBigInt : rawBigInt;

    return new Money({ amount: finalAmount, currency });
  }

  public static zero(currencyOrCode: CurrencyConfig | string): Money {
    return Money.fromMinor(0n, currencyOrCode);
  }

  public add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money({
      amount: this.amount + other.amount,
      currency: this.currency,
    });
  }

  public subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money({
      amount: this.amount - other.amount,
      currency: this.currency,
    });
  }

  public multiply(factor: number | bigint, mode: RoundingMode = 'HALF_EVEN'): Money {
    if (typeof factor === 'bigint') {
      return new Money({
        amount: this.amount * factor,
        currency: this.currency,
      });
    }

    // High-precision fractional multiplication using scaled integer arithmetic
    // eslint-disable-next-line no-restricted-syntax -- Math.round is safe here: we scale a float factor to a 6-decimal integer ONCE, then all subsequent arithmetic is BigInt-only. This is the designed entry point for fractional multiplication.
    const factorScaled = BigInt(Math.round(factor * 1_000_000));
    const divisor = 1_000_000n;
    const numerator = this.amount * factorScaled;

    const quotient = numerator / divisor;
    const remainder = numerator % divisor;
    const absRemainder = remainder < 0n ? -remainder : remainder;
    const half = divisor / 2n;

    let rounded = quotient;
    if (mode === 'HALF_EVEN') {
      if (absRemainder > half) {
        rounded += numerator > 0n ? 1n : -1n;
      } else if (absRemainder === half) {
        // Round to nearest even
        if (quotient % 2n !== 0n) {
          rounded += numerator > 0n ? 1n : -1n;
        }
      }
    } else {
      // HALF_UP
      if (absRemainder >= half) {
        rounded += numerator > 0n ? 1n : -1n;
      }
    }

    return new Money({ amount: rounded, currency: this.currency });
  }

  public isZero(): boolean {
    return this.amount === 0n;
  }

  public isPositive(): boolean {
    return this.amount > 0n;
  }

  public isNegative(): boolean {
    return this.amount < 0n;
  }

  public equals(other?: Money): boolean {
    if (!other || !(other instanceof Money)) return false;
    return this.amount === other.amount && this.currency.code === other.currency.code;
  }

  public greaterThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.amount > other.amount;
  }

  public greaterThanOrEqual(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.amount >= other.amount;
  }

  public lessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.amount < other.amount;
  }

  public lessThanOrEqual(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.amount <= other.amount;
  }

  public toDecimalString(): string {
    const isNeg = this.amount < 0n;
    const absAmount = isNeg ? -this.amount : this.amount;
    const dec = this.currency.decimalPlaces;

    if (dec === 0) {
      return (isNeg ? '-' : '') + absAmount.toString();
    }

    const str = absAmount.toString().padStart(dec + 1, '0');
    const intPart = str.slice(0, str.length - dec);
    const fracPart = str.slice(str.length - dec);
    return (isNeg ? '-' : '') + `${intPart}.${fracPart}`;
  }

  public toJSON(): MoneySerialized {
    return {
      amount: this.amount.toString(),
      currency: this.currency.code,
      decimals: this.currency.decimalPlaces,
      formatted: this.toDecimalString(),
    };
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency.code !== other.currency.code) {
      throw new CurrencyMismatchError(this.currency.code, other.currency.code);
    }
  }
}
