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
