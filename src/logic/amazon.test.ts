import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(1) }));

import { __setDataForTests, getData, addAmazonPayments, addAmazonOrders, type Transaction, type AmazonOrder } from '../db';
import { richFixture } from '../test/fixtures';
import { splitAmazonPaste, parseAmazonOrders } from '../parsers/amazon';
import { computeAmazonFlags, mergeRange, amazonDescriptor } from './amazon';

const ORDERS_PAGE = `
    Order placed
    November 3, 2026
    Total
    $41.76
    Ship to
    Jane Doe
    Order # 701-2501064-2913815
    View order details Invoice

Delivered 5 November
Package was left near the front door or porch

    adidas Men's Athletic Cushioned 6-Pack Quarter Socks, White/Black, Medium
    adidas Men's Athletic Cushioned 6-Pack Quarter Socks, White/Black, Medium
    Return or replace items: Eligible through January 31, 2027
    Buy it again

    Get product support
    Track package
    Return or replace items

More options
Delivered 6 November
Package was left near the front door or porch

    FITRELL 6 Pack Men's Athletic Ankle Socks Cushioned Sports Running Socks, Shoe Size 9-12, Blue Mixed
    FITRELL 6 Pack Men's Athletic Ankle Socks Cushioned Sports Running Socks, Shoe Size 9-12, Blue Mixed
    Return items: Eligible through January 31, 2027
    Buy it again

    Track package
    Return items
    Share gift receipt

More options

    Order placed
    November 3, 2026
    Total
    $21.75
    Ship to
    Jane Doe
    Order # 701-5454626-4552215
    View order details Invoice

Delivered 5 November
Package was left near the front door or porch

    NIVEA MEN Sensitive After Shave Balm, No Alcohol, Sensitive Skin, 2x100mL
    NIVEA MEN Sensitive After Shave Balm, No Alcohol, Sensitive Skin, 2x100mL
    Return or replace items: Eligible through January 31, 2027
    Buy it again

    Track package
    Return or replace items
    Share gift receipt
    Write a product review

    Order placed
    October 31, 2026
    Total
    $85.16
    Ship to
    Jane Doe
    Order # 701-1073588-0353837
    View order details Invoice

Delivered 1 November
Package was left near the front door or porch

    SANDISK 128GB Extreme PRO SD Memory Card, Up to 250MB/s Read Speeds, UHS-I | V30, U3, C10, 4K UHD
    Return or replace items: Eligible through December 1, 2026
    Buy it again
`;

const TRANSACTIONS_PAGE = `
Completed
November 5, 2026
Visa ****5010
-US$16.74
Order #D01-2613531-5488255
D01-2613531-5488255
November 4, 2026
Mastercard ****8776
-$19.37
Order #701-2501064-2913815
AMZN Mktp CA
Mastercard ****8776
-$21.75
Order #701-5454626-4552215
Amazon.ca
Mastercard ****8776
-$22.39
Order #701-2501064-2913815
AMZN Mktp CA
October 31, 2026
Mastercard ****8776
-$85.16
Order #701-1073588-0353837
Amazon.ca
September 14, 2026
Mastercard ****8776
+$157.74
Refund: Order #701-7723257-7341008
AMZN Mktp CA
September 13, 2026
Amazon gift card used
-$9.30
Order #701-5961284-7817841
Mastercard ****8776
-$2.73
Order #701-3597774-5252244
AMZN Mktp CA
October 4, 2026
`;

