import { getData, persistData, type Transaction } from '../db';

function tokenize(s: string): Set<string> {
  return new Set(
    s.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter((t) => t.length > 2),
  );
}

function tokenOverlap(a: Set<string>, b: Set<string>): number {
  let overlap = 0;
  for (const t of a) if (b.has(t)) overlap++;
  return overlap / Math.max(a.size, b.size, 1);
}

function dateDiffDays(a: string, b: string): number {
  const da = new Date(a + 'T00:00:00');
  const db2 = new Date(b + 'T00:00:00');
  return Math.abs((da.getTime() - db2.getTime()) / 86400000);
}

export interface PaypalMatchCandidate {
  paypalTxn: Omit<Transaction, 'id'> & { id?: number };
  cardTxn: Transaction;
  exact: boolean;
}

/**
 * Bank debits eligible for PayPal matching:
 * 1. Generic PayPal debits (descriptor contains "paypal") with no link or stale link
 * 2. Any bank debit with a stale link (linked txn was deleted by a previous import)
 */
function isBankPaypalCandidate(t: Transaction, allTxns: Transaction[]): boolean {
  if (t.instrument === 'PayPal') return false;
  if (t.linkedTransactionId === -1) return false; // already PayPal-linked via new system

  const hasPaypalInDesc = /paypal/i.test(t.descriptor);

  if (t.linkedTransactionId && t.linkedTransactionId > 0) {
    const linkedExists = allTxns.some((x) => x.id === t.linkedTransactionId);
    if (!linkedExists) return true; // stale link — eligible regardless of descriptor
    return false; // active link — not eligible
  }

  return hasPaypalInDesc;
}

/**
 * Match PayPal transactions against existing bank debits.
 * Bank-side PayPal debits often have generic descriptors (e.g. "miscellaneous payment Paypal"),
 * so matching is done primarily by amount + date proximity.
 * Exact amount matches: overwrite the bank txn descriptor and remove the PayPal txn.
 * Fuzzy matches (currency conversion): return for user confirmation.
 */
export interface PaypalMatchResult {
  autoMatched: number;
  fuzzy: PaypalMatchCandidate[];
  unmatched: Transaction[];
}

