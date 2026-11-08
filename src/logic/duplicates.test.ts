import { describe, it, expect, beforeEach } from 'vitest';
import { __setDataForTests } from '../db';
import { detectDuplicates } from './duplicates';
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
