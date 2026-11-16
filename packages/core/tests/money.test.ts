import { describe, it, expect } from 'vitest';
import { Money, Currencies, distributeDiscount, amortizeMonthlyExpense } from '../src/index.js';

describe('Money Value Object', () => {
  it('correctly creates and formats 2-decimal currencies (USD, EGP)', () => {
    const usd = Money.fromDecimal('102.60', Currencies.USD!);
    expect(usd.amount).toBe(10260n);
    expect(usd.toDecimalString()).toBe('102.60');

    const egp = Money.fromDecimal('50.05', Currencies.EGP!);
    expect(egp.amount).toBe(5005n);
    expect(egp.toDecimalString()).toBe('50.05');
  });

  it('correctly creates and formats 3-decimal currencies (KWD, JOD)', () => {
    const kwd = Money.fromDecimal('1.250', Currencies.KWD!);
    expect(kwd.amount).toBe(1250n);
    expect(kwd.toDecimalString()).toBe('1.250');

    const kwdZeroPadded = Money.fromDecimal('1.5', Currencies.KWD!);
    expect(kwdZeroPadded.amount).toBe(1500n);
    expect(kwdZeroPadded.toDecimalString()).toBe('1.500');
  });

  it('correctly creates and formats 0-decimal currencies (JPY)', () => {
    const jpy = Money.fromDecimal('500', Currencies.JPY!);
    expect(jpy.amount).toBe(500n);
    expect(jpy.toDecimalString()).toBe('500');
  });

  it('performs exact addition and subtraction without floating-point errors', () => {
    const a = Money.fromDecimal('0.10', Currencies.USD!);
    const b = Money.fromDecimal('0.20', Currencies.USD!);
    const sum = a.add(b);
    expect(sum.toDecimalString()).toBe('0.30');
    expect(sum.amount).toBe(30n);

    const diff = sum.subtract(a);
    expect(diff.toDecimalString()).toBe('0.20');
  });

  it('multiplies using Banker\'s Rounding (Round Half to Even)', () => {
    // 2.5 cents rounds to 2 cents (even)
    const m1 = Money.fromMinor(25n, Currencies.USD!); // $0.25
    const r1 = m1.multiply(0.10); // 25 * 0.10 = 2.5 -> rounds to 2
    expect(r1.amount).toBe(2n);

    // 3.5 cents rounds to 4 cents (even)
    const m2 = Money.fromMinor(35n, Currencies.USD!); // $0.35
    const r2 = m2.multiply(0.10); // 35 * 0.10 = 3.5 -> rounds to 4
    expect(r2.amount).toBe(4n);
  });
});

describe('Hamilton-Hare Discount Allocation', () => {
  it('allocates header discount across 3 items with exact sum preservation', () => {
    const totalDiscount = Money.fromDecimal('10.00', Currencies.USD!); // 1000 cents
    const item1 = Money.fromDecimal('33.33', Currencies.USD!);
    const item2 = Money.fromDecimal('33.33', Currencies.USD!);
    const item3 = Money.fromDecimal('33.34', Currencies.USD!);

    const discounts = distributeDiscount(totalDiscount, [item1, item2, item3]);
    expect(discounts).toHaveLength(3);

    const sumDiscounts = discounts.reduce((acc, curr) => acc + curr.amount, 0n);
    expect(sumDiscounts).toBe(totalDiscount.amount);
  });
});

