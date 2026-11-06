export abstract class DomainError extends Error {
  public abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class InvalidMoneyError extends DomainError {
  public readonly code = 'INVALID_MONEY';
}

export class CurrencyMismatchError extends DomainError {
  public readonly code = 'CURRENCY_MISMATCH';
  constructor(sourceCurrency: string, targetCurrency: string) {
    super(`Cannot operate on amounts with different currencies: ${sourceCurrency} vs ${targetCurrency}`);
  }
}

export class InsufficientStockError extends DomainError {
  public readonly code = 'INSUFFICIENT_STOCK';
  constructor(variantId: string, requested: string, available: string) {
    super(`Insufficient stock for variant ${variantId}. Requested: ${requested}, Available: ${available}`);
  }
}

export class InvalidCatalogError extends DomainError {
  public readonly code = 'INVALID_CATALOG';
}

export class InvalidStockOperationError extends DomainError {
  public readonly code = 'INVALID_STOCK_OPERATION';
}

export class InvalidCartError extends DomainError {
  public readonly code = 'INVALID_CART';
}

export class InvalidPaymentError extends DomainError {
  public readonly code = 'INVALID_PAYMENT';
}

export class InvalidSaleError extends DomainError {
  public readonly code = 'INVALID_SALE';
}

export class PeriodClosedError extends DomainError {
  public readonly code = 'PERIOD_CLOSED';
  constructor(periodName: string) {
    super(`Accounting period '${periodName}' is closed and cannot be modified.`);
  }
}

export class UnbalancedJournalEntryError extends DomainError {
  public readonly code = 'UNBALANCED_JOURNAL_ENTRY';
  constructor(debits: bigint, credits: bigint) {
    super(`Journal entry is unbalanced: Total Debits (${debits}) != Total Credits (${credits})`);
  }
}
