import { useState, useRef, useEffect } from 'react';
import { useSyncExternalStore } from 'react';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { invoke } from '@tauri-apps/api/core';
import {
  getData,
  subscribe,
  bulkAddTransactions,
  setSplits,
  updateTransaction,
  addAmazonOrders,
  executeCustomParser,
  type Transaction,
  type AmazonOrder,
} from '../db';
import { parseBankCsv } from '../parsers/csv';
import { parseAmazonOrders } from '../parsers/amazon';
import { parsePaypalPaste } from '../parsers/paypal';
import { detectDuplicates } from '../logic/duplicates';
import { categorizeTransactionsInPlace } from '../logic/categorize';
import { matchPaypalTransactions, confirmPaypalMatch, discardPaypalTransactions, type PaypalMatchCandidate } from '../logic/matching';
import { findRefundCandidates, applyRefundToOriginalMonth, type RefundCandidate } from '../logic/refunds';
import { formatAmount } from '../utils/format';
import { ParserGenerator } from './ParserGenerator';

type ImportType = 'csv' | 'amazon' | 'paypal';

interface ImportResult {
  parsed: number;
  inserted: number;
  duplicates: number;
  matched?: number;
  refundCandidates?: number;
  linkedOrders?: number;
}

interface ImportViewProps {
  onOpenParserSettings?: (parserId: string) => void;
}

