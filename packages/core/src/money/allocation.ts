import { Money } from './money.js';
import { CurrencyMismatchError, InvalidMoneyError } from '../common/errors.js';

export function distributeDiscount(totalDiscount: Money, itemAmounts: Money[]): Money[] {
  if (itemAmounts.length === 0) {
    return [];
  }

  const currency = totalDiscount.currency;
  for (const item of itemAmounts) {
    if (item.currency.code !== currency.code) {
      throw new CurrencyMismatchError(currency.code, item.currency.code);
    }
  }

  const totalSum = itemAmounts.reduce((acc, curr) => acc + curr.amount, 0n);
  if (totalSum <= 0n) {
    // If cart total is 0, split evenly across items
    return amortizeEvenly(totalDiscount, itemAmounts.length);
  }

  // Hamilton-Hare (Largest Remainder Method)
  const discountTotal = totalDiscount.amount;
  const entries = itemAmounts.map((item, index) => {
    const rawScaled = (item.amount * discountTotal * 1_000_000n) / totalSum;
    const baseShare = rawScaled / 1_000_000n;
    const remainder = rawScaled % 1_000_000n;
    return { index, baseShare, remainder };
  });

  const allocatedSum = entries.reduce((acc, curr) => acc + curr.baseShare, 0n);
  let leftover = discountTotal - allocatedSum;

  // Sort by largest remainder descending
  const sorted = [...entries].sort((a, b) => (b.remainder > a.remainder ? 1 : -1));

  let i = 0;
  while (leftover > 0n && i < sorted.length) {
    const target = sorted[i];
    if (target) {
      target.baseShare += 1n;
      leftover -= 1n;
    }
    i++;
  }

  // Restore original ordering
  entries.sort((a, b) => a.index - b.index);
  return entries.map((e) => Money.fromMinor(e.baseShare, currency));
}

export function amortizeMonthlyExpense(monthlyAmount: Money, daysInMonth: number): Money[] {
  if (daysInMonth < 28 || daysInMonth > 31) {
    throw new InvalidMoneyError(`Invalid days in month: ${daysInMonth}. Must be between 28 and 31.`);
  }

  const daysBig = BigInt(daysInMonth);
  const baseQuota = monthlyAmount.amount / daysBig;
  const remainder = monthlyAmount.amount % daysBig;

  const result: Money[] = [];
  for (let d = 0; d < daysInMonth; d++) {
    // Distribute 1 extra minor unit to the first remainder days
    const extra = BigInt(d) < remainder ? 1n : 0n;
    result.push(Money.fromMinor(baseQuota + extra, monthlyAmount.currency));
  }

  return result;
}

function amortizeEvenly(total: Money, partsCount: number): Money[] {
  const partsBig = BigInt(partsCount);
  const baseQuota = total.amount / partsBig;
  const remainder = total.amount % partsBig;

  const result: Money[] = [];
  for (let i = 0; i < partsCount; i++) {
    const extra = BigInt(i) < remainder ? 1n : 0n;
    result.push(Money.fromMinor(baseQuota + extra, total.currency));
  }
  return result;
}
