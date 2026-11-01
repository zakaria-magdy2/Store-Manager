export interface MoneyDTO {
  amount: string; // BigInt string
  currency: string; // ISO 4217
  decimals: number;
  formatted: string; // e.g. "102.60"
}
