import type { Transaction } from '../db';
import type { CategoryShare, SuggestTrace } from '../logic/suggest';
import type { LookupReport } from '../logic/lookup';
import { formatAmount } from '../utils/format';

const pct = (x: number) => `${Math.round(x * 100)}%`;

interface CatProps {
  catMap: Map<number, string>;
  catColorMap: Map<number, string>;
}

function ShareBars({ shares, catMap, catColorMap, max = 5 }: CatProps & { shares: CategoryShare[]; max?: number }) {
  if (!shares.length) return null;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 11rem) 1fr 2.6rem', gap: '0.25rem 0.5rem', alignItems: 'center', fontSize: '0.8rem' }}>
      {shares.slice(0, max).map((s) => (
        <div key={s.categoryId} style={{ display: 'contents' }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{catMap.get(s.categoryId) ?? `#${s.categoryId}`}</span>
          <span style={{ height: 8, background: 'var(--bar-track)', borderRadius: 4, overflow: 'hidden' }}>
            <span style={{ display: 'block', height: '100%', width: pct(s.share), background: catColorMap.get(s.categoryId) ?? 'var(--accent)' }} />
          </span>
          <span style={{ textAlign: 'right', opacity: 0.75 }}>{pct(s.share)}</span>
        </div>
      ))}
    </div>
  );
}

const TYPE_STATUS_TEXT: Record<SuggestTrace['merchantTypeStatus'], string> = {
  labelled: '',
  unknown: "the AI couldn't tell",
  vague: 'too broad to learn from',
  unlabelled: 'not labelled yet',
  'not applicable': 'not applicable (bank transfer)',
};

