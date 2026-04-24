import { useState, useCallback, useMemo, useSyncExternalStore, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  getData,
  subscribe,
  addTransaction,
  updateTransaction,
  deleteTransactions,
  addCategoryRule,
  type Transaction,
  type TransactionSplit,
} from '../db';
import { bulkCategorizeByDescriptor, bulkApplySplitRule, batchGetGuessScores } from '../logic/categorize';
import { findRefundCandidates, applyRefundToOriginalMonth, type RefundCandidate } from '../logic/refunds';
import { SplitEditor } from './SplitEditor';
import { SearchableSelect } from './SearchableSelect';
import { TransactionLookup } from './TransactionLookup';
import { formatAmount } from '../utils/format';
import type { CategorySuggestion } from '../logic/llm';

function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function useAppData() {
  const snapshot = useSyncExternalStore(subscribe, getData, getData);
  return snapshot;
}

interface NavFilter {
  month?: string;
  categoryId?: number;
  offBudget?: boolean;
}

interface TransactionViewProps {
  search?: string;
  navFilter?: NavFilter | null;
  onNavConsumed?: () => void;
  txnAiLookupEnabled?: boolean;
  onNeedOllama?: () => void;
}

export function TransactionView({ search = '', navFilter, onNavConsumed, txnAiLookupEnabled, onNeedOllama }: TransactionViewProps) {
  const appData = useAppData();
  const categories = appData.categories;
  const allTransactions = appData.transactions;
  const allSplits = appData.transactionSplits;

  const [monthFilter, setMonthFilter] = useState<string | 'all'>(currentMonth());
  const month = monthFilter === 'all' ? currentMonth() : monthFilter;
  const [ruleModal, setRuleModal] = useState<Transaction | null>(null);
  const [rulePattern, setRulePattern] = useState('');
  const [ruleType, setRuleType] = useState<'exact' | 'contains'>('exact');
  const [ruleCatId, setRuleCatId] = useState<number | ''>('');
  const [ruleAmount, setRuleAmount] = useState('');
  const [ruleAmountRequired, setRuleAmountRequired] = useState(false);
  const [ruleIsSplit, setRuleIsSplit] = useState(false);
  const [ruleSplitType, setRuleSplitType] = useState<'%' | '$'>('%');
  const [ruleSplits, setRuleSplits] = useState<Array<{ categoryId: number | ''; amount: string }>>([
    { categoryId: '', amount: '' },
    { categoryId: '', amount: '' },
  ]);
  const [splitTxn, setSplitTxn] = useState<Transaction | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [refundPrompts, setRefundPrompts] = useState<RefundCandidate[]>([]);
  const [editingCommentId, setEditingCommentId] = useState<number | null>(null);
  const [editingCommentText, setEditingCommentText] = useState('');
  const [moveMonthTxn, setMoveMonthTxn] = useState<Transaction | null>(null);
  const [moveMonthYear, setMoveMonthYear] = useState('');
  const [moveMonthNum, setMoveMonthNum] = useState('');
  const [lookupTxn, setLookupTxn] = useState<Transaction | null>(null);
  const [editingCategoryId, setEditingCategoryId] = useState<number | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [tooltip, setTooltip] = useState<{ text: string; top: number; left: number; flipUp: boolean } | null>(null);

  // History-based suggestions using the 4-tier point system (exact → stripped IDs → fuzzy → keywords).
  // Only computed for visible transactions; corpus is preprocessed once for all queries.
  const { allSuggestions, historyScoresMap } = useMemo(() => {
    const uncatVisible = txns.filter((t) => t.categoryId == null && !t.ignoreInBudget);
    const queries = uncatVisible.map((t) => ({ id: t.id, descriptor: t.descriptor }));
    const scoresMap = batchGetGuessScores(queries, allTransactions);
    const suggestions = new Map<number, CategorySuggestion>();
    const catMapLocal = new Map(categories.map((c) => [c.id, c]));
    for (const t of uncatVisible) {
      const scores = scoresMap.get(t.id);
      if (!scores) continue;
      const catId = [...scores.entries()].sort((a, b) => b[1] - a[1])[0][0];
      const cat = catMapLocal.get(catId);
      if (cat) suggestions.set(t.id, { txnId: t.id, categoryId: catId, categoryName: cat.name });
    }
    return { allSuggestions: suggestions, historyScoresMap: scoresMap };
  }, [txns, allTransactions, categories]);

  const showTooltip = useCallback((e: React.MouseEvent<HTMLTableCellElement>) => {
    const cell = e.currentTarget;
    const text = cell.getAttribute('data-tooltip') || '';
    if (!text) return;
    const rect = cell.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const flipUp = spaceBelow < 80;
    const top = flipUp ? rect.top - 4 : rect.bottom + 4;
    setTooltip({ text, top, left: rect.left, flipUp });
  }, []);

  const hideTooltip = useCallback(() => {
    setTooltip(null);
  }, []);

  // Manual transaction form state
  const [mDate, setMDate] = useState(() => new Date().toISOString().split('T')[0]);
  const [mAmount, setMAmount] = useState('');
  const [mDescriptor, setMDescriptor] = useState('');
  const [mInstrument, setMInstrument] = useState('');
  const [mCategoryId, setMCategoryId] = useState<number | ''>('');
  const [mType, setMType] = useState<'expense' | 'credit'>('expense');
  const [mComment, setMComment] = useState('');

  const [catFilter, setCatFilter] = useState<'all' | 'categorized' | 'uncategorized'>('all');
  const [categoryFilter, setCategoryFilter] = useState<number | ''>('');
  const [instrumentFilter, setInstrumentFilter] = useState<string>('');
  const [offBudgetFilter, setOffBudgetFilter] = useState(false);
  const navFilterApplied = useRef(false);

  // Apply nav filter from external navigation (e.g. clicking "Spent" in Budget view)
  useEffect(() => {
    if (navFilter && !navFilterApplied.current) {
      navFilterApplied.current = true;
      if (navFilter.month) setMonthFilter(navFilter.month);
      if (navFilter.categoryId != null) setCategoryFilter(navFilter.categoryId);
      if (navFilter.offBudget) setOffBudgetFilter(true);
      if ((navFilter as { uncategorized?: boolean }).uncategorized) setCatFilter('uncategorized');
      onNavConsumed?.();
    }
    if (!navFilter) { navFilterApplied.current = false; }
  }, [navFilter, onNavConsumed]);

  const splitsMap = useMemo(() => {
    const m = new Map<number, TransactionSplit[]>();
    for (const s of allSplits) {
      const arr = m.get(s.transactionId) ?? [];
      arr.push(s);
      m.set(s.transactionId, arr);
    }
    return m;
  }, [allSplits]);

  const catMap = useMemo(() => new Map(categories.map((c) => [c.id!, c.name])), [categories]);
  const catColorMap = useMemo(() => new Map(categories.map((c) => [c.id!, c.color ?? '#888'])), [categories]);
  const categoryOptions = useMemo(() => categories.map((c) => ({ value: c.id, label: c.name })), [categories]);
  const instrumentOptions = useMemo(() =>
    [...new Set(allTransactions.map((t) => t.instrument).filter(Boolean))].sort().map((i) => ({ value: i, label: i })),
    [allTransactions],
  );

  const txns = useMemo(() => {
    const monthStart = `${month}-01`;
    const monthEnd = `${month}-31`;
    let result = allTransactions
      .filter((t) => monthFilter === 'all' || (t.txnDate >= monthStart && t.txnDate <= monthEnd))
      .sort((a, b) => (b.txnDate > a.txnDate ? 1 : b.txnDate < a.txnDate ? -1 : b.id - a.id));
    if (catFilter === 'categorized') result = result.filter((t) => {
      const splits = splitsMap.get(t.id);
      return t.categoryId != null || (splits && splits.length > 0);
    });
    if (catFilter === 'uncategorized') result = result.filter((t) => {
      const splits = splitsMap.get(t.id);
      return t.categoryId == null && (!splits || splits.length === 0);
    });
    if (categoryFilter !== '') result = result.filter((t) => {
      const splits = splitsMap.get(t.id);
      if (splits && splits.length > 0) return splits.some((s) => s.categoryId === categoryFilter);
      return t.categoryId === categoryFilter;
    });
    if (instrumentFilter !== '') result = result.filter((t) => t.instrument === instrumentFilter);
    if (offBudgetFilter) {
      const d = getData();
      const budgetedCatIds = new Set(d.budgets.filter((b) => b.month === month).map((b) => b.categoryId));
      const incomeCatIds = new Set(d.categories.filter((c) => c.isIncome).map((c) => c.id));
      result = result.filter((t) => {
        const splits = splitsMap.get(t.id);
        if (splits && splits.length > 0) return splits.some((s) => !budgetedCatIds.has(s.categoryId) && !incomeCatIds.has(s.categoryId));
        return t.categoryId != null && !budgetedCatIds.has(t.categoryId) && !incomeCatIds.has(t.categoryId);
      });
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      result = result.filter((t) => {
        const catName = t.categoryId ? (catMap.get(t.categoryId) ?? '') : '';
        return t.descriptor.toLowerCase().includes(q)
          || (t.instrument ?? '').toLowerCase().includes(q)
          || t.txnDate.includes(q)
          || String(t.amount).includes(q)
          || catName.toLowerCase().includes(q)
          || (t.comment ?? '').toLowerCase().includes(q);
      });
    }
    return result;
  }, [allTransactions, monthFilter, month, catFilter, categoryFilter, instrumentFilter, offBudgetFilter, search, splitsMap, catMap]);

  const uncatCount = useMemo(() => allTransactions.filter((t) => {
    const splits = splitsMap.get(t.id);
    return t.categoryId == null && (!splits || splits.length === 0);
  }).length, [allTransactions, splitsMap]);

  async function assignCategory(txnId: number, categoryId: number | null) {
    await updateTransaction(txnId, { categoryId });
  }

  function openRuleModal(txn: Transaction) {
    setRuleModal(txn);
    setRulePattern(txn.descriptor);
    setRuleType('exact');
    setRuleCatId(txn.categoryId ?? '');
    setRuleAmount(txn.amount ? String(txn.amount) : '');
    setRuleAmountRequired(false);
    setRuleIsSplit(false);
    setRuleSplitType('%');
    setRuleSplits([
      { categoryId: '', amount: '' },
      { categoryId: '', amount: '' },
    ]);
  }

  async function createRule() {
    if (!rulePattern) return;
    const hasDollarSplit = ruleIsSplit && ruleSplitType === '$';
    const amountVal = (ruleAmountRequired || hasDollarSplit) && ruleAmount.trim() ? parseFloat(ruleAmount) : null;

    if (ruleIsSplit) {
      const validSplits = ruleSplits.filter((s) => s.categoryId !== '' && s.amount.trim() !== '');
      if (validSplits.length < 2) return;
      if (hasDollarSplit && !amountVal) return; // $ splits require amount
      const primaryCatId = validSplits[0].categoryId as number;
      const splitItems = validSplits.map((s) => ({
        categoryId: s.categoryId as number,
        ...(ruleSplitType === '%' ? { percent: parseFloat(s.amount) } : { amount: parseFloat(s.amount) }),
      }));
      await addCategoryRule({
        matchType: ruleType,
        pattern: rulePattern.toLowerCase(),
        categoryId: primaryCatId,
        amountMatch: amountVal,
        splits: splitItems,
      });
      const count = await bulkApplySplitRule(rulePattern, ruleType, amountVal, splitItems);
      setRuleModal(null);
      alert(`Split rule created. ${count} transaction${count !== 1 ? 's' : ''} split.`);
    } else {
      if (!ruleCatId) return;
      await addCategoryRule({
        matchType: ruleType,
        pattern: rulePattern.toLowerCase(),
        categoryId: ruleCatId as number,
        amountMatch: amountVal,
      });
      const count = await bulkCategorizeByDescriptor(rulePattern, ruleCatId as number, ruleType, amountVal ?? undefined);
      setRuleModal(null);
      alert(`Rule created. ${count} transactions categorized.`);
    }
  }

  function startEditComment(txn: Transaction) {
    setEditingCommentId(txn.id);
    setEditingCommentText(txn.comment ?? '');
  }

  async function saveComment() {
    if (editingCommentId === null) return;
    await updateTransaction(editingCommentId, {
      comment: editingCommentText.trim() || null,
    });
    setEditingCommentId(null);
    setEditingCommentText('');
  }

  async function addManualTransaction() {
    const amount = parseFloat(mAmount);
    if (!mDate || isNaN(amount) || amount <= 0 || !mDescriptor.trim()) return;

    const isCredit = mType === 'credit';
    const txn: Omit<Transaction, 'id'> = {
      source: 'manual',
      sourceRef: 'manual',
      txnDate: mDate,
      amount,
      instrument: mInstrument.trim() || 'Manual',
      descriptor: mDescriptor.trim(),
      categoryId: mCategoryId ? (mCategoryId as number) : null,
      linkedTransactionId: null,
      ignoreInBudget: isCredit,
      comment: mComment.trim() || null,
    };

    const id = await addTransaction(txn);

    if (isCredit && id !== undefined) {
      const candidates = findRefundCandidates([id]);
      if (candidates.length > 0) {
        setRefundPrompts(candidates);
      }
    }

    setMAmount('');
    setMDescriptor('');
    setMInstrument('');
    setMCategoryId('');
    setMComment('');
    setShowAddForm(false);
  }

  function openMoveMonth(txn: Transaction) {
    setMoveMonthTxn(txn);
    const y = txn.txnDate.slice(0, 4);
    const m = txn.txnDate.slice(5, 7);
    setMoveMonthYear(y);
    setMoveMonthNum(m);
  }

  async function confirmMoveMonth() {
    if (!moveMonthTxn || !moveMonthYear || !moveMonthNum) return;
    const oldDay = moveMonthTxn.txnDate.slice(8, 10);
    const newDate = `${moveMonthYear}-${moveMonthNum}-${oldDay}`;
    // Preserve the actual bank date for duplicate detection; only the display/budget month changes.
    const originalDate = moveMonthTxn.originalTxnDate ?? moveMonthTxn.txnDate;
    const dateNote = `[original date: ${originalDate}]`;
    const existingComment = moveMonthTxn.comment ?? '';
    const newComment = existingComment.includes('[original date:')
      ? existingComment
      : [existingComment, dateNote].filter(Boolean).join(' ').trim();
    await updateTransaction(moveMonthTxn.id, {
      txnDate: newDate,
      originalTxnDate: originalDate,
      comment: newComment,
    });
    setMoveMonthTxn(null);
  }

  async function handleRefundChoice(candidate: RefundCandidate, applyToOriginal: boolean) {
    if (applyToOriginal && candidate.refundTxn.id && candidate.originalTxn.id) {
      await applyRefundToOriginalMonth(candidate.refundTxn.id, candidate.originalTxn.id);
    }
    setRefundPrompts((prev) => prev.filter((r) => r.refundTxn.id !== candidate.refundTxn.id));
  }

  return (
    <div>
      <h1 className="view-title">Transactions</h1>

      {uncatCount > 0 && (
        <div className="card" style={{ borderLeft: '3px solid #fbbf24' }}>
          <strong>{uncatCount}</strong> uncategorized transaction{uncatCount !== 1 ? 's' : ''}
        </div>
      )}

      <div className="month-nav" style={{ flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center', fontSize: '0.875rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
          <button
            type="button"
            className="btn btn-ghost"
            style={{ fontSize: '0.875rem', padding: '0.3rem 0.5rem' }}
            onClick={() => {
              if (monthFilter === 'all') setMonthFilter(currentMonth());
              else {
                const [y, m] = monthFilter.split('-').map(Number);
                const d = new Date(y, m - 2, 1);
                setMonthFilter(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
              }
            }}
            title="Previous month"
          >
            ‹
          </button>
          <input
            type="month"
            value={month}
            onChange={(e) => setMonthFilter(e.target.value)}
            style={{ minWidth: 130, fontSize: '0.875rem' }}
          />
          <button
            type="button"
            className="btn btn-ghost"
            style={{ fontSize: '0.875rem', padding: '0.3rem 0.5rem' }}
            onClick={() => {
              if (monthFilter === 'all') setMonthFilter(currentMonth());
              else {
                const [y, m] = monthFilter.split('-').map(Number);
                const d = new Date(y, m, 1);
                setMonthFilter(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
              }
            }}
            title="Next month"
          >
            ›
          </button>
          <button
            type="button"
            className={`btn ${monthFilter === 'all' ? 'btn-primary' : 'btn-ghost'}`}
            style={{ fontSize: '0.875rem', padding: '0.3rem 0.6rem' }}
            onClick={() => setMonthFilter(monthFilter === 'all' ? currentMonth() : 'all')}
            title={monthFilter === 'all' ? 'Showing all months (click to filter by month)' : 'Show all months'}
          >
            All months
          </button>
        </div>
        <button
          className={`btn ${catFilter === 'uncategorized' ? 'btn-primary' : 'btn-ghost'}`}
          style={{ fontSize: '0.875rem', padding: '0.3rem 0.6rem' }}
          onClick={() => { setCatFilter(catFilter === 'uncategorized' ? 'all' : 'uncategorized'); setCategoryFilter(''); }}
        >
          Uncategorized
        </button>
        <SearchableSelect
          options={categoryOptions}
          value={categoryFilter}
          onChange={(v) => {
            const newVal = v === '' ? '' : Number(v);
            setCategoryFilter(newVal);
            if (newVal !== '') setCatFilter('all');
          }}
          placeholder="All categories"
          style={{ minWidth: 160, fontSize: '0.875rem' }}
          buttonStyle={{ padding: '0.3rem 0.6rem' }}
        />
        <SearchableSelect
          options={instrumentOptions}
          value={instrumentFilter}
          onChange={(v) => setInstrumentFilter(String(v))}
          placeholder="All instruments"
          style={{ minWidth: 160, fontSize: '0.875rem' }}
          buttonStyle={{ padding: '0.3rem 0.6rem' }}
        />
        <span style={{ fontSize: '0.875rem', opacity: 0.6 }}>{txns.length} transactions</span>
        <button
          className="btn btn-primary btn-sm"
          onClick={() => setShowAddForm(!showAddForm)}
          style={{ marginLeft: 'auto' }}
        >
          {showAddForm ? 'Cancel' : '+ Add'}
        </button>
      </div>

      {showAddForm && (
        <div className="card">
          <div className="section-title">Add transaction</div>
          <div className="row" style={{ marginBottom: '0.5rem' }}>
            <button
              className={`btn btn-sm ${mType === 'expense' ? 'btn-danger' : 'btn-ghost'}`}
              onClick={() => setMType('expense')}
            >
              Expense
            </button>
            <button
              className={`btn btn-sm ${mType === 'credit' ? 'btn-success' : 'btn-ghost'}`}
              onClick={() => setMType('credit')}
            >
              Credit / Refund
            </button>
          </div>
          <div className="row">
            <div className="field">
              <label>Date</label>
              <input type="date" value={mDate} onChange={(e) => setMDate(e.target.value)} />
            </div>
            <div className="field">
              <label>Amount</label>
              <input type="number" step="0.01" min="0.01" value={mAmount} onChange={(e) => setMAmount(e.target.value)} placeholder="0.00" />
            </div>
          </div>
          <div className="field">
            <label>Descriptor</label>
            <input value={mDescriptor} onChange={(e) => setMDescriptor(e.target.value)} placeholder="Description" />
          </div>
          <div className="row">
            <div className="field">
              <label>Instrument</label>
              <input value={mInstrument} onChange={(e) => setMInstrument(e.target.value)} placeholder="e.g. Visa, Cash" />
            </div>
            <div className="field">
              <label>Category</label>
              <SearchableSelect
                options={categoryOptions}
                value={mCategoryId}
                onChange={(v) => setMCategoryId(v === '' ? '' : Number(v))}
                placeholder="None"
              />
            </div>
          </div>
          <div className="field">
            <label>Comment</label>
            <textarea
              value={mComment}
              onChange={(e) => setMComment(e.target.value)}
              placeholder="Optional comment"
              rows={2}
              style={{ resize: 'vertical' }}
            />
          </div>
          <button className="btn btn-primary" onClick={addManualTransaction} style={{ marginTop: '0.5rem' }}>
            Add {mType === 'expense' ? 'Expense' : 'Credit'}
          </button>
        </div>
      )}

      <div className="card" style={{ overflowX: 'auto' }}>
        <table className="data-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Descriptor</th>
              <th>Instrument</th>
              <th className="num">Amount</th>
              <th>Category</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {(() => {
              let catIdx = 0, uncatIdx = 0;
              return txns.map((t) => {
              const splits = t.id !== undefined ? splitsMap.get(t.id) : undefined;
              const isCategorized = t.categoryId != null || (splits != null && splits.length > 0);
              const rowClass = isCategorized
                ? `txn-row-categorized ${catIdx++ % 2 === 0 ? '' : 'txn-row-categorized-alt'}`
                : `txn-row-uncat ${uncatIdx++ % 2 === 0 ? '' : 'txn-row-uncat-alt'}`;
              return (
                <tr key={t.id} className={rowClass}>
                  <td style={{ whiteSpace: 'nowrap' }}>{t.txnDate}</td>
                  <td className="descriptor-cell" data-tooltip={t.descriptor} onMouseEnter={showTooltip} onMouseLeave={hideTooltip}>
                    <span className="descriptor-text">{t.descriptor}</span>
                    {t.linkedTransactionId === -1 && <span className="chip" style={{ marginLeft: '4px', background: '#8b5cf6', color: '#fff' }}>PayPal</span>}
                    {t.linkedTransactionId && t.linkedTransactionId !== -1 && <span className="chip" style={{ marginLeft: '4px' }}>linked</span>}
                  </td>
                  <td>{t.instrument}</td>
                  <td className={`num budget-num ${t.ignoreInBudget || t.amount < 0 ? 'positive' : 'txn-neg'}`}>
                    {t.amount === 0 ? '' : t.ignoreInBudget || t.amount < 0 ? '+' : '-'}${formatAmount(Math.abs(t.amount))}
                  </td>
                  <td>
                    {splits && splits.length > 0 ? (
                      <span className="chip" title={splits.map(s => `${catMap.get(s.categoryId) ?? '?'}: $${formatAmount(s.amount)}`).join(', ')}>
                        Split ({splits.length})
                      </span>
                    ) : (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap' }}>
                        {/* Actual category — chip if assigned, dropdown if uncategorized or editing */}
                        {t.categoryId != null && editingCategoryId !== t.id ? (
                          <span
                            className="chip"
                            style={{ cursor: 'pointer', background: catColorMap.get(t.categoryId) ?? '#888', color: '#fff', whiteSpace: 'nowrap', fontWeight: 600 }}
                            title="Click to change category"
                            onClick={() => setEditingCategoryId(t.id)}
                          >
                            {catMap.get(t.categoryId) ?? '?'}
                          </span>
                        ) : (
                          <SearchableSelect
                            options={categoryOptions}
                            value={t.categoryId ?? ''}
                            onChange={(v) => {
                              assignCategory(t.id, v === '' ? null : Number(v));
                              setEditingCategoryId(null);
                            }}
                            placeholder="Uncategorized"
                            compact
                            style={{ fontSize: '0.67rem' }}
                          />
                        )}
                        {/* Suggestion chip — history-based */}
                        {t.categoryId == null && allSuggestions.has(t.id) && (() => {
                          const s = allSuggestions.get(t.id)!;
                          const baseColor = catColorMap.get(s.categoryId) ?? '#888';
                          const scores = historyScoresMap.get(t.id);
                          let tooltipText = 'History match — click to accept';
                          if (scores && scores.size > 0) {
                            const lines = [...scores.entries()]
                              .sort((a, b) => b[1] - a[1])
                              .slice(0, 6)
                              .map(([catId, pts]) => {
                                const name = categories.find((c) => c.id === catId)?.name ?? catId;
                                return `${name}: ${pts} pts`;
                              });
                            tooltipText += '\n' + lines.join('\n');
                          }
                          return (
                            <span
                              className="chip"
                              style={{
                                cursor: 'pointer',
                                background: baseColor + '33',
                                color: baseColor,
                                border: `1px solid ${baseColor}66`,
                                whiteSpace: 'nowrap',
                                fontSize: '0.67rem',
                                fontWeight: 500,
                              }}
                              title={tooltipText}
                              onClick={() => assignCategory(t.id, s.categoryId)}
                            >
                              ~{s.categoryName}
                            </span>
                          );
                        })()}
                      </div>
                    )}
                  </td>
                  <td className="txn-action-cell">
                    <button className="btn btn-ghost btn-sm" onClick={() => openRuleModal(t)} title="Create rule">
                      Create Rule
                    </button>
                    <button className="btn btn-ghost btn-sm" onClick={() => setSplitTxn(t)} title="Split transaction">
                      Split Txn
                    </button>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => openMoveMonth(t)}
                      title="Count in different month"
                    >
                      📅
                    </button>
                    <button
                      className={`btn btn-sm ${t.comment ? 'btn-warning' : 'btn-ghost'}`}
                      onClick={() => startEditComment(t)}
                      title={t.comment ? 'View/edit comment' : 'Add comment'}
                      style={{ fontWeight: t.comment ? 'bold' : 'normal' }}
                    >
                      💬
                    </button>
                    {txnAiLookupEnabled && (
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => { onNeedOllama?.(); setLookupTxn(t); }}
                        title="Identify this transaction with AI"
                        style={{ fontWeight: 600, opacity: 0.7 }}
                      >
                        ?
                      </button>
                    )}
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => setConfirmDeleteId(t.id)}
                      title="Delete transaction"
                      style={{ color: 'var(--red)', fontWeight: 600 }}
                    >
                      🗑
                    </button>
                  </td>
                </tr>
              );
            });
            })()}
            {txns.length === 0 && (
              <tr><td colSpan={6} className="empty">{monthFilter === 'all' ? 'No transactions' : 'No transactions this month'}</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {ruleModal && (() => {
        const hasDollarSplit = ruleIsSplit && ruleSplitType === '$';
        return (
        <div className="modal-overlay" onClick={() => setRuleModal(null)}>
          <div className="modal modal--rule" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520 }}>
            <h3>Create Category Rule</h3>
            <div className="field">
              <label>Pattern</label>
              <input value={rulePattern} onChange={(e) => setRulePattern(e.target.value)} />
            </div>
            <div className="row">
              <div className="field">
                <label>Match type</label>
                <SearchableSelect
                  options={[
                    { value: 'contains', label: 'Contains' },
                    { value: 'exact', label: 'Exact' },
                  ]}
                  value={ruleType}
                  onChange={(v) => setRuleType(v as 'exact' | 'contains')}
                  placeholder="Match type"
                />
              </div>
              {!ruleIsSplit && (
                <div className="field">
                  <label>Category</label>
                  <SearchableSelect
                    options={categoryOptions}
                    value={ruleCatId}
                    onChange={(v) => setRuleCatId(v === '' ? '' : Number(v))}
                    placeholder="Select..."
                  />
                </div>
              )}
            </div>

            {/* Split toggle */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.65rem' }}>
              <input
                type="checkbox"
                id="rule-split-cb"
                checked={ruleIsSplit}
                onChange={(e) => setRuleIsSplit(e.target.checked)}
              />
              <label htmlFor="rule-split-cb" style={{ fontSize: '0.85rem', cursor: 'pointer' }}>
                Split transaction into multiple categories
              </label>
            </div>

            {ruleIsSplit && (
              <div style={{ background: 'var(--bg-3)', borderRadius: 'var(--radius)', padding: '0.65rem', marginBottom: '0.65rem' }}>
                <div style={{ display: 'flex', gap: '0.25rem', marginBottom: '0.5rem', alignItems: 'center' }}>
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-3)', marginRight: '0.25rem' }}>Split by:</span>
                  <button className={`btn btn-sm ${ruleSplitType === '%' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setRuleSplitType('%')}>%</button>
                  <button className={`btn btn-sm ${ruleSplitType === '$' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setRuleSplitType('$')}>$</button>
                  {hasDollarSplit && <span style={{ fontSize: '0.72rem', color: 'var(--yellow)', marginLeft: '0.5rem' }}>requires amount condition</span>}
                </div>
                {ruleSplits.map((s, i) => (
                  <div key={i} style={{ display: 'flex', gap: '0.4rem', alignItems: 'center', marginBottom: '0.35rem', flexWrap: 'wrap' }}>
                    <div style={{ flex: '2 1 130px' }}>
                      <SearchableSelect
                        options={categoryOptions}
                        value={s.categoryId}
                        onChange={(v) => setRuleSplits((prev) => prev.map((x, j) => j === i ? { ...x, categoryId: v === '' ? '' : Number(v) } : x))}
                        placeholder="Category"
                      />
                    </div>
                    <input
                      type="number"
                      step="0.01"
                      placeholder={ruleSplitType === '%' ? '50' : '0.00'}
                      value={s.amount}
                      onChange={(e) => setRuleSplits((prev) => prev.map((x, j) => j === i ? { ...x, amount: e.target.value } : x))}
                      style={{ width: 80 }}
                    />
                    {ruleSplits.length > 2 && (
                      <button className="btn btn-ghost btn-sm" onClick={() => setRuleSplits((prev) => prev.filter((_, j) => j !== i))}>×</button>
                    )}
                  </div>
                ))}
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginTop: '0.25rem' }}>
                  <button className="btn btn-ghost btn-sm" onClick={() => setRuleSplits((prev) => [...prev, { categoryId: '', amount: '' }])}>+ Add row</button>
                  {ruleSplitType === '%' && (() => {
                    const pct = ruleSplits.reduce((sum, s) => sum + (parseFloat(s.amount) || 0), 0);
                    const ok = Math.abs(pct - 100) < 0.01;
                    return <span style={{ fontSize: '0.75rem', color: ok ? 'var(--green)' : 'var(--red)' }}>Total: {pct.toFixed(1)}%</span>;
                  })()}
                  {ruleSplitType === '$' && ruleModal && (() => {
                    const total = ruleSplits.reduce((sum, s) => sum + (parseFloat(s.amount) || 0), 0);
                    const txnAmt = Math.abs(ruleModal.amount);
                    const ok = Math.abs(total - txnAmt) < 0.01;
                    return <span style={{ fontSize: '0.75rem', color: ok ? 'var(--green)' : 'var(--red)' }}>
                      Total: ${total.toFixed(2)} / ${txnAmt.toFixed(2)}
                    </span>;
                  })()}
                </div>
              </div>
            )}

            {/* Amount condition */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.65rem' }}>
              <input
                type="checkbox"
                id="rule-amt-cb"
                checked={ruleAmountRequired || hasDollarSplit}
                disabled={hasDollarSplit}
                onChange={(e) => { setRuleAmountRequired(e.target.checked); if (!e.target.checked) setRuleAmount(''); }}
              />
              <label htmlFor="rule-amt-cb" style={{ fontSize: '0.85rem', cursor: 'pointer' }}>
                {hasDollarSplit ? 'Amount (required for $ splits)' : 'Require amount'}
              </label>
              {(ruleAmountRequired || hasDollarSplit) && (
                <input type="number" step="0.01" value={ruleAmount} onChange={(e) => setRuleAmount(e.target.value)} placeholder="0.00" style={{ width: '100px' }} />
              )}
            </div>

            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => setRuleModal(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={createRule}>
                {ruleIsSplit ? 'Create Split Rule' : 'Create & Apply'}
              </button>
            </div>
          </div>
        </div>
        );
      })()}

      {editingCommentId !== null && (
        <div className="modal-overlay" onClick={() => setEditingCommentId(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{editingCommentText.trim() ? 'View / Edit Comment' : 'Add Comment'}</h3>
            <div className="field">
              <textarea
                value={editingCommentText}
                onChange={(e) => setEditingCommentText(e.target.value)}
                placeholder="Enter comment..."
                rows={3}
                style={{ resize: 'vertical', width: '100%' }}
                autoFocus
              />
            </div>
            <div className="modal-actions" style={{ justifyContent: 'space-between' }}>
              <div>
                {editingCommentText.trim() && (
                  <button
                    className="btn btn-danger btn-sm"
                    onClick={async () => {
                      await updateTransaction(editingCommentId, { comment: null });
                      setEditingCommentId(null);
                    }}
                  >
                    Delete
                  </button>
                )}
              </div>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button className="btn btn-ghost" onClick={() => setEditingCommentId(null)}>Cancel</button>
                <button className="btn btn-primary" onClick={saveComment}>Save</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {splitTxn && (
        <SplitEditor
          transaction={splitTxn}
          categories={categories}
          onClose={() => { setSplitTxn(null); }}
        />
      )}

      {moveMonthTxn && (
        <div className="modal-overlay" onClick={() => setMoveMonthTxn(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Count in Different Month</h3>
            <div className="card" style={{ marginBottom: '0.75rem' }}>
              <div style={{ fontWeight: 600 }}>{moveMonthTxn.descriptor}</div>
              <div style={{ fontSize: '0.85rem' }}>
                {moveMonthTxn.ignoreInBudget ? '+' : '-'}${formatAmount(moveMonthTxn.amount)} — currently {moveMonthTxn.txnDate}
              </div>
            </div>
            <div className="row" style={{ gap: '0.5rem' }}>
              <div className="field">
                <label>Month</label>
                <select
                  value={moveMonthNum}
                  onChange={(e) => setMoveMonthNum(e.target.value)}
                  style={{ padding: '0.5rem 0.75rem' }}
                >
                  {['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'].map((m, i) => (
                    <option key={m} value={m}>
                      {new Date(2000, i, 1).toLocaleDateString('en-US', { month: 'long' })}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>Year</label>
                <select
                  value={moveMonthYear}
                  onChange={(e) => setMoveMonthYear(e.target.value)}
                  style={{ padding: '0.5rem 0.75rem' }}
                >
                  {(() => {
                    const cur = new Date().getFullYear();
                    return [cur - 1, cur, cur + 1];
                  })().map((y) => (
                    <option key={y} value={String(y)}>{y}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => setMoveMonthTxn(null)}>Cancel</button>
              <button
                className="btn btn-primary"
                disabled={!moveMonthYear || !moveMonthNum}
                onClick={confirmMoveMonth}
              >
                Move to {moveMonthYear}-{moveMonthNum}
              </button>
            </div>
          </div>
        </div>
      )}

      {refundPrompts.length > 0 && (
        <div className="modal-overlay" onClick={() => setRefundPrompts([])}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Possible Refund Detected</h3>
            {refundPrompts.map((r) => (
              <div key={r.refundTxn.id} style={{ marginBottom: '1rem' }}>
                <p style={{ fontSize: '0.85rem' }}>
                  This credit may be a refund for a previous transaction:
                </p>
                <div className="card" style={{ marginBottom: '0.5rem' }}>
                  <div style={{ fontSize: '0.8rem', opacity: 0.6 }}>Credit (new)</div>
                  <div><strong>{r.refundTxn.descriptor}</strong></div>
                  <div>${formatAmount(r.refundTxn.amount)} on {r.refundTxn.txnDate}</div>
                </div>
                <div className="card" style={{ marginBottom: '0.5rem' }}>
                  <div style={{ fontSize: '0.8rem', opacity: 0.6 }}>Original expense</div>
                  <div><strong>{r.originalTxn.descriptor}</strong></div>
                  <div>${formatAmount(r.originalTxn.amount)} on {r.originalTxn.txnDate}</div>
                  <div style={{ fontSize: '0.8rem', opacity: 0.6 }}>
                    {r.originalTxn.categoryId ? `Category: ${catMap.get(r.originalTxn.categoryId) ?? '?'}` : 'Uncategorized'}
                  </div>
                </div>
                <div className="modal-actions" style={{ justifyContent: 'stretch' }}>
                  <button
                    className="btn btn-primary btn-sm"
                    style={{ flex: 1 }}
                    onClick={() => handleRefundChoice(r, true)}
                  >
                    Count in original month ({r.originalTxn.txnDate.slice(0, 7)})
                  </button>
                  <button
                    className="btn btn-ghost btn-sm"
                    style={{ flex: 1 }}
                    onClick={() => handleRefundChoice(r, false)}
                  >
                    Keep as new transaction
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      {tooltip && createPortal(
        <div className="descriptor-tooltip" style={{
          top: tooltip.top,
          left: tooltip.left,
          transform: tooltip.flipUp ? 'translateY(-100%)' : undefined,
        }}>
          {tooltip.text}
        </div>,
        document.body,
      )}

      {lookupTxn && (
        <TransactionLookup
          transaction={lookupTxn}
          onClose={() => setLookupTxn(null)}
        />
      )}

      {confirmDeleteId !== null && createPortal(
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div className="card" style={{ maxWidth: 360, width: '90%', textAlign: 'center' }}>
            <p style={{ marginBottom: '1rem', fontWeight: 600 }}>Delete this transaction?</p>
            <p style={{ marginBottom: '1.25rem', fontSize: '0.85rem', opacity: 0.7 }}>This cannot be undone.</p>
            <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center' }}>
              <button className="btn btn-danger" onClick={async () => { await deleteTransactions([confirmDeleteId]); setConfirmDeleteId(null); }}>Delete</button>
              <button className="btn btn-ghost" onClick={() => setConfirmDeleteId(null)}>Cancel</button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
