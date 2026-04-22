/** Format a number with comma separators (e.g. 1000 -> 1,000). Rounds away -0. */
export function formatAmount(n: number, decimals: number = 2): string {
  const rounded = Number(n.toFixed(decimals));
  const val = Object.is(rounded, -0) ? 0 : rounded;
  return val.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}
