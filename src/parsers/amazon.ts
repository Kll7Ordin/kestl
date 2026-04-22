
/* ── Shared helpers ─────────────────────────────────────────────── */

const NOISE = [
  /^delivered/i, /^return or replace/i, /^buy again/i,
  /^track package/i, /^get product support/i, /^write a product review/i,
  /^leave .* feedback/i, /^view order detail/i, /^archive order/i,
  /^not yet shipped/i, /^arriving/i, /^package was/i,
  /^view return/i, /^when will i get/i, /^your return is/i,
  /^your order was/i, /^you have not been/i, /^ship to$/i,
  /^view your item/i, /^share gift receipt/i, /^ask a product/i,
  /^return items/i, /^return window/i, /^invoice$/i,
  /^refund$/i, /^eligible through/i, /^see all reviews/i,
  /^gift receipt/i, /^subscription charged/i,
];

const MONTH_MAP: Record<string, string> = {
  january: '01', february: '02', march: '03', april: '04',
  may: '05', june: '06', july: '07', august: '08',
  september: '09', october: '10', november: '11', december: '12',
};

function parseAmazonDate(raw: string): string | null {
  const m = raw.match(/(\w+)\s+(\d{1,2}),?\s*(\d{4})/);
  if (!m) return null;
  const month = MONTH_MAP[m[1].toLowerCase()];
  if (!month) return null;
  return `${m[3]}-${month}-${m[2].padStart(2, '0')}`;
}

function parseOrderAmount(raw: string): number | null {
  const cleaned = raw.replace(/[^0-9.−-]/g, '').replace(/−/g, '-');
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}

function isNoiseLine(line: string): boolean {
  return NOISE.some((re) => re.test(line));
}

