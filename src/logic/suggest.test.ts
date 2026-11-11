import { describe, it, expect } from 'vitest';
import { parseDescriptor, buildSuggester, isBankTransferDescriptor } from './suggest';
import { makeTxn } from '../test/fixtures';

describe('parseDescriptor', () => {
  it.each([
    ['thrifty foods #9457 Victoria Bc', 'thrifty foods'],
    ['sp penna co. Victoria Bc', 'penna co'],
    ['penna co Victoria Bc', 'penna co'],
    ['sq *kizuna ramen 8774174551 Bc', 'kizuna ramen'],
    ['act*saanich parks 2504755494 Bc', 'saanich parks'],
    ['audible*gu1z48f23 Amzn.Com/Billnj', 'audible'],
    ['pos purchase Gpos Red Barn Vanalm     Victo', 'red barn vanalm'],
    ['pos purchase Fpos Hillside Pharmasave Victo', 'hillside pharmasave'],
    ['pos purchase Natalies Nail Spa        Victo', 'natalies nail spa'],
    ['withdrawal Free Interac E-Transfer', 'withdrawal free interac e transfer'],
    ['customer transfer dr. Pc To 4537800409394688', 'customer transfer dr pc to acct4688'],
    ['James RRSP', 'james rrsp'],
    ['PayPal | eBay Commerce Canada Limited | Payment | Order Number: 06-1', 'ebay commerce limited'],
  ])('%s → %s', (d, key) => {
    expect(parseDescriptor(d).key).toBe(key);
  });

  it('marks marketplace products', () => {
    const p = parseDescriptor('Amazon | Anker USB C Charger Block | #701-4740559-6767410');
    expect(p.product).toBe(true);
    expect(p.words).toContain('charger');
  });

  it('recognises bank transfers with no merchant', () => {
    expect(isBankTransferDescriptor('withdrawal Free Interac E-Transfer')).toBe(true);
    expect(isBankTransferDescriptor('pos purchase Gpos Red Barn')).toBe(false);
    expect(isBankTransferDescriptor('thrifty foods Victoria Bc')).toBe(false);
  });
});

