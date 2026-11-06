import type { Sale } from '@retailos/core';

export type ReceiptWidth = '58mm' | '80mm';

export interface ReceiptPrinterOptions {
  width: ReceiptWidth;
  storeName: string;
  /** Printer-specific byte encoder. Provide this for Arabic or other non-Latin text. */
  encodeText?: (text: string) => Uint8Array;
  /** ESC/POS code page index supported by the target printer model. */
  codePage?: number;
}

/** Creates a raw ESC/POS receipt stream. Sending bytes to USB/network devices belongs to the host adapter. */
export class EscPosReceiptPrinter {
  private readonly columns: number;
  private readonly encodeText: (text: string) => Uint8Array;

  public constructor(private readonly options: ReceiptPrinterOptions) {
    if (options.codePage !== undefined && (!Number.isInteger(options.codePage) || options.codePage < 0 || options.codePage > 255)) {
      throw new RangeError('ESC/POS code page must be an integer from 0 to 255');
    }
    this.columns = options.width === '58mm' ? 32 : 48;
    this.encodeText = options.encodeText ?? latin1;
  }

  public format(sale: Sale): Uint8Array {
    const chunks: Uint8Array[] = [Uint8Array.from([0x1b, 0x40])];
    if (this.options.codePage !== undefined) {
      chunks.push(Uint8Array.from([0x1b, 0x74, this.options.codePage]));
    }
    chunks.push(Uint8Array.from([0x1b, 0x61, 1]));
    chunks.push(this.line(this.options.storeName.trim()));
    chunks.push(this.line(`Receipt ${sale.saleNumber}`));
    chunks.push(Uint8Array.from([0x1b, 0x61, 0]));
    chunks.push(this.line('-'.repeat(this.columns)));

    for (const item of sale.items) {
      chunks.push(this.line(item.productName));
      const qty = `${item.quantity} x ${item.unitPrice.toDecimalString()}`;
      chunks.push(this.line(`${qty}  ${item.netRevenue.toDecimalString()}`));
    }

    chunks.push(this.line('-'.repeat(this.columns)));
    chunks.push(this.line(`Total: ${sale.total.toDecimalString()} ${sale.currency}`));
    chunks.push(this.line(`Paid:  ${sale.paidTotal.toDecimalString()}`));
    if (!sale.changeGiven.isZero()) {
      chunks.push(this.line(`Change: ${sale.changeGiven.toDecimalString()}`));
    }
    for (const payment of sale.payments) {
      chunks.push(this.line(`${payment.method}: ${payment.amount.toDecimalString()}`));
    }

    // Feed and cut; cut is supported by most ESC/POS thermal printers.
    chunks.push(Uint8Array.from([0x1b, 0x64, 4, 0x1d, 0x56, 0x00]));
    return concat(chunks);
  }

  /** Standard ESC/POS cash-drawer kick pulse for the printer's DK port. */
  public cashDrawerPulse(): Uint8Array {
    return Uint8Array.from([0x1b, 0x70, 0x00, 0x19, 0xfa]);
  }

  private line(text: string): Uint8Array {
    const chars = Array.from(text);
    const chunks: Uint8Array[] = [];
    for (let offset = 0; offset < chars.length || offset === 0; offset += this.columns) {
      chunks.push(this.encodeText(chars.slice(offset, offset + this.columns).join('')));
      chunks.push(Uint8Array.from([0x0a]));
      if (chars.length === 0) break;
    }
    return concat(chunks);
  }
}

function latin1(text: string): Uint8Array {
  const chars = Array.from(text);
  const unsupported = chars.find((char) => (char.codePointAt(0) ?? 0) > 0xff);
  if (unsupported) {
    throw new Error(
      `Receipt contains '${unsupported}' which the default Latin-1 encoder cannot print; configure an encoder and printer code page`,
    );
  }
  return Uint8Array.from(chars.map((char) => {
    const code = char.codePointAt(0) ?? 0x3f;
    return code;
  }));
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
