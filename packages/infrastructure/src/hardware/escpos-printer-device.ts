import type { Sale } from '@retailos/core';
import type { CashDrawerPort } from '@retailos/application';
import type { ExecutionContext } from '@retailos/application';
import type { EscPosReceiptPrinter } from './escpos-receipt-printer.js';

export interface EscPosByteTransport {
  write(bytes: Uint8Array): Promise<void>;
}

/** Binds the ESC/POS formatter to a host-provided USB, serial, or network writer. */
export class EscPosPrinterDevice {
  constructor(
    private readonly printer: EscPosReceiptPrinter,
    private readonly transport: EscPosByteTransport,
  ) {}

  public async print(sale: Sale): Promise<void> {
    await this.transport.write(this.printer.format(sale));
  }

  public async openCashDrawer(): Promise<void> {
    await this.transport.write(this.printer.cashDrawerPulse());
  }
}

/** Resolves the configured printer/DK port for the requested store. */
export class EscPosCashDrawerDriver implements CashDrawerPort {
  constructor(
    private readonly deviceForStore: (storeId: string) => Promise<EscPosPrinterDevice>,
  ) {}

  public async openDrawer(_ctx: ExecutionContext, storeId: string): Promise<void> {
    const device = await this.deviceForStore(storeId);
    await device.openCashDrawer();
  }
}
