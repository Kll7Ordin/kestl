import { describe, it, expect, vi } from 'vitest';
import { runLookup, sanitizeQuery, type LookupDeps, type LookupReport } from './lookup';
import { buildSuggester } from './suggest';
import { makeTxn } from '../test/fixtures';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const categories = [{ id: 1, name: 'Groceries' }, { id: 2, name: 'Eating Out' }, { id: 3, name: 'Household' }];
const corpus = [
  makeTxn({ descriptor: 'siam thai Victoria Bc', categoryId: 2, txnDate: '2026-05-01' }),
  makeTxn({ descriptor: 'pizza garden Victoria Bc', categoryId: 2, txnDate: '2026-05-02' }),
  makeTxn({ descriptor: 'thrifty foods Victoria Bc', categoryId: 1, txnDate: '2026-05-03' }),
];
const types = { 'siam thai': 'restaurant', 'pizza garden': 'restaurant', 'thrifty foods': 'grocery store' };
const ctx = { suggester: buildSuggester(corpus, { merchantTypes: types }), categories, model: 'test-model' };
const input = { descriptor: 'sq *kizuna ramen 8774174551 Bc', amount: 42.5, txnDate: '2026-06-01', instrument: 'Visa' };

/** Fake model: answers each step by recognising its schema. */
function fakeDeps(over: Partial<LookupDeps> = {}): LookupDeps & { prompts: string[]; queries: string[] } {
  const prompts: string[] = [];
  const queries: string[] = [];
  return {
    prompts,
    queries,
    aiAvailable: async () => true,
    search: async (q) => { queries.push(q); return [{ title: 'Kizuna Ramen - Victoria', snippet: 'Japanese ramen restaurant downtown' }, { title: 'Ramen recipes', snippet: 'How to make ramen' }]; },
    chat: async (_system, user, schema) => {
      prompts.push(user);
      const props = (schema as { properties: Record<string, unknown> }).properties;
      if ('queries' in props) return { businessName: 'Kizuna Ramen', location: 'Victoria, BC', queries: ['Kizuna Ramen Victoria BC 8774174551', 'Kizuna Ramen'], reasoning: 'sq * is Square.' };
      if ('merchantType' in props) return { merchantName: 'Kizuna Ramen', whatTheySell: 'A ramen restaurant.', relevantResults: [1, 9], resultNotes: 'Result 2 is recipes.', merchantType: 'restaurant', typeConfidence: 'high', typeReason: 'Result 1 says restaurant.', chargeNote: 'A meal for two.', unresolved: [] };
      return { reason: 'Restaurants go to Eating Out.', category: 'Eating Out', confidence: 'high', unresolved: ['whether this was takeout'] };
    },
    ...over,
  };
}

describe('sanitizeQuery', () => {
  it.each([
    ['Kizuna Ramen Victoria BC 8774174551', 'Kizuna Ramen Victoria BC'],
    ['thrifty foods #9457 $84.12 2026-06-01', 'thrifty foods'],
    ['99 Ranch Market', '99 Ranch Market'],
    ['7-Eleven Victoria', '7-Eleven Victoria'],
    ['ref *gu1z48f23 audible', 'ref audible'],
  ])('%s → %s', (q, out) => expect(sanitizeQuery(q)).toBe(out));
});

