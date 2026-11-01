import { z } from 'zod';

export const CreateDirectExpenseSchema = z.object({
  tenantId: z.string().uuid(),
  storeId: z.string().uuid().optional(),
  categoryId: z.string().uuid(),
  expenseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD'),
  amount: z.string().regex(/^\d+$/, 'Amount must be a positive integer minor units string'),
  currency: z.string().length(3),
  paymentMethod: z.enum(['CASH_DRAWER', 'CASH_SAFE', 'BANK_TRANSFER']),
  notes: z.string().max(500).optional(),
  referenceNumber: z.string().max(64).optional(),
});

export const ConfirmMonthlyExpenseActualSchema = z.object({
  tenantId: z.string().uuid(),
  storeId: z.string().uuid().optional(),
  obligationId: z.string().uuid(),
  periodId: z.string().uuid(),
  year: z.number().int().min(2020).max(2100),
  month: z.number().int().min(1).max(12),
  amount: z.string().regex(/^\d+$/, 'Amount must be an integer minor units string'),
  currency: z.string().length(3),
});

export type CreateDirectExpenseInput = z.infer<typeof CreateDirectExpenseSchema>;
export type ConfirmMonthlyExpenseActualInput = z.infer<typeof ConfirmMonthlyExpenseActualSchema>;
