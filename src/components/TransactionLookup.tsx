import { useState, useEffect } from 'react';
import { useSyncExternalStore } from 'react';
import { getData, subscribe, getAISettings, updateTransaction, type Transaction } from '../db';
import { lookupTransaction, cleanDescriptorForSearch, type LookupResult } from '../logic/llm';
import { formatAmount } from '../utils/format';

interface Props {
  transaction: Transaction;
  onClose: () => void;
}

export function TransactionLookup({ transaction, onClose }: Props) {
  const appData = useSyncExternalStore(subscribe, getData, getData);
  const [loading, setLoading] = useState(true);
  const [result, setResult] = useState<LookupResult | null>(null);
  const [toolStatus, setToolStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [accepted, setAccepted] = useState(false);

  const catMap = new Map(appData.categories.map((c) => [c.id, c.name]));

  const similar = appData.transactions
    .filter((t) => t.id !== transaction.id && t.descriptor.toLowerCase() === transaction.descriptor.toLowerCase())
    .sort((a, b) => b.txnDate.localeCompare(a.txnDate))
    .slice(0, 8);

  const aiSettings = getAISettings();

  useEffect(() => {
    let cancelled = false;
    async function run() {
      setLoading(true);
      setError(null);
      setToolStatus(null);
      setResult(null);
      setAccepted(false);
      try {
        const r = await lookupTransaction(
          transaction.descriptor, transaction.amount, transaction.txnDate,
          transaction.instrument, aiSettings,
          (status) => { if (!cancelled) setToolStatus(status); },
        );
        if (!cancelled) { setResult(r); setToolStatus(null); }
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    run();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transaction.id]);

  const searchQuery = cleanDescriptorForSearch(transaction.descriptor);

  async function acceptCategory() {
    if (!result?.categoryId) return;
    await updateTransaction(transaction.id, { categoryId: result.categoryId });
    setAccepted(true);
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 520 }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginBottom: '0.75rem' }}>Transaction Lookup</h3>

        {/* Transaction details */}
        <div className="card" style={{ marginBottom: '0.75rem', padding: '0.75rem' }}>
          <div style={{ fontWeight: 600, marginBottom: '0.25rem', wordBreak: 'break-word' }}>{transaction.descriptor}</div>
          <div style={{ fontSize: '0.85rem', opacity: 0.75, display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
            <span>{transaction.txnDate}</span>
            <span className={transaction.amount < 0 ? 'positive' : 'negative'} style={{ fontWeight: 600 }}>
              {transaction.amount < 0 ? '+' : '-'}${formatAmount(Math.abs(transaction.amount))}
            </span>
            <span>{transaction.instrument}</span>
            {transaction.categoryId && <span>Category: {catMap.get(transaction.categoryId) ?? '?'}</span>}
          </div>
          <div style={{ fontSize: '0.8rem', opacity: 0.55, marginTop: '0.25rem' }}>
            Search query: <em>{searchQuery}</em>
          </div>
        </div>

        {/* Similar past transactions */}
        {similar.length > 0 && (
          <div style={{ marginBottom: '0.75rem' }}>
            <div className="section-title" style={{ marginBottom: '0.4rem' }}>
              {similar.length} past transaction{similar.length !== 1 ? 's' : ''} with this descriptor
            </div>
            <div style={{ maxHeight: 130, overflowY: 'auto', fontSize: '0.82rem', border: '1px solid var(--border)', borderRadius: 6, padding: '0.4rem 0.6rem' }}>
              {similar.map((t) => (
                <div key={t.id} style={{ display: 'flex', gap: '0.75rem', justifyContent: 'space-between', padding: '0.15rem 0', borderBottom: '1px solid var(--border-2)' }}>
                  <span style={{ opacity: 0.7 }}>{t.txnDate}</span>
                  <span style={{ flex: 1 }} />
                  <span className={t.amount < 0 ? 'positive' : 'negative'}>{t.amount < 0 ? '+' : '-'}${formatAmount(Math.abs(t.amount))}</span>
                  <span style={{ opacity: 0.8, fontWeight: t.categoryId ? 600 : 400 }}>
                    {t.categoryId ? (catMap.get(t.categoryId) ?? '?') : <em style={{ opacity: 0.5 }}>uncategorized</em>}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* AI result */}
        <div className="section-title" style={{ marginBottom: '0.4rem' }}>AI Analysis</div>
        <div style={{ minHeight: 60, padding: '0.75rem', background: 'var(--bg-3)', borderRadius: 6, fontSize: '0.875rem', lineHeight: 1.6, wordBreak: 'break-word' }}>
          {loading && !result && <span style={{ opacity: 0.6 }}>{toolStatus ?? 'Analyzing…'}</span>}
          {error && <span style={{ color: 'var(--red)' }}>Error: {error}{error.includes('fetch') || error.includes('connect') ? ' — is Ollama running?' : ''}</span>}
          {result && <span>{result.info}</span>}
        </div>

        {/* Category suggestion chip */}
        {result?.categoryId && !accepted && !transaction.categoryId && (
          <div style={{ marginTop: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-3)' }}>Suggested category:</span>
            <span
              className="chip"
              style={{ cursor: 'pointer', background: 'var(--accent)', color: '#fff', fontSize: '0.82rem', padding: '0.25rem 0.75rem' }}
              title="Click to assign this category"
              onClick={acceptCategory}
            >
              {result.categoryName} ✓
            </span>
          </div>
        )}
        {accepted && (
          <div style={{ marginTop: '0.75rem', fontSize: '0.85rem', color: 'var(--green)' }}>
            ✓ Category assigned: {result?.categoryName}
          </div>
        )}

        <div className="modal-actions" style={{ marginTop: '0.75rem' }}>
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
