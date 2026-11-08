import { describe, it, expect } from 'vitest';
import { runParserCode, sandboxParseDate } from './sandbox';

const code = `function parseTransactions(text, filename) {
  return text.split('\\n').filter(Boolean).map(l => { const [d, desc, a] = l.split(','); return { txnDate: parseDate(d), descriptor: desc, amount: parseFloat(a) }; });
}`;

describe('parser sandbox', () => {
  it('runs parser code with parseDate injected', () => {
    const rows = runParserCode(code, '3/4/26,Coffee,4.5', 'x.csv') as { txnDate: string; amount: number }[];
    expect(rows[0].txnDate).toBe('2026-03-04');
    expect(rows[0].amount).toBe(4.5);
  });
  it('rejects bad dates with a helpful message', () => {
    const bad = `function parseTransactions(){ return [{ txnDate: 'tomorrow', descriptor: 'x', amount: 1 }]; }`;
    expect(() => runParserCode(bad, '', 'f')).toThrow(/not YYYY-MM-DD/);
  });
  it('parses common date shapes', () => {
    expect(sandboxParseDate('2026-01-02')).toBe('2026-01-02');
    expect(sandboxParseDate('02-Jan-2026')).toBe('2026-01-02');
    expect(sandboxParseDate('20260102')).toBe('2026-01-02');
  });
});
