import { getData, type AppData, type Transaction } from '../db';
import { parseDescriptor } from './suggest';

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

/**
 * Same merchant despite the bank reformatting its name between exports. Scotia rewrites
 * descriptors after posting, both by renaming the tail ("koodo mobile" → "koodo stream plus",
 * "telus" → "telus pre-auth payment") and by changing spacing/punctuation ("old navy" → "oldnavy.com",
 * "walmart" → "wal-mart supercenter"). Match when the first 6 characters agree either as written
 * (whitespace-collapsed) or with only letters and digits kept.
 *
 * PayPal-linked descriptors ("PayPal | <merchant> | ...") all share the same opening, so for those
 * the merchant segment is compared instead.
 *
 * Scotia also adds or drops a payment-processor prefix ("penna co" → "sp penna co.", "sq *kizuna"),
 * so the cleaned merchant names (parseDescriptor: processor prefix and city removed) are compared too.
 */
export function sameMerchant(a: string, b: string): boolean {
  const paypal = /^\s*paypal\s*\|\s*([^|]*)/i;
  const pa = a.match(paypal), pb = b.match(paypal);
  if (pa && pb) return sameMerchant(pa[1], pb[1]);
  const prefixMatch = (x: string, y: string) =>
    x === y || (Math.min(x.length, y.length) >= 6 && x.slice(0, 6) === y.slice(0, 6));
  const alnum = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (prefixMatch(normalize(a), normalize(b)) || prefixMatch(alnum(a), alnum(b))) return true;
  const ka = parseDescriptor(a).compact, kb = parseDescriptor(b).compact;
  return ka.length >= 4 && kb.length >= 4 && prefixMatch(ka, kb);
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
 * Duplicate detection — only checks incoming transactions against what is already
 * in the database. Two identical rows within the same incoming CSV are never
 * considered duplicates of each other (e.g. two standing transfers of the same
 * amount on the same day are both real transactions).
 *
 * Uses count-based matching: if the DB contains N transactions with a given key,
 * exactly N incoming transactions with that key are treated as duplicates. Any
 * additional incoming ones are unique. This correctly handles recurring same-day
 * payments to the same recipient.
 *
 * Checks against existing transactions:
 * 1. Exact: same date + descriptor + amount (re-import of same file)
 * 2. SourceRef: same date + sourceRef + amount (PayPal linking changes descriptors)
 * 3. Pending→Captured: same amount + instrument from bank_csv, dates within 5 days.
 *    Credit cards show a pending transaction with one descriptor, then when it
 *    settles it appears in the next statement with a different descriptor and
 *    often a slightly different date. We treat same amount + same instrument
 *    within a ±5 day window as a duplicate for bank_csv, when sameMerchant() agrees.
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

  // Count-based maps: key → number of remaining DB entries available to absorb a match.
  // When an incoming txn is matched, we decrement the count so that N DB entries only
  // absorb exactly N incoming ones — not N+1, N+2, etc.
  const descKeyCounts = new Map<string, number>();
  for (const t of transactions) {
    const key = `${dedupDate(t)}|${normalize(t.descriptor)}|${t.amount}`;
    descKeyCounts.set(key, (descKeyCounts.get(key) ?? 0) + 1);
  }

  const sourceKeyCounts = new Map<string, number>();
  for (const t of transactions.filter((t) => t.sourceRef)) {
    const key = `${dedupDate(t)}|${t.sourceRef}|${t.amount}`;
    sourceKeyCounts.set(key, (sourceKeyCounts.get(key) ?? 0) + 1);
  }

  // Mutable descriptor lists per date|amount for prefix matching.
  // Splice out matched entries so they can't absorb more than one incoming txn.
  const dateAmountToDescs = new Map<string, string[]>();
  for (const t of transactions) {
    const key = `${dedupDate(t)}|${t.amount}`;
    const arr = dateAmountToDescs.get(key) ?? [];
    arr.push(normalize(t.descriptor));
    dateAmountToDescs.set(key, arr);
  }

  // Mutable card entries for pending→captured matching; splice when consumed.
  const remainingCardEntries = transactions
    .filter((t) => t.source === 'bank_csv' && t.instrument)
    .map((t) => ({
      dateMs: dateToMs(dedupDate(t)),
      amount: t.amount,
      instrument: normalizeInstrument(t.instrument),
      desc: normalize(t.descriptor),
    }));

  function consumePendingCaptureDup(txn: Omit<Transaction, 'id'>): boolean {
    if (txn.source !== 'bank_csv' || !txn.instrument) return false;
    const txnMs = dateToMs(txn.txnDate);
    const txnInst = normalizeInstrument(txn.instrument ?? '');
    const idx = remainingCardEntries.findIndex((e) => {
      if (e.amount !== txn.amount) return false;
      if (e.instrument !== txnInst) return false;
      if (Math.abs(e.dateMs - txnMs) > 5 * DAY_MS) return false;
      return sameMerchant(txn.descriptor, e.desc);
    });
    if (idx < 0) return false;
    remainingCardEntries.splice(idx, 1);
    return true;
  }

  const duplicates: Omit<Transaction, 'id'>[] = [];
  const unique: Omit<Transaction, 'id'>[] = [];

  for (const txn of incoming) {
    const txnDedupDate = txn.originalTxnDate ?? txn.txnDate;
    const descKey = `${txnDedupDate}|${normalize(txn.descriptor)}|${txn.amount}`;
    const srcKey = `${txnDedupDate}|${txn.sourceRef}|${txn.amount}`;
    const incomingNorm = normalize(txn.descriptor);
    const daKey = `${txnDedupDate}|${txn.amount}`;
    const existingDescs = dateAmountToDescs.get(daKey) ?? [];

    const descCount = descKeyCounts.get(descKey) ?? 0;
    const srcCount = sourceKeyCounts.get(srcKey) ?? 0;
    const prefixIdx = existingDescs.findIndex(
      (d) => d.length >= 8 && (d.startsWith(incomingNorm) || incomingNorm.startsWith(d)),
    );

    if (descCount > 0) {
      descKeyCounts.set(descKey, descCount - 1);
      // Also remove from dateAmountToDescs so prefix dedup doesn't double-count the same entry
      const dIdx = existingDescs.indexOf(incomingNorm);
      if (dIdx >= 0) existingDescs.splice(dIdx, 1);
      duplicates.push(txn);
    } else if (srcCount > 0) {
      sourceKeyCounts.set(srcKey, srcCount - 1);
      duplicates.push(txn);
    } else if (consumePendingCaptureDup(txn)) {
      duplicates.push(txn);
    } else if (prefixIdx >= 0) {
      existingDescs.splice(prefixIdx, 1);
      duplicates.push(txn);
    } else {
      unique.push(txn);
    }
  }

  return { duplicates, unique };
}

