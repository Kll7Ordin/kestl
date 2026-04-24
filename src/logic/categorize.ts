import { getData, addCategoryRule, persistData, setSplits, type Transaction, type CategoryRule, type SplitRuleItem } from '../db';

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
  // Geographic noise
  'bc','ab','on','qc','mb','sk','ns','nb','nl','pe','nt','yt','nu',
  'canada','canadian','inc','ltd','llc','co','corp','company',
]);

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
  const norm = normalize(descriptor);
  const stripped = stripIds(descriptor);
  const words = stripped.split(/\s+/).filter((w) => w.length >= 3 && !NOISE_WORDS.has(w));

  const scores = new Map<number, number>();
  const addScore = (catId: number | null, pts: number) => {
    if (catId == null) return;
    scores.set(catId, (scores.get(catId) ?? 0) + pts);
  };

  for (const t of transactions) {
    if (t.categoryId == null || t.ignoreInBudget) continue;
    const tNorm = normalize(t.descriptor);
    const tStripped = stripIds(t.descriptor);

    if (tNorm === norm) { addScore(t.categoryId, 40); continue; }
    if (tStripped === stripped && stripped.length > 2) { addScore(t.categoryId, 25); continue; }
    const sim = diceSimilarity(norm, tNorm);
    if (sim >= 0.6) { addScore(t.categoryId, 10); continue; }
    const tWords = tStripped.split(/\s+/).filter((w) => w.length >= 3 && !NOISE_WORDS.has(w));
    const shared = words.filter((w) => tWords.includes(w)).length;
    if (shared > 0) addScore(t.categoryId, shared);
  }

  return scores;
}