export async function matchPaypalTransactions(paypalIds: number[]): Promise<PaypalMatchResult> {
  const data = getData();
  const paypalTxns = data.transactions.filter((t) => paypalIds.includes(t.id));
  const bankPaypalDebits = data.transactions.filter((t) => isBankPaypalCandidate(t, data.transactions));
  // All unlinked non-PayPal bank debits for the second pass (token-based matching)
  const allBankDebits = data.transactions.filter(
    (t) => t.instrument !== 'PayPal' && t.linkedTransactionId === null && !t.ignoreInBudget,
  );

  let autoMatched = 0;
  const fuzzy: PaypalMatchCandidate[] = [];
  const unmatched: Transaction[] = [];
  const usedIds = new Set<number>();
  const ppToRemove = new Set<number>();

  function findBestMatch(pp: Transaction, candidates: Transaction[], requireTokenOverlap: boolean) {
    const ppTokens = tokenize(pp.descriptor);
    let bestMatch: Transaction | null = null;
    let bestDateDiff = Infinity;
    let isExact = false;

    for (const bank of candidates) {
      if (usedIds.has(bank.id)) continue;
      const days = dateDiffDays(pp.txnDate, bank.txnDate);
      if (days > 5) continue;

      const amountDiff = Math.abs(pp.amount - bank.amount);
      const exactAmt = amountDiff <= 0.02;
      const fuzzyAmt = amountDiff <= pp.amount * 0.15;
      if (!exactAmt && !fuzzyAmt) continue;

      if (requireTokenOverlap) {
        const overlap = tokenOverlap(ppTokens, tokenize(bank.descriptor));
        if (overlap < 0.3) continue;
      }

      if (exactAmt && !isExact) {
        bestMatch = bank;
        bestDateDiff = days;
        isExact = true;
      } else if (exactAmt === isExact && days < bestDateDiff) {
        bestMatch = bank;
        bestDateDiff = days;
        isExact = exactAmt;
      }
    }

    return { bestMatch, isExact };
  }

  // Pass 1: match against bank debits with "paypal" in descriptor or stale links
  for (const pp of paypalTxns) {
    const { bestMatch, isExact } = findBestMatch(pp, bankPaypalDebits, false);
    if (bestMatch) {
      if (isExact) {
        applyPaypalToBank(bestMatch, pp);
        ppToRemove.add(pp.id);
        usedIds.add(bestMatch.id);
        autoMatched++;
      } else {
        fuzzy.push({ paypalTxn: pp, cardTxn: bestMatch, exact: false });
        usedIds.add(bestMatch.id);
      }
    }
  }

  // Pass 2: for remaining unmatched, try any bank debit with shared descriptor tokens
  const pass1Matched = new Set([...ppToRemove, ...fuzzy.map((f) => f.paypalTxn.id)]);
  for (const pp of paypalTxns) {
    if (pass1Matched.has(pp.id)) continue;
    const { bestMatch, isExact } = findBestMatch(pp, allBankDebits, true);
    if (bestMatch) {
      if (isExact) {
        applyPaypalToBank(bestMatch, pp);
        ppToRemove.add(pp.id);
        usedIds.add(bestMatch.id);
        autoMatched++;
      } else {
        fuzzy.push({ paypalTxn: pp, cardTxn: bestMatch, exact: false });
        usedIds.add(bestMatch.id);
      }
    } else {
      unmatched.push(pp);
    }
  }

  if (ppToRemove.size > 0) {
    data.transactions = data.transactions.filter((t) => !ppToRemove.has(t.id));
    data.transactionSplits = data.transactionSplits.filter((s) => !ppToRemove.has(s.transactionId));
  }

  if (autoMatched > 0) await persistData();
  return { autoMatched, fuzzy, unmatched };
}

/** Overwrite bank txn descriptor with PayPal info, keep bank amount, mark as PayPal-linked. */
function applyPaypalToBank(bankTxn: Transaction, ppTxn: { descriptor: string; categoryId?: number | null; comment?: string | null }) {
  bankTxn.descriptor = ppTxn.descriptor;
  bankTxn.linkedTransactionId = -1; // sentinel: PayPal-linked
  if (ppTxn.categoryId && !bankTxn.categoryId) bankTxn.categoryId = ppTxn.categoryId;
}

/** Re-run matching for all existing unlinked PayPal transactions in the system. */
export async function rematchAllPaypal(): Promise<PaypalMatchResult> {
  const data = getData();
  const unlinkedPP = data.transactions.filter(
    (t) => t.instrument === 'PayPal' && t.linkedTransactionId === null,
  );
  if (unlinkedPP.length === 0) return { autoMatched: 0, fuzzy: [], unmatched: [] };
  return matchPaypalTransactions(unlinkedPP.map((t) => t.id));
}

/** Delete unmatched PayPal transactions that the user chose to discard. */
export async function discardPaypalTransactions(ids: number[]): Promise<void> {
  const data = getData();
  const idSet = new Set(ids);
  data.transactions = data.transactions.filter((t) => !idSet.has(t.id));
  data.transactionSplits = data.transactionSplits.filter((s) => !idSet.has(s.transactionId));
  await persistData();
}

export async function confirmPaypalMatch(paypalId: number, cardId: number): Promise<void> {
  const data = getData();
  const pp = data.transactions.find((t) => t.id === paypalId);
  const card = data.transactions.find((t) => t.id === cardId);
  if (!pp || !card) return;
  applyPaypalToBank(card, pp);
  data.transactions = data.transactions.filter((t) => t.id !== paypalId);
  data.transactionSplits = data.transactionSplits.filter((s) => s.transactionId !== paypalId);
  await persistData();
}
