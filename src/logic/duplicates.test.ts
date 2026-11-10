import { describe, it, expect, beforeEach } from 'vitest';
import { __setDataForTests } from '../db';
import { detectDuplicates, sameMerchant, findExistingDuplicates, removeExistingDuplicates } from './duplicates';
import { emptyFixture, makeTxn } from '../test/fixtures';

const strip = ({ id: _id, ...rest }: ReturnType<typeof makeTxn>) => rest;

describe('detectDuplicates', () => {
  beforeEach(() => {
    const d = emptyFixture();
    d.transactions = [makeTxn({ id: 1, txnDate: '2026-03-01', descriptor: 'COFFEE SHOP', amount: 5, sourceRef: 'r1' })];
    __setDataForTests(d);
  });

  it('flags exact re-import', () => {
    const r = detectDuplicates([strip(makeTxn({ txnDate: '2026-03-01', descriptor: 'coffee  shop', amount: 5 }))]);
    expect(r.duplicates).toHaveLength(1);
    expect(r.unique).toHaveLength(0);
  });

  it('matches by sourceRef when descriptor changed', () => {
    const r = detectDuplicates([strip(makeTxn({ txnDate: '2026-03-01', descriptor: 'PAYPAL *X', amount: 5, sourceRef: 'r1', source: 'paypal' }))]);
    expect(r.duplicates).toHaveLength(1);
  });

  it('treats unrelated rows as unique', () => {
    const r = detectDuplicates([strip(makeTxn({ txnDate: '2026-03-02', descriptor: 'OTHER', amount: 7 }))]);
    expect(r.unique).toHaveLength(1);
  });

  it('pending -> captured within 5 days', () => {
    const d = emptyFixture();
    d.transactions = [makeTxn({ id: 1, txnDate: '2026-03-01', descriptor: 'AMAZON PENDING', amount: 20 })];
    __setDataForTests(d);
    const r = detectDuplicates([strip(makeTxn({ txnDate: '2026-03-04', descriptor: 'AMAZON.CA CAPTURED', amount: 20 }))]);
    expect(r.duplicates).toHaveLength(1);
    const far = detectDuplicates([strip(makeTxn({ txnDate: '2026-03-09', descriptor: 'AMAZON.CA CAPTURED', amount: 20 }))]);
    expect(far.unique).toHaveLength(1);
  });

  it('prefix match on long descriptors', () => {
    const d = emptyFixture();
    d.transactions = [makeTxn({ id: 1, source: 'manual', instrument: '', txnDate: '2026-03-01', descriptor: 'LONG MERCHANT NAME', amount: 9 })];
    __setDataForTests(d);
    const r = detectDuplicates([strip(makeTxn({ source: 'manual', instrument: '', txnDate: '2026-03-01', descriptor: 'LONG MERCHANT NAME 123', amount: 9 }))]);
    expect(r.duplicates).toHaveLength(1);
  });

  it('N in DB absorb exactly N incoming', () => {
    const d = emptyFixture();
    d.transactions = [
      makeTxn({ id: 1, txnDate: '2026-03-01', descriptor: 'TRANSFER', amount: 50, source: 'manual', instrument: '' }),
      makeTxn({ id: 2, txnDate: '2026-03-01', descriptor: 'TRANSFER', amount: 50, source: 'manual', instrument: '' }),
    ];
    __setDataForTests(d);
    const row = () => strip(makeTxn({ txnDate: '2026-03-01', descriptor: 'TRANSFER', amount: 50, source: 'manual', instrument: '' }));
    const r = detectDuplicates([row(), row(), row()]);
    expect(r.duplicates).toHaveLength(2);
    expect(r.unique).toHaveLength(1);
  });
});

describe('merchant renamed between exports', () => {
  it('sameMerchant ignores spacing and punctuation', () => {
    expect(sameMerchant('old navy 800-427-7895 On', 'oldnavy.com 800-427-7895 On')).toBe(true);
    expect(sameMerchant('walmart Victoria Bc', 'wal-mart supercenter#3109 Victoria Bc')).toBe(true);
    expect(sameMerchant('d j * wsj 800-568-7625 Nj', 'd j*wsj 800-568-7625 Nj')).toBe(true);
    expect(sameMerchant('sun oka fruit farms Summerland Bc', 'sun-oka fruit farms Summerland Bc')).toBe(true);
    // Renamed tails still match on the as-written prefix.
    expect(sameMerchant('koodo mobile 4033102255 Ab', 'koodo stream plus 4033102255 Ab')).toBe(true);
    expect(sameMerchant('telus Edmonton Ab', 'telus pre-auth payment Edmonton Ab')).toBe(true);
    expect(sameMerchant('sp ca-keenfootwear Brampton On', 'sp vessi-footwear-ca Vancouver Bc')).toBe(false);
  });

  it('sameMerchant ignores an added or dropped payment-processor prefix', () => {
    expect(sameMerchant('penna co Victoria Bc', 'sp penna co. Victoria Bc')).toBe(true);
    expect(sameMerchant('podium imports Penticton Bc', 'sp podium imports Penticton Bc')).toBe(true);
    expect(sameMerchant('habit coffee Victoria Bc', 'sq *habit coffee Victoria Bc')).toBe(true);
    expect(sameMerchant('camp steam 519-870-8762 On', 'bam*camp steam 519-870-8762 On')).toBe(true);
    expect(sameMerchant('saanich parks 2504755494 Bc', 'act*saanich parks 2504755494 Bc')).toBe(true);
    expect(sameMerchant('sp penna co. Victoria Bc', 'sp podium imports Penticton Bc')).toBe(false);
  });

  it('flags a re-export where Scotia renamed the merchant', () => {
    const d = emptyFixture();
    d.transactions = [makeTxn({ id: 1, txnDate: '2026-09-15', descriptor: 'old navy 800-427-7895 On', amount: -31.35 })];
    __setDataForTests(d);
    const r = detectDuplicates([strip(makeTxn({ txnDate: '2026-09-15', descriptor: 'oldnavy.com 800-427-7895 On', amount: -31.35 }))]);
    expect(r.duplicates).toHaveLength(1);
  });
});

