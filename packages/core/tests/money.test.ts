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
