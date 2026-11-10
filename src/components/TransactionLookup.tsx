import { useState, useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from 'react';
import {
  getData, subscribe, getAISettings, updateTransaction, getMerchantLookup, saveMerchantLookup,
  addMerchantTypes, setMerchantType, logSuggestionOutcome, type Transaction,
} from '../db';
import { checkOllama, ollamaJson, searchWeb } from '../logic/llm';
import { runLookup, type LookupReport, type LookupStep } from '../logic/lookup';
import { MERCHANT_TYPES } from '../logic/aiSuggest';
import type { Suggester } from '../logic/suggest';
import { HistoryEvidence } from './SuggestionDetails';
import { SearchableSelect } from './SearchableSelect';
import { formatAmount } from '../utils/format';

interface Props {
  transaction: Transaction;
  suggester: Suggester;
  onClose: () => void;
}

const STATUS_ICON: Record<LookupStep['status'], string> = {
  pending: '·', running: '…', done: '✓', skipped: '–', failed: '✕',
};

function Step({ n, title, step, children }: { n: number; title: string; step: LookupStep | undefined; children?: ReactNode }) {
  const status = step?.status ?? 'pending';
  const color = status === 'failed' ? 'var(--red)' : status === 'done' ? 'var(--green)' : 'var(--text-3)';
  return (
    <div style={{ marginBottom: '0.75rem' }}>
      <div className="section-title" style={{ marginBottom: '0.3rem', display: 'flex', gap: '0.4rem', alignItems: 'baseline' }}>
        <span style={{ color, width: '1ch', display: 'inline-block' }}>{STATUS_ICON[status]}</span>
        <span>{n}. {title}</span>
        {status === 'running' && <span style={{ fontWeight: 400, opacity: 0.6 }}>working…</span>}
        {status === 'skipped' && <span style={{ fontWeight: 400, opacity: 0.6 }}>skipped</span>}
      </div>
      <div style={{ fontSize: '0.85rem', paddingLeft: '1.4rem', lineHeight: 1.5 }}>
        {step?.note && <div style={{ color: status === 'failed' ? 'var(--red)' : 'var(--text-2)', marginBottom: children ? '0.25rem' : 0 }}>{step.note}</div>}
        {children}
      </div>
    </div>
  );
}

function Unresolved({ items }: { items: string[] | undefined }) {
  if (!items?.length) return null;
  return (
    <div style={{ marginTop: '0.25rem' }}>
      <span style={{ color: 'var(--yellow)' }}>Couldn't tell:</span> {items.join('; ')}
    </div>
  );
}

const TYPE_OPTIONS = [...MERCHANT_TYPES, 'unknown'].map((t) => ({ value: t, label: t }));

/**
 * The ? window: history, AI-prepared search, AI reading and a recommended category. It only
 * recommends: a category changes only when the user clicks a Use button.
 */
export function TransactionLookup({ transaction, suggester, onClose }: Props) {
  const appData = useSyncExternalStore(subscribe, getData, getData);
  const live = appData.transactions.find((t) => t.id === transaction.id) ?? transaction;
  const catMap = useMemo(() => new Map(appData.categories.map((c) => [c.id, c.name])), [appData.categories]);
  const catColorMap = useMemo(() => new Map(appData.categories.map((c) => [c.id, c.color ?? '#888'])), [appData.categories]);
  const pickable = useMemo(() => appData.categories.filter((c) => !c.isIncome && !c.archived), [appData.categories]);

  const trace = useMemo(
    () => suggester.explain(transaction.descriptor, transaction.amount, { asOf: transaction.txnDate, categoryName: (id) => catMap.get(id) ?? `#${id}` }),
    [suggester, transaction.descriptor, transaction.amount, catMap],
  );
  const merchantKey = trace.merchant;
  const savedType = appData.merchantTypes?.[merchantKey];

  const [report, setReport] = useState<LookupReport | null>(() => (merchantKey ? getMerchantLookup(merchantKey) ?? null : null));
  const [fromCache, setFromCache] = useState(() => report != null);
  const [running, setRunning] = useState(false);
  const [used, setUsed] = useState<string | null>(null);
  const alive = useRef(true);
  const inFlight = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  async function run() {
    if (inFlight.current) return;
    inFlight.current = true;
    setRunning(true);
    setFromCache(false);
    setUsed(null);
    try {
      const settings = getAISettings();
      const final = await runLookup(
        { descriptor: transaction.descriptor, amount: transaction.amount, txnDate: transaction.txnDate, instrument: transaction.instrument },
        { suggester, categories: pickable.map((c) => ({ id: c.id, name: c.name })), model: settings.model },
        {
          aiAvailable: () => checkOllama(settings.ollamaUrl),
          chat: (system, user, schema) => ollamaJson(settings, system, user, schema),
          search: searchWeb,
        },
        (r) => { if (alive.current) setReport(r); },
      );
      // Closed before it finished: keep nothing half-done.
      if (!alive.current || !merchantKey || trace.bankTransfer) return;
      await saveMerchantLookup(merchantKey, final);
      // Fill in the merchant type only where none is known. A saved type (possibly picked by hand) is
      // never overwritten; the window offers to switch instead.
      const t = final.reading.merchantType;
      const existing = getData().merchantTypes?.[merchantKey];
      if (t && (existing === undefined || (existing === 'unknown' && t !== 'unknown'))) {
        await addMerchantTypes({ [merchantKey]: t });
      }
    } finally {
      inFlight.current = false;
      if (alive.current) setRunning(false);
    }
  }

  // Look up on open, unless this merchant already has a saved lookup.
  useEffect(() => {
    if (!report) void run();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const history = trace.guess;
  const aiCat = report?.category.categoryId != null && catMap.has(report.category.categoryId) ? report.category.categoryId : null;
  const disagree = history != null && aiCat != null && history.categoryId !== aiCat;

  async function use(categoryId: number, source: 'history' | 'ai') {
    const wasUncategorized = live.categoryId == null;
    await updateTransaction(transaction.id, { categoryId });
    if (wasUncategorized) {
      const offered: { source: 'history' | 'ai'; categoryId: number }[] = [];
      if (history) offered.push({ source: 'history', categoryId: history.categoryId });
      if (aiCat != null) offered.push({ source: 'ai', categoryId: aiCat });
      await logSuggestionOutcome(transaction.descriptor, categoryId, offered);
    }
    setUsed(`${catMap.get(categoryId)} (${source === 'ai' ? "the AI's recommendation" : 'the history guess'})`);
  }

  const categoryButton = (categoryId: number, source: 'history' | 'ai') => (
    live.categoryId === categoryId
      ? <span style={{ fontSize: '0.8rem', color: 'var(--green)', whiteSpace: 'nowrap' }}>✓ current</span>
      : <button className="btn btn-ghost btn-sm" onClick={() => { void use(categoryId, source); }}>{live.categoryId == null ? 'Use' : 'Change to this'}</button>
  );

  const r = report;
  const relevant = new Set(r?.reading.relevantResults ?? []);
  const lastNote = trace.notes[trace.notes.length - 1] ?? '';

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 680 }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginBottom: '0.75rem' }}>Transaction Lookup</h3>

        <div className="card" style={{ marginBottom: '0.75rem', padding: '0.6rem 0.75rem' }}>
          <div style={{ fontWeight: 600, wordBreak: 'break-word' }}>{transaction.descriptor}</div>
          <div style={{ fontSize: '0.82rem', opacity: 0.75, display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
            <span>{transaction.txnDate}</span>
            <span style={{ fontWeight: 600 }}>{transaction.amount < 0 ? '+' : '-'}${formatAmount(Math.abs(transaction.amount))}</span>
            <span>{transaction.instrument}</span>
            <span>Category: {live.categoryId != null ? catMap.get(live.categoryId) ?? '?' : <em>uncategorized</em>}</span>
          </div>
        </div>

        {fromCache && r && (
          <div style={{ fontSize: '0.8rem', color: 'var(--text-3)', marginBottom: '0.6rem' }}>
            Saved lookup for this merchant from {new Date(r.at).toLocaleString()}
            {r.amount !== transaction.amount || r.txnDate !== transaction.txnDate ? ` (run on a $${formatAmount(Math.abs(r.amount))} charge on ${r.txnDate})` : ''}.
            {' '}Re-run to search again.
          </div>
        )}

        <Step n={1} title="Your history" step={{ status: 'done' }}>
          <details>
            <summary style={{ cursor: 'pointer' }}>
              {history ? <>Chip: <strong>{catMap.get(history.categoryId)}</strong> ({Math.round(history.confidence * 100)}%)</> : 'No chip'}
              {lastNote && <span style={{ opacity: 0.75 }}> — {lastNote}</span>}
            </summary>
            <div style={{ marginTop: '0.5rem' }}>
              <HistoryEvidence trace={trace} catMap={catMap} catColorMap={catColorMap} />
            </div>
          </details>
        </Step>

        <Step n={2} title="Search query" step={r?.query}>
          {r && r.query.queries.length > 0 && (
            <>
              <div>
                {r.query.queries.map((q, i) => <code key={i} style={{ marginRight: 8 }}>{q}</code>)}
                <span className="chip" style={{ marginLeft: 4 }}>{r.query.source === 'ai' ? 'prepared by AI' : 'rule-based'}</span>
              </div>
              {(r.query.businessName || r.query.location) && (
                <div style={{ opacity: 0.85 }}>
                  {r.query.businessName && <>Read as <strong>{r.query.businessName}</strong></>}
                  {r.query.location && <> in {r.query.location}</>}
                </div>
              )}
              {r.query.reasoning && <div style={{ opacity: 0.75 }}>{r.query.reasoning}</div>}
            </>
          )}
        </Step>

        <Step n={3} title="Web search" step={r?.search}>
          {r && r.search.results.length > 0 && (
            <details>
              <summary style={{ cursor: 'pointer' }}>
                {r.search.results.length} result{r.search.results.length === 1 ? '' : 's'} for <code>{r.search.usedQuery}</code>
                {r.reading.status === 'done' && ` · ${relevant.size} about this merchant`}
              </summary>
              <ol style={{ margin: '0.35rem 0 0', paddingLeft: '1.3rem', fontSize: '0.8rem' }}>
                {r.search.results.map((res, i) => (
                  <li key={i} style={{ marginBottom: '0.3rem', opacity: r.reading.status === 'done' && !relevant.has(i + 1) ? 0.55 : 1 }}>
                    <strong>{res.title}</strong>
                    {r.reading.status === 'done' && relevant.has(i + 1) && <span style={{ color: 'var(--green)' }}> ✓ relevant</span>}
                    <div>{res.snippet}</div>
                  </li>
                ))}
              </ol>
            </details>
          )}
        </Step>

        <Step n={4} title="AI reading" step={r?.reading}>
          {r?.reading.status === 'done' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
              <div>
                <strong>{r.reading.merchantName || 'Merchant not identified'}</strong>
                {r.reading.whatTheySell && <> — {r.reading.whatTheySell}</>}
              </div>
              <div>
                Kind of business: <strong>{r.reading.merchantType}</strong> <span style={{ opacity: 0.7 }}>({r.reading.typeConfidence} confidence)</span>
                {r.reading.typeReason && <div style={{ opacity: 0.8 }}>{r.reading.typeReason}</div>}
              </div>
              {r.reading.chargeNote && <div>This charge: {r.reading.chargeNote}</div>}
              {r.reading.resultNotes && <div style={{ opacity: 0.8 }}>Search results: {r.reading.resultNotes}</div>}
              <Unresolved items={r.reading.unresolved} />
            </div>
          )}
        </Step>

        <Step n={5} title="Recommendation" step={r?.category}>
          <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto', gap: '0.35rem 0.75rem', alignItems: 'start' }}>
            <span style={{ opacity: 0.65 }}>History chip</span>
            <span>
              {history
                ? <><strong>{catMap.get(history.categoryId)}</strong> <span style={{ opacity: 0.7 }}>({Math.round(history.confidence * 100)}%, {history.reason})</span></>
                : <span style={{ color: 'var(--text-3)' }}>no guess (see step 1)</span>}
            </span>
            <span>{history && categoryButton(history.categoryId, 'history')}</span>

            <span style={{ opacity: 0.65 }}>AI</span>
            <span>
              {aiCat != null
                ? <><strong>{catMap.get(aiCat)}</strong> <span style={{ opacity: 0.7 }}>({r?.category.confidence} confidence)</span></>
                : <span style={{ color: 'var(--text-3)' }}>{r?.category.status === 'running' ? 'thinking…' : 'no recommendation'}</span>}
              {r?.category.reason && <div style={{ opacity: 0.8 }}>{r.category.reason}</div>}
              {r?.category.typeShares && r.category.typeShares.length > 0 && (
                <div style={{ opacity: 0.65, fontSize: '0.8rem' }}>
                  Shown how you file other {r.reading.merchantType} merchants ({r.category.typePeers}):{' '}
                  {r.category.typeShares.slice(0, 3).map((s) => `${catMap.get(s.categoryId) ?? '?'} ${Math.round(s.share * 100)}%`).join(', ')}
                </div>
              )}
              <Unresolved items={r?.category.unresolved} />
            </span>
            <span>{aiCat != null && categoryButton(aiCat, 'ai')}</span>
          </div>
          {disagree && (
            <div style={{ marginTop: '0.4rem', color: 'var(--yellow)' }}>History and the AI disagree; check the reasons above before choosing.</div>
          )}
          {aiCat != null && !history && live.categoryId == null && (
            <div style={{ marginTop: '0.3rem', opacity: 0.65, fontSize: '0.8rem' }}>With no history guess, the AI's recommendation shows as this merchant's suggestion chip.</div>
          )}
          {used && <div style={{ marginTop: '0.4rem', color: 'var(--green)' }}>✓ Category set to {used}</div>}
        </Step>

        {merchantKey && !trace.bankTransfer && (
          <div style={{ fontSize: '0.85rem', borderTop: '1px solid var(--border)', paddingTop: '0.6rem', display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
            <span style={{ opacity: 0.7 }}>Saved kind of business for <code>{merchantKey}</code>:</span>
            <SearchableSelect
              options={TYPE_OPTIONS}
              value={savedType ?? ''}
              onChange={(v) => { if (v !== '') void setMerchantType(merchantKey, String(v)); }}
              placeholder="not labelled"
              compact
              style={{ minWidth: 200 }}
            />
            {r?.reading.merchantType && savedType && r.reading.merchantType !== savedType && r.reading.merchantType !== 'unknown' && (
              <button className="btn btn-ghost btn-sm" onClick={() => { void setMerchantType(merchantKey, r.reading.merchantType!); }}>
                Use AI's "{r.reading.merchantType}"
              </button>
            )}
            <span style={{ opacity: 0.55, fontSize: '0.78rem', flexBasis: '100%' }}>Suggestion chips use this to learn how you file this kind of business.</span>
          </div>
        )}

        <div className="modal-actions" style={{ marginTop: '0.9rem' }}>
          <button className="btn btn-ghost" onClick={() => { void run(); }} disabled={running}>{running ? 'Looking up…' : r ? 'Re-run lookup' : 'Run lookup'}</button>
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
