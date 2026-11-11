/**
 * The ? lookup: identify one transaction, step by step, and recommend a category.
 *
 *   1. History   — the same evidence as the suggestion chip (suggest.ts `explain`), shown in the UI.
 *   2. Query     — the local model turns the descriptor into a web search (rule-based if it's not available).
 *   3. Search    — DuckDuckGo, trying the second query if the first finds nothing.
 *   4. Reading   — the model says who the merchant is, what kind of business (independent of any
 *                  category), what this charge likely is, and what it couldn't work out.
 *   5. Category  — a separate model call picks a category, given the household's history, how it files
 *                  that kind of business, and the reading.
 *
 * Each step records its status and a note, so the window can show where it stopped and why. The result
 * is only a recommendation: nothing here changes a transaction. The caller saves the report and the
 * merchant type; the user decides whether to use the category.
 */
import { MERCHANT_TYPES } from './aiSuggest';
import { cleanDescriptorForSearch, type DDGResult } from './llm';
import type { CategoryShare, Suggester, SuggestTrace } from './suggest';

export type StepStatus = 'pending' | 'running' | 'done' | 'skipped' | 'failed';

export interface LookupStep {
  status: StepStatus;
  /** Why it was skipped or failed, or a short summary. */
  note?: string;
}

export type Confidence = 'high' | 'medium' | 'low';

export interface LookupReport {
  /** ISO timestamp of when the lookup ran. */
  at: string;
  descriptor: string;
  amount: number;
  txnDate: string;
  /** Merchant key (suggest.ts parseDescriptor). */
  merchant: string;
  /** Model used, or null if the AI wasn't available. */
  model: string | null;
  query: LookupStep & {
    source?: 'ai' | 'rules';
    queries: string[];
    businessName?: string;
    location?: string;
    reasoning?: string;
  };
  search: LookupStep & {
    usedQuery?: string;
    results: DDGResult[];
  };
  reading: LookupStep & {
    merchantName?: string;
    whatTheySell?: string;
    /** 1-based numbers of the search results that are about this merchant. */
    relevantResults?: number[];
    resultNotes?: string;
    merchantType?: string;
    typeConfidence?: Confidence;
    typeReason?: string;
    chargeNote?: string;
    unresolved?: string[];
  };
  category: LookupStep & {
    categoryId: number | null;
    confidence?: Confidence;
    reason?: string;
    unresolved?: string[];
    /** How the household files the merchant type the reading found (what the model was shown). */
    typeShares?: CategoryShare[];
    typePeers?: number;
  };
}

export interface LookupInput {
  descriptor: string;
  amount: number;
  txnDate: string;
  instrument: string;
}

export interface LookupContext {
  suggester: Suggester;
  /** Categories the recommendation may use (non-income, not archived). */
  categories: { id: number; name: string }[];
  model: string;
}

export interface LookupDeps {
  /** Is the local model reachable? */
  aiAvailable(): Promise<boolean>;
  /** One structured model call; resolves to the parsed JSON object. */
  chat(system: string, user: string, schema: object): Promise<unknown>;
  search(query: string): Promise<DDGResult[]>;
}

const MAX_RESULTS = 6;

/**
 * Keep a search query to words that describe the business: no amounts, dates, card/account numbers or
 * reference codes go to the search engine.
 */
