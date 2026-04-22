import { getData, type Transaction } from '../db';

function normalize(s: string): string {
  return s.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Normalize instrument for dedup purposes:
 * - Strip the " - {identifier}" suffix added by the new parser naming scheme
 * - Map legacy short names ("Card", "Chequing") to their new equivalents
 * so that old imports (instrument="Card") still match new imports (instrument="Scotiabank Credit Card CSV - 1234")
 */
function normalizeInstrument(instrument: string): string {
  const base = instrument.split(' - ')[0].trim();
  if (base === 'Card') return 'Scotiabank Credit Card CSV';
  if (base === 'Chequing') return 'Scotiabank Chequing CSV';
  return base;
}

function dateToMs(dateStr: string): number {
  return new Date(dateStr).getTime();
}

const DAY_MS = 86_400_000;

export interface DuplicateResult {
  duplicates: Omit<Transaction, 'id'>[];
  unique: Omit<Transaction, 'id'>[];
}

/**
 * Duplicate detection:
 * 1. Exact: same date + descriptor + amount (re-import of same file)
 * 2. SourceRef: same date + sourceRef + amount (PayPal linking changes descriptors)
 * 3. Pending→Captured: same amount + instrument from bank_csv, dates within 5 days.
 *    Credit cards show a pending transaction with one descriptor, then when it
 *    settles it appears in the next statement with a different descriptor and
 *    often a slightly different date. We treat same amount + same instrument
 *    within a ±5 day window as a duplicate for bank_csv.
 * 4. Prefix match: handles parser version differences where descriptor text differs slightly.
 *
 * Note: when a transaction's date has been moved via the UI, originalTxnDate is used
 * for duplicate detection so that date adjustments don't break dedup.
 */
export function detectDuplicates(incoming: Omit<Transaction, 'id'>[]): DuplicateResult {
  const { transactions } = getData();

  // Use originalTxnDate (if set) as the canonical date for dedup
  const dedupDate = (t: Pick<Transaction, 'txnDate' | 'originalTxnDate'>) =>
    t.originalTxnDate ?? t.txnDate;

  const descKeys = new Set(
    transactions.map((t) => `${dedupDate(t)}|${normalize(t.descriptor)}|${t.amount}`),
  );

  // Prefix-match dedup: handles parser version differences where one import produces
  // "audible ca" and another produces "audible ca*d11ie7643 Amzn.Com/Billnj" for the same txn.
  // Build a map of date|amount → normalized descriptors of existing transactions.
  const dateAmountToDescs = new Map<string, string[]>();
  for (const t of transactions) {
    const key = `${dedupDate(t)}|${t.amount}`;
    const arr = dateAmountToDescs.get(key) ?? [];
    arr.push(normalize(t.descriptor));
    dateAmountToDescs.set(key, arr);
  }

  const sourceKeys = new Set(
    transactions
      .filter((t) => t.sourceRef)
      .map((t) => `${dedupDate(t)}|${t.sourceRef}|${t.amount}`),
  );

  // For pending→captured: build a list of (dateMs, amount, instrument, normalizedDescriptor)
  // for existing bank_csv txns. We'll check incoming txns within a ±5 day window.
  const existingCardEntries = transactions
    .filter((t) => t.source === 'bank_csv' && t.instrument)
    .map((t) => ({
      dateMs: dateToMs(dedupDate(t)),
      amount: t.amount,
      instrument: normalizeInstrument(t.instrument),
      desc: normalize(t.descriptor),
    }));

  function isPendingCaptureDup(txn: Omit<Transaction, 'id'>): boolean {
    if (txn.source !== 'bank_csv' || !txn.instrument) return false;
    const txnMs = dateToMs(txn.txnDate);
    const txnInst = normalizeInstrument(txn.instrument ?? '');
    const txnDesc = normalize(txn.descriptor);
    return existingCardEntries.some((e) => {
      if (e.amount !== txn.amount) return false;
      if (e.instrument !== txnInst) return false;
      if (Math.abs(e.dateMs - txnMs) > 5 * DAY_MS) return false;
      // Require descriptors to share at least 6 characters from the start to
      // avoid false positives on same-amount purchases at the same merchant.
      const minLen = Math.min(txnDesc.length, e.desc.length);
      return minLen >= 6 && txnDesc.slice(0, 6) === e.desc.slice(0, 6);
    });
  }

  const duplicates: Omit<Transaction, 'id'>[] = [];
  const unique: Omit<Transaction, 'id'>[] = [];

  // Track accepted incoming entries for within-batch dedup (same ±5 day window)
  const incomingCardEntries: { dateMs: number; amount: number; instrument: string; desc: string }[] = [];
  // Track accepted incoming descriptors by date|amount for within-batch prefix dedup
  const incomingDateAmountToDescs = new Map<string, string[]>();

  for (const txn of incoming) {
    const txnDedupDate = txn.originalTxnDate ?? txn.txnDate;
    const descKey = `${txnDedupDate}|${normalize(txn.descriptor)}|${txn.amount}`;
    const srcKey = `${txnDedupDate}|${txn.sourceRef}|${txn.amount}`;

    const incomingNorm = normalize(txn.descriptor);
    const existingDescs = dateAmountToDescs.get(`${txnDedupDate}|${txn.amount}`) ?? [];
    const batchDescs = incomingDateAmountToDescs.get(`${txnDedupDate}|${txn.amount}`) ?? [];
    const isPrefixDup = [...existingDescs, ...batchDescs]
      .some((d) => d.length >= 8 && (d.startsWith(incomingNorm) || incomingNorm.startsWith(d)));

    const txnMs = dateToMs(txn.txnDate);
    const txnInst = normalizeInstrument(txn.instrument ?? '');

    const txnDesc = normalize(txn.descriptor);
    const isInBatchDup =
      txn.source === 'bank_csv' &&
      txn.instrument &&
      incomingCardEntries.some((e) => {
        if (e.amount !== txn.amount || e.instrument !== txnInst) return false;
        if (Math.abs(e.dateMs - txnMs) > 5 * DAY_MS) return false;
        const minLen = Math.min(txnDesc.length, e.desc.length);
        return minLen >= 6 && txnDesc.slice(0, 6) === e.desc.slice(0, 6);
      });

    if (
      descKeys.has(descKey) ||
      sourceKeys.has(srcKey) ||
      isPendingCaptureDup(txn) ||
      isPrefixDup ||
      isInBatchDup
    ) {
      duplicates.push(txn);
    } else {
      unique.push(txn);
      // Add to in-memory sets so duplicates within the same incoming batch are also caught
      descKeys.add(descKey);
      if (txn.sourceRef) sourceKeys.add(srcKey);
      if (txn.source === 'bank_csv' && txn.instrument) {
        existingCardEntries.push({ dateMs: txnMs, amount: txn.amount, instrument: txnInst, desc: txnDesc });
        incomingCardEntries.push({ dateMs: txnMs, amount: txn.amount, instrument: txnInst, desc: txnDesc });
        const batchKey = `${txnDedupDate}|${txn.amount}`;
        const batchArr = incomingDateAmountToDescs.get(batchKey) ?? [];
        batchArr.push(incomingNorm);
        incomingDateAmountToDescs.set(batchKey, batchArr);
      }
    }
  }

  return { duplicates, unique };
}