export function ImportView({ onOpenParserSettings }: ImportViewProps = {}) {
  const appData = useSyncExternalStore(subscribe, getData, getData);
  const customParsers = appData.customParsers ?? [];
  const [importType, setImportType] = useState<ImportType>('csv');
  const [pasteText, setPasteText] = useState('');
  const [showParserForm, setShowParserForm] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [dupReview, setDupReview] = useState<{
    dups: Omit<Transaction, 'id'>[];
    unique: Omit<Transaction, 'id'>[];
    source: string;
  } | null>(null);
  const [dupSelected, setDupSelected] = useState<Set<number>>(new Set());
  const [refundPrompts, setRefundPrompts] = useState<RefundCandidate[]>([]);
  const [paypalFuzzy, setPaypalFuzzy] = useState<PaypalMatchCandidate[]>([]);
  const [paypalUnmatched, setPaypalUnmatched] = useState<Transaction[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const importTypeRef = useRef(importType);
  useEffect(() => { importTypeRef.current = importType; }, [importType]);

  useEffect(() => {
    let cleanup: (() => void) | null = null;
    getCurrentWebview().onDragDropEvent((event) => {
      const { type } = event.payload;
      if (type === 'enter' || type === 'over') {
        setDragOver(true);
      } else if (type === 'leave') {
        setDragOver(false);
      } else if (type === 'drop') {
        setDragOver(false);
        if (importTypeRef.current !== 'csv') return;
        const csvPath = event.payload.paths.find((p: string) => p.toLowerCase().endsWith('.csv'));
        if (!csvPath) return;
        invoke<string>('load_data', { path: csvPath })
          .then((text) => handleCsvImport(undefined, text))
          .catch((e) => setError(String(e)));
      }
    }).then((fn) => { cleanup = fn; });
    return () => { cleanup?.(); };
  }, []);

  function reset() {
    setResult(null);
    setError('');
    setDupReview(null);
  }

  async function insertAndReport(
    txns: Omit<Transaction, 'id'>[],
    source: string,
  ) {
    const splitActions = categorizeTransactionsInPlace(txns);
    const { duplicates, unique } = detectDuplicates(txns);
    // Remap split action indices from the original txns array to the unique txns array
    const remappedSplits = splitActions
      .map((a) => ({ ...a, txnIndex: unique.indexOf(txns[a.txnIndex]) }))
      .filter((a) => a.txnIndex >= 0);

    if (duplicates.length > 0) {
      setDupSelected(new Set());
      setDupReview({ dups: duplicates, unique, source });
      return;
    }

    await finalizeImportResult({
      txnsToInsert: unique,
      source,
      parsed: txns.length,
      duplicatesDropped: duplicates.length,
      splitActions: remappedSplits,
    });
  }

  async function finalizeImportResult(args: {
    txnsToInsert: Omit<Transaction, 'id'>[];
    source: string;
    parsed: number;
    duplicatesDropped: number;
    splitActions?: Array<{ txnIndex: number; splits: Array<{ categoryId: number; amount: number }> }>;
  }) {
    const { txnsToInsert, source, parsed, duplicatesDropped, splitActions = [] } = args;
    const ids = await bulkAddTransactions(txnsToInsert);
    // Apply split rules
    for (const action of splitActions) {
      const txnId = ids[action.txnIndex];
      if (txnId == null) continue;
      await setSplits(txnId, action.splits.map((s) => ({ categoryId: s.categoryId, amount: s.amount })));
    }

    let matched = 0;
    if (source === 'paypal_paste') {
      const { autoMatched, fuzzy, unmatched } = await matchPaypalTransactions(ids);
      matched = autoMatched;
      if (fuzzy.length > 0) setPaypalFuzzy(fuzzy);
      if (unmatched.length > 0) setPaypalUnmatched(unmatched);
    }

    const { transactions } = getData();
    const insertedTxns = transactions.filter((t) => ids.includes(t.id));
    const credits = insertedTxns.filter((t) => t.ignoreInBudget);
    let refundCandidateCount = 0;
    if (credits.length > 0) {
      const creditIds = credits.map((t) => t.id);
      const candidates = findRefundCandidates(creditIds);
      if (candidates.length > 0) {
        setRefundPrompts(candidates);
        refundCandidateCount = candidates.length;
      }
    }

    setResult({
      parsed,
      inserted: txnsToInsert.length,
      duplicates: duplicatesDropped,
      matched: source === 'paypal_paste' ? matched : undefined,
      refundCandidates: refundCandidateCount || undefined,
    });
  }

  async function confirmDupImportSkip() {
    if (!dupReview) return;
    await finalizeImportResult({
      txnsToInsert: dupReview.unique,
      source: dupReview.source,
      parsed: dupReview.unique.length + dupReview.dups.length,
      duplicatesDropped: dupReview.dups.length,
    });
    setDupReview(null);
  }

  async function confirmDupImportAll() {
    if (!dupReview) return;
    await finalizeImportResult({
      txnsToInsert: [...dupReview.unique, ...dupReview.dups],
      source: dupReview.source,
      parsed: dupReview.unique.length + dupReview.dups.length,
      duplicatesDropped: 0,
    });
    setDupReview(null);
  }

  async function confirmDupImportSelected() {
    if (!dupReview) return;
    const selectedDups = dupReview.dups.filter((_, i) => dupSelected.has(i));
    const skippedCount = dupReview.dups.length - selectedDups.length;
    await finalizeImportResult({
      txnsToInsert: [...dupReview.unique, ...selectedDups],
      source: dupReview.source,
      parsed: dupReview.unique.length + dupReview.dups.length,
      duplicatesDropped: skippedCount,
    });
    setDupReview(null);
  }

  function toggleDupSelected(index: number) {
    setDupSelected((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  async function handleRefundChoice(candidate: RefundCandidate, applyToOriginal: boolean) {
    if (applyToOriginal && candidate.refundTxn.id && candidate.originalTxn.id) {
      await applyRefundToOriginalMonth(candidate.refundTxn.id, candidate.originalTxn.id);
    }
    setRefundPrompts((prev) => prev.filter((r) => r.refundTxn.id !== candidate.refundTxn.id));
  }

  async function handleCsvImport(fileArg?: File, textArg?: string) {
    reset();
    setBusy(true);
    try {
      let text: string;
      let name = 'import.csv';
      if (textArg !== undefined) {
        text = textArg;
      } else {
        const file = fileArg ?? fileRef.current?.files?.[0];
        if (!file) { setBusy(false); return; }
        text = await file.text();
        name = file.name;
      }

      // Try built-in parser first
      const txns = parseBankCsv(text, name);
      if (txns.length > 0) {
        await insertAndReport(txns, 'bank_csv');
        return;
      }

      // Try each custom parser in order
      for (const parser of customParsers) {
        try {
          const customTxns = executeCustomParser(parser.code, text, name);
          if (customTxns.length > 0) {
            const withInstrument = customTxns.map((t) => ({ ...t, instrument: parser.name }));
            await insertAndReport(withInstrument, `custom_${parser.id}`);
            return;
          }
        } catch { /* try next */ }
      }

      throw new Error('No transactions parsed. Check the file format, or add a parser for your bank in Settings → Bank CSV Formats.');
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleAmazonOrderImport() {
    if (!pasteText.trim()) return;
    reset();
    setBusy(true);
    try {
      const orders = parseAmazonOrders(pasteText);
      if (orders.length === 0) throw new Error('No orders parsed from pasted text');

      // Store metadata for future backfills
      const amazonOrders: AmazonOrder[] = orders.map((o) => ({
        orderNum: o.orderNum,
        itemName: o.itemName,
        orderDate: o.orderDate,
        amount: o.amount,
        status: o.status,
      }));
      await addAmazonOrders(amazonOrders);

      const { transactions: existing } = getData();
      const amazonSources = new Set(['amazon_order', 'amazon_paste', 'amazon_payment']);
      const existingByOrder = new Map(
        existing
          .filter((t) => amazonSources.has(t.source) && t.sourceRef && t.sourceRef !== 'paste')
          .map((t) => [t.sourceRef, t]),
      );

      const toInsert: Omit<Transaction, 'id'>[] = [];
      let overwritten = 0;
      let skipped = 0;

      for (const o of orders) {
        if (o.amount === 0 && o.status === 'delivered') {
          skipped++;
          continue; // no price known, skip
        }
        const isReturnedOrCancelled = o.status === 'returned' || o.status === 'cancelled';
        const existingTxn = existingByOrder.get(o.orderNum);
        const descriptor = o.itemName
          ? `Amazon | ${o.itemName} | #${o.orderNum}`
          : `Amazon | #${o.orderNum}`;

        if (existingTxn) {
          if (isReturnedOrCancelled && existingTxn.amount > 0) {
            await updateTransaction(existingTxn.id!, {
              amount: 0,
              ignoreInBudget: true,
              source: 'amazon_order',
              descriptor,
            });
            overwritten++;
          } else {
            skipped++;
          }
          continue;
        }

        toInsert.push({
          source: 'amazon_order',
          sourceRef: o.orderNum,
          txnDate: o.orderDate,
          amount: isReturnedOrCancelled ? 0 : o.amount,
          instrument: 'Amazon',
          descriptor,
          categoryId: null,
          linkedTransactionId: null,
          ignoreInBudget: isReturnedOrCancelled,
          comment: null,
        });
      }

      const amazonSplits = categorizeTransactionsInPlace(toInsert);
      if (toInsert.length > 0) {
        const amazonIds = await bulkAddTransactions(toInsert);
        for (const action of amazonSplits) {
          const txnId = amazonIds[action.txnIndex];
          if (txnId != null) await setSplits(txnId, action.splits.map((s) => ({ categoryId: s.categoryId, amount: s.amount })));
        }
      }

      setResult({
        parsed: orders.length,
        inserted: toInsert.length,
        duplicates: skipped,
        linkedOrders: overwritten || undefined,
      });
      setPasteText('');
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handlePasteImport(type: 'paypal') {
    if (!pasteText.trim()) return;
    reset();
    setBusy(true);
    try {
      const txns = parsePaypalPaste(pasteText);
      if (txns.length === 0) throw new Error('No transactions parsed from pasted text');
      await insertAndReport(txns, `${type}_paste`);
      setPasteText('');
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h1 className="view-title">Import</h1>


      <div className="card">
        <div className="row" style={{ marginBottom: '0.75rem', flexWrap: 'wrap' }}>
          {(['csv', 'amazon', 'paypal'] as ImportType[]).map((t) => (
            <button
              key={t}
              className={`btn ${importType === t ? 'btn-primary' : 'btn-ghost'} btn-sm`}
              onClick={() => { setImportType(t); reset(); }}
            >
              {t === 'csv' ? 'Bank CSV' : t === 'amazon' ? 'Amazon' : 'PayPal'}
            </button>
          ))}
        </div>

        {importType === 'csv' && (
          <>
            {/* Supported formats list */}
            <div style={{ marginBottom: '0.75rem' }}>
              <div style={{ fontSize: '0.8rem', fontWeight: 600, marginBottom: '0.35rem' }}>Supported formats:</div>
              {['Scotia Chequing CSV', 'Scotia Credit Card CSV'].map((name) => (
                <div key={name} style={{ fontSize: '0.8rem', opacity: 0.7, marginBottom: '0.2rem' }}>
                  • <strong>{name}</strong>
                </div>
              ))}
              {customParsers.map((p) => (
                <div key={p.id} style={{ fontSize: '0.8rem', opacity: 0.7, marginBottom: '0.2rem' }}>
                  • {onOpenParserSettings ? (
                    <strong
                      style={{ cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: 2 }}
                      onClick={() => onOpenParserSettings(p.id)}
                    >{p.name}</strong>
                  ) : (
                    <strong>{p.name}</strong>
                  )}
                </div>
              ))}
              <button
                className="btn btn-ghost btn-sm"
                style={{ marginTop: '0.35rem', fontSize: '0.8rem' }}
                onClick={() => setShowParserForm((v) => !v)}
              >
                {showParserForm ? '− Cancel' : '+ Add format for my bank'}
              </button>
            </div>
            {showParserForm && (
              <div style={{ marginBottom: '0.75rem', padding: '0.65rem', border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}>
                <ParserGenerator
                  onParsersChange={() => setShowParserForm(false)}
                  onImportFile={async (txns, source) => {
                    setShowParserForm(false);
                    await insertAndReport(txns, source);
                  }}
                />
              </div>
            )}
            <div
              onClick={() => fileRef.current?.click()}
              style={{
                border: `2px dashed ${dragOver ? 'var(--accent, #14b8a6)' : 'var(--border)'}`,
                borderRadius: 'var(--radius-lg, 8px)',
                padding: '2rem 1.5rem',
                textAlign: 'center',
                background: dragOver ? 'var(--bg-2)' : 'transparent',
                transition: 'border-color 0.15s, background 0.15s',
                cursor: 'pointer',
                userSelect: 'none',
              }}
            >
              <div style={{ fontSize: '1.5rem', marginBottom: '0.4rem', opacity: 0.5 }}>↓</div>
              <div style={{ fontWeight: 600, marginBottom: '0.25rem' }}>
                {dragOver ? 'Drop to import' : 'Drop CSV here'}
              </div>
              <div style={{ fontSize: '0.8rem', opacity: 0.5 }}>or click to browse</div>
            </div>
            <input ref={fileRef} type="file" accept=".csv" style={{ display: 'none' }} onChange={() => handleCsvImport()} />
          </>
        )}

        {importType === 'amazon' && (
          <>
            <p style={{ fontSize: '0.8rem', opacity: 0.6 }}>
              Paste your Amazon order history. Each order creates a transaction. Returned or cancelled orders are automatically zeroed out. These will be added as new transactions.
            </p>
            <div className="field">
              <textarea
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
                placeholder={"Delivered March 21, 2026\nWireless Keyboard and Mouse...\nOrder placed\nMarch 21, 2026\nTotal $49.99\nOrder # 123-4567890-1234567"}
              />
            </div>
            <button className="btn btn-primary" onClick={handleAmazonOrderImport} disabled={busy}>
              Import Orders
            </button>
          </>
        )}

        {importType === 'paypal' && (
          <>
            <p style={{ fontSize: '0.8rem', opacity: 0.6 }}>
              Paste your PayPal activity text below. Imported entries will be matched against existing bank transactions and update the descriptor. Any that don't match a bank transaction can be added as new transactions instead.
            </p>
            <div className="field">
              <textarea
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
                placeholder="Feb 2026&#10;Sample Store&#10;$15.99&#10;Feb 1 . Automatic Payment"
              />
            </div>
            <button className="btn btn-primary" onClick={() => handlePasteImport('paypal')} disabled={busy}>
              Import PayPal
            </button>
          </>
        )}

      </div>

      {dupReview && (
        <div className="modal-overlay" onClick={() => setDupReview(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 600 }}>
            <h3>Duplicate Review</h3>
            <p style={{ fontSize: '0.85rem' }}>
              Found <strong>{dupReview.dups.length}</strong> possible duplicate{dupReview.dups.length !== 1 ? 's' : ''} and{' '}
              <strong>{dupReview.unique.length}</strong> new transaction{dupReview.unique.length !== 1 ? 's' : ''}.
              Check the ones you want to import anyway.
            </p>
            <div className="section-title">Possible duplicates</div>
            <div className="dup-list" style={{ maxHeight: 300, overflowY: 'auto' }}>
              {dupReview.dups.map((d, i) => (
                <label
                  className="dup-item"
                  key={i}
                  style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', padding: '0.35rem 0', background: dupSelected.has(i) ? 'rgba(59,130,246,0.1)' : undefined, borderRadius: 4 }}
                >
                  <input
                    type="checkbox"
                    checked={dupSelected.has(i)}
                    onChange={() => toggleDupSelected(i)}
                    style={{ accentColor: '#3b82f6', width: 16, height: 16, flexShrink: 0 }}
                  />
                  <span style={{ flex: 1 }}>{d.txnDate} — {d.descriptor.slice(0, 40)}</span>
                  <span>${formatAmount(d.amount)}</span>
                </label>
              ))}
            </div>
            <div className="modal-actions" style={{ flexWrap: 'wrap', gap: '0.5rem' }}>
              <button className="btn btn-ghost" onClick={() => setDupReview(null)}>Cancel</button>
              <button className="btn btn-ghost" onClick={confirmDupImportAll}>
                Import all ({dupReview.unique.length + dupReview.dups.length})
              </button>
              {dupSelected.size > 0 && (
                <button className="btn btn-primary" onClick={confirmDupImportSelected}>
                  Import {dupReview.unique.length + dupSelected.size} ({dupSelected.size} selected + {dupReview.unique.length} new)
                </button>
              )}
              {dupSelected.size === 0 && (
                <button className="btn btn-primary" onClick={confirmDupImportSkip}>
                  Import {dupReview.unique.length} new
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {refundPrompts.length > 0 && (
        <div className="modal-overlay" onClick={() => setRefundPrompts([])}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Possible Refund{refundPrompts.length > 1 ? 's' : ''} Detected</h3>
            {refundPrompts.map((r) => (
              <div key={r.refundTxn.id} style={{ marginBottom: '1rem', paddingBottom: '0.75rem', borderBottom: '1px solid var(--border-color)' }}>
                <div className="card" style={{ marginBottom: '0.5rem', borderLeft: '3px solid #22c55e' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
                    <span style={{ fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', background: '#22c55e', color: '#fff', padding: '0.1rem 0.4rem', borderRadius: '4px' }}>Credit</span>
                    <span style={{ fontSize: '0.75rem', opacity: 0.5 }}>Possible refund</span>
                  </div>
                  <div style={{ fontWeight: 600 }}>{r.refundTxn.descriptor}</div>
                  <div style={{ fontSize: '0.85rem' }}>
                    <span style={{ color: '#22c55e', fontWeight: 600 }}>+${formatAmount(r.refundTxn.amount)}</span>
                    {' '}on {r.refundTxn.txnDate}
                  </div>
                </div>
                <div className="card" style={{ marginBottom: '0.5rem', borderLeft: '3px solid #ef4444' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
                    <span style={{ fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', background: '#ef4444', color: '#fff', padding: '0.1rem 0.4rem', borderRadius: '4px' }}>Debit</span>
                    <span style={{ fontSize: '0.75rem', opacity: 0.5 }}>Original expense</span>
                  </div>
                  <div style={{ fontWeight: 600 }}>{r.originalTxn.descriptor}</div>
                  <div style={{ fontSize: '0.85rem' }}>
                    <span style={{ color: '#ef4444', fontWeight: 600 }}>-${formatAmount(r.originalTxn.amount)}</span>
                    {' '}on {r.originalTxn.txnDate}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <button className="btn btn-primary btn-sm" style={{ flex: 1 }} onClick={() => handleRefundChoice(r, true)}>
                    Count in {r.originalTxn.txnDate.slice(0, 7)}
                  </button>
                  <button className="btn btn-ghost btn-sm" style={{ flex: 1 }} onClick={() => handleRefundChoice(r, false)}>
                    Keep as new
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {paypalFuzzy.length > 0 && (
        <div className="modal-overlay" onClick={() => setPaypalFuzzy([])}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Confirm PayPal Matches</h3>
            <p style={{ fontSize: '0.85rem', marginBottom: '0.75rem' }}>
              These PayPal transactions have close but not exact amounts (likely due to currency conversion). Confirm each match or skip it.
            </p>
            {paypalFuzzy.map((m) => {
              const diff = Math.abs(m.paypalTxn.amount - m.cardTxn.amount);
              return (
                <div key={m.paypalTxn.id} style={{ marginBottom: '1rem', paddingBottom: '0.75rem', borderBottom: '1px solid var(--border-color)' }}>
                  <div className="card" style={{ marginBottom: '0.5rem', borderLeft: '3px solid #8b5cf6' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
                      <span style={{ fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', background: '#8b5cf6', color: '#fff', padding: '0.1rem 0.4rem', borderRadius: '4px' }}>PayPal</span>
                    </div>
                    <div style={{ fontWeight: 600 }}>{m.paypalTxn.descriptor}</div>
                    <div style={{ fontSize: '0.85rem' }}>
                      ${formatAmount(m.paypalTxn.amount)} on {m.paypalTxn.txnDate}
                      {m.paypalTxn.comment && <span style={{ fontSize: '0.8rem', opacity: 0.6, marginLeft: '0.5rem' }}>({m.paypalTxn.comment})</span>}
                    </div>
                  </div>
                  <div className="card" style={{ marginBottom: '0.5rem', borderLeft: '3px solid #3b82f6' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
                      <span style={{ fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', background: '#3b82f6', color: '#fff', padding: '0.1rem 0.4rem', borderRadius: '4px' }}>{m.cardTxn.instrument}</span>
                    </div>
                    <div style={{ fontWeight: 600 }}>{m.cardTxn.descriptor}</div>
                    <div style={{ fontSize: '0.85rem' }}>
                      ${formatAmount(m.cardTxn.amount)} on {m.cardTxn.txnDate}
                    </div>
                  </div>
                  <div style={{ fontSize: '0.8rem', opacity: 0.7, marginBottom: '0.5rem' }}>
                    Difference: ${formatAmount(diff)} ({(diff / Math.max(m.paypalTxn.amount, 0.01) * 100).toFixed(1)}%)
                  </div>
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <button
                      className="btn btn-primary btn-sm"
                      style={{ flex: 1 }}
                      onClick={async () => {
                        await confirmPaypalMatch(m.paypalTxn.id!, m.cardTxn.id!);
                        setPaypalFuzzy((prev) => prev.filter((x) => x.paypalTxn.id !== m.paypalTxn.id));
                      }}
                    >
                      Link these
                    </button>
                    <button
                      className="btn btn-ghost btn-sm"
                      style={{ flex: 1 }}
                      onClick={() => setPaypalFuzzy((prev) => prev.filter((x) => x.paypalTxn.id !== m.paypalTxn.id))}
                    >
                      Skip
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {paypalUnmatched.length > 0 && (
        <div className="modal-overlay" onClick={() => {}}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 600 }}>
            <h3>Unmatched PayPal Transactions</h3>
            <p style={{ fontSize: '0.85rem', marginBottom: '0.25rem' }}>
              These PayPal transactions could not be matched to any bank debit. They are most likely
              already recorded from your bank statement — keeping them will create duplicates.
            </p>
            <p style={{ fontSize: '0.85rem', opacity: 0.65, marginBottom: '0.75rem' }}>
              <strong>Recommended: discard them.</strong> Only keep if you're certain there is no matching bank entry.
            </p>
            <div style={{ maxHeight: 400, overflowY: 'auto' }}>
              {paypalUnmatched.map((t) => (
                <div key={t.id} style={{ marginBottom: '0.75rem', paddingBottom: '0.75rem', borderBottom: '1px solid var(--border-color)' }}>
                  <div className="card" style={{ marginBottom: '0.5rem', borderLeft: '3px solid #f59e0b' }}>
                    <div style={{ fontWeight: 600 }}>{t.descriptor}</div>
                    <div style={{ fontSize: '0.85rem' }}>
                      ${formatAmount(t.amount)} on {t.txnDate}
                      {t.comment && <span style={{ fontSize: '0.8rem', opacity: 0.6, marginLeft: '0.5rem' }}>({t.comment})</span>}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <button
                      className="btn btn-primary btn-sm"
                      style={{ flex: 1 }}
                      onClick={async () => {
                        await discardPaypalTransactions([t.id]);
                        setPaypalUnmatched((prev) => prev.filter((x) => x.id !== t.id));
                      }}
                    >
                      Discard
                    </button>
                    <button
                      className="btn btn-ghost btn-sm"
                      style={{ flex: 1, opacity: 0.6 }}
                      onClick={() => setPaypalUnmatched((prev) => prev.filter((x) => x.id !== t.id))}
                    >
                      Keep anyway
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <div className="modal-actions" style={{ marginTop: '0.75rem' }}>
              <button
                className="btn btn-primary"
                onClick={async () => {
                  await discardPaypalTransactions(paypalUnmatched.map((t) => t.id));
                  setPaypalUnmatched([]);
                }}
              >
                Discard all {paypalUnmatched.length}
              </button>
              <button
                className="btn btn-ghost"
                style={{ opacity: 0.6 }}
                onClick={() => setPaypalUnmatched([])}
              >
                Keep all anyway
              </button>
            </div>
          </div>
        </div>
      )}

      {result && (
        <div className="import-status success">
          Parsed: {result.parsed} | Inserted: {result.inserted} | Duplicates dropped: {result.duplicates}
          {result.matched !== undefined && ` | PayPal matched: ${result.matched}`}
          {result.linkedOrders !== undefined && ` | Linked to orders: ${result.linkedOrders}`}
          {result.refundCandidates !== undefined && ` | Refund candidates: ${result.refundCandidates}`}
        </div>
      )}

      {error && <div className="import-status error">{error}</div>}
    </div>
  );
}