describe('Monthly Operating Expense Amortization', () => {
  it('amortizes monthly rent exactly over 30 days without losing single minor units', () => {
    const monthlyRent = Money.fromDecimal('1500.00', Currencies.USD!); // 150,000 cents
    const dailyShares = amortizeMonthlyExpense(monthlyRent, 30);

    expect(dailyShares).toHaveLength(30);
    const sumDaily = dailyShares.reduce((acc, curr) => acc + curr.amount, 0n);
    expect(sumDaily).toBe(monthlyRent.amount);
    // 150,000 / 30 = 5000 cents exactly ($50.00)
    expect(dailyShares[0]!.toDecimalString()).toBe('50.00');
  });

  it('amortizes monthly electricity with odd remainder over 31 days with exact sum guarantee', () => {
    const monthlyBill = Money.fromDecimal('100.00', Currencies.USD!); // 10,000 cents
    const dailyShares = amortizeMonthlyExpense(monthlyBill, 31);

    expect(dailyShares).toHaveLength(31);
    const sumDaily = dailyShares.reduce((acc, curr) => acc + curr.amount, 0n);
    expect(sumDaily).toBe(10000n); // exactly 10,000 cents ($100.00)
  });

  it('amortizes across February 28 and 29 days', () => {
    const bill = Money.fromDecimal('280.00', Currencies.EGP!);
    const feb28 = amortizeMonthlyExpense(bill, 28);
    expect(feb28).toHaveLength(28);
    expect(feb28.reduce((acc, curr) => acc + curr.amount, 0n)).toBe(28000n);

    const feb29 = amortizeMonthlyExpense(bill, 29);
    expect(feb29).toHaveLength(29);
    expect(feb29.reduce((acc, curr) => acc + curr.amount, 0n)).toBe(28000n);
  });
});

describe('Money.divideBy exactness & deterministic discount tie-breaking', () => {
  it('handles odd divisors and divisor=1n accurately without integer-half truncation bug', () => {
    const m = (n: bigint) => Money.fromMinor(n, Currencies.EGP!);

    expect(m(5n).divideBy(1n, 'HALF_EVEN').amount).toBe(5n);
    expect(m(5n).divideBy(1n, 'HALF_UP').amount).toBe(5n);
    expect(m(-5n).divideBy(1n, 'HALF_EVEN').amount).toBe(-5n);

    expect(m(4n).divideBy(3n).amount).toBe(1n); // 1.33 -> 1
    expect(m(5n).divideBy(3n).amount).toBe(2n); // 1.66 -> 2
    expect(m(7n).divideBy(5n).amount).toBe(1n); // 1.4 -> 1
    expect(m(10n).divideBy(3n).amount).toBe(3n); // 3.33 -> 3
    expect(m(-4n).divideBy(3n).amount).toBe(-1n);
    expect(m(-5n).divideBy(3n).amount).toBe(-2n);

    // True ties (.5) under HALF_EVEN and HALF_UP
    expect(m(5n).divideBy(2n, 'HALF_EVEN').amount).toBe(2n);
    expect(m(7n).divideBy(2n, 'HALF_EVEN').amount).toBe(4n);
    expect(m(5n).divideBy(2n, 'HALF_UP').amount).toBe(3n);
    expect(m(7n).divideBy(2n, 'HALF_UP').amount).toBe(4n);
    expect(m(-5n).divideBy(2n, 'HALF_EVEN').amount).toBe(-2n);
    expect(m(-7n).divideBy(2n, 'HALF_EVEN').amount).toBe(-4n);

    // Exhaustive cross-check across odd and even divisors vs exact doubled-remainder half-even
    for (let num = -40n; num <= 40n; num += 1n) {
      for (let div = 1n; div <= 19n; div += 1n) {
        const absN = num < 0n ? -num : num;
        const q = absN / div;
        const r = absN % div;
        const roundUp = 2n * r > div || (2n * r === div && q % 2n !== 0n);
        const expected = (num < 0n ? -1n : 1n) * (q + (roundUp ? 1n : 0n));
        expect(m(num).divideBy(div, 'HALF_EVEN').amount).toBe(expected);
      }
    }
  });

  it('supports exact decimal and rational string factors in Money.multiply', () => {
    const base = Money.fromDecimal('30.00', Currencies.EGP!);
    expect(base.multiply('1/3').amount).toBe(1000n);
    expect(Money.fromMinor(1000n, Currencies.EGP!).multiply('0.125').amount).toBe(125n);
    expect(Money.fromMinor(1000n, Currencies.EGP!).multiply('0.0000005').amount).toBe(0n);
  });

  it('breaks equal remainders deterministically by original item index in distributeDiscount', () => {
    const discount = Money.fromMinor(2n, Currencies.EGP!);
    const items = [
      Money.fromMinor(1000n, Currencies.EGP!),
      Money.fromMinor(1000n, Currencies.EGP!),
      Money.fromMinor(1000n, Currencies.EGP!),
    ];
    const shares = distributeDiscount(discount, items);
    expect(shares.map((s) => s.amount)).toEqual([1n, 1n, 0n]);
  });
});