export function sanitizeQuery(q: string): string {
  return q
    .replace(/\$\s*\d[\d,]*(\.\d+)?/g, ' ')           // $84.12
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ')            // dates
    .replace(/[#*]?\b[a-z]*\d[\w-]*\d[\w-]*\b/gi, (m) => (/^\d{1,3}$/.test(m) ? m : ' ')) // codes with 2+ digits
    .replace(/\b\d{4,}\b/g, ' ')
    .replace(/[^\p{L}\p{N}\s&'.,"-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100)
    .trim();
}

function emptyReport(input: LookupInput, merchant: string): LookupReport {
  return {
    at: new Date().toISOString(),
    descriptor: input.descriptor,
    amount: input.amount,
    txnDate: input.txnDate,
    merchant,
    model: null,
    query: { status: 'pending', queries: [] },
    search: { status: 'pending', results: [] },
    reading: { status: 'pending' },
    category: { status: 'pending', categoryId: null },
  };
}

const money = (n: number) => `$${Math.abs(n).toFixed(2)}`;
const pct = (x: number) => `${Math.round(x * 100)}%`;
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const strList = (v: unknown) => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);
const conf = (v: unknown): Confidence | undefined => (v === 'high' || v === 'medium' || v === 'low' ? v : undefined);
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ── Prompts ───────────────────────────────────────────────────────────────────

const QUERY_SYSTEM = 'You prepare web searches that identify merchants on Canadian bank and credit card statements. Respond with JSON only.';

function queryPrompt(input: LookupInput, merchant: string): string {
  return `Statement descriptor: "${input.descriptor}"
Merchant name as the app reads it: "${merchant}"
Account: ${input.instrument || 'unknown'}

Descriptors are often cut off around 20 characters, and may start with a payment processor ("sq *", "tst*", "sp ") and end with a store number, phone number, city and province.

Return:
- businessName: your best reading of the full business name. Expand a cut-off word only if you're confident; otherwise keep it as written.
- location: the city/province shown in the descriptor, or "".
- queries: 1 or 2 web searches that would find this business, most specific first. Use only the business name, words describing it, and the location. Never include amounts, dates, card or account numbers, or reference codes.
- reasoning: one or two sentences on how you read the descriptor, including anything you weren't sure of.`;
}

const QUERY_SCHEMA = {
  type: 'object',
  properties: {
    businessName: { type: 'string' },
    location: { type: 'string' },
    queries: { type: 'array', items: { type: 'string' } },
    reasoning: { type: 'string' },
  },
  required: ['businessName', 'location', 'queries', 'reasoning'],
};

const READING_SYSTEM = 'You identify merchants from Canadian card statements using web search results. Say plainly what you could not determine; never invent details. Respond with JSON only.';

function readingPrompt(input: LookupInput, merchant: string, productTitle: string | null, report: LookupReport): string {
  const what = productTitle
    ? `Amazon order, product title: "${productTitle}"`
    : `Descriptor: "${input.descriptor}"\nMerchant name as the app reads it: "${merchant}"${report.query.businessName ? `\nLikely business name: "${report.query.businessName}"` : ''}`;
  const results = report.search.results.length
    ? `Web search for "${report.search.usedQuery}":\n${report.search.results.map((r, i) => `${i + 1}. ${r.title} — ${r.snippet}`).join('\n')}`
    : productTitle ? 'No web search (the product title says what it is).' : 'The web search found nothing; go by the name alone.';
  return `${what}
Amount: ${money(input.amount)} on ${input.txnDate}

${results}

Allowed merchant types: ${[...MERCHANT_TYPES, 'unknown'].join('; ')}

Return:
- merchantName: the business's name, or "" if you can't tell.
- whatTheySell: one sentence on what the business is or sells, or "".
- relevantResults: the numbers of the search results that are about this business (empty if none).
- resultNotes: one sentence on the search results: which helped, and which were about something else.
- merchantType: one of the allowed types, "unknown" if you can't tell. Describe the business, not a budget category.
- typeConfidence: high, medium or low.
- typeReason: why that type, citing the results or the name.
- chargeNote: what this particular charge probably is given the amount (e.g. "a typical grocery shop", "matches their monthly plan"), or "".
- unresolved: things you couldn't determine (e.g. "which business this is", "which location"). Empty if none.`;
}

const READING_SCHEMA = {
  type: 'object',
  properties: {
    merchantName: { type: 'string' },
    whatTheySell: { type: 'string' },
    relevantResults: { type: 'array', items: { type: 'integer' } },
    resultNotes: { type: 'string' },
    merchantType: { type: 'string', enum: [...MERCHANT_TYPES, 'unknown'] },
    typeConfidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    typeReason: { type: 'string' },
    chargeNote: { type: 'string' },
    unresolved: { type: 'array', items: { type: 'string' } },
  },
  required: ['merchantName', 'whatTheySell', 'relevantResults', 'resultNotes', 'merchantType', 'typeConfidence', 'typeReason', 'chargeNote', 'unresolved'],
};

const CATEGORY_SYSTEM = "You pick budget categories for one household's transactions. The household's own history outweighs general knowledge. Respond with JSON only.";

function categoryPrompt(
  input: LookupInput, trace: SuggestTrace, report: LookupReport, ctx: LookupContext, name: (id: number) => string,
): string {
  const r = report.reading;
  const lines: string[] = [];
  lines.push(`Transaction: "${input.descriptor}", ${money(input.amount)} on ${input.txnDate}`);
  if (r.status === 'done') {
    lines.push(`Merchant: ${r.merchantName || 'not identified'}${r.whatTheySell ? ` — ${r.whatTheySell}` : ''}`);
    lines.push(`Kind of business: ${r.merchantType ?? 'unknown'} (${r.typeConfidence ?? 'low'} confidence)`);
    if (r.chargeNote) lines.push(`This charge: ${r.chargeNote}`);
  } else {
    lines.push('The merchant could not be identified from the web.');
  }
  lines.push('', "This household's history:");
  if (trace.matches.length) {
    for (const m of trace.matches.slice(0, 4)) {
      lines.push(`- "${m.merchant}" (${m.kind}, ${m.purchases} purchase${m.purchases === 1 ? '' : 's'}): ${m.categories.map((c) => `${name(c.categoryId)} ×${c.count}`).join(', ')}`);
    }
  } else {
    lines.push('- No past purchases from a similar merchant.');
  }
  if (report.category.typeShares?.length) {
    lines.push(`- Other "${r.merchantType}" merchants (${report.category.typePeers}) are filed as: ${report.category.typeShares.slice(0, 4).map((s) => `${name(s.categoryId)} ${pct(s.share)}`).join(', ')}`);
  }
  lines.push(`- The app's own history guess: ${trace.guess ? `${name(trace.guess.categoryId)} (${pct(trace.guess.confidence)})` : 'none'}`);
  lines.push('', 'Categories:', ...ctx.categories.map((c) => `- ${c.name}`));
  lines.push('', `Return, in this order:
- reason: two or three sentences weighing the evidence. If history and the kind of business point different ways, say so.
- category: the category your reason points to, written exactly as in the list above, or "${NO_CATEGORY}" if none fits or you can't tell.
- confidence: high, medium or low.
- unresolved: anything that would change the answer that you couldn't determine. Empty if none.`);
  return lines.join('\n');
}

const NO_CATEGORY = 'none';

/**
 * The reason comes first so the model reasons before it commits (constrained decoding writes the
 * properties in order), and it picks by name: small models pick a mismatched number far more often.
 */
function categorySchema(names: string[]) {
  return {
    type: 'object',
    properties: {
      reason: { type: 'string' },
      category: { type: 'string', enum: [...new Set(names), NO_CATEGORY] },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      unresolved: { type: 'array', items: { type: 'string' } },
    },
    required: ['reason', 'category', 'confidence', 'unresolved'],
  };
}

// ── Pipeline ──────────────────────────────────────────────────────────────────

/**
 * Run the lookup. `onUpdate` receives a fresh copy of the report after every step change, so the
 * window can fill in as it goes. Never throws: failures are recorded on the step.
 */
export async function runLookup(
  input: LookupInput,
  ctx: LookupContext,
  deps: LookupDeps,
  onUpdate: (report: LookupReport) => void = () => {},
): Promise<LookupReport> {
  const catName = new Map(ctx.categories.map((c) => [c.id, c.name]));
  const name = (id: number) => catName.get(id) ?? `#${id}`;
  const trace = ctx.suggester.explain(input.descriptor, input.amount, { categoryName: name });
  const report = emptyReport(input, trace.merchant);
  const emit = () => onUpdate(structuredClone(report));
  emit();

  let aiOk = false;
  try { aiOk = await deps.aiAvailable(); } catch { aiOk = false; }
  if (aiOk) report.model = ctx.model;
  const noAi = 'The local AI model isn\'t running, so this step was skipped.';

  // Bank transfers name no merchant; there is nothing to search for or identify.
  if (trace.bankTransfer) {
    const note = 'A bank transfer or payment names no merchant, so there is nothing to look up. Your history (above) is the only evidence.';
    report.query = { status: 'skipped', note, queries: [] };
    report.search = { status: 'skipped', note, results: [] };
    report.reading = { status: 'skipped', note };
    report.category = { status: 'skipped', note, categoryId: null };
    emit();
    return report;
  }

  const productTitle = trace.product ? (input.descriptor.split('|')[1]?.trim() ?? '') : null;

  // 2. Query
  if (productTitle !== null) {
    const note = 'Amazon order: the product title already says what it is, so no web search is needed.';
    report.query = { status: 'skipped', note, queries: [] };
    report.search = { status: 'skipped', note, results: [] };
    emit();
  } else {
    const fallback = sanitizeQuery(cleanDescriptorForSearch(input.descriptor)) || trace.merchant;
    if (aiOk) {
      report.query = { status: 'running', queries: [] };
      emit();
      try {
        const out = await deps.chat(QUERY_SYSTEM, queryPrompt(input, trace.merchant), QUERY_SCHEMA) as Record<string, unknown>;
        const queries = [...new Set(strList(out.queries).map(sanitizeQuery).filter((q) => q.length >= 2))].slice(0, 2);
        if (queries.length) {
          report.query = {
            status: 'done', source: 'ai', queries,
            businessName: str(out.businessName) || undefined,
            location: str(out.location) || undefined,
            reasoning: str(out.reasoning) || undefined,
          };
        } else {
          report.query = { status: 'done', source: 'rules', queries: [fallback], note: 'The AI gave no usable search, so the descriptor was cleaned up by rules instead.', reasoning: str(out.reasoning) || undefined };
        }
      } catch (e) {
        report.query = { status: 'done', source: 'rules', queries: [fallback], note: `The AI couldn't prepare the search (${errText(e)}), so the descriptor was cleaned up by rules instead.` };
      }
    } else {
      report.query = { status: 'done', source: 'rules', queries: [fallback], note: `${noAi} The descriptor was cleaned up by rules instead.` };
    }
    emit();

    // 3. Search
    report.search = { status: 'running', results: [] };
    emit();
    const errors: string[] = [];
    for (const q of report.query.queries) {
      try {
        const results = (await deps.search(q)).slice(0, MAX_RESULTS);
        report.search.usedQuery = q;
        if (results.length) { report.search.results = results; break; }
      } catch (e) {
        errors.push(errText(e));
      }
    }
    if (report.search.results.length) {
      report.search.status = 'done';
      report.search.note = report.search.usedQuery !== report.query.queries[0] ? 'The first search found nothing; these are from the second.' : undefined;
    } else if (errors.length === report.query.queries.length) {
      report.search.status = 'failed';
      report.search.note = `The search didn't work (${errors[0]}).`;
    } else {
      report.search.status = 'done';
      report.search.note = `No results for ${report.query.queries.map((q) => `"${q}"`).join(' or ')}.`;
    }
    emit();
  }

  // 4. Reading
  if (!aiOk) {
    report.reading = { status: 'skipped', note: `${noAi} Read the search results yourself.` };
    report.category = { status: 'skipped', note: noAi, categoryId: null };
    emit();
    return report;
  }
  report.reading = { status: 'running' };
  emit();
  try {
    const out = await deps.chat(READING_SYSTEM, readingPrompt(input, trace.merchant, productTitle, report), READING_SCHEMA) as Record<string, unknown>;
    const allowed = new Set<string>([...MERCHANT_TYPES, 'unknown']);
    const type = str(out.merchantType);
    const n = report.search.results.length;
    report.reading = {
      status: 'done',
      merchantName: str(out.merchantName) || undefined,
      whatTheySell: str(out.whatTheySell) || undefined,
      relevantResults: Array.isArray(out.relevantResults)
        ? [...new Set(out.relevantResults.map(Number).filter((x) => Number.isInteger(x) && x >= 1 && x <= n))]
        : [],
      resultNotes: str(out.resultNotes) || undefined,
      merchantType: allowed.has(type) ? type : 'unknown',
      typeConfidence: conf(out.typeConfidence) ?? 'low',
      typeReason: str(out.typeReason) || undefined,
      chargeNote: str(out.chargeNote) || undefined,
      unresolved: strList(out.unresolved),
    };
  } catch (e) {
    report.reading = { status: 'failed', note: `The AI couldn't read the results (${errText(e)}).` };
  }
  emit();

  // 5. Category
  const type = report.reading.merchantType;
  if (type && type !== 'unknown') {
    const prof = ctx.suggester.typeProfile(type, trace.merchant);
    report.category.typeShares = prof.shares;
    report.category.typePeers = prof.peers;
  }
  report.category = { ...report.category, status: 'running' };
  emit();
  try {
    const out = await deps.chat(CATEGORY_SYSTEM, categoryPrompt(input, trace, report, ctx, name), categorySchema(ctx.categories.map((c) => c.name))) as Record<string, unknown>;
    const picked = str(out.category).trim().toLowerCase();
    const id = ctx.categories.find((c) => c.name.trim().toLowerCase() === picked)?.id ?? null;
    const valid = id != null;
    report.category = {
      ...report.category,
      status: 'done',
      categoryId: valid ? id : null,
      confidence: valid ? conf(out.confidence) ?? 'low' : undefined,
      reason: str(out.reason) || undefined,
      unresolved: strList(out.unresolved),
      note: valid ? undefined : 'The AI didn\'t settle on a category.',
    };
  } catch (e) {
    report.category = { ...report.category, status: 'failed', categoryId: null, note: `The AI couldn't pick a category (${errText(e)}).` };
  }
  emit();
  return report;
}
