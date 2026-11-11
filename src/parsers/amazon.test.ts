import { describe, it, expect } from 'vitest';
import { parseAmazonOrders } from './amazon';

const order = (date: string, total: string, num: string) =>
  ['Order placed', date, 'Total', total, 'Ship to', 'Jane Doe', `Order # ${num}`, 'View order details', 'Invoice'];

describe('parseAmazonOrders status', () => {
  it('current layout (status after "Order placed"): a returned order does not mark the next one returned', () => {
    const text = [
      'Your Orders',
      ...order('May 12, 2026', '$24.99', '701-1111111-1111111'),
      'Return complete',
      'Your return is complete. Your refund has been issued.',
      'Some Returned Gadget With A Long Product Name',
      'Buy it again',
      ...order('May 11, 2026', '$13.49', '701-8753215-5490664'),
      'Delivered May 13',
      'Proraso Shaving Cream, Sensitive Skin, 5.2 Oz, 1 Count',
      'Buy it again',
    ].join('\n');
    const [a, b] = parseAmazonOrders(text);
    expect(a).toMatchObject({ orderNum: '701-1111111-1111111', status: 'returned' });
    expect(b).toMatchObject({ orderNum: '701-8753215-5490664', status: 'delivered', amount: 13.49 });
    expect(b.itemName).toMatch(/Proraso/);
  });

  it('a partial return keeps the order delivered', () => {
    const text = [
      ...order('May 1, 2026', '$60.00', '701-2222222-2222222'),
      'Delivered May 3',
      'Kept Item With A Reasonably Long Name',
      'Return complete',
      'Returned Item With A Reasonably Long Name',
    ].join('\n');
    expect(parseAmazonOrders(text)[0].status).toBe('delivered');
  });

  it('older layout (status before "Order placed") still works', () => {
    const text = [
      'Return complete',
      'Returned Wireless Keyboard And Mouse Combo',
      'Order placed', 'March 21, 2026', 'Total $49.99', 'Order # 123-4567890-1234567',
      'Delivered March 25, 2026',
      'Kept Bluetooth Speaker Waterproof Edition',
      'Order placed', 'March 20, 2026', 'Total $30.00', 'Order # 123-4567890-7654321',
    ].join('\n');
    const [a, b] = parseAmazonOrders(text);
    expect(a.status).toBe('returned');
    expect(b.status).toBe('delivered');
  });
});

describe('parseAmazonOrders subscriptions', () => {
  it('"Subscription charged on" starts its own order instead of taking over the one above', () => {
    const text = [
      ...order('July 20, 2026', '$15.55', '701-7348515-3525839'),
      'Delivered 23 July',
      'MSY BIGSUNNY 9 inch Buffet Tongs, 2 Pack Stainless Steel Food Serving Tongs',
      'Return window closed on August 22, 2026',
      'Buy it again',
      'Ask a Product-Related Question',
      'Write a product review',
      'Subscription charged on',
      'July 14, 2026',
      'Total',
      '$10.07',
      'Order # D01-7688004-3968212',
      'View order details',
      'Invoice',
      'Audible Standard',
      'Audiobook',
      'Write a product review',
    ].join('\n');
    const [a, b] = parseAmazonOrders(text);
    expect(a).toMatchObject({ orderNum: '701-7348515-3525839', orderDate: '2026-07-20', amount: 15.55 });
    expect(a.itemName).toMatch(/Tongs/);
    expect(b).toMatchObject({ orderNum: 'D01-7688004-3968212', orderDate: '2026-07-14', amount: 10.07 });
  });
});

describe('parseAmazonOrders partial returns', () => {
  it('one returned item among kept ones with no "Delivered" line is a partial return, not a full one', () => {
    const text = [
      ...order('June 1, 2026', '$121.70', '701-1167005-8048252'),
      'PATIKIL E26/E27 Medium Base 4 Light Cluster Socket, 1 Pcs Lamp Base Holder',
      'PATIKIL E26/E27 Medium Base 4 Light Cluster Socket, 1 Pcs Lamp Base Holder',
      'Return and product support windows have closed',
      'Buy it again',
      'Write a product review',
      'Return complete',
      'Your return is complete. Your refund has been issued.',
      'When will I get my refund?',
      "FITRELL 6 Pack Men's Ankle Running Socks Low Cut Cushioned Athletic Sports Socks",
      "FITRELL 6 Pack Men's Ankle Running Socks Low Cut Cushioned Athletic Sports Socks",
      'Buy it again',
      'View Return/Refund Status',
      'Write a product review',
      'Opaza Bike Locks with 5-Digit Code, 1.2 M/4 feet Bicycle Combination Cable Lock',
      'Return and product support windows have closed',
      'Master Lock 8122D Combination Cable Lock, 6-Feet x 1/2-Inch',
      'Return window closed on July 4, 2026',
      'Get product support',
    ].join('\n');
    const [o] = parseAmazonOrders(text);
    expect(o).toMatchObject({ status: 'delivered', amount: 121.7 });
    expect(o.returnedItems).toEqual(["FITRELL 6 Pack Men's Ankle Running Socks Low Cut Cushioned Athletic Sports Socks"]);
  });
});
