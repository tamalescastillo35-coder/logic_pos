// Builds raw ESC/POS byte tickets for 58/80mm thermal printers (e.g. MERION PT-B1) that talk
// over Bluetooth SPP instead of Android's Print Framework — see BluetoothPrinterPlugin.java.

const ESC = 0x1b;
const GS = 0x1d;

interface EscPosSaleItem {
  quantity: number;
  name: string;
  salePrice: number;
}

export interface EscPosReceiptParams {
  businessName: string;
  tagline?: string;
  saleId: string;
  timestamp: string;
  payLabel: string;
  customerName?: string;
  employeeName?: string;
  items: EscPosSaleItem[];
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  showTaxLine: boolean;
  footerText: string;
  columns: number; // 32 chars for 58mm, 48 for 80mm (Font A)
  formatMXN: (n: number) => string;
}

class EscPosBuilder {
  private bytes: number[] = [];

  private raw(...b: number[]) {
    this.bytes.push(...b);
    return this;
  }

  // Chars beyond Latin-1 fall back to '?': printers are set to codepage 16 (WPC1252) below,
  // whose accented-letter byte values match the char codes directly for 0x00-0xFF.
  private text(str: string) {
    for (let i = 0; i < str.length; i++) {
      const code = str.charCodeAt(i);
      this.bytes.push(code <= 0xff ? code : 0x3f);
    }
    return this;
  }

  line(str = '') {
    return this.text(str).raw(0x0a);
  }

  init() {
    return this.raw(ESC, 0x40, ESC, 0x74, 0x10);
  }

  align(a: 'left' | 'center' | 'right') {
    const n = a === 'center' ? 1 : a === 'right' ? 2 : 0;
    return this.raw(ESC, 0x61, n);
  }

  bold(on: boolean) {
    return this.raw(ESC, 0x45, on ? 1 : 0);
  }

  doubleSize(on: boolean) {
    return this.raw(GS, 0x21, on ? 0x11 : 0x00);
  }

  feed(lines = 1) {
    for (let i = 0; i < lines; i++) this.raw(0x0a);
    return this;
  }

  cut() {
    return this.raw(GS, 0x56, 0x01);
  }

  toUint8Array() {
    return new Uint8Array(this.bytes);
  }
}

function row(left: string, right: string, width: number): string {
  let l = left;
  if (l.length + right.length + 1 > width) {
    l = l.slice(0, Math.max(0, width - right.length - 1));
  }
  const gap = Math.max(1, width - l.length - right.length);
  return l + ' '.repeat(gap) + right;
}

const sep = (width: number) => '-'.repeat(width);
const underscoreLine = (width: number) => '_'.repeat(Math.max(0, width));

export function buildReceiptEscPos(p: EscPosReceiptParams): Uint8Array {
  const w = p.columns;
  const b = new EscPosBuilder();

  b.init();
  b.align('center');
  b.bold(true).doubleSize(true);
  b.line(p.businessName.toUpperCase());
  b.doubleSize(false).bold(false);
  if (p.tagline) b.line(p.tagline);
  b.line(`Transaccion: ${p.saleId}`);

  b.align('left');
  b.line(sep(w));
  b.line(`Fecha: ${p.timestamp}`);
  b.line(`Metodo de pago: ${p.payLabel}`);
  if (p.customerName) b.line(`Cliente: ${p.customerName}`);
  if (p.employeeName) b.line(`Atendido por: ${p.employeeName}`);
  b.line(sep(w));

  b.bold(true).line('ARTICULOS:').bold(false);
  for (const it of p.items) {
    b.line(row(`${it.quantity}x ${it.name}`, p.formatMXN(it.salePrice * it.quantity), w));
  }
  b.line(sep(w));

  b.line(row('Subtotal:', p.formatMXN(p.subtotal), w));
  if (p.discount > 0) b.line(row('Descuento:', `-${p.formatMXN(p.discount)}`, w));
  if (p.showTaxLine) b.line(row('Impuestos:', p.formatMXN(p.tax), w));
  b.bold(true);
  b.line(row('TOTAL:', p.formatMXN(p.total), w));
  b.bold(false);

  b.feed(1);
  b.align('center');
  b.bold(true).line(p.footerText).bold(false);
  b.line('Comprobante simplificado sin validez fiscal');
  b.feed(3);
  b.cut();

  return b.toUint8Array();
}