describe('splitAmazonPaste', () => {
  it('reads the transactions page: one entry per charge, refunds and gift cards included', () => {
    const { payments } = splitAmazonPaste(TRANSACTIONS_PAGE);
    expect(payments.map((p) => [p.date, p.orderNum, p.amount, p.isRefund])).toEqual([
      ['2026-11-05', 'D01-2613531-5488255', -16.74, false],
      ['2026-11-04', '701-2501064-2913815', -19.37, false],
      ['2026-11-04', '701-5454626-4552215', -21.75, false],
      ['2026-11-04', '701-2501064-2913815', -22.39, false],
      ['2026-10-31', '701-1073588-0353837', -85.16, false],
      ['2026-09-14', '701-7723257-7341008', 157.74, true],
      ['2026-09-13', '701-5961284-7817841', -9.3, false],
      ['2026-09-13', '701-3597774-5252244', -2.73, false],
    ]);
    expect(payments[0].isUSD).toBe(true);
    expect(payments[6].paymentMethod).toBe('Amazon gift card used');
  });

  it('separates the two pages pasted together, in either order', () => {
    for (const text of [ORDERS_PAGE + TRANSACTIONS_PAGE, TRANSACTIONS_PAGE + ORDERS_PAGE]) {
      const { ordersText, payments } = splitAmazonPaste(text);
      expect(payments).toHaveLength(8);
      const orders = parseAmazonOrders(ordersText);
      expect(orders.map((o) => [o.orderNum, o.orderDate, o.amount])).toEqual([
        ['701-2501064-2913815', '2026-11-03', 41.76],
        ['701-5454626-4552215', '2026-11-03', 21.75],
        ['701-1073588-0353837', '2026-10-31', 85.16],
      ]);
    }
  });

  it('leaves an orders-only paste alone', () => {
    expect(splitAmazonPaste(ORDERS_PAGE)).toEqual({ ordersText: ORDERS_PAGE, payments: [] });
  });
});

describe('mergeRange', () => {
  it('joins overlapping and touching ranges', () => {
    let r = mergeRange(undefined, { from: '2026-09-01', to: '2026-09-30' });
    r = mergeRange(r, { from: '2026-11-01', to: '2026-11-10' });
    expect(r).toHaveLength(2);
    r = mergeRange(r, { from: '2026-10-01', to: '2026-10-31' });
    expect(r).toEqual([{ from: '2026-09-01', to: '2026-11-10' }]);
  });
});

let nextTestId = 1000;
function txn(p: Partial<Transaction>): Transaction {
  return {
    id: nextTestId++, source: 'amazon_payment', sourceRef: '', txnDate: '2026-11-04', amount: 0, instrument: 'Amazon',
    descriptor: '', categoryId: null, linkedTransactionId: null, ignoreInBudget: false, comment: null, ...p,
  };
}
const order = (p: Partial<AmazonOrder>): AmazonOrder => ({
  orderNum: '701-1', itemName: 'Socks', orderDate: '2026-11-03', amount: 41.76, status: 'delivered', ...p,
});
const covered = { orders: [{ from: '2026-09-01', to: '2026-11-10' }], payments: [{ from: '2026-09-01', to: '2026-11-10' }] };

describe('computeAmazonFlags', () => {
  it('no flag when split-shipment charges add up to the order total', () => {
    const a = txn({ sourceRef: '701-1', amount: 19.37 });
    const b = txn({ sourceRef: '701-1', amount: 22.39 });
    expect(computeAmazonFlags([a, b], [order({})], covered).size).toBe(0);
  });

  it('no flag when the orders page total leaves out a gift card charge', () => {
    const card = txn({ sourceRef: '701-1', amount: 2.73, comment: 'Mastercard ****8776' });
    const gift = txn({ sourceRef: '701-1', amount: 10.7, comment: 'Paid by Amazon gift card' });
    expect(computeAmazonFlags([card, gift], [order({ amount: 2.73 })], covered).size).toBe(0);
  });

  it('flags charges that fall short of the order total', () => {
    const a = txn({ sourceRef: '701-1', amount: 19.37, txnDate: '2026-10-04' });
    const flags = computeAmazonFlags([a], [order({ orderDate: '2026-10-03' })], covered);
    expect(flags.get(a.id)?.label).toBe('Orders page says $41.76, charged $19.37');
  });

  it('flags a partial return with no refund, and clears once the refund is in', () => {
    const o = order({ returnedItems: ['Blue socks'] });
    const a = txn({ sourceRef: '701-1', amount: 41.76 });
    expect(computeAmazonFlags([a], [o], covered).get(a.id)?.label).toBe('Partial return, no refund');
    const r = txn({ sourceRef: '701-1', amount: 20, ignoreInBudget: true });
    expect(computeAmazonFlags([a, r], [o], covered).size).toBe(0);
  });

  it('flags a returned order whose refund is missing', () => {
    const a = txn({ sourceRef: '701-1', amount: 41.76 });
    expect(computeAmazonFlags([a], [order({ status: 'returned' })], covered).get(a.id)?.label).toBe('Returned, no refund');
  });

  it('flags a charge with no order only where the orders page was pasted', () => {
    const a = txn({ sourceRef: '701-9', amount: 5, txnDate: '2026-10-20' });
    expect(computeAmazonFlags([a], [], covered).get(a.id)?.label).toBe('No order details');
    expect(computeAmazonFlags([a], [], { payments: covered.payments }).size).toBe(0);
    const digital = txn({ sourceRef: 'D01-2613531-5488255', amount: 23.1, txnDate: '2026-10-20' });
    expect(computeAmazonFlags([digital], [], covered).size).toBe(0);
  });

  it('flags an order-page total with no charge only where the transactions page was pasted', () => {
    const t = txn({ source: 'amazon_order', sourceRef: '701-1', amount: 41.76, txnDate: '2026-10-03' });
    const o = order({ orderDate: '2026-10-03' });
    expect(computeAmazonFlags([t], [o], covered).get(t.id)?.label).toBe('No charge found');
    expect(computeAmazonFlags([t], [o], { orders: covered.orders }).size).toBe(0);
  });

  it('flags a refund whose charge was never imported', () => {
    const r = txn({ sourceRef: '701-7723257-7341008', amount: 157.74, ignoreInBudget: true });
    expect(computeAmazonFlags([r], [], covered).get(r.id)?.label).toBe('Refund, no charge');
  });
});