export interface DuplicateGroup {
  /** The copy to keep: categorized/split/annotated first, then the earliest import. */
  keep: Transaction;
  /** The other copies, proposed for deletion. */
  extras: Transaction[];
  /** All copies share the exact same descriptor, which can also mean genuine repeat purchases. */
  identical: boolean;
}

/**
 * Find bank-CSV transactions already in the data that look like the same charge recorded twice:
 * same card, same bank date, same amount, and the same merchant (see sameMerchant).
 */
export function findExistingDuplicates(data: Pick<AppData, 'transactions' | 'transactionSplits'>): DuplicateGroup[] {
  const hasSplits = new Set(data.transactionSplits.map((s) => s.transactionId));
  const keepScore = (t: Transaction) =>
    (t.categoryId != null || hasSplits.has(t.id) ? 8 : 0)
    + (t.comment ? 4 : 0)
    + (t.starred || t.starNote ? 2 : 0)
    + (t.isTransfer ? 1 : 0);

  const buckets = new Map<string, Transaction[]>();
  for (const t of data.transactions) {
    if (t.source !== 'bank_csv' || !t.instrument) continue;
    const key = `${normalizeInstrument(t.instrument)}|${t.originalTxnDate ?? t.txnDate}|${t.amount}`;
    const arr = buckets.get(key);
    if (arr) arr.push(t); else buckets.set(key, [t]);
  }

  const groups: DuplicateGroup[] = [];
  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue;
    // Cluster the bucket by merchant; each cluster of 2+ is one duplicate group.
    const remaining = [...bucket].sort((a, b) => a.id - b.id);
    while (remaining.length > 0) {
      const first = remaining.shift()!;
      const cluster = [first];
      for (let i = remaining.length - 1; i >= 0; i--) {
        const other = remaining[i];
        // sourceRef is the CSV filename. One statement never lists the same posted charge twice, so
        // rows from the same file are separate purchases (two RESP deposits, two phone lines, ...).
        if (other.sourceRef && cluster.some((c) => c.sourceRef === other.sourceRef)) continue;
        if (sameMerchant(first.descriptor, other.descriptor)) cluster.push(...remaining.splice(i, 1));
      }
      if (cluster.length < 2) continue;
      cluster.sort((a, b) => keepScore(b) - keepScore(a) || a.id - b.id);
      const [keep, ...extras] = cluster;
      const identical = cluster.every((t) => normalize(t.descriptor) === normalize(keep.descriptor));
      groups.push({ keep, extras, identical });
    }
  }
  return groups.sort((a, b) => (b.keep.txnDate > a.keep.txnDate ? 1 : b.keep.txnDate < a.keep.txnDate ? -1 : 0));
}

/**
 * Remove the extra copies found by findExistingDuplicates, in place. The kept copy inherits a
 * category, comment and star from the removed ones when it lacks them. Returns how many were removed.
 */
export function removeExistingDuplicates(data: Pick<AppData, 'transactions' | 'transactionSplits'>): number {
  const groups = findExistingDuplicates(data);
  const hasSplits = new Set(data.transactionSplits.map((s) => s.transactionId));
  const remove = new Set<number>();
  for (const { keep, extras } of groups) {
    const withCat = extras.find((t) => t.categoryId != null);
    if (keep.categoryId == null && !hasSplits.has(keep.id) && withCat) keep.categoryId = withCat.categoryId;
    const comments = extras.map((t) => t.comment).filter((c): c is string => !!c && c !== keep.comment);
    if (comments.length > 0) keep.comment = [keep.comment, ...comments].filter(Boolean).join(' ');
    if (!keep.starred && extras.some((t) => t.starred)) keep.starred = true;
    if (!keep.starNote) keep.starNote = extras.find((t) => t.starNote)?.starNote ?? keep.starNote;
    for (const t of extras) remove.add(t.id);
  }
  if (remove.size > 0) {
    data.transactions = data.transactions.filter((t) => !remove.has(t.id));
    data.transactionSplits = data.transactionSplits.filter((s) => !remove.has(s.transactionId));
  }
  return remove.size;
}