describe('buildSuggester', () => {
  const row = (descriptor: string, categoryId: number, amount = 20, txnDate = '2026-06-01') =>
    makeTxn({ descriptor, categoryId, amount, txnDate });

  it('matches the same merchant across city, store number and processor prefix changes', () => {
    const s = buildSuggester([row('thrifty foods #123 Victoria Bc', 1), row('petro-canada 69903 Victoria Bc', 2)]);
    expect(s.suggest('thrifty foods #9 Langley Bc', 30)?.categoryId).toBe(1);
    expect(s.suggest('sp thrifty foods Victoria Bc', 30)?.categoryId).toBe(1);
  });

  it('does not match on the city alone', () => {
    const s = buildSuggester([row('petro-canada Victoria Bc', 2), row('penny lane Victoria Bc', 2)]);
    expect(s.suggest('penna co Victoria Bc', 300)).toBeNull();
  });

  it('uses the amount to tell apart repeat payments to the same payee', () => {
    const corpus = [
      ...[1, 2, 3].map((m) => row('withdrawal Free Interac E-Transfer', 10, 501, `2026-0${m}-01`)),
      ...[1, 2, 3].map((m) => row('withdrawal Free Interac E-Transfer', 11, 75, `2026-0${m}-05`)),
    ];
    const s = buildSuggester(corpus);
    expect(s.suggest('withdrawal Free Interac E-Transfer', 501)?.categoryId).toBe(10);
    expect(s.suggest('withdrawal Free Interac E-Transfer', 75)?.categoryId).toBe(11);
    // An amount matching neither: both are compelling and equal, so both are offered.
    const both = s.suggest('withdrawal Free Interac E-Transfer', 240);
    expect([both?.categoryId, both?.second?.categoryId].sort()).toEqual([10, 11]);
  });

  it('lets a monthly same-amount e-transfer win over many other e-transfers', () => {
    const et = 'withdrawal Free Interac E-Transfer';
    const corpus = [
      ...[7, 8, 9].map((m) => row(et, 10, 501, `2026-0${m}-01`)),
      // A busy history of e-transfers for other things and amounts.
      ...[1, 2, 3, 4, 5, 6, 7, 8, 9].flatMap((m) => [row(et, 11, 40 + m, `2026-0${m}-10`), row(et, 12, 120 + m, `2026-0${m}-15`), row(et, 13, 300 + m * 7, `2026-0${m}-20`)]),
    ];
    const s = buildSuggester(corpus);
    expect(s.suggest(et, 501, '2026-10-01')?.categoryId).toBe(10);
  });

  it('prefers the recent choice when a merchant moved category', () => {
    const s = buildSuggester([
      row('clean cuts barbarshop Victoria Bc', 1, 30, '2024-01-01'),
      row('clean cuts barbarshop Victoria Bc', 1, 30, '2024-02-01'),
      row('clean cuts barbarshop Victoria Bc', 2, 30, '2026-05-01'),
      row('clean cuts barbarshop Victoria Bc', 2, 30, '2026-06-01'),
    ]);
    expect(s.suggest('clean cuts barbarshop Victoria Bc', 30)?.categoryId).toBe(2);
  });

  it('offers two suggestions when history is evenly split between two categories', () => {
    const s = buildSuggester([row('costco Victoria Bc', 1), row('costco Victoria Bc', 2)]);
    const g = s.suggest('costco Victoria Bc', 50);
    expect([g?.categoryId, g?.second?.categoryId].sort()).toEqual([1, 2]);
  });

  it('offers a single suggestion when one category dominates', () => {
    const s = buildSuggester([row('costco Victoria Bc', 1), row('costco Victoria Bc', 1), row('costco Victoria Bc', 1), row('costco Victoria Bc', 2)]);
    const g = s.suggest('costco Victoria Bc', 50);
    expect(g?.categoryId).toBe(1);
    expect(g?.second).toBeUndefined();
  });

  it('abstains when three or more categories share the vote', () => {
    const s = buildSuggester([row('costco Victoria Bc', 1), row('costco Victoria Bc', 2), row('costco Victoria Bc', 3)]);
    expect(s.suggest('costco Victoria Bc', 50)).toBeNull();
  });

  it('never matches an Amazon product to a merchant by name prefix', () => {
    const s = buildSuggester([row('amazon.ca Amzn.Com/Bill', 5), row('amazon.ca Amzn.Com/Bill', 5)]);
    expect(s.suggest('Amazon | Kids Toothbrush Heads | #701-1', 15)).toBeNull();
  });

  it('falls back to how the household files the same kind of business', () => {
    const corpus = [row('siam thai Victoria Bc', 7), row('pizza garden Victoria Bc', 7), row('kizuna ramen Victoria Bc', 7), row('red barn Victoria Bc', 3)];
    const merchantTypes = { 'siam thai': 'restaurant', 'pizza garden': 'restaurant', 'kizuna ramen': 'restaurant', 'tonollis deli': 'restaurant', 'red barn': 'grocery store' };
    expect(buildSuggester(corpus).suggest('tonollis deli Sidney Bc', 40)).toBeNull();
    const g = buildSuggester(corpus, { merchantTypes }).suggest('tonollis deli Sidney Bc', 40);
    expect(g?.categoryId).toBe(7);
    expect(g?.reason).toMatch(/restaurant/);
  });
});

