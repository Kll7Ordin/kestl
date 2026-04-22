import { getData, persistData, type Transaction } from '../db';

function normalize(s: string): string {
  return s.trim().replace(/\s+/g, ' ').toLowerCase();
}

function tokenize(s: string): string[] {
  return normalize(s).replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter((t) => t.length > 2);
}

const LOCATION_TOKENS = new Set([
  'on', 'bc', 'ab', 'qc', 'mb', 'sk', 'ns', 'nb', 'pe', 'nl', 'nt', 'nu', 'yt',
  'toronto', 'vancouver', 'montreal', 'calgary', 'edmonton', 'ottawa', 'winnipeg',
  'victoria', 'halifax', 'regina', 'saskatoon', 'hamilton', 'london', 'kitchener',
  'mississauga', 'brampton', 'surrey', 'burnaby', 'markham', 'richmond',
  'canada', 'usa', 'com', 'www', 'the',
]);

function tokenOverlap(a: string[], b: string[]): { ratio: number; meaningful: number } {
  const setB = new Set(b);
  let overlap = 0;
  let meaningful = 0;
  for (const t of a) {
    if (setB.has(t)) {
      overlap++;
      if (!LOCATION_TOKENS.has(t)) meaningful++;
    }
  }
  return { ratio: overlap / Math.max(a.length, b.length, 1), meaningful };
}

export interface RefundCandidate {
  refundTxn: Transaction;
  originalTxn: Transaction;
  score: number;
}

export function findRefundCandidates(creditIds: number[]): RefundCandidate[] {
  const { transactions } = getData();
  const threeMonthsAgo = new Date();
  threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
  const cutoff = threeMonthsAgo.toISOString().split('T')[0];

  // Refund must be a credit (ignoreInBudget = true); original must be a debit (ignoreInBudget = false).
  const credits = transactions.filter(
    (t) => creditIds.includes(t.id) && t.ignoreInBudget,
  );
  const expenses = transactions.filter(
    (t) => !t.ignoreInBudget && t.linkedTransactionId === null && t.txnDate >= cutoff,
  );

  const results: RefundCandidate[] = [];

  for (const credit of credits) {
    const creditTokens = tokenize(credit.descriptor);
    let bestMatch: Transaction | null = null;
    let bestScore = 0;

    for (const expense of expenses) {
      if (expense.id === credit.id) continue;
      if (Math.abs(expense.amount - credit.amount) > 0.02) continue;
      if (expense.txnDate >= credit.txnDate) continue; // credit must occur after debit
      const { ratio, meaningful } = tokenOverlap(creditTokens, tokenize(expense.descriptor));
      if (meaningful < 1) continue;
      const finalScore = ratio + (expense.instrument === credit.instrument ? 0.1 : 0);
      if (finalScore > bestScore) {
        bestScore = finalScore;
        bestMatch = expense;
      }
    }

    if (bestMatch && bestScore >= 0.5) {
      results.push({ refundTxn: credit, originalTxn: bestMatch, score: bestScore });
    }
  }

  return results;
}

export async function applyRefundToOriginalMonth(refundId: number, originalId: number): Promise<void> {
  const { transactions } = getData();
  const refund = transactions.find((t) => t.id === refundId);
  const original = transactions.find((t) => t.id === originalId);
  if (!refund || !original) return;

  refund.txnDate = original.txnDate;
  refund.linkedTransactionId = originalId;
  refund.categoryId = original.categoryId;
  refund.ignoreInBudget = false;
  refund.amount = -Math.abs(refund.amount); // negate so it offsets the original in budget
  original.linkedTransactionId = refundId;
  await persistData();
}
