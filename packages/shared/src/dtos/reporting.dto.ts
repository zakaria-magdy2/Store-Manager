import type { MoneyDTO } from './money.dto.js';

export interface DailyPerformanceReportDTO {
  date: string; // ISO date 'YYYY-MM-DD'
  storeId?: string;
  currency: string;

  // 8-Tier Accrual Progression
  grossSales: MoneyDTO;
  discountsAndReturns: MoneyDTO;
  netSales: MoneyDTO;
  cogs: MoneyDTO;
  grossProfit: MoneyDTO;
  directDailyExpenses: MoneyDTO;
  dailyAmortizedMonthlyExpenses: MoneyDTO;
  operatingProfit: MoneyDTO;

  // Decoupled Cash Liquidity Panel
  cashFlow: {
    cashFromSales: MoneyDTO;
    electronicSales: MoneyDTO;
    directExpensesPaid: MoneyDTO;
    monthlyObligationsSettled: MoneyDTO;
    netCashMovement: MoneyDTO;
    pendingDueObligations: MoneyDTO;
  };

  // Warnings / Notices
  unenteredRecurringExpensesCount: number;
  warnings: string[];
}
