/**
 * Local-LLM (Ollama) help for category suggestions.
 *
 * The model is NOT asked to pick a budget category: a small local model can't know that this
 * household files restaurants under "Joint Spending" or chargers under "Household Items", and when
 * asked directly it was right less than half the time. Instead it does what it's good at — saying
 * what kind of business or product a merchant is, from a fixed list ("restaurant", "museum or
 * attraction", "kids toy or game"). Those labels are saved per merchant, and the history-based
 * suggester (suggest.ts) then learns how this household files each kind of business. A first-time
 * Thai restaurant gets whatever category past restaurants mostly went to — or nothing, if past
 * restaurants are split between categories.
 */
import type { AISettings } from '../db';
import { ollamaFetch } from './llm';
import { isBankTransferDescriptor, parseDescriptor } from './suggest';

export const MERCHANT_TYPES = [
  'restaurant', 'fast food', 'cafe or bakery', 'bar or pub', 'food delivery',
  'grocery store', 'specialty food or deli', 'liquor store',
  'pharmacy or drugstore', 'health product', 'medical, dental or physio', 'optical',
  'gas station', 'auto repair or parts', 'parking', 'taxi, transit or rideshare',
  'ferry', 'airline', 'hotel or lodging', 'museum, zoo or attraction', 'ski hill or outdoor recreation',
  'kids activity, camp or lessons', 'gym, sports or fitness', 'recreation centre',
  'hair salon or barber', 'nails, spa or beauty',
  'adult clothing or shoes', 'kids clothing or shoes', 'baby products',
  'toys, games or hobby', 'books', 'electronics or computer accessories', 'video games',
  'software, AI or app subscription', 'video or music streaming', 'news or magazine subscription', 'audiobooks or podcasts',
  'phone or mobile plan', 'internet or tv', 'utility', 'insurance', 'government or tax',
  'charity or fundraiser', 'political donation', 'religious organization', 'school or tuition', 'childcare',
  'hardware or home improvement', 'furniture or home decor', 'kitchen or household goods', 'cleaning supplies',
  'garden or plants', 'personal care or toiletries', 'pets', 'office supplies', 'crafts, gifts or party supplies',
  'photo or printing', 'department store', 'outdoor or sporting goods', 'tickets or events',
  'bank or financial', 'other',
] as const;

const BATCH = 25;
// Generous: the first call may load the model from disk (several GB).
const TIMEOUT_MS = 300_000;
// Ollama's default context (often 4096 tokens) could cut off a long batch.
const NUM_CTX = 8192;

/** What the model is shown: the cleaned merchant name, or the product title for marketplace orders. */
export function merchantLabel(descriptor: string): string {
  const p = parseDescriptor(descriptor);
  if (p.product) return `Amazon product: ${descriptor.split('|')[1]?.trim().slice(0, 100) ?? p.key}`;
  return p.key;
}

/** Descriptors worth labelling: a merchant or product is named (not "withdrawal Free Interac E-Transfer"). */
export function needsMerchantType(descriptor: string, known: Record<string, string>): boolean {
  if (isBankTransferDescriptor(descriptor)) return false;
  const key = parseDescriptor(descriptor).key;
  return !!key && known[key] === undefined;
}

function buildPrompt(names: string[]): string {
  return `Classify each Canadian card-statement merchant (or Amazon product) by what kind of business or product it is.
Merchant names are lowercased and may be cut off ("red barn vanalm" = Red Barn Market, a grocery store).

Allowed types:
${MERCHANT_TYPES.join('; ')}

Use "unknown" if you don't recognise the name and it gives no clue. Don't guess from city names.

Merchants:
${names.map((n, i) => `${i + 1}. ${n}`).join('\n')}`;
}

const SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          n: { type: 'integer' },
          type: { type: 'string', enum: [...MERCHANT_TYPES, 'unknown'] },
        },
        required: ['n', 'type'],
      },
    },
  },
  required: ['results'],
};

/**
 * Label every distinct merchant in `descriptors` that isn't in `known` yet. Returns merchant key →
 * type ("unknown" included, so it isn't asked again). Throws if Ollama can't be reached or errors.
 * `onBatch` receives each batch's labels as they arrive so progress can be saved incrementally.
 */
export async function classifyMerchants(
  descriptors: string[],
  known: Record<string, string>,
  settings: AISettings,
  onBatch?: (labels: Record<string, string>, done: number, total: number) => void | Promise<void>,
): Promise<Record<string, string>> {
  const todo = new Map<string, string>(); // key → label shown to the model
  for (const d of descriptors) {
    if (!needsMerchantType(d, known)) continue;
    const key = parseDescriptor(d).key;
    if (!todo.has(key)) todo.set(key, merchantLabel(d));
  }
  const entries = [...todo.entries()];
  const allowed = new Set<string>([...MERCHANT_TYPES, 'unknown']);
  const out: Record<string, string> = {};

  for (let i = 0; i < entries.length; i += BATCH) {
    const chunk = entries.slice(i, i + BATCH);
    const resp = await ollamaFetch(`${settings.ollamaUrl}/api/chat`, TIMEOUT_MS, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: settings.model,
        messages: [{ role: 'user', content: buildPrompt(chunk.map(([, label]) => label)) }],
        stream: false,
        format: SCHEMA,
        options: { temperature: 0, num_ctx: NUM_CTX },
      }),
    });
    if (!resp.ok) throw new Error(`Ollama returned ${resp.status}`);
    const body = await resp.json();
    let results: { n: number; type: string }[] = [];
    try { results = JSON.parse(body.message?.content ?? '{}').results ?? []; } catch { results = []; }
    const byN = new Map(results.map((r) => [Number(r.n), String(r.type)]));
    const batch: Record<string, string> = {};
    chunk.forEach(([key], j) => {
      const t = byN.get(j + 1);
      // A missing answer stays unlabelled so a later run retries it.
      if (t && allowed.has(t)) batch[key] = t;
    });
    Object.assign(out, batch);
    await onBatch?.(batch, Math.min(i + BATCH, entries.length), entries.length);
  }
  return out;
}
