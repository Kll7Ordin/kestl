import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { __setDataForTests, getData, addRecurringTemplate, updateRecurringTemplate, deleteTransactions, startupCleanup } from '../db';
import { processRecurringTemplates } from './recurring';
import { emptyFixture, makeTxn } from '../test/fixtures';

describe('recurring templates', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-15T12:00:00'));
    const d = emptyFixture();
    // history from years ago must NOT be backfilled for a new template
    d.transactions = [makeTxn({ id: 1, txnDate: '2024-01-10' })];
    __setDataForTests(d);
  });
  afterEach(() => vi.useRealTimers());

  const rec = () => getData().transactions.filter((t) => t.source === 'recurring');

  it('new template generates only the current month', async () => {
    await addRecurringTemplate({ descriptor: 'Gym', amount: 40, instrument: 'recurring', categoryId: null, dayOfMonth: 5, active: true });
    expect(await processRecurringTemplates()).toBe(1);
    expect(rec().map((t) => t.txnDate)).toEqual(['2026-03-05']);
  });

  it('is idempotent', async () => {
    await addRecurringTemplate({ descriptor: 'Gym', amount: 40, instrument: 'recurring', categoryId: null, dayOfMonth: 5, active: true, startMonth: '2026-01' });
    await processRecurringTemplates();
    expect(rec()).toHaveLength(3);
    expect(await processRecurringTemplates()).toBe(0);
  });

  it('a deleted occurrence stays deleted', async () => {
    await addRecurringTemplate({ descriptor: 'Gym', amount: 40, instrument: 'recurring', categoryId: null, dayOfMonth: 5, active: true });
    await processRecurringTemplates();
    await deleteTransactions(rec().map((t) => t.id));
    expect(await processRecurringTemplates()).toBe(0);
    expect(getData().recurringTemplates[0].skippedMonths).toEqual(['2026-03']);
  });

  it('pause then resume skips the gap', async () => {
    const id = await addRecurringTemplate({ descriptor: 'Gym', amount: 40, instrument: 'recurring', categoryId: null, dayOfMonth: 5, active: true, startMonth: '2026-01' });
    await processRecurringTemplates(); // Jan, Feb, Mar
    await updateRecurringTemplate(id, { active: false }); // paused 2026-03
    vi.setSystemTime(new Date('2026-06-10T12:00:00'));
    await updateRecurringTemplate(id, { active: true });
    expect(getData().recurringTemplates[0].skippedMonths).toEqual(['2026-04', '2026-05']);
    await processRecurringTemplates();
    expect(rec().map((t) => t.txnDate.slice(0, 7)).sort()).toEqual(['2026-01', '2026-02', '2026-03', '2026-06']);
  });

  it('migration backfills startMonth from existing generated txns', async () => {
    const d = emptyFixture();
    d.recurringTemplates = [{ id: 7, descriptor: 'Old', amount: 10, instrument: 'recurring', categoryId: null, dayOfMonth: 1, active: true }];
    d.transactions = [makeTxn({ id: 1, source: 'recurring', sourceRef: '7', txnDate: '2025-11-01' })];
    __setDataForTests(d);
    await startupCleanup();
    expect(getData().recurringTemplates[0].startMonth).toBe('2025-11');
  });
});
