import { memo, forwardRef, useImperativeHandle, useState, useEffect, useRef, type MutableRefObject } from 'react';
import { createPortal } from 'react-dom';
import type { Transaction, TransactionSplit } from '../db';
import { SearchableSelect, type SearchableSelectOption } from './SearchableSelect';
import { formatAmount } from '../utils/format';
import { isCredit, isPaypalLinked } from '../logic/txnKind';

/** Handlers a row can call. Passed as a ref so rows don't re-render when the parent re-creates them. */
export interface TxnRowActions {
  assignCategory: (txnId: number, categoryId: number | null) => void;
  setEditingCategory: (txnId: number | null) => void;
  toggleStar: (t: Transaction) => void;
  editStarNote: (t: Transaction) => void;
  toggleTransfer: (t: Transaction) => void;
  openRule: (t: Transaction) => void;
  openSplit: (t: Transaction) => void;
  openMoveMonth: (t: Transaction) => void;
  editComment: (t: Transaction) => void;
  lookup: (t: Transaction) => void;
  /** Show why the suggestion chip guessed what it did (or nothing). Local only, no AI. */
  explain: (t: Transaction) => void;
  confirmDelete: (txnId: number) => void;
  showTooltip: (cell: HTMLElement) => void;
  hideTooltip: () => void;
}

interface TxnRowProps {
  t: Transaction;
  /** See txnRowSignature in TransactionView — forces a re-render when the txn is mutated in place. */
  sig: string;
  rowClass: string;
  splits: TransactionSplit[] | undefined;
  isEditingCategory: boolean;
  /** History-match suggestion, as primitives so memo can skip rows whose suggestion didn't change. */
  suggestionCatId: number | undefined;
  suggestionName: string | undefined;
  suggestionTitle: string | undefined;
  /** The chip comes from a saved ? lookup (history made no guess). */
  suggestionFromAi: boolean;
  catMap: Map<number, string>;
  catColorMap: Map<number, string>;
  categoryOptions: SearchableSelectOption[];
  aiLookupEnabled: boolean;
  actions: MutableRefObject<TxnRowActions>;
}

export const TxnRow = memo(function TxnRow({
  t, rowClass, splits, isEditingCategory, suggestionCatId, suggestionName, suggestionTitle, suggestionFromAi,
  catMap, catColorMap, categoryOptions, aiLookupEnabled, actions,
}: TxnRowProps) {
  const a = () => actions.current;
  const credit = isCredit(t) || t.amount < 0;
  const suggestionColor = suggestionCatId != null ? catColorMap.get(suggestionCatId) ?? '#888' : '';
  // Same rows the chips are computed for (TransactionView allSuggestions).
  const canExplain = t.categoryId == null && !(splits && splits.length > 0) && !isCredit(t) && !t.isTransfer;

  return (
    <tr className={rowClass} style={t.isTransfer ? { opacity: 0.55 } : undefined}>
      <td style={{ whiteSpace: 'nowrap' }}>{t.txnDate}</td>
      <td
        className="descriptor-cell"
        data-tooltip={t.descriptor}
        onMouseEnter={(e) => a().showTooltip(e.currentTarget)}
        onMouseLeave={() => a().hideTooltip()}
      >
        <span className="descriptor-text">{t.descriptor}</span>
        {t.isTransfer && <span className="chip" style={{ marginLeft: '4px', background: '#64748b', color: '#fff' }}>Transfer</span>}
        {isPaypalLinked(t) && <span className="chip" style={{ marginLeft: '4px', background: '#8b5cf6', color: '#fff' }}>PayPal</span>}
        {t.linkedTransactionId && !isPaypalLinked(t) && <span className="chip" style={{ marginLeft: '4px' }}>linked</span>}
      </td>
      <td>{t.instrument}</td>
      <td className={`num budget-num ${credit ? 'positive' : 'txn-neg'}`}>
        {t.amount === 0 ? '' : credit ? '+' : '-'}${formatAmount(Math.abs(t.amount))}
      </td>
      <td>
        {splits && splits.length > 0 ? (
          <span className="chip" title={splits.map((s) => `${catMap.get(s.categoryId) ?? '?'}: $${formatAmount(s.amount)}`).join(', ')}>
            Split ({splits.length})
          </span>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap' }}>
            {t.categoryId != null && !isEditingCategory ? (
              <span
                className="chip"
                style={{ cursor: 'pointer', background: catColorMap.get(t.categoryId) ?? '#888', color: '#fff', whiteSpace: 'nowrap', fontWeight: 600 }}
                title="Click to change category"
                onClick={() => a().setEditingCategory(t.id)}
              >
                {catMap.get(t.categoryId) ?? '?'}
              </span>
            ) : (
              <SearchableSelect
                options={categoryOptions}
                value={t.categoryId ?? ''}
                onChange={(v) => {
                  a().assignCategory(t.id, v === '' ? null : Number(v));
                  a().setEditingCategory(null);
                }}
                placeholder="Uncategorized"
                compact
                style={{ fontSize: '0.67rem' }}
              />
            )}
            {t.categoryId == null && suggestionCatId != null && (
              <span
                className="chip"
                style={{
                  cursor: 'pointer',
                  background: suggestionColor + '33',
                  color: suggestionColor,
                  border: `1px ${suggestionFromAi ? 'dashed' : 'solid'} ${suggestionColor}${suggestionFromAi ? 'aa' : '66'}`,
                  whiteSpace: 'nowrap',
                  fontSize: '0.67rem',
                  fontWeight: 500,
                }}
                title={suggestionTitle}
                onClick={() => a().assignCategory(t.id, suggestionCatId)}
              >
                {suggestionFromAi ? '✦ ' : '~'}{suggestionName}
              </span>
            )}
            {canExplain && (
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => a().explain(t)}
                title={suggestionCatId != null ? 'Why this suggestion?' : 'Why no suggestion?'}
                style={{ padding: '0 0.3rem', fontSize: '0.7rem', opacity: 0.55, lineHeight: 1.4 }}
              >
                ⓘ
              </button>
            )}
          </div>
        )}
      </td>
      <td className="txn-action-cell">
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => a().toggleStar(t)}
          title={t.starred ? 'Unstar transaction' : 'Star transaction'}
          style={{ color: t.starred ? '#fbbf24' : undefined, fontWeight: t.starred ? 'bold' : 'normal' }}
        >
          {t.starred ? '★' : '☆'}
        </button>
        {t.starred && (
          <button
            className={`btn btn-sm ${t.starNote ? 'btn-warning' : 'btn-ghost'}`}
            onClick={() => a().editStarNote(t)}
            title={t.starNote ? 'View/edit star note' : 'Add star note'}
            style={{ fontWeight: t.starNote ? 'bold' : 'normal' }}
          >
            🏷
          </button>
        )}
        <button
          className={`btn btn-sm ${t.isTransfer ? 'btn-warning' : 'btn-ghost'}`}
          onClick={() => a().toggleTransfer(t)}
          title={t.isTransfer ? 'Unmark transfer' : 'Mark as transfer between your own accounts'}
        >
          ⇄
        </button>
        <button className="btn btn-ghost btn-sm" onClick={() => a().openRule(t)} title="Create rule">
          Create Rule
        </button>
        <button className="btn btn-ghost btn-sm" onClick={() => a().openSplit(t)} title="Split transaction">
          Split Txn
        </button>
        <button className="btn btn-ghost btn-sm" onClick={() => a().openMoveMonth(t)} title="Count in different month">
          📅
        </button>
        <button
          className={`btn btn-sm ${t.comment ? 'btn-warning' : 'btn-ghost'}`}
          onClick={() => a().editComment(t)}
          title={t.comment ? 'View/edit comment' : 'Add comment'}
          style={{ fontWeight: t.comment ? 'bold' : 'normal' }}
        >
          💬
        </button>
        {aiLookupEnabled && (
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => a().lookup(t)}
            title="Identify this transaction with AI"
            style={{ fontWeight: 600, opacity: 0.7 }}
          >
            ?
          </button>
        )}
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => a().confirmDelete(t.id)}
          title="Delete transaction"
          style={{ color: 'var(--red)', fontWeight: 600 }}
        >
          🗑
        </button>
      </td>
    </tr>
  );
});

