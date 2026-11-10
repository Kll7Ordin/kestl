import { describe, it, expect } from 'vitest';
import { transactionsToCsv, transactionsToClipboardTable } from './export';
import { makeTxn, makeSplit } from '../test/fixtures';

describe('transactionsToCsv', () => {
  it('exports date, descriptor, instrument, signed amount, category and note', () => {
    const cats = new Map([[1, 'Groceries'], [2, 'Fun']]);
    const txns = [
      makeTxn({ id: 1, txnDate: '2026-09-16', descriptor: 'sun-oka fruit farms Summerland Bc', amount: 61.07, categoryId: 1, comment: 'peaches, "lots"' }),
      makeTxn({ id: 2, txnDate: '2026-09-15', descriptor: 'oldnavy.com', amount: -31.35, ignoreInBudget: true }),
      makeTxn({ id: 3, txnDate: '2026-09-14', descriptor: 'costco', amount: 100, starNote: 'check receipt' }),
    ];
    const splits = new Map([[3, [makeSplit({ transactionId: 3, categoryId: 1, amount: 60 }), makeSplit({ transactionId: 3, categoryId: 2, amount: 40 })]]]);
    const csv = transactionsToCsv(txns, (id) => cats.get(id), (id) => splits.get(id));
    expect(csv.split('\r\n')).toEqual([
      'Date,Descriptor,Instrument,Amount,Category,Note',
      '2026-09-16,sun-oka fruit farms Summerland Bc,Scotiabank Credit Card CSV,-61.07,Groceries,"peaches, ""lots"""',
      '2026-09-15,oldnavy.com,Scotiabank Credit Card CSV,31.35,,',
      '2026-09-14,costco,Scotiabank Credit Card CSV,-100.00,Groceries 60.00; Fun 40.00,check receipt',
      '',
    ]);
  });
});

describe('transactionsToClipboardTable', () => {
  it('has the CSV columns as an HTML table and tab-separated text', () => {
    const txns = [makeTxn({ id: 1, txnDate: '2026-09-16', descriptor: 'a & b <shop>', amount: 10, categoryId: 1, comment: 'x\ty' })];
    const { html, text } = transactionsToClipboardTable(txns, () => 'Groceries', () => undefined);
    expect(html).toContain('<th style="border:1px solid #999;padding:2px 6px;text-align:left">Descriptor</th>');
    expect(html).toContain('a &amp; b &lt;shop&gt;');
    expect(text.split('\n')).toEqual([
      'Date\tDescriptor\tInstrument\tAmount\tCategory\tNote',
      '2026-09-16\ta & b <shop>\tScotiabank Credit Card CSV\t-10.00\tGroceries\tx y',
    ]);
  });
});