describe('addAmazonPayments', () => {
  beforeEach(() => { __setDataForTests(richFixture()); });

  const charge = (orderNum: string, amount: number, extra: Partial<Transaction> = {}): Omit<Transaction, 'id'> => ({
    source: 'amazon_payment', sourceRef: orderNum, txnDate: '2026-11-04', amount, instrument: 'Amazon',
    descriptor: amazonDescriptor(orderNum, 'Socks'), categoryId: null, linkedTransactionId: null,
    ignoreInBudget: false, comment: 'Mastercard ****8776', ...extra,
  });

  it('replaces the order total with its charges, keeping the category, and skips re-imports', async () => {
    const catId = getData().categories[0].id;
    await addAmazonOrders([order({ orderNum: '701-1' })]);
    getData().transactions.push(txn({ source: 'amazon_order', sourceRef: '701-1', amount: 41.76, categoryId: catId, txnDate: '2026-11-03' }));

    const lines = [charge('701-1', 19.37), charge('701-1', 22.39), charge('701-1', 10, { ignoreInBudget: true })];
    const res = await addAmazonPayments(lines, new Map());
    expect(res).toEqual({ inserted: 3, duplicates: 0, replaced: 1 });

    const mine = getData().transactions.filter((t) => t.sourceRef === '701-1');
    expect(mine.map((t) => [t.source, t.amount, t.ignoreInBudget, t.categoryId])).toEqual([
      ['amazon_payment', 19.37, false, catId],
      ['amazon_payment', 22.39, false, catId],
      ['amazon_payment', 10, true, catId], // refund takes the order's category
    ]);
    expect(getData().amazonCoverage?.payments).toEqual([{ from: '2026-11-04', to: '2026-11-04' }]);

    const again = await addAmazonPayments(lines, new Map());
    expect(again).toEqual({ inserted: 0, duplicates: 3, replaced: 0 });
  });

  it('moves the order total\'s splits to a single matching charge', async () => {
    const [c1, c2] = getData().categories;
    const old = txn({ source: 'amazon_order', sourceRef: '701-2', amount: 30 });
    getData().transactions.push(old);
    getData().transactionSplits.push(
      { id: 5001, transactionId: old.id, categoryId: c1.id, amount: 10 },
      { id: 5002, transactionId: old.id, categoryId: c2.id, amount: 20 },
    );
    await addAmazonPayments([charge('701-2', 30)], new Map());
    const t = getData().transactions.find((x) => x.sourceRef === '701-2')!;
    expect(t.source).toBe('amazon_payment');
    expect(getData().transactionSplits.filter((s) => s.transactionId === t.id).map((s) => s.amount)).toEqual([10, 20]);
    expect(getData().transactionSplits.some((s) => s.transactionId === old.id)).toBe(false);
  });
});