/** Everything the history-based suggestion (the chip) looked at, for one transaction. */
export function HistoryEvidence({ trace, catMap, catColorMap }: CatProps & { trace: SuggestTrace }) {
  const g = trace.guess;
  const typeText = trace.merchantType && trace.merchantTypeStatus === 'labelled'
    ? trace.merchantType
    : `${trace.merchantType && trace.merchantTypeStatus !== 'unlabelled' ? `${trace.merchantType}: ` : ''}${TYPE_STATUS_TEXT[trace.merchantTypeStatus]}`;
  return (
    <div style={{ fontSize: '0.85rem', display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '0.2rem 0.75rem' }}>
        <span style={{ opacity: 0.6 }}>Merchant read as</span>
        <span>
          {trace.merchant ? <code>{trace.merchant}</code> : <em style={{ opacity: 0.6 }}>nothing readable</em>}
          {trace.product && <span className="chip" style={{ marginLeft: 6 }}>Amazon product</span>}
          {trace.bankTransfer && <span className="chip" style={{ marginLeft: 6 }}>bank transfer</span>}
        </span>
        <span style={{ opacity: 0.6 }}>Kind of business</span>
        <span>{typeText}</span>
        <span style={{ opacity: 0.6 }}>Chip</span>
        <span style={{ fontWeight: 600 }}>
          {g
            ? <>{catMap.get(g.categoryId) ?? `#${g.categoryId}`} <span style={{ fontWeight: 400, opacity: 0.7 }}>({pct(g.confidence)}, {g.tier === 'type' ? 'from the kind of business' : 'from similar names'})</span></>
            : <span style={{ color: 'var(--text-3)' }}>no guess</span>}
        </span>
      </div>

      <div>
        <div className="section-title" style={{ marginBottom: '0.25rem' }}>How it decided</div>
        <ul style={{ margin: 0, paddingLeft: '1.1rem', lineHeight: 1.5 }}>
          {trace.notes.map((n, i) => <li key={i}>{n}</li>)}
        </ul>
      </div>

      {trace.nameScores.length > 0 && (
        <div>
          <div className="section-title" style={{ marginBottom: '0.3rem' }}>Vote from similar merchants</div>
          <ShareBars shares={trace.nameScores} catMap={catMap} catColorMap={catColorMap} />
        </div>
      )}

      {trace.matches.length > 0 && (
        <details>
          <summary style={{ cursor: 'pointer', opacity: 0.8 }}>{trace.matches.length} matching past merchant{trace.matches.length === 1 ? '' : 's'}</summary>
          <table style={{ width: '100%', fontSize: '0.78rem', marginTop: '0.35rem' }}>
            <thead>
              <tr><th>Merchant</th><th>Match</th><th className="num">Buys</th><th>Filed as</th><th>Last</th></tr>
            </thead>
            <tbody>
              {trace.matches.map((m) => (
                <tr key={m.merchant}>
                  <td style={{ wordBreak: 'break-word' }}>{m.merchant}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{m.kind} <span style={{ opacity: 0.6 }}>{pct(m.similarity)}</span></td>
                  <td className="num">{m.purchases}{m.sameAmount > 0 && <span title="Purchases for exactly this amount" style={{ opacity: 0.6 }}> ({m.sameAmount} same $)</span>}</td>
                  <td>{m.categories.map((c) => `${catMap.get(c.categoryId) ?? `#${c.categoryId}`} ×${c.count}`).join(', ')}</td>
                  <td style={{ whiteSpace: 'nowrap', opacity: 0.7 }}>{m.lastDate}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}

      {trace.typeScores.length > 0 && (
        <div>
          <div className="section-title" style={{ marginBottom: '0.3rem' }}>How you file other {trace.merchantType} merchants ({trace.typePeers})</div>
          <ShareBars shares={trace.typeScores} catMap={catMap} catColorMap={catColorMap} />
        </div>
      )}
    </div>
  );
}

interface DetailsProps extends CatProps {
  transaction: Transaction;
  trace: SuggestTrace;
  /** Saved ? lookup for this merchant, if any. */
  lookup: LookupReport | undefined;
  aiLookupEnabled: boolean;
  onUse: (categoryId: number, source: 'history' | 'ai') => void;
  onRunLookup: () => void;
  onClose: () => void;
}

/** The chip's reasoning for one transaction. Local only: no AI call, no web search. */
export function SuggestionDetails({ transaction: t, trace, lookup, aiLookupEnabled, onUse, onRunLookup, onClose, catMap, catColorMap }: DetailsProps) {
  const ai = lookup?.category.categoryId != null && catMap.has(lookup.category.categoryId) ? lookup.category.categoryId : null;
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 620 }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginBottom: '0.75rem' }}>{trace.guess || ai != null ? 'Why this suggestion' : 'Why no suggestion'}</h3>
        <div className="card" style={{ marginBottom: '0.75rem', padding: '0.6rem 0.75rem' }}>
          <div style={{ fontWeight: 600, wordBreak: 'break-word' }}>{t.descriptor}</div>
          <div style={{ fontSize: '0.82rem', opacity: 0.7 }}>{t.txnDate} · ${formatAmount(Math.abs(t.amount))} · {t.instrument}</div>
        </div>

        <HistoryEvidence trace={trace} catMap={catMap} catColorMap={catColorMap} />

        <div style={{ marginTop: '0.9rem', paddingTop: '0.75rem', borderTop: '1px solid var(--border)', fontSize: '0.85rem' }}>
          <div className="section-title" style={{ marginBottom: '0.3rem' }}>? lookup</div>
          {lookup ? (
            <div>
              {ai != null
                ? <>AI recommended <strong>{catMap.get(ai)}</strong>{lookup.category.confidence && ` (${lookup.category.confidence} confidence)`}</>
                : <span style={{ color: 'var(--text-3)' }}>The AI didn't recommend a category.</span>}
              <span style={{ opacity: 0.6 }}> · looked up {lookup.at.slice(0, 10)} for a ${formatAmount(Math.abs(lookup.amount))} charge</span>
              {lookup.category.reason && <div style={{ opacity: 0.8, marginTop: '0.2rem' }}>{lookup.category.reason}</div>}
              {!trace.guess && ai != null && <div style={{ opacity: 0.6, marginTop: '0.2rem' }}>The chip shows this because history made no guess.</div>}
            </div>
          ) : (
            <div style={{ color: 'var(--text-3)' }}>Not looked up yet.{aiLookupEnabled ? ' The lookup searches the web and asks the local AI.' : ' Turn on Transaction AI Lookup in Settings to use it.'}</div>
          )}
        </div>

        <div className="modal-actions" style={{ marginTop: '1rem', display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          {t.categoryId == null && trace.guess && (
            <button className="btn btn-primary" onClick={() => onUse(trace.guess!.categoryId, 'history')}>Use {catMap.get(trace.guess.categoryId)}</button>
          )}
          {t.categoryId == null && ai != null && ai !== trace.guess?.categoryId && (
            <button className="btn btn-primary" onClick={() => onUse(ai, 'ai')}>Use AI's {catMap.get(ai)}</button>
          )}
          {aiLookupEnabled && (
            <button className="btn btn-ghost" onClick={onRunLookup}>{lookup ? 'Open ? lookup' : 'Run ? lookup'}</button>
          )}
          <button className="btn btn-ghost" onClick={onClose} style={{ marginLeft: 'auto' }}>Close</button>
        </div>
      </div>
    </div>
  );
}
