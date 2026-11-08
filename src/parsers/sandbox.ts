/** Pure parser sandbox helpers — run inside a Web Worker (see workers/parserWorker.ts). */

/**
 * Robust date parser injected into the custom parser sandbox.
 * Handles M/D/YY, M/D/YYYY, YYYY-MM-DD, DD-Mon-YYYY, and ISO variants.
 * Returns YYYY-MM-DD or throws with a helpful message.
 */
export function sandboxParseDate(raw: string): string {
  const s = (raw ?? '').trim();
  if (!s) throw new Error(`Empty date value`);
  // Already YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // M/D/YY or M/D/YYYY
  const slash = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (slash) {
    const [, m, d, y] = slash;
    const year = y.length === 2 ? `20${y}` : y;
    return `${year}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  // YYYY/MM/DD
  const ymd = s.match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
  if (ymd) return `${ymd[1]}-${ymd[2]}-${ymd[3]}`;
  // DD-Mon-YYYY or DD Mon YYYY
  const months: Record<string, string> = { jan:'01',feb:'02',mar:'03',apr:'04',may:'05',jun:'06',jul:'07',aug:'08',sep:'09',oct:'10',nov:'11',dec:'12' };
  const mon = s.match(/^(\d{1,2})[-\s]([A-Za-z]{3})[-\s](\d{4})$/);
  if (mon) {
    const mo = months[mon[2].toLowerCase()];
    if (mo) return `${mon[3]}-${mo}-${mon[1].padStart(2, '0')}`;
  }
  // YYYYMMDD
  if (/^\d{8}$/.test(s)) return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`;
  throw new Error(`Unrecognised date format: "${s}"`);
}

/** Run AI-generated parser code. Returns the raw rows (validated again by the caller). */
export function runParserCode(code: string, text: string, filename: string): unknown[] {
  // eslint-disable-next-line no-new-func
  const fn = new Function('text', 'filename', 'parseDate', `
    ${code}
    return parseTransactions(text, filename);
  `);
  const result = fn(text, filename, sandboxParseDate);
  if (!Array.isArray(result)) return [];
  for (let i = 0; i < result.length; i++) {
    const r = result[i] as Record<string, unknown>;
    if (typeof r?.txnDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.txnDate as string)) {
      throw new Error(`Row ${i + 1}: txnDate "${r?.txnDate}" is not YYYY-MM-DD. Check your date parsing logic.`);
    }
  }
  return result;
}
