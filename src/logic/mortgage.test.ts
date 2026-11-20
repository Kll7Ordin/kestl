import { describe, it, expect } from 'vitest';
import type { MortgageConfig, MortgageLedgerEntry } from '../db';
import { impliedRate, recalcLedger, findPaymentChange, withRateChange, rateAt, paymentChangeKey } from './mortgage';

const baseCfg: MortgageConfig = {
  outstandingBalance: 418819.91,
  originalAmount: 450000,
  annualRate: 0.0415,
  paymentFrequency: 'semi-monthly',
  regularPayment: 1110.55,
  mortgageType: 'variable',
  rateChangeBehavior: 'change_payment',
};

let nextId = 1;
const pay = (date: string, amount: number): MortgageLedgerEntry => ({ id: nextId++, date, type: 'payment', amount, balance: 0 });
const ledger = (): MortgageLedgerEntry[] => [
  pay('2026-04-15', 1110.55),
  { id: nextId++, date: '2026-04-21', type: 'opening_balance', amount: 0, balance: 418819.91 },
  pay('2026-10-01', 1110.55),
  pay('2026-10-15', 1110.55),
  pay('2026-11-02', 1138.96),
  pay('2026-11-16', 1138.96),
];

describe('impliedRate', () => {
  it('recovers a quarter-point hike from the new payment', () => {
    const r = impliedRate(414057.55, 0.0415, 1110.55, 1138.96, 'semi-monthly');
    expect(r).not.toBeNull();
    expect(r!).toBeCloseTo(0.044, 3);
  });

  it('returns null when the old payment never paid the loan off', () => {
    expect(impliedRate(500000, 0.05, 500, 600, 'monthly')).toBeNull();
  });
});

describe('findPaymentChange', () => {
  it('flags the first changed payment with an implied rate', () => {
    const cfg = baseCfg;
    const change = findPaymentChange(recalcLedger(ledger(), cfg), cfg);
    expect(change?.date).toBe('2026-11-02');
    expect(change?.oldAmount).toBe(1110.55);
    expect(change?.impliedRate!).toBeCloseTo(0.044, 3);
  });

  it('stays quiet once resolved, and skips ignored one-offs', () => {
    const l = ledger();
    const resolved = { ...baseCfg, resolvedPaymentChanges: [paymentChangeKey(l[4])] };
    expect(findPaymentChange(recalcLedger(l, resolved), resolved)).toBeNull();

    const oneOff = [...ledger().slice(0, 4), pay('2026-11-02', 1500), pay('2026-11-16', 1110.55)];
    const ignored = { ...baseCfg, ignoredPayments: [paymentChangeKey(oneOff[4])] };
    expect(findPaymentChange(recalcLedger(oneOff, ignored), ignored)).toBeNull();
  });
});

describe('rate history', () => {
  it('applies the new rate only from its date', () => {
    const hist = withRateChange(baseCfg, '2026-11-01', 0.044, '2026-04-15');
    const cfg = { ...baseCfg, annualRate: 0.044, rateHistory: hist };
    expect(rateAt(cfg, '2026-10-15')).toBe(0.0415);
    expect(rateAt(cfg, '2026-11-02')).toBe(0.044);

    const before = recalcLedger(ledger(), baseCfg);
    const after = recalcLedger(ledger(), cfg);
    // October payments unchanged, November interest higher
    expect(after[3].interestPortion).toBeCloseTo(before[3].interestPortion!, 6);
    expect(after[4].interestPortion!).toBeGreaterThan(before[4].interestPortion! + 30);
    // pre-anchor balance still lands exactly on the opening balance
    expect(after[0].balance).toBeCloseTo(418819.91, 2);
  });
});