function isMetadataLine(line: string): boolean {
  if (parseAmazonDate(line) !== null) return true;
  if (/^(total\s*)?(CDN\s*)?[$€]/i.test(line)) return true;
  if (/^(CDN\s*)?\$[\d,.]+/i.test(line)) return true;
  if (/^ship\s+to/i.test(line)) return true;
  if (/^order\s*#/i.test(line)) return true;
  if (/^total$/i.test(line)) return true;
  return false;
}

function isItemCandidate(line: string): boolean {
  return !isNoiseLine(line) && !isMetadataLine(line) && line.length > 20;
}

/* ── Amazon Order parsing (product reference data) ──────────────── */

export type AmazonOrderStatus = 'delivered' | 'returned' | 'cancelled';

export interface AmazonParsedOrder {
  orderNum: string;
  itemName: string;
  orderDate: string;
  amount: number;
  status: AmazonOrderStatus;
}

function detectStatus(lines: string[], orderPlacedIndex: number): AmazonOrderStatus {
  for (let j = orderPlacedIndex - 1; j >= Math.max(0, orderPlacedIndex - 40); j--) {
    if (/^return complete/i.test(lines[j])) return 'returned';
    if (/^cancelled/i.test(lines[j])) return 'cancelled';
    if (/^order\s+placed$/i.test(lines[j])) break;
  }
  return 'delivered';
}

export function parseAmazonOrders(text: string): AmazonParsedOrder[] {
  const allLines = text.split(/\r?\n/).map((l) => l.trim());
  const nonEmpty = allLines.filter(Boolean);
  const results: AmazonParsedOrder[] = [];

  let i = 0;
  while (i < nonEmpty.length) {
    if (!/^order\s+placed$/i.test(nonEmpty[i])) {
      i++;
      continue;
    }

    const orderPlacedIdx = i;
    const status = detectStatus(nonEmpty, orderPlacedIdx);
    i++;

    let txnDate: string | null = null;
    let amount: number | null = null;
    let orderNum = '';
    const backwardItems: string[] = [];
    const forwardItems: string[] = [];

    while (i < nonEmpty.length && !/^order\s+placed$/i.test(nonEmpty[i])) {
      const line = nonEmpty[i];

      if (/^(delivered|return complete|cancelled)\b/i.test(line)) break;

      if (!txnDate) {
        const d = parseAmazonDate(line);
        if (d) { txnDate = d; i++; continue; }
      }

      if (amount === null && /^(total\s*)?(CDN\s*)?[$€]/i.test(line)) {
        const a = parseOrderAmount(line.replace(/^total\s*/i, ''));
        if (a !== null) { amount = a; i++; continue; }
      }
      if (amount === null && /^total$/i.test(line)) {
        i++;
        if (i < nonEmpty.length) {
          const a = parseOrderAmount(nonEmpty[i]);
          if (a !== null) { amount = a; i++; continue; }
        }
        continue;
      }

      const orderMatch = line.match(/order\s*#\s*([\w-]+)/i);
      if (orderMatch) { orderNum = orderMatch[1]; i++; continue; }

      if (isItemCandidate(line) && !forwardItems.includes(line)) {
        forwardItems.push(line);
      }

      i++;
    }

    // Backward scan: items appear BEFORE "Order placed" in Amazon's layout (between
    // the previous order's status line and this "Order placed"). Stop at any order
    // boundary: another "Order placed", any status line, or any noise-category line.
    for (let j = orderPlacedIdx - 1; j >= Math.max(0, orderPlacedIdx - 20); j--) {
      const bl = nonEmpty[j];
      if (/^order\s+placed$/i.test(bl)) break;
      if (/^(delivered|return complete|cancelled|arriving|not yet shipped|order\s*#)/i.test(bl)) break;
      if (isNoiseLine(bl)) break; // any noise line = we've crossed into the previous order's action buttons
      if (isItemCandidate(bl) && !backwardItems.includes(bl)) {
        backwardItems.push(bl);
      }
    }

    if (!txnDate || !orderNum) continue;

    // Prefer forward items (after "Order placed") when they are strong candidates;
    // fall back to backward items only when no forward items found.
    const strongForward = forwardItems.filter((s) => s.length > 25);
    const candidates = strongForward.length > 0 ? strongForward
      : forwardItems.length > 0 ? forwardItems
      : backwardItems;
    const bestItem = [...candidates].sort((a, b) => b.length - a.length)[0] ?? '';

    results.push({
      orderNum,
      itemName: bestItem,
      orderDate: txnDate,
      amount: amount ?? 0,
      status,
    });
  }

  return results;
}

/* ── Amazon Payment parsing (creates actual transactions) ───────── */

const USD_TO_CAD = 1.38;

export interface AmazonPaymentEntry {
  date: string;
  paymentMethod: string;
  amount: number;
  orderNum: string;
  isRefund: boolean;
  isUSD: boolean;
  merchant: string;
}

function isPaymentMethodLine(line: string): boolean {
  return /^(Mastercard|Visa)\s+\*{3,4}\d{4}$/i.test(line)
    || /^Amazon gift card used$/i.test(line);
}

function parsePaymentAmount(line: string): { amount: number; isUSD: boolean } | null {
  const m = line.match(/^([+-])\s*(?:(US)\s*)?\$([\d,]+\.?\d*)/i);
  if (!m) return null;
  const sign = m[1] === '+' ? 1 : -1;
  const val = parseFloat(m[3].replace(/,/g, ''));
  if (isNaN(val)) return null;
  return { amount: sign * val, isUSD: !!m[2] };
}

export function parseAmazonPayments(text: string): AmazonPaymentEntry[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const results: AmazonPaymentEntry[] = [];

  let currentDate: string | null = null;
  let i = 0;

  while (i < lines.length) {
    const dateVal = parseAmazonDate(lines[i]);
    if (dateVal) {
      currentDate = dateVal;
      i++;
      continue;
    }

    if (!isPaymentMethodLine(lines[i]) || !currentDate) {
      i++;
      continue;
    }

    const paymentMethod = lines[i];
    i++;

    if (i >= lines.length) break;
    const amtResult = parsePaymentAmount(lines[i]);
    if (!amtResult) continue;
    i++;

    if (i >= lines.length) break;
    const orderLine = lines[i];
    const isRefund = /^Refund:/i.test(orderLine);
    const orderMatch = orderLine.match(/#([\w-]+)/);
    if (!orderMatch) continue;
    const orderNum = orderMatch[1];
    i++;

    let merchant = '';
    if (i < lines.length) {
      const next = lines[i];
      if (!parseAmazonDate(next) && !isPaymentMethodLine(next) && !parsePaymentAmount(next)) {
        merchant = next;
        i++;
      }
    }

    results.push({
      date: currentDate,
      paymentMethod,
      amount: amtResult.amount,
      orderNum,
      isRefund,
      isUSD: amtResult.isUSD,
      merchant,
    });
  }

  return results;
}

export { USD_TO_CAD };