describe('findExistingDuplicates', () => {
  it('groups same card/date/amount/merchant and keeps the categorized copy', () => {
    const d = emptyFixture();
    d.transactions = [
      makeTxn({ id: 1, txnDate: '2026-09-15', descriptor: 'old navy 800-427-7895 On', amount: -31.35 }),
      makeTxn({ id: 2, txnDate: '2026-09-15', descriptor: 'oldnavy.com 800-427-7895 On', amount: -31.35, categoryId: 7 }),
      makeTxn({ id: 3, txnDate: '2026-09-16', descriptor: 'sun-oka fruit farms Summerland Bc', amount: 61.07 }),
      makeTxn({ id: 4, txnDate: '2026-09-16', descriptor: 'sun-oka fruit farms Summerland Bc', amount: 61.07 }),
      makeTxn({ id: 5, txnDate: '2026-09-16', descriptor: 'other shop', amount: 61.07 }),
      makeTxn({ id: 6, txnDate: '2026-09-16', descriptor: 'sun-oka fruit farms Summerland Bc', amount: 61.07, instrument: 'Scotiabank Chequing CSV' }),
      makeTxn({ id: 7, txnDate: '2026-09-16', descriptor: 'sun-oka fruit farms Summerland Bc', amount: 61.07, source: 'manual' }),
    ];
    const groups = findExistingDuplicates(d);
    expect(groups).toHaveLength(2);
    const sun = groups.find((g) => g.keep.descriptor.startsWith('sun'))!;
    expect(sun.keep.id).toBe(3);
    expect(sun.extras.map((t) => t.id)).toEqual([4]);
    expect(sun.identical).toBe(true);
    const navy = groups.find((g) => g.keep.descriptor.includes('navy'))!;
    expect(navy.keep.id).toBe(2);
    expect(navy.extras.map((t) => t.id)).toEqual([1]);
    expect(navy.identical).toBe(false);
  });
});

describe('findExistingDuplicates — real repeats are not duplicates', () => {
  it('never pairs two rows from the same CSV file', () => {
    const d = emptyFixture();
    d.transactions = [
      makeTxn({ id: 1, txnDate: '2026-11-02', descriptor: 'investment Wealthsimple', amount: 200, sourceRef: 'a.csv' }),
      makeTxn({ id: 2, txnDate: '2026-11-02', descriptor: 'investment Wealthsimple', amount: 200, sourceRef: 'a.csv' }),
      makeTxn({ id: 3, txnDate: '2026-11-02', descriptor: 'investment Wealthsimple', amount: 200, sourceRef: 'b.csv' }),
    ];
    const groups = findExistingDuplicates(d);
    expect(groups).toHaveLength(1);
    expect([groups[0].keep.id, ...groups[0].extras.map((t) => t.id)]).toEqual([1, 3]);
  });

  it('compares the merchant segment of PayPal-linked descriptors', () => {
    expect(sameMerchant('PayPal | eBay Commerce Canada Limited | Payment', 'PayPal | Hierhebikpijn.nl B.V. | Automatic Payment')).toBe(false);
    expect(sameMerchant('PayPal | checkdomain GmbH | Automatic Payment', 'PayPal | checkdomain GmbH | Automatic Payment')).toBe(true);
  });
});

describe('removeExistingDuplicates', () => {
  it('removes renamed copies from overlapping statements and keeps the categorized one', () => {
    const d = emptyFixture();
    d.transactions = [
      makeTxn({ id: 1, txnDate: '2026-09-20', descriptor: 'sp penna co. Victoria Bc', amount: 304.64, sourceRef: 'a.csv' }),
      makeTxn({ id: 2, txnDate: '2026-09-20', descriptor: 'penna co Victoria Bc', amount: 304.64, sourceRef: 'b.csv', categoryId: 4, comment: 'gift' }),
      // Same file: two real e-transfers, kept.
      makeTxn({ id: 3, txnDate: '2026-09-11', descriptor: 'deposit Free Interac E-Transfer', amount: -84, sourceRef: 'c.csv' }),
      makeTxn({ id: 4, txnDate: '2026-09-11', descriptor: 'deposit Free Interac E-Transfer', amount: -84, sourceRef: 'c.csv' }),
    ];
    expect(removeExistingDuplicates(d)).toBe(1);
    expect(d.transactions.map((t) => t.id)).toEqual([2, 3, 4]);
    expect(d.transactions[0].comment).toBe('gift');
  });
});