describe('runLookup', () => {
  it('runs every step and recommends without touching anything', async () => {
    const deps = fakeDeps();
    const updates: LookupReport[] = [];
    const r = await runLookup(input, ctx, deps, (u) => updates.push(u));
    expect(r.model).toBe('test-model');
    expect(r.query).toMatchObject({ status: 'done', source: 'ai', businessName: 'Kizuna Ramen' });
    // Phone numbers never reach the search engine.
    expect(deps.queries).toEqual(['Kizuna Ramen Victoria BC']);
    expect(r.search).toMatchObject({ status: 'done', usedQuery: 'Kizuna Ramen Victoria BC' });
    expect(r.reading).toMatchObject({ status: 'done', merchantType: 'restaurant', relevantResults: [1] });
    expect(r.category).toMatchObject({ status: 'done', categoryId: 2, confidence: 'high', unresolved: ['whether this was takeout'], typePeers: 2 });
    // The category step was shown the household's restaurant history.
    expect(deps.prompts[2]).toMatch(/Other "restaurant" merchants \(2\) are filed as: Eating Out 100%/);
    expect(updates.length).toBeGreaterThan(5);
    expect(updates.some((u) => u.reading.status === 'running')).toBe(true);
  });

  it('falls back to a rule-based search and skips the AI steps when the model is down', async () => {
    const r = await runLookup(input, ctx, fakeDeps({ aiAvailable: async () => false }));
    expect(r.model).toBeNull();
    expect(r.query).toMatchObject({ status: 'done', source: 'rules' });
    expect(r.query.note).toMatch(/isn't running/);
    expect(r.search.status).toBe('done');
    expect(r.reading.status).toBe('skipped');
    expect(r.category).toMatchObject({ status: 'skipped', categoryId: null });
  });

  it('records failures on the step instead of throwing', async () => {
    const deps = fakeDeps({
      search: async () => { throw new Error('offline'); },
      chat: async (_s, _u, schema) => {
        const props = (schema as { properties: Record<string, unknown> }).properties;
        if ('queries' in props) throw new Error('model not found');
        if ('merchantType' in props) return { merchantName: '', whatTheySell: '', relevantResults: [], resultNotes: '', merchantType: 'nonsense', typeConfidence: 'x', typeReason: '', chargeNote: '', unresolved: ['which business this is'] };
        return { reason: 'Not enough to go on.', category: 'none', confidence: 'low', unresolved: [] };
      },
    });
    const r = await runLookup(input, ctx, deps);
    expect(r.query).toMatchObject({ source: 'rules' });
    expect(r.query.note).toMatch(/model not found/);
    expect(r.search).toMatchObject({ status: 'failed' });
    expect(r.reading).toMatchObject({ status: 'done', merchantType: 'unknown', typeConfidence: 'low', unresolved: ['which business this is'] });
    expect(r.category).toMatchObject({ status: 'done', categoryId: null });
    expect(r.category.note).toMatch(/didn't settle/);
  });

  it('tries the second query when the first finds nothing', async () => {
    let n = 0;
    const deps = fakeDeps({ search: async () => (n++ === 0 ? [] : [{ title: 'Kizuna', snippet: 'ramen' }]) });
    const r = await runLookup(input, ctx, deps);
    expect(r.search).toMatchObject({ status: 'done', usedQuery: 'Kizuna Ramen' });
    expect(r.search.note).toMatch(/second/);
  });

  it('skips search for bank transfers and Amazon products', async () => {
    const deps = fakeDeps();
    const t = await runLookup({ ...input, descriptor: 'withdrawal Free Interac E-Transfer' }, ctx, deps);
    expect([t.query.status, t.search.status, t.reading.status, t.category.status]).toEqual(['skipped', 'skipped', 'skipped', 'skipped']);

    const a = await runLookup({ ...input, descriptor: 'Amazon | Anker USB C Charger | #701-1' }, ctx, deps);
    expect(a.search.status).toBe('skipped');
    expect(a.reading.status).toBe('done');
    expect(deps.queries).toHaveLength(0);
    expect(deps.prompts.some((p) => p.includes('product title: "Anker USB C Charger"'))).toBe(true);
  });

  it('rejects categories that are not on the list', async () => {
    const deps = fakeDeps({
      chat: async (_s, _u, schema) => {
        const props = (schema as { properties: Record<string, unknown> }).properties;
        if ('queries' in props) return { businessName: '', location: '', queries: ['x y'], reasoning: '' };
        if ('merchantType' in props) return { merchantType: 'restaurant', typeConfidence: 'medium' };
        return { reason: 'r', category: 'ChatGPT', confidence: 'high', unresolved: [] };
      },
    });
    const r = await runLookup(input, ctx, deps);
    expect(r.category.categoryId).toBeNull();
  });
});
