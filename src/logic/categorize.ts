import { getData, addCategoryRule, persistData, setSplitsBulk, withUndo, type Transaction, type CategoryRule, type SplitRuleItem } from '../db';
import { isCredit } from './txnKind';

export interface RunRuleOptions {
  ruleId: number;
  startDate?: string; // ISO date or undefined for all time
  endDate?: string;
  includeAlreadyCategorized: boolean;
}

function normalize(s: string): string {
  return s.trim().replace(/\s+/g, ' ').toLowerCase();
}

// ── Transaction guessing (4-tier point system) ────────────────────────────────

// Strip ID-like tokens: long digit sequences, reference codes like G150027389
function stripIds(s: string): string {
  return s
    .replace(/[A-Z]?\d{6,}/gi, '') // long digit sequences with optional letter prefix
    .replace(/[#*]\S+/g, '')        // #ref or *ref tokens
    .replace(/\s+/g, ' ').trim().toLowerCase();
}

// Common noise words to exclude from keyword matching
const NOISE_WORDS = new Set([
  'the','a','an','and','or','for','of','to','in','at','by','with','from',
  'on','is','it','as','be','was','but','not','are','do','did','has','have',
  // Payment types
  'pos','gpos','purchase','payment','debit','credit','transfer','deposit',
  'withdrawal','auto','bill','pre','authorized',
  // Province abbreviations
  'bc','ab','on','qc','mb','sk','ns','nb','nl','pe','nt','yt','nu',
  // Business suffixes
  'canada','canadian','inc','ltd','llc','co','corp','company',
  // Canadian city names common in transaction descriptors
  'victoria','vancouver','burnaby','surrey','richmond','kelowna','nanaimo',
  'abbotsford','toronto','calgary','edmonton','winnipeg','montreal','ottawa',
  'hamilton','london','halifax','saskatoon','regina','whitehorse','yellowknife',
  'iqaluit','charlottetown','fredericton','moncton','langley','coquitlam',
  'delta','chilliwack','kamloops','courtenay','campbell','comox','squamish',
]);

/**
 * Build the set of words that appear in 3 or more distinct categories.
 * Such words are too generic to be useful for Tier 4 keyword matching and
 * are excluded dynamically in addition to the static NOISE_WORDS list.
 */
function archivedCategoryIds(): Set<number> {
  return new Set(getData().categories.filter((c) => c.archived).map((c) => c.id));
}

/** Corpus rows: categorized debits, excluding transfers and archived categories. */
function usableForSuggestions(t: Transaction, archived: Set<number>): boolean {
  return t.categoryId != null && !isCredit(t) && !t.isTransfer && !archived.has(t.categoryId);
}

function buildHighSpreadWords(transactions: Transaction[]): Set<string> {
  const archived = archivedCategoryIds();
  const wordToCategories = new Map<string, Set<number>>();
  for (const t of transactions) {
    if (!usableForSuggestions(t, archived)) continue;
    const words = stripIds(t.descriptor).split(/\s+/).filter((w) => w.length >= 3 && !NOISE_WORDS.has(w));
    for (const w of words) {
      let cats = wordToCategories.get(w);
      if (!cats) { cats = new Set(); wordToCategories.set(w, cats); }
      cats.add(t.categoryId!);
    }
  }
  const result = new Set<string>();
  for (const [word, cats] of wordToCategories) {
    if (cats.size >= 3) result.add(word);
  }
  return result;
}

// Compute fuzzy similarity (Dice coefficient on trigrams)
function diceSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const trigramsA = new Set<string>();
  const trigramsB = new Set<string>();
  for (let i = 0; i < a.length - 2; i++) trigramsA.add(a.slice(i, i + 3));
  for (let i = 0; i < b.length - 2; i++) trigramsB.add(b.slice(i, i + 3));
  let intersection = 0;
  for (const t of trigramsA) if (trigramsB.has(t)) intersection++;
  return (2 * intersection) / (trigramsA.size + trigramsB.size);
}

/**
 * Compute guess scores for all categories using a 4-tier point system:
 * Cat 1 = exact descriptor match (40 pts)
 * Cat 2 = match after stripping IDs/numbers (25 pts)
 * Cat 3 = fuzzy trigram match ≥ 0.6 similarity (10 pts)
 * Cat 4 = shared meaningful keywords (1 pt each)
 */
function computeGuessScores(descriptor: string, transactions: Transaction[]): Map<number, number> {
  const highSpread = buildHighSpreadWords(transactions);
  const isNoise = (w: string) => NOISE_WORDS.has(w) || highSpread.has(w);

  const norm = normalize(descriptor);
  const stripped = stripIds(descriptor);
  const words = stripped.split(/\s+/).filter((w) => w.length >= 3 && !isNoise(w));

  const scores = new Map<number, number>();
  const addScore = (catId: number | null, pts: number) => {
    if (catId == null) return;
    scores.set(catId, (scores.get(catId) ?? 0) + pts);
  };

  const archived = archivedCategoryIds();
  for (const t of transactions) {
    if (!usableForSuggestions(t, archived)) continue;
    const tNorm = normalize(t.descriptor);
    const tStripped = stripIds(t.descriptor);

    if (tNorm === norm) { addScore(t.categoryId, 40); continue; }
    if (tStripped === stripped && stripped.length > 2) { addScore(t.categoryId, 25); continue; }
    const sim = diceSimilarity(norm, tNorm);
    if (sim >= 0.6) { addScore(t.categoryId, 10); continue; }
    const tWords = tStripped.split(/\s+/).filter((w) => w.length >= 3 && !isNoise(w));
    const shared = words.filter((w) => tWords.includes(w)).length;
    if (shared > 0) addScore(t.categoryId, shared);
  }

  return scores;
}

/** Returns the best-match categoryId, or null if no match. */
export function guessCategory(descriptor: string, transactions: Transaction[]): number | null {
  const scores = computeGuessScores(descriptor, transactions);
  if (scores.size === 0) return null;
  const sorted = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  if (sorted.length >= 2 && sorted[0][1] < 2 * sorted[1][1]) return null;
  return sorted[0][0];
}

/** Returns the full score map (catId → points) for tooltip display. */
export function getGuessScores(descriptor: string, transactions: Transaction[]): Map<number, number> {
  return computeGuessScores(descriptor, transactions);
}

interface CorpusEntry {
  norm: string;
  stripped: string;
  words: string[];
  cats: Map<number, number>; // categoryId → how many corpus transactions share this descriptor
}

/**
 * Batch variant: preprocess the corpus once (grouped by unique descriptor), then score many
 * descriptors against it. Scores are identical to scoring each corpus transaction one by one:
 * every corpus row lands in exactly one tier, so identical descriptors just contribute `count` times.
 */
export function batchGetGuessScores(
  queries: { id: number; descriptor: string }[],
  transactions: Transaction[],
): Map<number, Map<number, number>> {
  const highSpread = buildHighSpreadWords(transactions);
  const isNoise = (w: string) => NOISE_WORDS.has(w) || highSpread.has(w);

  const archived = archivedCategoryIds();
  const unique = new Map<string, CorpusEntry>();
  for (const t of transactions) {
    if (!usableForSuggestions(t, archived) || t.categoryId == null) continue;
    const norm = normalize(t.descriptor);
    const stripped = stripIds(t.descriptor);
    const key = `${norm}\u0000${stripped}`;
    let e = unique.get(key);
    if (!e) {
      e = { norm, stripped, words: stripped.split(/\s+/).filter((w) => w.length >= 3 && !isNoise(w)), cats: new Map() };
      unique.set(key, e);
    }
    e.cats.set(t.categoryId, (e.cats.get(t.categoryId) ?? 0) + 1);
  }
  const corpus = [...unique.values()];
  const byNorm = new Map<string, CorpusEntry[]>();
  for (const e of corpus) {
    const arr = byNorm.get(e.norm);
    if (arr) arr.push(e); else byNorm.set(e.norm, [e]);
  }

  const memo = new Map<string, Map<number, number>>();
  const scoreOne = (descriptor: string): Map<number, number> => {
    const norm = normalize(descriptor);
    const stripped = stripIds(descriptor);
    const memoKey = `${norm}\u0000${stripped}`;
    const hit = memo.get(memoKey);
    if (hit) return hit;
    const words = stripped.split(/\s+/).filter((w) => w.length >= 3 && !isNoise(w));
    const scores = new Map<number, number>();
    const add = (catId: number, pts: number) => scores.set(catId, (scores.get(catId) ?? 0) + pts);

    const exactSet = new Set(byNorm.get(norm) ?? []);
    for (const e of exactSet) for (const [cat, n] of e.cats) add(cat, 40 * n);

    for (const e of corpus) {
      if (exactSet.has(e)) continue;
      if (e.stripped === stripped && stripped.length > 2) { for (const [cat, n] of e.cats) add(cat, 25 * n); continue; }
      if (diceSimilarity(norm, e.norm) >= 0.6) { for (const [cat, n] of e.cats) add(cat, 10 * n); continue; }
      let shared = 0;
      for (const w of words) if (e.words.includes(w)) shared++;
      if (shared > 0) for (const [cat, n] of e.cats) add(cat, shared * n);
    }
    memo.set(memoKey, scores);
    return scores;
  };

  const result = new Map<number, Map<number, number>>();
  for (const { id, descriptor } of queries) {
    const scores = scoreOne(descriptor);
    if (scores.size > 0) result.set(id, scores);
  }
  return result;
}

export interface SplitAction {
  txnIndex: number;
  splits: Array<{ categoryId: number; amount: number }>;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Turn rule split items into concrete amounts. Each amount is rounded to cents, and any
 * remainder (stray cents from percentages, or fixed-dollar splits applied to a transaction of a
 * different amount) goes to the LAST split so the parts always sum to the transaction.
 */
export function resolveSplits(items: SplitRuleItem[], txnAmount: number): Array<{ categoryId: number; amount: number }> {
  const out = items.map((s) => ({
    categoryId: s.categoryId,
    amount: round2(s.percent != null ? txnAmount * s.percent / 100 : (s.amount ?? 0)),
  }));
  if (out.length === 0) return out;
  const diff = round2(txnAmount - out.reduce((sum, x) => sum + x.amount, 0));
  if (Math.abs(diff) >= 0.005) out[out.length - 1].amount = round2(out[out.length - 1].amount + diff);
  return out;
}

function splitTxnIds(): Set<number> {
  return new Set(getData().transactionSplits.map((s) => s.transactionId));
}

export function categorizeTransactionsInPlace(txns: Omit<Transaction, 'id'>[]): SplitAction[] {
  const { categoryRules } = getData();
  const splitActions: SplitAction[] = [];

  for (let i = 0; i < txns.length; i++) {
    const txn = txns[i];
    if (txn.categoryId || txn.isTransfer) continue;
    const norm = normalize(txn.descriptor);
    const amountMatch = (r: CategoryRule) =>
      r.amountMatch == null || Math.abs((r.amountMatch ?? 0) - txn.amount) < 0.01;

    // Apply rules in order — last match wins
    let lastMatch: CategoryRule | undefined;
    for (const r of categoryRules) {
      const descMatch = r.matchType === 'exact'
        ? normalize(r.pattern) === norm
        : norm.includes(normalize(r.pattern));
      if (descMatch && amountMatch(r)) lastMatch = r;
    }
    if (!lastMatch) continue;

    if (lastMatch.markTransfer) {
      txn.isTransfer = true;
      continue;
    }
    if (lastMatch.splits && lastMatch.splits.length >= 2) {
      splitActions.push({ txnIndex: i, splits: resolveSplits(lastMatch.splits, txn.amount) });
    } else {
      txn.categoryId = lastMatch.categoryId;
    }
  }

  return splitActions;
}

export async function recategorizeAll(): Promise<number> {
  return withUndo('Re-run category rules', async () => {
    const { transactions, categoryRules } = getData();
    const hasSplits = splitTxnIds();

    let count = 0;
    const splitEntries: { transactionId: number; splits: Array<{ categoryId: number; amount: number }> }[] = [];
    const amountMatch = (r: CategoryRule, txn: Transaction) =>
      r.amountMatch == null || Math.abs((r.amountMatch ?? 0) - txn.amount) < 0.01;
    for (const txn of transactions) {
      if (txn.categoryId !== null || txn.isTransfer || hasSplits.has(txn.id)) continue;
      const norm = normalize(txn.descriptor);
      // Last rule wins
      let matched: CategoryRule | undefined;
      for (const r of categoryRules) {
        const descMatch = r.matchType === 'exact'
          ? normalize(r.pattern) === norm
          : norm.includes(normalize(r.pattern));
        if (descMatch && amountMatch(r, txn)) matched = r;
      }
      if (matched) {
        if (matched.markTransfer) {
          txn.isTransfer = true;
        } else if (matched.splits && matched.splits.length >= 2) {
          splitEntries.push({ transactionId: txn.id, splits: resolveSplits(matched.splits, txn.amount) });
        } else {
          txn.categoryId = matched.categoryId;
        }
        count++;
      }
    }
    if (splitEntries.length > 0) await setSplitsBulk(splitEntries);
    if (count > 0) await persistData();
    return count;
  });
}

export async function bulkCategorizeByDescriptor(
  pattern: string,
  categoryId: number,
  matchType: 'exact' | 'contains',
  amount?: number | null,
): Promise<number> {
  return withUndo('Categorize by descriptor', async () => {
    const { transactions } = getData();
    const norm = normalize(pattern);
    let count = 0;
    for (const txn of transactions) {
      const txnNorm = normalize(txn.descriptor);
      const descMatch = matchType === 'exact' ? txnNorm === norm : txnNorm.includes(norm);
      const amountOk = amount == null || Math.abs(amount - txn.amount) < 0.01;
      const isMatch = descMatch && amountOk;
      if (isMatch) {
        txn.categoryId = categoryId;
        count++;
      }
    }
    if (count > 0) await persistData();
    return count;
  });
}

export async function bulkMarkTransferByDescriptor(
  pattern: string,
  matchType: 'exact' | 'contains',
  amount?: number | null,
): Promise<number> {
  return withUndo('Mark as transfer', async () => {
    const { transactions } = getData();
    const norm = normalize(pattern);
    let count = 0;
    for (const txn of transactions) {
      const txnNorm = normalize(txn.descriptor);
      const descMatch = matchType === 'exact' ? txnNorm === norm : txnNorm.includes(norm);
      const amountOk = amount == null || Math.abs(amount - txn.amount) < 0.01;
      if (descMatch && amountOk && !txn.isTransfer) { txn.isTransfer = true; count++; }
    }
    if (count > 0) await persistData();
    return count;
  });
}

export async function bulkApplySplitRule(
  pattern: string,
  matchType: 'exact' | 'contains',
  amount: number | null,
  splits: SplitRuleItem[],
): Promise<number> {
  return withUndo('Apply split rule', async () => {
    const { transactions } = getData();
    const norm = normalize(pattern);
    const entries: { transactionId: number; splits: Array<{ categoryId: number; amount: number }> }[] = [];
    for (const txn of transactions) {
      const txnNorm = normalize(txn.descriptor);
      const descMatch = matchType === 'exact' ? txnNorm === norm : txnNorm.includes(norm);
      const amountOk = amount == null || Math.abs(amount - txn.amount) < 0.01;
      if (!descMatch || !amountOk) continue;
      entries.push({ transactionId: txn.id, splits: resolveSplits(splits, txn.amount) });
    }
    await setSplitsBulk(entries);
    return entries.length;
  });
}

export async function runRuleOnHistory(opts: RunRuleOptions): Promise<number> {
  return withUndo('Run rule on history', async () => {
    const { transactions, categoryRules } = getData();
    const rule = categoryRules.find((r) => r.id === opts.ruleId);
    if (!rule) return 0;
    const hasSplits = splitTxnIds();

    const norm = normalize(rule.pattern);
    const amountMatch = (txn: Transaction) =>
      rule.amountMatch == null || Math.abs((rule.amountMatch ?? 0) - txn.amount) < 0.01;

    let count = 0;
    const splitEntries: { transactionId: number; splits: Array<{ categoryId: number; amount: number }> }[] = [];
    for (const txn of transactions) {
      if (!opts.includeAlreadyCategorized && (txn.categoryId !== null || txn.isTransfer || hasSplits.has(txn.id))) continue;
      if (opts.startDate && txn.txnDate < opts.startDate) continue;
      if (opts.endDate && txn.txnDate > opts.endDate) continue;

      const txnNorm = normalize(txn.descriptor);
      const descMatch = rule.matchType === 'exact' ? txnNorm === norm : txnNorm.includes(norm);
      if (!descMatch || !amountMatch(txn)) continue;

      if (rule.markTransfer) {
        txn.isTransfer = true;
      } else if (rule.splits && rule.splits.length >= 2) {
        splitEntries.push({ transactionId: txn.id, splits: resolveSplits(rule.splits, txn.amount) });
      } else {
        txn.categoryId = rule.categoryId;
      }
      count++;
    }
    if (splitEntries.length > 0) await setSplitsBulk(splitEntries);
    if (count > 0) await persistData();
    return count;
  });
}

export async function createRuleAndApply(
  pattern: string,
  categoryId: number,
  matchType: 'exact' | 'contains',
  amount?: number | null,
): Promise<number> {
  return withUndo('Create rule', async () => {
    await addCategoryRule({ matchType, pattern: pattern.toLowerCase(), categoryId, amountMatch: amount ?? null });
    return bulkCategorizeByDescriptor(pattern, categoryId, matchType, amount);
  });
}
