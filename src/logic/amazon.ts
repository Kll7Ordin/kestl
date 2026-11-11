import type { AmazonOrder, Transaction } from '../db';
import { isCredit } from './txnKind';

/** Dates (YYYY-MM-DD, inclusive) one Amazon paste covered. */
export interface DateRange { from: string; to: string }

/** Which dates each Amazon page has been pasted for, so a missing match is only flagged where it means something. */
export interface AmazonCoverage {
  orders?: DateRange[];
  payments?: DateRange[];
}

export interface AmazonFlag {
  /** Short chip text. */
  label: string;
  /** Hover text explaining the flag. */
  detail: string;
}

/** Amazon charges shipped separately by the same order can arrive this many days after it. */
const CHARGE_LAG_DAYS = 14;
/** Orders are charged within a few days of being placed. */
const ORDER_CHARGE_DAYS = 7;

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function rangeOf(dates: string[]): DateRange | null {
  if (dates.length === 0) return null;
  const sorted = [...dates].sort();
  return { from: sorted[0], to: sorted[sorted.length - 1] };
}

/** Add a range, merging any it overlaps or touches. */
export function mergeRange(ranges: DateRange[] | undefined, r: DateRange): DateRange[] {
  const all = [...(ranges ?? []), r].sort((a, b) => a.from.localeCompare(b.from));
  const out: DateRange[] = [];
  for (const x of all) {
    const last = out[out.length - 1];
    if (last && x.from <= addDays(last.to, 1)) {
      if (x.to > last.to) last.to = x.to;
    } else {
      out.push({ ...x });
    }
  }
  return out;
}

/** True when `date` sits inside a pasted range, `startPad` days past its start and `endPad` days before its end. */
export function isCovered(ranges: DateRange[] | undefined, date: string, startPad = 0, endPad = 0): boolean {
  return (ranges ?? []).some((r) => date >= addDays(r.from, startPad) && date <= addDays(r.to, -endPad));
}

/** Kindle, Audible and other digital orders: on the transactions page but never on the orders page. */
export const isDigitalOrder = (orderNum: string): boolean => /^D\d{2}-/i.test(orderNum);

export function amazonDescriptor(orderNum: string, itemName: string | undefined): string {
  if (itemName) return `Amazon | ${itemName} | #${orderNum}`;
  if (isDigitalOrder(orderNum)) return `Amazon | Digital order | #${orderNum}`;
  return `Amazon | #${orderNum}`;
}

/** Key for one charge or refund line, used to skip lines already imported. */
export function amazonPaymentKey(t: Pick<Transaction, 'sourceRef' | 'txnDate' | 'originalTxnDate' | 'amount' | 'ignoreInBudget'>): string {
  return `${t.sourceRef}|${t.originalTxnDate ?? t.txnDate}|${t.amount.toFixed(2)}|${isCredit(t) ? 'refund' : 'charge'}`;
}

/** Comment on a charge line paid from an Amazon gift card balance. */
export const GIFT_CARD_NOTE = 'Paid by Amazon gift card';
const isGiftCardCharge = (t: Transaction) => (t.comment ?? '').startsWith(GIFT_CARD_NOTE);

const money = (n: number) => `$${n.toFixed(2)}`;
const cents = (n: number) => Math.round(n * 100) / 100;

/**
 * Amazon transactions that are missing their other half or don't add up. Computed fresh each
 * time, so a flag clears once the missing page is pasted.
 */
