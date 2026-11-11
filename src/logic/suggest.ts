/**
 * History-based category suggestions.
 *
 * Each descriptor is reduced to a merchant name (city/province, processor prefixes, store numbers and
 * reference codes removed), then every categorized past purchase votes for its category, weighted by:
 *   - how similar its merchant is (same merchant ≫ same name prefix ≫ similar spelling ≫ shared rare words)
 *   - how recent it is (habits change: the latest choice for a merchant counts most)
 *   - whether the amount matches (same merchant + same amount ≈ the same recurring thing, e.g. a $501
 *     e-transfer is daycare, a $3 one is an allowance). Same-amount payments made about monthly count
 *     even more. For bank transfers, which name no merchant, the amount is most of the evidence: past
 *     transfers for other amounts count for little.
 * A suggestion is made only when one category clearly wins and there is enough evidence behind it.
 */
import type { Transaction } from '../db';
import { isCredit } from './txnKind';
import { formatAmount } from '../utils/format';

// ── Merchant extraction ───────────────────────────────────────────────────────

/** Payment processors / aggregators that prefix the real merchant name ("sq *kizuna ramen", "sp penna co"). */
const PROCESSOR_PREFIX = /^(?:sp|sq|tst|act|bam|pp|ppl|dd|ckt|pg|iz|sumup|zettle|fs|pnp|py|clv|lsp|wpy|paypal|google|apple\.com\/bill)\s*\*\s*|^(?:sp|sq|tst)\s+/;

/** Chequing transaction-type phrases. For these the Title Case tail is the payee, not a city. */
const BANK_TYPE = /^(?:withdrawal|deposit|customer transfer (?:dr|cr)\.?|bill payment|investment|mortgage|loans?|insurance|transfer|payroll(?: dep(?:osit)?)?|service charge|interest|atm|misc(?:ellaneous)? payment|pre-?authori[sz]ed|e-?transfer|shared abm|abm)\b/i;

const PROVINCES = new Set(['bc', 'ab', 'sk', 'mb', 'on', 'qc', 'nb', 'ns', 'pe', 'nl', 'yt', 'nt', 'nu',
  'wa', 'ca', 'ny', 'nj', 'tx', 'fl', 'il', 'nv', 'az', 'mn']); // not co/or/de/ma: usually part of a name

const STOP = new Set(['the', 'and', 'of', 'a', 'an', 'for', 'to', 'at', 'in', 'on', 'by', 'with', 'from', 'inc', 'ltd',
  'llc', 'corp', 'co', 'canada', 'ca', 'com', 'www', 'online', 'store', 'purchase', 'payment', 'pos', 'free', 'de']);

/** Bank transfers/payments whose descriptor names no merchant ("withdrawal Free Interac E-Transfer"). */
export function isBankTransferDescriptor(descriptor: string): boolean {
  return BANK_TYPE.test(descriptor.trim()) && !/^pos\b/i.test(descriptor.trim());
}

export interface ParsedDescriptor {
  /** Merchant name as space-separated lowercase words ("red barn vanalman"). */
  key: string;
  /** key with spaces removed, for prefix matching across spacing changes ("oldnavy" vs "old navy"). */
  compact: string;
  /** Meaningful words (merchant words, or the product title for marketplace orders). */
  words: string[];
  /** A marketplace product title rather than a merchant name: matched by words only. */
  product: boolean;
}

