import { useState, useEffect } from 'react';
import { getData, setSplits, clearSplits, subscribe, type Transaction, type Category } from '../db';
import { SearchableSelect } from './SearchableSelect';
import { formatAmount } from '../utils/format';

interface Props {
  transaction: Transaction;
  categories: Category[];
  onClose: () => void;
}

interface SplitLine {
  categoryId: number | '';
  amount: string;
  txnDate?: string; // optional: assign this split to a different month
}

export function SplitEditor({ transaction, categories, onClose }: Props) {
  const [lines, setLines] = useState<SplitLine[]>([
    { categoryId: '', amount: '' },
    { categoryId: '', amount: '' },
  ]);

  useEffect(() => {
    function load() {
      const { transactionSplits } = getData();
      const existing = transactionSplits.filter((s) => s.transactionId === transaction.id);
      if (existing.length > 0) {
        setLines(existing.map((s) => ({
          categoryId: s.categoryId,
          amount: String(s.amount),
          txnDate: s.txnDate,
        })));
      }
    }
    load();
    return subscribe(load);
  }, [transaction.id]);

  function updateLine(i: number, field: keyof SplitLine, value: string | number) {
    setLines((prev) => prev.map((l, j) => j === i ? { ...l, [field]: value } : l));
  }

  function addLine() {
    setLines((prev) => [...prev, { categoryId: '', amount: '' }]);
  }

  function removeLine(i: number) {
    setLines((prev) => prev.filter((_, j) => j !== i));
  }

  const totalSplit = lines.reduce((s, l) => s + (parseFloat(l.amount) || 0), 0);
  const diff = transaction.amount - totalSplit;
  const valid = Math.abs(diff) < 0.01 && lines.every((l) => l.categoryId !== '' && parseFloat(l.amount) > 0);

  async function save() {
    if (!valid) return;
    await setSplits(
      transaction.id,
      lines.map((l) => ({
        categoryId: l.categoryId as number,
        amount: parseFloat(l.amount),
        ...(l.txnDate ? { txnDate: l.txnDate } : {}),
      })),
    );
    onClose();
  }

  async function handleClearSplits() {
    await clearSplits(transaction.id);
    onClose();
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 680 }} onClick={(e) => e.stopPropagation()}>
        <h3>Split Transaction</h3>
        <p style={{ fontSize: '0.8rem', opacity: 0.6 }}>
          {transaction.descriptor} — ${formatAmount(transaction.amount)}
        </p>

        {lines.map((l, i) => {
          const selYear = l.txnDate ? l.txnDate.substring(0, 4) : '';
          const selMonth = l.txnDate ? l.txnDate.substring(5, 7) : '';
          const curYear = new Date().getFullYear();
          const MONTHS = ['01','02','03','04','05','06','07','08','09','10','11','12'];
          const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
          function setMonthYear(year: string, month: string) {
            if (year && month) {
              updateLine(i, 'txnDate', `${year}-${month}-01`);
            } else {
              updateLine(i, 'txnDate', undefined as unknown as string);
            }
          }
          return (
            <div key={i} style={{ display: 'flex', gap: '0.4rem', marginBottom: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
              <div style={{ flex: '2 1 140px', minWidth: 0 }}>
                <SearchableSelect
                  options={categories.map((c) => ({ value: c.id, label: c.name }))}
                  value={l.categoryId}
                  onChange={(v) => updateLine(i, 'categoryId', v === '' ? '' : Number(v))}
                  placeholder="Category..."
                />
              </div>
              <input
                type="number"
                step="0.01"
                placeholder="$"
                value={l.amount}
                onChange={(e) => updateLine(i, 'amount', e.target.value)}
                style={{ flex: '0 0 80px', width: 80 }}
              />
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.2rem', flexShrink: 0 }}>
                <span style={{ fontSize: '0.72rem', opacity: 0.45 }}>mo:</span>
                <select
                  value={selMonth}
                  onChange={(e) => setMonthYear(selYear || String(curYear), e.target.value)}
                  style={{ fontSize: '0.78rem', padding: '0.2rem 0.2rem' }}
                >
                  <option value="">—</option>
                  {MONTHS.map((m, idx) => (
                    <option key={m} value={m}>{MONTH_NAMES[idx]}</option>
                  ))}
                </select>
                <select
                  value={selYear}
                  onChange={(e) => setMonthYear(e.target.value, selMonth || '01')}
                  style={{ fontSize: '0.78rem', padding: '0.2rem 0.2rem' }}
                >
                  <option value="">—</option>
                  {[curYear - 1, curYear, curYear + 1].map((y) => (
                    <option key={y} value={String(y)}>{y}</option>
                  ))}
                </select>
                {l.txnDate && (
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => updateLine(i, 'txnDate', undefined as unknown as string)}
                    title="Reset to transaction date"
                    style={{ padding: '0.1rem 0.3rem', fontSize: '0.7rem' }}
                  >
                    ✕
                  </button>
                )}
              </div>
              <button
                className="btn btn-danger btn-sm"
                style={{ flexShrink: 0, padding: '0.2rem 0.45rem' }}
                onClick={() => removeLine(i)}
              >
                ×
              </button>
            </div>
          );
        })}

        <button className="btn btn-ghost btn-sm" onClick={addLine}>+ Add line</button>

        <p style={{ fontSize: '0.8rem', marginTop: '0.5rem' }}>
          Split total: ${formatAmount(totalSplit)} | Remaining: <span className={Math.abs(diff) < 0.01 ? 'positive' : 'negative'}>${formatAmount(diff)}</span>
        </p>

        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={handleClearSplits}>Clear splits</button>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={!valid}>Save</button>
        </div>
      </div>
    </div>
  );
}