export function computeAmazonFlags(
  transactions: Transaction[],
  orders: AmazonOrder[] | undefined,
  coverage: AmazonCoverage | undefined,
): Map<number, AmazonFlag> {
  const flags = new Map<number, AmazonFlag>();
  const orderMap = new Map((orders ?? []).map((o) => [o.orderNum, o]));

  const charges = new Map<string, Transaction[]>();
  const refunds = new Map<string, Transaction[]>();
  const orderTxns = new Set<string>();
  for (const t of transactions) {
    if (!t.sourceRef) continue;
    if (t.source === 'amazon_order') orderTxns.add(t.sourceRef);
    if (t.source !== 'amazon_payment' || t.amount === 0) continue;
    const m = isCredit(t) ? refunds : charges;
    const list = m.get(t.sourceRef) ?? [];
    list.push(t);
    m.set(t.sourceRef, list);
  }

  for (const t of transactions) {
    if (!t.sourceRef) continue;

    if (t.source === 'amazon_order') {
      const o = orderMap.get(t.sourceRef);
      if (!o || o.status !== 'delivered' || charges.has(t.sourceRef)) continue;
      if (isCovered(coverage?.payments, o.orderDate, 0, ORDER_CHARGE_DAYS)) {
        flags.set(t.id, {
          label: 'No charge found',
          detail: 'The transactions page you pasted covers this order date but shows no card charge for it. '
            + 'It may have been paid by gift card or points, or not charged yet. The amount shown is the order total.',
        });
      }
      continue;
    }

    if (t.source !== 'amazon_payment' || t.amount === 0) continue;
    const o = orderMap.get(t.sourceRef);
    const orderRefunds = refunds.get(t.sourceRef) ?? [];

    if (isCredit(t)) {
      if (!charges.has(t.sourceRef) && !orderTxns.has(t.sourceRef)) {
        flags.set(t.id, {
          label: 'Refund, no charge',
          detail: 'No charge for this order has been imported. It may be older than the pastes so far, '
            + 'or a replacement under a different order number.',
        });
      }
      continue;
    }

    if (!o) {
      if (!isDigitalOrder(t.sourceRef) && isCovered(coverage?.orders, t.txnDate, CHARGE_LAG_DAYS, 0)) {
        flags.set(t.id, {
          label: 'No order details',
          detail: 'The orders page you pasted covers this date but doesn\'t list this order, so there is no item name.',
        });
      }
      continue;
    }

    const refunded = orderRefunds.reduce((s, r) => s + r.amount, 0);
    if ((o.status === 'returned' || o.status === 'cancelled') && refunded === 0) {
      flags.set(t.id, {
        label: o.status === 'cancelled' ? 'Cancelled, no refund' : 'Returned, no refund',
        detail: `The orders page says this order was ${o.status}, but no refund has been imported. `
          + 'Paste the transactions page again once the refund shows there.',
      });
      continue;
    }
    if (o.returnedItems?.length && refunded === 0) {
      flags.set(t.id, {
        label: 'Partial return, no refund',
        detail: `Returned: ${o.returnedItems.join(', ')}. No refund has been imported yet. `
          + 'Paste the transactions page again once it shows there.',
      });
      continue;
    }

    // The orders page total leaves out whatever a gift card paid, so either sum can match it.
    const orderCharges = charges.get(t.sourceRef) ?? [];
    const charged = cents(orderCharges.reduce((s, c) => s + c.amount, 0));
    const chargedToCard = cents(orderCharges.filter((c) => !isGiftCardCharge(c)).reduce((s, c) => s + c.amount, 0));
    const matches = Math.abs(charged - o.amount) <= 0.01 || Math.abs(chargedToCard - o.amount) <= 0.01;
    if (o.amount > 0 && !matches && isCovered(coverage?.payments, o.orderDate, 0, CHARGE_LAG_DAYS)) {
      flags.set(t.id, {
        label: `Orders page says ${money(o.amount)}, charged ${money(charged)}`,
        detail: `The orders page says this order cost ${money(o.amount)}, but its charges on the transactions page add up to ${money(charged)}. `
          + (charged < o.amount
            ? 'Points may have covered the rest, or a charge falls outside the pasted dates.'
            : 'An extra charge may belong to another order, or the order total changed after it was placed.'),
      });
    }
  }
  return flags;
}