export interface DescriptorTooltipHandle {
  show: (cell: HTMLElement) => void;
  hide: () => void;
}

/** Owns its own state so hovering a row re-renders only the tooltip, not the whole table. */
export const DescriptorTooltip = forwardRef<DescriptorTooltipHandle>(function DescriptorTooltip(_props, ref) {
  const [tip, setTip] = useState<{ text: string; top: number; left: number; flipUp: boolean } | null>(null);
  const lastScroll = useRef(0);

  // Rows slide under the cursor while scrolling; don't pop the tooltip for each one.
  useEffect(() => {
    const mark = () => { lastScroll.current = performance.now(); };
    window.addEventListener('scroll', mark, { capture: true, passive: true });
    window.addEventListener('wheel', mark, { passive: true });
    return () => {
      window.removeEventListener('scroll', mark, { capture: true });
      window.removeEventListener('wheel', mark);
    };
  }, []);

  useImperativeHandle(ref, () => ({
    show(cell) {
      const text = cell.getAttribute('data-tooltip') || '';
      if (!text || performance.now() - lastScroll.current < 200) return;
      const rect = cell.getBoundingClientRect();
      const flipUp = window.innerHeight - rect.bottom < 80;
      setTip({ text, top: flipUp ? rect.top - 4 : rect.bottom + 4, left: rect.left, flipUp });
    },
    hide() {
      setTip(null);
    },
  }), []);

  // A fixed-position tooltip would drift away from its row while scrolling, so drop it.
  useEffect(() => {
    if (!tip) return;
    const hide = () => setTip(null);
    window.addEventListener('scroll', hide, { capture: true, passive: true });
    window.addEventListener('wheel', hide, { passive: true });
    return () => {
      window.removeEventListener('scroll', hide, { capture: true });
      window.removeEventListener('wheel', hide);
    };
  }, [tip]);

  if (!tip) return null;
  return createPortal(
    <div
      className="descriptor-tooltip"
      style={{ top: tip.top, left: tip.left, transform: tip.flipUp ? 'translateY(-100%)' : undefined }}
    >
      {tip.text}
    </div>,
    document.body,
  );
});