export interface EscPosTransferItem {
  productName: string;
  quantity: number;
  unitPrice: number;
}

export interface EscPosTransferParams {
  businessName: string;
  tagline?: string;
  transferId: string;
  timestamp: string;
  sourceBranchName: string;
  sourceBranchAddress?: string;
  targetBranchName: string;
  targetBranchAddress?: string;
  initiatedByName?: string;
  items: EscPosTransferItem[];
  columns: number;
  formatMXN: (n: number) => string;
}

// A physical delivery note for inter-branch stock transfers — mostly about what moved and 3
// blank spaces for pen signatures collected as the merchandise physically changes hands
// (carrier pickup, destination staff, destination manager), but also shows each product's
// sale price and the accumulated total value of the shipment (same layout as the sale receipt).
export function buildTransferEscPos(p: EscPosTransferParams): Uint8Array {
  const w = p.columns;
  const b = new EscPosBuilder();

  b.init();
  b.align('center');
  b.bold(true).doubleSize(true);
  b.line(p.businessName.toUpperCase());
  b.doubleSize(false).bold(false);
  if (p.tagline) b.line(p.tagline);
  b.bold(true).line('TRASPASO ENTRE SUCURSALES').bold(false);
  b.line(`Folio: ${p.transferId}`);

  b.align('left');
  b.line(sep(w));
  b.line(`Fecha: ${p.timestamp}`);
  b.line(`Origen: ${p.sourceBranchName}`);
  if (p.sourceBranchAddress) b.line(`  ${p.sourceBranchAddress}`);
  b.line(`Destino: ${p.targetBranchName}`);
  if (p.targetBranchAddress) b.line(`  ${p.targetBranchAddress}`);
  if (p.initiatedByName) b.line(`Iniciado por: ${p.initiatedByName}`);
  b.line(sep(w));

  b.bold(true).line('PRODUCTOS:').bold(false);
  let total = 0;
  for (const it of p.items) {
    total += it.unitPrice * it.quantity;
    b.line(row(`${it.quantity}x ${it.productName}`, p.formatMXN(it.unitPrice * it.quantity), w));
  }
  b.line(sep(w));
  b.bold(true);
  b.line(row('TOTAL:', p.formatMXN(total), w));
  b.bold(false);
  b.line(sep(w));

  const signatureBlock = (n: number, title: string, subtitle: string) => {
    b.align('center');
    b.bold(true).line(`${n}) ${title}`).bold(false);
    b.line(subtitle);
    b.align('left');
    b.feed(3);
    b.line(underscoreLine(w));
    b.line(`Nombre: ${underscoreLine(Math.max(0, w - 8))}`);
    b.feed(2);
    if (n < 3) b.line(sep(w));
  };

  signatureBlock(1, 'FIRMA DE RECOLECCION', '(Repartidor)');
  signatureBlock(2, 'FIRMA DE RECEPCION', '(Personal sucursal destino)');
  signatureBlock(3, 'FIRMA DE VALIDACION', '(Encargado sucursal destino)');

  b.feed(3);
  b.cut();

  return b.toUint8Array();
}

export function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export function columnsForPaperWidth(paperWidth: '58mm' | '80mm' | 'A4'): number {
  return paperWidth === '80mm' ? 48 : 32;
}

export function buildTestPrint(columns: number): Uint8Array {
  const b = new EscPosBuilder();
  b.init();
  b.align('center');
  b.bold(true).doubleSize(true);
  b.line('LOGIC POS');
  b.doubleSize(false).bold(false);
  b.line('Impresora conectada');
  b.align('left');
  b.line(sep(columns));
  b.line(`Ancho: ${columns} columnas`);
  b.line(new Date().toLocaleString('es-MX'));
  b.feed(3);
  b.cut();
  return b.toUint8Array();
}
