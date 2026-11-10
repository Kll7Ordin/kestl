/**
 * History-based category suggestions.
 *
 * Each descriptor is reduced to a merchant name (city/province, processor prefixes, store numbers and
 * reference codes removed), then every categorized past purchase votes for its category, weighted by:
 *   - how similar its merchant is (same merchant ≫ same name prefix ≫ similar spelling ≫ shared rare words)
 *   - how recent it is (habits change: the latest choice for a merchant counts most)
 *   - whether the amount matches (same merchant + same amount ≈ the same recurring thing, e.g. a $501
 *     e-transfer is daycare, a $3 one is an allowance)
 * A suggestion is made only when one category clearly wins and there is enough evidence behind it.
 */
import type { Transaction } from '../db';

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
}

/** Types too vague to learn from. */
const VAGUE_TYPES = new Set(['unknown', 'other', 'department store', 'bank or financial']);

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

  function scoreFor(descriptor: string, amount: number, refMs: number): CategoryGuess | null {
    const q = parseDescriptor(descriptor);
    if (!q.key) return null;
    const qTri = trigrams(q.compact);

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
      for (const r of m.rows) {
        const ageDays = Math.max(0, (refMs - r.dateMs) / DAY_MS);
        const recency = 0.25 + 0.75 * Math.pow(0.5, ageDays / 240);
        let amt = 1;
        if (sim >= 0.85) {
          const diff = Math.abs(r.amount - amount);
          if (diff < 0.01) amt = 4;
          else if (diff <= Math.max(1, Math.abs(amount) * 0.05)) amt = 1.6;
        }
        raw.set(r.categoryId, (raw.get(r.categoryId) ?? 0) + recency * amt);
      }
      const damp = Math.max(Math.sqrt(m.rows.length) / m.rows.length, 0.15);
      for (const [cat, w] of raw) scores.set(cat, (scores.get(cat) ?? 0) + sim * w * damp);
    }

    const pick = (sc: Map<number, number>, share: number, evidence: number) => {
      let total = 0, topCat = -1, top = 0;
      for (const [cat, s] of sc) { total += s; if (s > top) { top = s; topCat = cat; } }
      return total > 0 && top / total >= share && top >= evidence ? { topCat, confidence: top / total } : null;
    };
    const byName = pick(scores, minShare, minEvidence);
    if (byName) {
      return { categoryId: byName.topCat, confidence: byName.confidence, scores, reason: best.kind ? `${best.kind}${best.n > 1 ? ` ×${best.n}` : ''}` : '' };
    }
    return byKindOfBusiness(q, refMs);
  }

  /**
   * Fallback: how this household files other merchants of the same kind. Each merchant gets one
   * (recency-weighted) vote split across its categories, so one busy store doesn't decide for its type.
   */
  function byKindOfBusiness(q: ParsedDescriptor, refMs: number): CategoryGuess | null {
    const type = types[q.key];
    const peers = type ? byType.get(type) : undefined;
    if (!peers || peers.length < 3) return null;
    const scores = new Map<number, number>();
    let total = 0;
    for (const m of peers) {
      if (m.parsed.key === q.key) continue;
      const latest = Math.max(...m.rows.map((r) => r.dateMs));
      const recency = 0.4 + 0.6 * Math.pow(0.5, Math.max(0, (refMs - latest) / DAY_MS) / 365);
      const perCat = new Map<number, number>();
      for (const r of m.rows) perCat.set(r.categoryId, (perCat.get(r.categoryId) ?? 0) + 1);
      for (const [cat, n] of perCat) {
        const w = recency * n / m.rows.length;
        scores.set(cat, (scores.get(cat) ?? 0) + w);
        total += w;
      }
    }
    let topCat = -1, top = 0;
    for (const [cat, s] of scores) if (s > top) { top = s; topCat = cat; }
    // Stricter than name matches: the same kind of business is weaker evidence than the same merchant.
    if (total <= 0 || top / total < Math.max(minShare, 0.65) || top < 2) return null;
    return { categoryId: topCat, confidence: top / total, scores, reason: `like other ${type} merchants` };
  }

  return {
    /** Best guess for one descriptor/amount, or null when not confident. `asOf` defaults to the newest corpus date. */
    suggest(descriptor: string, amount: number, asOf?: string): CategoryGuess | null {
      const refMs = asOf ? Date.parse(asOf) || latestMs : latestMs;
      return scoreFor(descriptor, amount, refMs);
    },
  };
}