/** Returns the best-match categoryId, or null if no match. */
export function guessCategory(descriptor: string, transactions: Transaction[]): number | null {
  const scores = computeGuessScores(descriptor, transactions);
  if (scores.size === 0) return null;
  return [...scores.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

/** Returns the full score map (catId → points) for tooltip display. */
export function getGuessScores(descriptor: string, transactions: Transaction[]): Map<number, number> {
  return computeGuessScores(descriptor, transactions);
}

interface CorpusEntry {
  categoryId: number;
  norm: string;
  stripped: string;
  words: string[];
}

/**
 * Batch variant: preprocess the corpus once, then score multiple descriptors against it.
 * Use this when computing suggestions for many transactions at once to avoid redundant
 * normalize/stripIds work on the corpus for every query descriptor.
 */
export function batchGetGuessScores(
  queries: { id: number; descriptor: string }[],
  transactions: Transaction[],
): Map<number, Map<number, number>> {
  const corpus: CorpusEntry[] = [];
  for (const t of transactions) {
    if (t.categoryId == null || t.ignoreInBudget) continue;
    const stripped = stripIds(t.descriptor);
    corpus.push({
      categoryId: t.categoryId,
      norm: normalize(t.descriptor),
      stripped,
      words: stripped.split(/\s+/).filter((w) => w.length >= 3 && !NOISE_WORDS.has(w)),
    });
  }

  const result = new Map<number, Map<number, number>>();
  for (const { id, descriptor } of queries) {
    const norm = normalize(descriptor);
    const stripped = stripIds(descriptor);
    const words = stripped.split(/\s+/).filter((w) => w.length >= 3 && !NOISE_WORDS.has(w));
    const scores = new Map<number, number>();
    for (const c of corpus) {
      const add = (pts: number) => scores.set(c.categoryId, (scores.get(c.categoryId) ?? 0) + pts);
      if (c.norm === norm) { add(40); continue; }
      if (c.stripped === stripped && stripped.length > 2) { add(25); continue; }
      const sim = diceSimilarity(norm, c.norm);
      if (sim >= 0.6) { add(10); continue; }
      const shared = words.filter((w) => c.words.includes(w)).length;
      if (shared > 0) add(shared);
    }
    if (scores.size > 0) result.set(id, scores);
  }
  return result;
}

export interface SplitAction {
  txnIndex: number;
  splits: Array<{ categoryId: number; amount: number }>;
}

function resolveSplits(items: SplitRuleItem[], txnAmount: number): Array<{ categoryId: number; amount: number }> {
  return items.map((s) => ({
    categoryId: s.categoryId,
    amount: s.percent != null ? txnAmount * s.percent / 100 : (s.amount ?? 0),
  }));
}

export function categorizeTransactionsInPlace(txns: Omit<Transaction, 'id'>[]): SplitAction[] {
  const { categoryRules } = getData();
  const splitActions: SplitAction[] = [];

  for (let i = 0; i < txns.length; i++) {
    const txn = txns[i];
    if (txn.categoryId) continue;
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

    if (lastMatch.splits && lastMatch.splits.length >= 2) {
      splitActions.push({ txnIndex: i, splits: resolveSplits(lastMatch.splits, txn.amount) });
    } else {
      txn.categoryId = lastMatch.categoryId;
    }
  }

  return splitActions;
}

export async function recategorizeAll(): Promise<number> {
  const { transactions, categoryRules } = getData();

  let count = 0;
  const amountMatch = (r: CategoryRule, txn: Transaction) =>
    r.amountMatch == null || Math.abs((r.amountMatch ?? 0) - txn.amount) < 0.01;
  for (const txn of transactions) {
    if (txn.categoryId !== null) continue;
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
      if (!matched.splits || matched.splits.length < 2) {
        txn.categoryId = matched.categoryId;
      }
      count++;
    }
  }
  if (count > 0) await persistData();
  return count;
}

export async function bulkCategorizeByDescriptor(
  pattern: string,
  categoryId: number,
  matchType: 'exact' | 'contains',
  amount?: number | null,
): Promise<number> {
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
}

export async function bulkApplySplitRule(
  pattern: string,
  matchType: 'exact' | 'contains',
  amount: number | null,
  splits: SplitRuleItem[],
): Promise<number> {
  const { transactions } = getData();
  const norm = normalize(pattern);
  let count = 0;
  for (const txn of transactions) {
    const txnNorm = normalize(txn.descriptor);
    const descMatch = matchType === 'exact' ? txnNorm === norm : txnNorm.includes(norm);
    const amountOk = amount == null || Math.abs(amount - txn.amount) < 0.01;
    if (!descMatch || !amountOk) continue;
    const resolved = resolveSplits(splits, txn.amount);
    await setSplits(txn.id, resolved.map((s) => ({ categoryId: s.categoryId, amount: s.amount })));
    count++;
  }
  return count;
}

export async function runRuleOnHistory(opts: RunRuleOptions): Promise<number> {
  const { transactions, categoryRules } = getData();
  const rule = categoryRules.find((r) => r.id === opts.ruleId);
  if (!rule) return 0;

  const norm = normalize(rule.pattern);
  const amountMatch = (txn: Transaction) =>
    rule.amountMatch == null || Math.abs((rule.amountMatch ?? 0) - txn.amount) < 0.01;

  let count = 0;
  for (const txn of transactions) {
    if (!opts.includeAlreadyCategorized && txn.categoryId !== null) continue;
    if (opts.startDate && txn.txnDate < opts.startDate) continue;
    if (opts.endDate && txn.txnDate > opts.endDate) continue;

    const txnNorm = normalize(txn.descriptor);
    const descMatch = rule.matchType === 'exact' ? txnNorm === norm : txnNorm.includes(norm);
    if (!descMatch || !amountMatch(txn)) continue;

    if (rule.splits && rule.splits.length >= 2) {
      const resolved = resolveSplits(rule.splits, txn.amount);
      await setSplits(txn.id, resolved);
    } else {
      txn.categoryId = rule.categoryId;
    }
    count++;
  }
  if (count > 0) await persistData();
  return count;
}

export async function createRuleAndApply(
  pattern: string,
  categoryId: number,
  matchType: 'exact' | 'contains',
  amount?: number | null,
): Promise<number> {
  await addCategoryRule({ matchType, pattern: pattern.toLowerCase(), categoryId, amountMatch: amount ?? null });
  return bulkCategorizeByDescriptor(pattern, categoryId, matchType, amount);
}
