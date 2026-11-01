export interface CurrencyConfig {
  readonly code: string;
  readonly symbol: string;
  readonly decimalPlaces: number;
  readonly scaleFactor: bigint;
}

export const Currencies: Record<string, CurrencyConfig> = {
  USD: { code: 'USD', symbol: '$', decimalPlaces: 2, scaleFactor: 100n },
  EUR: { code: 'EUR', symbol: '€', decimalPlaces: 2, scaleFactor: 100n },
  EGP: { code: 'EGP', symbol: 'E£', decimalPlaces: 2, scaleFactor: 100n },
  SAR: { code: 'SAR', symbol: '﷼', decimalPlaces: 2, scaleFactor: 100n },
  AED: { code: 'AED', symbol: 'د.إ', decimalPlaces: 2, scaleFactor: 100n },
  KWD: { code: 'KWD', symbol: 'KD', decimalPlaces: 3, scaleFactor: 1000n },
  BHD: { code: 'BHD', symbol: 'BD', decimalPlaces: 3, scaleFactor: 1000n },
  JOD: { code: 'JOD', symbol: 'JD', decimalPlaces: 3, scaleFactor: 1000n },
  OMR: { code: 'OMR', symbol: 'RO', decimalPlaces: 3, scaleFactor: 1000n },
  JPY: { code: 'JPY', symbol: '¥', decimalPlaces: 0, scaleFactor: 1n },
} as const;

export function getCurrency(code: string): CurrencyConfig {
  const upper = code.toUpperCase();
  const found = Currencies[upper];
  if (!found) {
    // Default to 2 decimal places if custom/unknown ISO code
    return {
      code: upper,
      symbol: upper,
      decimalPlaces: 2,
      scaleFactor: 100n,
    };
  }
  return found;
}
