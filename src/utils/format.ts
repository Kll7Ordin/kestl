// Intl formatters are slow to create (WebKit: ~20µs per toLocaleString call with options, vs
// under 1µs reusing a formatter), and screens format thousands of values per render. Reuse them.
const numberFormats = new Map<number, Intl.NumberFormat>();
const dateFormats = new Map<string, Intl.DateTimeFormat>();

/** Format a number with comma separators (e.g. 1000 -> 1,000). Rounds away -0. */
export function formatAmount(n: number, decimals: number = 2): string {
  const rounded = Number(n.toFixed(decimals));
  const val = Object.is(rounded, -0) ? 0 : rounded;
  let nf = numberFormats.get(decimals);
  if (!nf) {
    nf = new Intl.NumberFormat('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    numberFormats.set(decimals, nf);
  }
  return nf.format(val);
}

/** `date.toLocaleDateString(locale, opts)`, with the formatter reused across calls. */
export function formatDate(date: Date, locale: string, opts: Intl.DateTimeFormatOptions): string {
  const key = `${locale}|${JSON.stringify(opts)}`;
  let df = dateFormats.get(key);
  if (!df) {
    df = new Intl.DateTimeFormat(locale, opts);
    dateFormats.set(key, df);
  }
  return df.format(date);
}
