import { type ColorThresholds } from '../db';
import { formatAmount } from './format';

export function formatDiff(n: number): string {
  const r = Math.round(n);
  if (r === 0) return '—';
  return `${r > 0 ? '+' : '-'}$${formatAmount(Math.abs(n), 0)}`;
}

export function budgetDiffColor(diff: number, target: number, t: ColorThresholds): string {
  if (Math.abs(diff) < 0.5) return '#166534'; // zero = dark green
  if (diff < 0) return '#16a34a'; // under budget = medium green
  const overPct = target > 0 ? (diff / target) * 100 : 100;
  if (overPct > t.redPct && diff > t.redAbs) return '#dc2626';
  if (overPct > t.orangePct && diff > t.orangeAbs) return '#d97706';
  return '#16a34a'; // over but below both thresholds = still green
}