describe('explain', () => {
  const row = (descriptor: string, categoryId: number, amount = 20, txnDate = '2026-06-01') =>
    makeTxn({ descriptor, categoryId, amount, txnDate });
  const names: Record<number, string> = { 1: 'Groceries', 2: 'Fun', 3: 'Household', 7: 'Eating Out' };
  const categoryName = (id: number) => names[id] ?? `#${id}`;

  it('agrees with suggest and lists the matching merchants', () => {
    const corpus = [row('thrifty foods #1 Victoria Bc', 1), row('thrifty foods #2 Victoria Bc', 1, 55)];
    const s = buildSuggester(corpus);
    const tr = s.explain('thrifty foods #9 Langley Bc', 55, { categoryName });
    expect(tr.guess?.categoryId).toBe(s.suggest('thrifty foods #9 Langley Bc', 55)?.categoryId);
    expect(tr.guess?.tier).toBe('name');
    expect(tr.merchant).toBe('thrifty foods');
    expect(tr.matches[0]).toMatchObject({ merchant: 'thrifty foods', kind: 'same merchant', purchases: 2, sameAmount: 1 });
    expect(tr.nameScores[0]).toMatchObject({ categoryId: 1, share: 1 });
    expect(tr.notes.join(' ')).toMatch(/Guess Groceries/);
  });

  it('says why there is no guess when history is split three ways', () => {
    const tr = buildSuggester([row('costco Victoria Bc', 1), row('costco Victoria Bc', 3), row('costco Victoria Bc', 4)]).explain('costco Victoria Bc', 50, { categoryName });
    expect(tr.guess).toBeNull();
    expect(tr.notes.join(' ')).toMatch(/33% of the weighted vote, but a guess needs 60%/);
    expect(tr.merchantTypeStatus).toBe('unlabelled');
    expect(tr.notes.join(' ')).toMatch(/not labelled yet/);
  });

  it('says when no past merchant is similar', () => {
    const tr = buildSuggester([row('petro-canada Victoria Bc', 2)]).explain('kizuna ramen Victoria Bc', 20);
    expect(tr.guess).toBeNull();
    expect(tr.matches).toHaveLength(0);
    expect(tr.notes[0]).toMatch(/No past purchase has a similar merchant name/);
  });

  it('explains a kind-of-business guess and when there are too few peers', () => {
    const corpus = [row('siam thai Victoria Bc', 7), row('pizza garden Victoria Bc', 7), row('kizuna ramen Victoria Bc', 7)];
    const merchantTypes = { 'siam thai': 'restaurant', 'pizza garden': 'restaurant', 'kizuna ramen': 'restaurant', 'tonollis deli': 'restaurant', 'big wok': 'restaurant' };
    const tr = buildSuggester(corpus, { merchantTypes }).explain('tonollis deli Sidney Bc', 40, { categoryName });
    expect(tr.guess).toMatchObject({ categoryId: 7, tier: 'type' });
    expect(tr.typePeers).toBe(3);
    expect(tr.notes.join(' ')).toMatch(/Guess Eating Out .* other restaurant merchants/);

    const few = buildSuggester(corpus.slice(0, 2), { merchantTypes }).explain('big wok Victoria Bc', 30);
    expect(few.guess).toBeNull();
    expect(few.notes.join(' ')).toMatch(/only 2 other restaurant merchants have categorized purchases \(needs 3\)/);
  });

  it('calls out same-amount transfers and a monthly pattern', () => {
    const et = 'withdrawal Free Interac E-Transfer';
    const corpus = [...[7, 8, 9].map((m) => row(et, 3, 501, `2026-0${m}-01`)), row(et, 2, 60, '2026-08-12')];
    const s = buildSuggester(corpus);
    const tr = s.explain(et, 501, { asOf: '2026-10-01', categoryName });
    expect(tr.sameAmount).toMatchObject({ count: 3, monthlyCategoryId: 3, lastDate: '2026-09-01' });
    expect(tr.matches[0].monthly).toBe(true);
    const text = tr.notes.join(' ');
    expect(text).toMatch(/3 past transfers for exactly \$501\.00 \(all Household, latest 2026-09-01\)/);
    expect(text).toMatch(/recur about monthly/);
    expect(text).toMatch(/amount is the best clue/);
    expect(tr.guess?.categoryId).toBe(3);

    expect(s.explain(et, 240, { categoryName }).notes.join(' ')).toMatch(/No past transfer was for exactly \$240\.00/);
  });

  it('marks bank transfers and vague or unknown types', () => {
    const s = buildSuggester([row('the bay Victoria Bc', 3)], { merchantTypes: { 'the bay': 'department store', 'mystery co': 'unknown' } });
    expect(s.explain('withdrawal Free Interac E-Transfer', 20)).toMatchObject({ bankTransfer: true, merchantTypeStatus: 'not applicable' });
    expect(s.explain('the bay Langford Bc', 20).merchantTypeStatus).toBe('vague');
    expect(s.explain('mystery co Victoria Bc', 20).merchantTypeStatus).toBe('unknown');
  });

  it('typeProfile reports how a kind of business is filed', () => {
    const corpus = [row('siam thai Victoria Bc', 7), row('pizza garden Victoria Bc', 7), row('red barn Victoria Bc', 1)];
    const p = buildSuggester(corpus, { merchantTypes: { 'siam thai': 'restaurant', 'pizza garden': 'restaurant', 'red barn': 'grocery store' } }).typeProfile('restaurant');
    expect(p.peers).toBe(2);
    expect(p.shares).toEqual([expect.objectContaining({ categoryId: 7, share: 1 })]);
  });
});