function cleanWords(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/\*[a-z0-9-]*\d[a-z0-9-]*/g, ' ')        // "*gu1z48f23" reference codes
    .replace(/#\s*[\w-]*\d[\w-]*/g, ' ')               // "#9457", "#701-4740559-..."
    .replace(/[^a-z0-9&'+]+/g, ' ')
    .split(' ')
    .map((w) => w.replace(/^'+|'+$/g, ''))
    .filter((w) => w && (/^acct\d{4}$/.test(w) || (!/\d{3,}/.test(w) && !/^\d+$/.test(w))));
}

/** Drop the Title Case "City Prov" tail Scotia appends to card descriptors ("thrifty foods Victoria Bc"). */
function stripLocationTail(raw: string): string {
  const tokens = raw.trim().split(/\s+/);
  let end = tokens.length;
  while (end > 1) {
    const t = tokens[end - 1];
    // Scotia writes the location in Title Case ("Victoria", "Bc", "Amzn.Com/Billnj"); ALL-CAPS words
    // ("RRSP") belong to the name.
    const startsUpper = /^[A-Z][a-z.]/.test(t) || /^[A-Z]$/.test(t);
    const isPhoneOrNum = /^[\d()+-]{7,}$/.test(t);
    if (!startsUpper && !isPhoneOrNum) break;
    end--;
  }
  // Everything Title Case (a manual entry like "James RRSP"): nothing lowercase to call a merchant.
  if (/^[A-Z]/.test(tokens[0])) return raw;
  return tokens.slice(0, end).join(' ');
}

export function parseDescriptor(descriptor: string): ParsedDescriptor {
  let s = descriptor.trim();

  const segments = s.split('|').map((x) => x.trim());
  if (segments.length >= 2 && /^(amazon|paypal)$/i.test(segments[0])) {
    // "Amazon | <product title> | #order" — the product title is what predicts the category.
    // "PayPal | <merchant> | Payment | Order Number..." — the merchant segment.
    const isAmazon = /^amazon$/i.test(segments[0]);
    const body = cleanWords(segments[1]).filter((w) => !STOP.has(w));
    if (isAmazon) {
      const key = `amazon: ${body.join(' ')}`;
      return { key, compact: key.replace(/ /g, ''), words: body.filter((w) => w.length >= 3).slice(0, 14), product: true };
    }
    const key = body.join(' ');
    return { key, compact: key.replace(/ /g, ''), words: body, product: false };
  }

  // Chequing debit-card purchases: "pos purchase Gpos Red Barn Vanalm     Victo" — a 20-character
  // merchant field, then a truncated city.
  const pos = s.match(/^(?:pos purchase|pos return|correction)\s+(?:[a-z]pos\s+)?(.*)$/i);
  if (pos) {
    s = pos[1].length > 20 ? pos[1].slice(0, 20) : pos[1];
  } else if (!BANK_TYPE.test(s)) {
    s = stripLocationTail(s);
  }

  let low = s.toLowerCase().trim();
  // Account numbers (12+ digits) identify where a transfer went: keep the last 4 as a word.
  // Shorter numbers (confirmation codes, phone numbers) change every time and are dropped below.
  low = low.replace(/\b\d{8,}(\d{4})\b/g, (_m, last4: string) => `acct${last4}`);
  for (let i = 0; i < 2; i++) low = low.replace(PROCESSOR_PREFIX, '').trim();
  const words = cleanWords(low);
  // A trailing province code that survived (lowercase descriptors from other parsers).
  while (words.length > 1 && PROVINCES.has(words[words.length - 1])) words.pop();
  const key = words.join(' ');
  return { key, compact: key.replace(/ /g, ''), words: words.filter((w) => w.length >= 2 && !STOP.has(w)), product: false };
}

// ── Similarity ────────────────────────────────────────────────────────────────

function trigrams(s: string): Set<string> {
  const out = new Set<string>();
  const p = ` ${s} `;
  for (let i = 0; i < p.length - 2; i++) out.add(p.slice(i, i + 3));
  return out;
}

interface Merchant {
  parsed: ParsedDescriptor;
  tri: Set<string>;
  /** History rows with this merchant key. */
  rows: { categoryId: number; amount: number; dateMs: number }[];
}

const DAY_MS = 86_400_000;

export interface SuggestOptions {
  /** Minimum winning share of the vote (0–1). */
  minShare?: number;
  /** Minimum absolute evidence for the winner. */
  minEvidence?: number;
  /**
   * Merchant key → kind of business ("restaurant", "museum, zoo or attraction"), labelled by the local
   * model (aiSuggest.ts). Lets a first-time merchant inherit how this household files that kind of
   * business. Optional: without it, suggestions come from merchant names alone.
   */
  merchantTypes?: Record<string, string>;
}

export interface CategoryGuess {
  categoryId: number;
  /** Winning share of the weighted vote, 0–1. */
  confidence: number;
  /** All category scores (catId → weight), for tooltips. */
  scores: Map<number, number>;
  /** The strongest piece of evidence, e.g. `same merchant ×4` or `like other restaurants`. */
  reason: string;
  /** Which evidence decided it: similar merchant names, or how this kind of business is usually filed. */
  tier: 'name' | 'type';
  /** A close runner-up with compelling evidence of its own (no category dominates): shown as a second chip. */
  second?: { categoryId: number; confidence: number };
}

/** One past merchant that counted towards a suggestion. */
export interface MatchEvidence {
  /** Merchant key of the past purchases. */
  merchant: string;
  /** How it matched: `same merchant`, `similar name`, `same first word`, `shared words`, `same product`. */
  kind: string;
  /** 0–1. */
  similarity: number;
  purchases: number;
  categories: { categoryId: number; count: number }[];
  /** Newest purchase, YYYY-MM-DD ('' if unknown). */
  lastDate: string;
  /** Purchases for exactly this amount (only counted for close matches, where amount matters). */
  sameAmount: number;
  /** The same-amount purchases recur about monthly in one category. */
  monthly: boolean;
}

/** Past purchases for exactly this amount, across all close matches. */
export interface SameAmountEvidence {
  count: number;
  categories: { categoryId: number; count: number }[];
  /** Category whose same-amount purchases recur about monthly, if any. */
  monthlyCategoryId: number | null;
  /** Newest same-amount purchase, YYYY-MM-DD ('' if none). */
  lastDate: string;
}

export interface CategoryShare {
  categoryId: number;
  weight: number;
  /** 0–1 share of the total. */
  share: number;
}

export type MerchantTypeStatus = 'labelled' | 'unknown' | 'vague' | 'unlabelled' | 'not applicable';

/** Everything the suggester looked at for one transaction, including why it made no guess. */
export interface SuggestTrace {
  /** Merchant name as extracted from the descriptor ('' if none). */
  merchant: string;
  /** A marketplace product title rather than a merchant. */
  product: boolean;
  /** A bank transfer/payment with no merchant name. */
  bankTransfer: boolean;
  merchantType: string | null;
  merchantTypeStatus: MerchantTypeStatus;
  /** Past merchants that matched, strongest first (at most 8). */
  matches: MatchEvidence[];
  /** Close matches for exactly this amount. */
  sameAmount: SameAmountEvidence;
  /** Weighted vote from matching merchant names. */
  nameScores: CategoryShare[];
  /** How past merchants of the same kind were filed (empty without a usable type). */
  typeScores: CategoryShare[];
  /** Other merchants of the same kind with categorized purchases. */
  typePeers: number;
  guess: CategoryGuess | null;
  /** Plain-language steps: what was found, and why a guess was or wasn't made. */
  notes: string[];
}

/** Types too vague to learn from. */
const VAGUE_TYPES = new Set(['unknown', 'other', 'department store', 'bank or financial']);

/** Two-chip rule: neither category dominates, but together they own the vote and each has real evidence. */
const PAIR_MIN_SECOND_SHARE = 0.25;
const PAIR_MIN_COMBINED = 0.8;

const MIN_TYPE_PEERS = 3;
const MIN_TYPE_SHARE = 0.65;
const MIN_TYPE_EVIDENCE = 2;

function toShares(scores: Map<number, number>): CategoryShare[] {
  let total = 0;
  for (const s of scores.values()) total += s;
  return [...scores.entries()]
    .map(([categoryId, weight]) => ({ categoryId, weight, share: total > 0 ? weight / total : 0 }))
    .sort((a, b) => b.weight - a.weight);
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const isoDate = (ms: number) => (ms > 0 ? new Date(ms).toISOString().slice(0, 10) : '');

/** Vote weights for one past purchase of a close match, by how its amount compares. */
const AMT_SAME = 4;
const AMT_SAME_MONTHLY = 8;
const AMT_NEAR = 1.6;
/** A bank transfer for a different amount is most likely a different thing. */
const TRANSFER_AMT_OTHER = 0.2;

/** At least three dates, mostly about a month apart. */
export function isMonthly(datesMs: number[]): boolean {
  const d = [...new Set(datesMs.filter((x) => x > 0))].sort((a, b) => a - b);
  if (d.length < 3) return false;
  let monthly = 0;
  for (let i = 1; i < d.length; i++) {
    const gap = (d[i] - d[i - 1]) / DAY_MS;
    if (gap >= 25 && gap <= 36) monthly++;
  }
  return monthly >= 2 && monthly / (d.length - 1) >= 0.6;
}

/**
 * Build a reusable suggester over a corpus of categorized transactions. Use `corpusFilter` upstream to
 * exclude credits/transfers/archived categories.
 */
export function buildSuggester(corpus: Pick<Transaction, 'descriptor' | 'categoryId' | 'amount' | 'txnDate'>[], opts: SuggestOptions = {}) {
  const minShare = opts.minShare ?? 0.6;
  const minEvidence = opts.minEvidence ?? 0.3;
  const types = opts.merchantTypes ?? {};

  const byKey = new Map<string, Merchant>();
  let latestMs = 0;
  for (const t of corpus) {
    if (t.categoryId == null) continue;
    const parsed = parseDescriptor(t.descriptor);
    if (!parsed.key) continue;
    let m = byKey.get(parsed.key);
    if (!m) { m = { parsed, tri: trigrams(parsed.compact), rows: [] }; byKey.set(parsed.key, m); }
    const dateMs = Date.parse(t.txnDate) || 0;
    latestMs = Math.max(latestMs, dateMs);
    m.rows.push({ categoryId: t.categoryId, amount: t.amount, dateMs });
  }
  const merchants = [...byKey.values()];

  // Word rarity: in how many merchants (not rows) and categories a word appears. Words spread over
  // many categories ("saanich", "interac", "victoria") say little about which one this is.
  const wordMerchants = new Map<string, number>();
  const wordCats = new Map<string, Set<number>>();
  const byWord = new Map<string, number[]>();
  const byTri = new Map<string, number[]>();
  merchants.forEach((m, i) => {
    for (const w of new Set(m.parsed.words)) {
      wordMerchants.set(w, (wordMerchants.get(w) ?? 0) + 1);
      let cs = wordCats.get(w);
      if (!cs) { cs = new Set(); wordCats.set(w, cs); }
      for (const r of m.rows) cs.add(r.categoryId);
      const arr = byWord.get(w); if (arr) arr.push(i); else byWord.set(w, [i]);
    }
    for (const g of m.tri) { const arr = byTri.get(g); if (arr) arr.push(i); else byTri.set(g, [i]); }
  });
  // Merchants grouped by labelled kind of business, for the fallback tier.
  const byType = new Map<string, Merchant[]>();
  for (const m of merchants) {
    const t = types[m.parsed.key];
    if (!t || VAGUE_TYPES.has(t)) continue;
    const arr = byType.get(t); if (arr) arr.push(m); else byType.set(t, [m]);
  }

  const N = Math.max(merchants.length, 1);
  const idf = (w: string) => {
    const df = wordMerchants.get(w) ?? 0;
    const spread = wordCats.get(w)?.size ?? 0;
    return Math.log(1 + N / (1 + df)) / (spread >= 3 ? 3 : 1);
  };

  function similarity(q: ParsedDescriptor, qTri: Set<string>, m: Merchant, inter: number): { sim: number; kind: string } {
    const a = q.compact, b = m.parsed.compact;
    if (a === b) return { sim: 1, kind: q.product ? 'same product' : 'same merchant' };
    if (q.product !== m.parsed.product) return { sim: 0, kind: '' };
    if (q.product) return sharedWords(q, m);
    // Truncated or extended name: "redbarnvanalm" vs "redbarnvanalman", "koodomobile" vs "koodomobilestream".
    const shorter = a.length <= b.length ? a : b;
    if (shorter.length >= 6 && (a.startsWith(b) || b.startsWith(a))) return { sim: 0.85, kind: 'same merchant' };
    const dice = (2 * inter) / (qTri.size + m.tri.size);
    if (dice >= 0.7) return { sim: dice * 0.8, kind: 'similar name' };
    // Same distinctive first word ("bcf coastal renaissance" / "bcf online sales"); words used across
    // several categories ("saanich", "the") don't count.
    const fa = q.words[0], fb = m.parsed.words[0];
    if (fa && fa === fb && fa.length >= 3 && (wordCats.get(fa)?.size ?? 0) <= 2 && (q.key.startsWith(fa) && m.parsed.key.startsWith(fb))) {
      return { sim: 0.45, kind: 'same first word' };
    }
    return sharedWords(q, m);
  }

  function sharedWords(q: ParsedDescriptor, m: Merchant): { sim: number; kind: string } {
    // Shared rare words, weighted by rarity, relative to both sides (so one shared word in a long
    // product title counts for less than a shared merchant name).
    if (q.words.length && m.parsed.words.length) {
      const mw = new Set(m.parsed.words);
      let shared = 0, qTot = 0, mTot = 0;
      for (const w of new Set(q.words)) { const x = idf(w); qTot += x; if (mw.has(w)) shared += x; }
      for (const w of mw) mTot += idf(w);
      if (shared > 0 && qTot > 0 && mTot > 0) {
        const overlap = Math.sqrt((shared / qTot) * (shared / mTot));
        if (overlap >= 0.35) return { sim: overlap * 0.55, kind: 'shared words' };
      }
    }
    return { sim: 0, kind: '' };
  }

  const inter = new Uint16Array(merchants.length);
  const seen = new Uint8Array(merchants.length);

  /** Name-matching tier. With `trace`, also records every match and the vote. */
  function byName(q: ParsedDescriptor, amount: number, refMs: number, transfer: boolean, trace?: SuggestTrace): { scores: Map<number, number>; best: { sim: number; kind: string; n: number } } {
    const qTri = trigrams(q.compact);
    const same = trace?.sameAmount;
    const sameCats = new Map<number, number>();
    const sameDates = new Map<number, number[]>();
    let sameLast = 0;
    const touched: number[] = [];
    const touch = (i: number) => { if (!seen[i]) { seen[i] = 1; touched.push(i); } };
    for (const g of qTri) for (const i of byTri.get(g) ?? []) { inter[i]++; touch(i); }
    for (const w of q.words) for (const i of byWord.get(w) ?? []) touch(i);

    const scores = new Map<number, number>();
    let best = { sim: 0, kind: '', n: 0 };
    for (const i of touched) {
      const m = merchants[i];
      const { sim, kind } = similarity(q, qTri, m, inter[i]);
      inter[i] = 0; seen[i] = 0;
      if (sim <= 0) continue;
      if (sim > best.sim) best = { sim, kind, n: m.rows.length };
      // Within one merchant, each row votes; the vote total for a merchant is damped (sqrt) so a
      // merchant seen 40 times doesn't drown out a closer match seen twice.
      const raw = new Map<number, number>();
      const close = sim >= 0.85;
      const isSame = (r: Merchant['rows'][number]) => Math.abs(r.amount - amount) < 0.01;
      // Same-amount purchases that recur about monthly in one category are a standing payment.
      const monthlyCats = new Set<number>();
      let sameAmount = 0;
      if (close) {
        const datesByCat = new Map<number, number[]>();
        for (const r of m.rows) {
          if (!isSame(r)) continue;
          sameAmount++;
          const arr = datesByCat.get(r.categoryId); if (arr) arr.push(r.dateMs); else datesByCat.set(r.categoryId, [r.dateMs]);
          sameCats.set(r.categoryId, (sameCats.get(r.categoryId) ?? 0) + 1);
          sameLast = Math.max(sameLast, r.dateMs);
        }
        for (const [cat, dates] of datesByCat) {
          if (isMonthly(dates)) monthlyCats.add(cat);
          const all = sameDates.get(cat); if (all) all.push(...dates); else sameDates.set(cat, [...dates]);
        }
      }
      const near = (r: Merchant['rows'][number]) => Math.abs(r.amount - amount) <= Math.max(1, Math.abs(amount) * 0.05);
      // Only when some transfer matches the amount: otherwise all of them are equally (un)likely.
      const otherAmt = transfer && close && m.rows.some(near) ? TRANSFER_AMT_OTHER : 1;
      for (const r of m.rows) {
        const ageDays = Math.abs(refMs - r.dateMs) / DAY_MS; // distance in either direction
        const recency = 0.25 + 0.75 * Math.pow(0.5, ageDays / 240);
        let amt = 1;
        if (close) {
          if (isSame(r)) amt = monthlyCats.has(r.categoryId) ? AMT_SAME_MONTHLY : AMT_SAME;
          else if (near(r)) amt = AMT_NEAR;
          else amt = otherAmt;
        }
        raw.set(r.categoryId, (raw.get(r.categoryId) ?? 0) + recency * amt);
      }
      const damp = Math.max(Math.sqrt(m.rows.length) / m.rows.length, 0.15);
      for (const [cat, w] of raw) scores.set(cat, (scores.get(cat) ?? 0) + sim * w * damp);
      if (trace) {
        const counts = new Map<number, number>();
        for (const r of m.rows) counts.set(r.categoryId, (counts.get(r.categoryId) ?? 0) + 1);
        const last = Math.max(...m.rows.map((r) => r.dateMs));
        trace.matches.push({
          merchant: m.parsed.key,
          kind,
          similarity: sim,
          purchases: m.rows.length,
          categories: [...counts.entries()].map(([categoryId, count]) => ({ categoryId, count })).sort((a, b) => b.count - a.count),
          lastDate: isoDate(last),
          sameAmount,
          monthly: monthlyCats.size > 0,
        });
      }
    }
    if (same) {
      same.count = [...sameCats.values()].reduce((a, b) => a + b, 0);
      same.categories = [...sameCats.entries()].map(([categoryId, count]) => ({ categoryId, count })).sort((a, b) => b.count - a.count);
      same.lastDate = isoDate(sameLast);
      // Across merchant spellings too: the biggest monthly series wins.
      const monthly = [...sameDates.entries()].filter(([, d]) => isMonthly(d)).sort((a, b) => b[1].length - a[1].length);
      same.monthlyCategoryId = monthly[0]?.[0] ?? null;
    }
    return { scores, best };
  }

  /**
   * How this household files merchants of one kind. Each merchant gets one (recency-weighted) vote
   * split across its categories, so one busy store doesn't decide for its type.
   */
  function typeVote(type: string, excludeKey: string, refMs: number): { peers: number; scores: Map<number, number> } {
    const scores = new Map<number, number>();
    let peers = 0;
    for (const m of byType.get(type) ?? []) {
      if (m.parsed.key === excludeKey) continue;
      peers++;
      const latest = Math.max(...m.rows.map((r) => r.dateMs));
      const recency = 0.4 + 0.6 * Math.pow(0.5, Math.abs(refMs - latest) / DAY_MS / 365);
      const perCat = new Map<number, number>();
      for (const r of m.rows) perCat.set(r.categoryId, (perCat.get(r.categoryId) ?? 0) + 1);
      for (const [cat, n] of perCat) scores.set(cat, (scores.get(cat) ?? 0) + recency * n / m.rows.length);
    }
    return { peers, scores };
  }

  function top(sc: Map<number, number>): { topCat: number; top: number; total: number } {
    let total = 0, topCat = -1, best = 0;
    for (const [cat, s] of sc) { total += s; if (s > best) { best = s; topCat = cat; } }
    return { topCat, top: best, total };
  }

  function run(descriptor: string, amount: number, refMs: number, trace?: SuggestTrace, name: (id: number) => string = (id) => `#${id}`): CategoryGuess | null {
    const q = parseDescriptor(descriptor);
    const note = (s: string) => { trace?.notes.push(s); };
    const transfer = isBankTransferDescriptor(descriptor);
    if (trace) {
      trace.merchant = q.key;
      trace.product = q.product;
      trace.bankTransfer = transfer;
    }
    if (!q.key) {
      note('No merchant name could be read from the descriptor, so there is nothing to compare.');
      return null;
    }

    // Tier 1: similar merchant names.
    const { scores, best } = byName(q, amount, refMs, transfer, trace);
    if (trace) {
      trace.matches.sort((a, b) => b.similarity - a.similarity || b.purchases - a.purchases);
      trace.matches = trace.matches.slice(0, 8);
      trace.nameScores = toShares(scores);
      const sa = trace.sameAmount;
      const things = transfer ? 'transfers' : 'purchases';
      const $ = `$${formatAmount(Math.abs(amount))}`;
      if (sa.count > 0) {
        const split = sa.categories.length === 1
          ? (sa.count === 1 ? `filed as ${name(sa.categories[0].categoryId)}` : `all ${name(sa.categories[0].categoryId)}`)
          : sa.categories.map((c) => `${c.count} ${name(c.categoryId)}`).join(', ');
        const monthly = sa.monthlyCategoryId != null
          ? ` ${sa.categories.length === 1 ? 'They' : `The ${name(sa.monthlyCategoryId)} ones`} recur about monthly, which looks like a standing payment, so they count double.`
          : '';
        const why = transfer ? ' A bank transfer names no payee, so the amount is the best clue: transfers for other amounts count for little.' : '';
        note(`${sa.count} past ${sa.count === 1 ? things.slice(0, -1) : things} for exactly ${$} (${split}, latest ${sa.lastDate}).${monthly}${why}`);
      } else if (transfer && trace.matches.some((m) => m.similarity >= 0.85)) {
        note(`No past transfer was for exactly ${$}, so the amount can't tell which payment this is.`);
      }
    }
    let guess: CategoryGuess | null = null;
    const n = top(scores);
    if (n.total <= 0) {
      note(q.product ? 'No past product shares enough words with this one.' : 'No past purchase has a similar merchant name.');
    } else if (n.top / n.total < minShare && (() => {
      // No single winner: offer two if exactly two categories have compelling, comparable evidence.
      const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
      const [a, b] = ranked;
      if (!b || a[1] < minEvidence || b[1] < minEvidence) return false;
      if (b[1] / n.total < PAIR_MIN_SECOND_SHARE || (a[1] + b[1]) / n.total < PAIR_MIN_COMBINED) return false;
      const reason = best.kind ? `${best.kind}${best.n > 1 ? ` ×${best.n}` : ''}` : '';
      guess = { categoryId: a[0], confidence: a[1] / n.total, scores, reason, tier: 'name', second: { categoryId: b[0], confidence: b[1] / n.total } };
      note(`No single winner, but two categories share the vote: ${name(a[0])} (${pct(a[1] / n.total)}) and ${name(b[0])} (${pct(b[1] / n.total)}). Showing both.`);
      return true;
    })()) {
      // two-way guess made above
    } else if (n.top / n.total < minShare) {
      note(`From similar names: ${name(n.topCat)} leads with ${pct(n.top / n.total)} of the weighted vote, but a guess needs ${pct(minShare)}.`);
    } else if (n.top < minEvidence) {
      note(`From similar names: ${name(n.topCat)} leads, but the matches are too weak to rely on (score ${n.top.toFixed(2)}, needs ${minEvidence}).`);
    } else {
      const reason = best.kind ? `${best.kind}${best.n > 1 ? ` ×${best.n}` : ''}` : '';
      guess = { categoryId: n.topCat, confidence: n.top / n.total, scores, reason, tier: 'name' };
      note(`Guess ${name(n.topCat)} (${pct(guess.confidence)}) from ${reason || 'similar names'}.`);
    }

    // Tier 2: how this kind of business is usually filed. Evaluated for the trace even when tier 1
    // already decided, so the details show both.
    if (guess && !trace) return guess;
    const type = types[q.key];
    let status: MerchantTypeStatus;
    if (trace?.bankTransfer) status = 'not applicable';
    else if (type === undefined) status = 'unlabelled';
    else if (type === 'unknown') status = 'unknown';
    else if (VAGUE_TYPES.has(type)) status = 'vague';
    else status = 'labelled';
    if (trace) {
      trace.merchantType = type ?? null;
      trace.merchantTypeStatus = status;
    }
    const prefix = guess ? 'Kind of business (not needed): ' : 'Kind of business: ';
    if (status === 'not applicable') { note(`${prefix}a bank transfer names no merchant, so the kind of business can't help.`); return guess; }
    if (status === 'unlabelled') { note(`${prefix}not labelled yet. A ? lookup or "AI: label merchants" can add it.`); return guess; }
    if (status === 'unknown') { note(`${prefix}the AI couldn't tell what kind of business this is.`); return guess; }
    if (status === 'vague') { note(`${prefix}"${type}" is too broad to learn from.`); return guess; }

    const tv = typeVote(type!, q.key, refMs);
    const t = top(tv.scores);
    if (trace) { trace.typeScores = toShares(tv.scores); trace.typePeers = tv.peers; }
    if (tv.peers < MIN_TYPE_PEERS) {
      note(`${prefix}${type}, but only ${tv.peers} other ${type} merchant${tv.peers === 1 ? ' has' : 's have'} categorized purchases (needs ${MIN_TYPE_PEERS}).`);
      return guess;
    }
    const typeShare = Math.max(minShare, MIN_TYPE_SHARE);
    if (t.total <= 0 || t.top / t.total < typeShare) {
      const split = toShares(tv.scores).slice(0, 3).map((s) => `${name(s.categoryId)} ${pct(s.share)}`).join(', ');
      note(`${prefix}${type}, but your ${type} merchants are split (${split}); a guess needs ${pct(typeShare)}.`);
      return guess;
    }
    if (t.top < MIN_TYPE_EVIDENCE) {
      note(`${prefix}${type}, but there isn't enough ${type} history to rely on yet.`);
      return guess;
    }
    if (guess) {
      note(`${prefix}${type} merchants mostly go to ${name(t.topCat)} (${pct(t.top / t.total)}).`);
      return guess;
    }
    guess = { categoryId: t.topCat, confidence: t.top / t.total, scores: tv.scores, reason: `like other ${type} merchants`, tier: 'type' };
    note(`Guess ${name(t.topCat)} (${pct(guess.confidence)}) from how you file other ${type} merchants.`);
    return guess;
  }

  const refFor = (asOf?: string) => (asOf ? Date.parse(asOf) || latestMs : latestMs);

  return {
    /** Best guess for one descriptor/amount, or null when not confident. `asOf` (the transaction's own date) is the point recency is measured from, in both directions; defaults to the newest corpus date. */
    suggest(descriptor: string, amount: number, asOf?: string): CategoryGuess | null {
      return run(descriptor, amount, refFor(asOf));
    },
    /**
     * The same decision as `suggest`, with everything it looked at and plain-language notes on why it
     * did or didn't guess. `categoryName` turns ids into names for the notes.
     */
    explain(descriptor: string, amount: number, opts: { asOf?: string; categoryName?: (id: number) => string } = {}): SuggestTrace {
      const trace: SuggestTrace = {
        merchant: '', product: false, bankTransfer: false, merchantType: null, merchantTypeStatus: 'unlabelled',
        matches: [], sameAmount: { count: 0, categories: [], monthlyCategoryId: null, lastDate: '' }, nameScores: [], typeScores: [], typePeers: 0, guess: null, notes: [],
      };
      trace.guess = run(descriptor, amount, refFor(opts.asOf), trace, opts.categoryName);
      return trace;
    },
    /** How merchants of one kind are filed (for the AI lookup's category step). */
    typeProfile(type: string, excludeMerchant = ''): { peers: number; shares: CategoryShare[] } {
      const tv = typeVote(type, excludeMerchant, latestMs);
      return { peers: tv.peers, shares: toShares(tv.scores) };
    },
  };
}

export type Suggester = ReturnType<typeof buildSuggester>;

/**
 * Past purchases the suggester learns from: categorized, live (not archived) categories, no credits
 * or transfers. Shared by the suggestion chips and the ? lookup so both see the same history.
 */
export function suggestionCorpus<T extends Pick<Transaction, 'categoryId' | 'isTransfer' | 'ignoreInBudget'>>(
  transactions: T[],
  liveCategoryIds: Set<number>,
): T[] {
  return transactions.filter((t) => t.categoryId != null && liveCategoryIds.has(t.categoryId) && !isCredit(t) && !t.isTransfer);
}
