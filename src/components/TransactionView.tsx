import { useState, useMemo, useSyncExternalStore, useEffect, useRef, useDeferredValue } from 'react';
import { createPortal } from 'react-dom';
import {
  getData,
  subscribe,
  addTransaction,
  updateTransaction,
  deleteTransactions,
  addCategoryRule,
  withUndo,
  getAISettings,
  addMerchantTypes,
  logSuggestionOutcome,
  type Transaction,
} from '../db';
import { getSplitsIndex, isCategorized as txnIsCategorized } from '../logic/spend';
import { bulkCategorizeByDescriptor, bulkApplySplitRule, bulkMarkTransferByDescriptor } from '../logic/categorize';
import { buildSuggester, parseDescriptor, suggestionCorpus, type CategoryGuess } from '../logic/suggest';
import { classifyMerchants, needsMerchantType } from '../logic/aiSuggest';
import { findRefundCandidates, applyRefundToOriginalMonth, type RefundCandidate } from '../logic/refunds';
import { SplitEditor } from './SplitEditor';
import { SearchableSelect } from './SearchableSelect';
import { TransactionLookup } from './TransactionLookup';
import { SuggestionDetails } from './SuggestionDetails';
import { formatAmount } from '../utils/format';
import { isCredit } from '../logic/txnKind';
import { TxnRow, DescriptorTooltip, type DescriptorTooltipHandle, type TxnRowActions } from './TransactionRow';
import { useWindowedRows } from './useWindowedRows';
import { transactionsToCsv, saveTransactionsCsv, transactionsToClipboardTable, copyRichText } from '../utils/export';

function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Transactions are mutated in place by db.ts, so the object reference alone can't tell memo
 * that a row changed. This string covers every field the row displays.
 */
function txnRowSignature(t: Transaction): string {
  return `${t.txnDate}|${t.amount}|${t.categoryId}|${t.linkedTransactionId}|${t.ignoreInBudget ? 1 : 0}|${t.isTransfer ? 1 : 0}|${t.starred ? 1 : 0}|${t.starNote ? 1 : 0}|${t.comment ? 1 : 0}|${t.instrument}|${t.descriptor}`;
}

/** What's on offer for an uncategorized row. The chip shows the history guess, else the ? lookup's. */
interface RowSuggestion {
  history: CategoryGuess | null;
  /** Category recommended by a saved ? lookup for this merchant. */
  ai: { categoryId: number; at: string; confidence?: string; reason?: string } | null;
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
  const budgets = appData.budgets;

  const [monthFilter, setMonthFilter] = useState<string | 'all'>(currentMonth());
  const month = monthFilter === 'all' ? currentMonth() : monthFilter;
  const [ruleModal, setRuleModal] = useState<Transaction | null>(null);
  const [rulePattern, setRulePattern] = useState('');
  const [ruleType, setRuleType] = useState<'exact' | 'contains'>('exact');
  const [ruleCatId, setRuleCatId] = useState<number | ''>('');
  const [ruleAmount, setRuleAmount] = useState('');
  const [ruleAmountRequired, setRuleAmountRequired] = useState(false);
  const [ruleIsSplit, setRuleIsSplit] = useState(false);
  const [ruleMarkTransfer, setRuleMarkTransfer] = useState(false);
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
  const [editingStarNoteId, setEditingStarNoteId] = useState<number | null>(null);
  const [editingStarNoteText, setEditingStarNoteText] = useState('');
  const [moveMonthTxn, setMoveMonthTxn] = useState<Transaction | null>(null);
  const [moveMonthYear, setMoveMonthYear] = useState('');
  const [moveMonthNum, setMoveMonthNum] = useState('');
  const [lookupTxn, setLookupTxn] = useState<Transaction | null>(null);
  const [explainTxn, setExplainTxn] = useState<Transaction | null>(null);
  const [editingCategoryId, setEditingCategoryId] = useState<number | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [exportStatus, setExportStatus] = useState<string | null>(null);
  const [labelStatus, setLabelStatus] = useState<string | null>(null);
  const [labelling, setLabelling] = useState(false);
  const tooltipRef = useRef<DescriptorTooltipHandle>(null);
  const tbodyRef = useRef<HTMLTableSectionElement>(null);
  // Rows read handlers through this ref so they stay memoized across parent re-renders.
  const rowActions = useRef<TxnRowActions>(null!);
  rowActions.current = {
    assignCategory: (id, catId) => { void assignCategory(id, catId); },
    setEditingCategory: setEditingCategoryId,
    toggleStar: (t) => { void toggleStar(t); },
    editStarNote: startEditStarNote,
    toggleTransfer: (t) => { void updateTransaction(t.id, { isTransfer: t.isTransfer ? undefined : true }); },
    openRule: openRuleModal,
    openSplit: setSplitTxn,
    openMoveMonth,
    editComment: startEditComment,
    lookup: (t) => { onNeedOllama?.(); setLookupTxn(t); },
    explain: setExplainTxn,
    confirmDelete: setConfirmDeleteId,
    showTooltip: (cell) => tooltipRef.current?.show(cell),
    hideTooltip: () => tooltipRef.current?.hide(),
  };

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
  const [starredFilter, setStarredFilter] = useState(false);
  const [transferFilter, setTransferFilter] = useState(false);
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

  const splitsMap = useMemo(() => getSplitsIndex({ transactionSplits: allSplits }), [allSplits]);

  // db.ts hands out fresh array references on every save, so key the category-derived props on
  // their content. Otherwise every edit gives each row new props and re-renders the whole table.
  const catKey = categories.map((c) => `${c.id}\u0001${c.name}\u0001${c.color ?? ''}\u0001${c.archived ? 1 : 0}`).join('\u0002');
  /* eslint-disable react-hooks/exhaustive-deps -- deliberately keyed on catKey, see above */
  const catMap = useMemo(() => new Map(categories.map((c) => [c.id!, c.name])), [catKey]);
  const catColorMap = useMemo(() => new Map(categories.map((c) => [c.id!, c.color ?? '#888'])), [catKey]);
  const categoryOptions = useMemo(() => categories.filter((c) => !c.archived).map((c) => ({ value: c.id, label: c.name })), [catKey]);
  const filterCategoryOptions = useMemo(() => categories.map((c) => ({ value: c.id, label: c.archived ? `${c.name} (archived)` : c.name })), [catKey]);
  /* eslint-enable react-hooks/exhaustive-deps */
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
    if (transferFilter) result = result.filter((t) => t.isTransfer);
    if (catFilter === 'categorized') result = result.filter((t) => !t.isTransfer && txnIsCategorized(t, splitsMap));
    if (catFilter === 'uncategorized') result = result.filter((t) => !t.isTransfer && !txnIsCategorized(t, splitsMap));
    if (categoryFilter !== '') result = result.filter((t) => {
      const splits = splitsMap.get(t.id);
      if (splits && splits.length > 0) return splits.some((s) => s.categoryId === categoryFilter);
      return t.categoryId === categoryFilter;
    });
    if (instrumentFilter !== '') result = result.filter((t) => t.instrument === instrumentFilter);
    if (starredFilter) result = result.filter((t) => t.starred);
    if (offBudgetFilter) {
      const budgetedCatIds = new Set(budgets.filter((b) => b.month === month).map((b) => b.categoryId));
      const incomeCatIds = new Set(categories.filter((c) => c.isIncome).map((c) => c.id));
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
  }, [allTransactions, monthFilter, month, catFilter, categoryFilter, instrumentFilter, starredFilter, offBudgetFilter, transferFilter, search, splitsMap, catMap, budgets, categories]);

  // Suggestions scored against all uncategorized transactions — not filtered by visible txns,
  // so month/search filter changes don't retrigger batchGetGuessScores.
  // Deferred: after a category click React paints the row first, then rescores in the background.
  const suggestTxns = useDeferredValue(allTransactions);
  const suggestSplits = useDeferredValue(splitsMap);
  const merchantTypes = useDeferredValue(appData.merchantTypes);
  const merchantLookups = useDeferredValue(appData.merchantLookups);
  const { suggester, allSuggestions } = useMemo(() => {
    const live = new Set(categories.filter((c) => !c.archived).map((c) => c.id));
    const suggester = buildSuggester(suggestionCorpus(suggestTxns, live), { merchantTypes });
    const suggestions = new Map<number, RowSuggestion>();
    for (const t of suggestTxns) {
      if (t.categoryId != null || isCredit(t) || t.isTransfer || suggestSplits.has(t.id)) continue;
      const g = suggester.suggest(t.descriptor, t.amount);
      const history = g && live.has(g.categoryId) ? g : null;
      const lk = merchantLookups?.[parseDescriptor(t.descriptor).key];
      const aiCat = lk?.category.categoryId;
      const ai = lk && aiCat != null && live.has(aiCat)
        ? { categoryId: aiCat, at: lk.at, confidence: lk.category.confidence, reason: lk.category.reason }
        : null;
      if (history || ai) suggestions.set(t.id, { history, ai });
    }
    return { suggester, allSuggestions: suggestions };
  }, [suggestTxns, categories, suggestSplits, merchantTypes, merchantLookups]);

  // Merchants the local model hasn't labelled yet (only offered when AI features are on).
  const unlabelledCount = useMemo(() => {
    if (!txnAiLookupEnabled) return 0;
    const known = merchantTypes ?? {};
    const keys = new Set<string>();
    for (const t of suggestTxns) {
      if (!isCredit(t) && !t.isTransfer && needsMerchantType(t.descriptor, known)) keys.add(parseDescriptor(t.descriptor).key);
    }
    return keys.size;
  }, [suggestTxns, merchantTypes, txnAiLookupEnabled]);

  async function labelMerchants() {
    if (labelling) return;
    onNeedOllama?.();
    setLabelling(true);
    setLabelStatus('Asking the local model what kind of business each merchant is…');
    try {
      const descriptors = getData().transactions.filter((t) => !isCredit(t) && !t.isTransfer).map((t) => t.descriptor);
      let labelled = 0;
      await classifyMerchants(descriptors, getData().merchantTypes ?? {}, getAISettings(), async (batch, done, total) => {
        labelled += Object.values(batch).filter((v) => v !== 'unknown').length;
        await addMerchantTypes(batch);
        setLabelStatus(`Labelling merchants… ${done} of ${total}`);
      });
      setLabelStatus(`Done: ${labelled} merchant${labelled !== 1 ? 's' : ''} recognised. Suggestions now also use how you file similar businesses.`);
    } catch (e) {
      setLabelStatus(`Couldn't reach the local model (${e instanceof Error ? e.message : String(e)}). Suggestions still work from your history.`);
    } finally {
      setLabelling(false);
    }
  }

  // Row stripe classes for every filtered row (cheap strings), so windowing doesn't change striping.
  const rowClasses = useMemo(() => {
    let catIdx = 0, uncatIdx = 0;
    return txns.map((t) => {
      const splits = splitsMap.get(t.id);
      const isCategorized = t.isTransfer || t.categoryId != null || (splits != null && splits.length > 0);
      return t.isTransfer ? 'txn-row-categorized' : isCategorized
        ? `txn-row-categorized ${catIdx++ % 2 === 0 ? '' : 'txn-row-categorized-alt'}`
        : `txn-row-uncat ${uncatIdx++ % 2 === 0 ? '' : 'txn-row-uncat-alt'}`;
    });
  }, [txns, splitsMap]);

  const win = useWindowedRows(txns.length, tbodyRef);

  function suggestionTitleFor(s: RowSuggestion): string {
    const g = s.history;
    if (!g) {
      const ai = s.ai!;
      return `Recommended by the ? lookup on ${ai.at.slice(0, 10)}${ai.confidence ? ` (${ai.confidence} confidence)` : ''} — click to use it\n`
        + (ai.reason ? `${ai.reason}\n` : '')
        + 'ⓘ shows why';
    }
    const total = [...g.scores.values()].reduce((a, b) => a + b, 0) || 1;
    return `Suggested from your history (${g.reason}) — click to use it\n`
      + [...g.scores.entries()]
        .sort((x, y) => y[1] - x[1])
        .slice(0, 5)
        .map(([catId, w]) => `${catMap.get(catId) ?? catId}: ${Math.round((100 * w) / total)}%`)
        .join('\n')
      + (s.ai && s.ai.categoryId !== g.categoryId ? `\nThe ? lookup recommended ${catMap.get(s.ai.categoryId)} instead` : '')
      + '\nⓘ shows why';
  }

  async function exportDisplayed() {
    setExportStatus(null);
    try {
      const csv = transactionsToCsv(txns, (id) => catMap.get(id), (id) => splitsMap.get(id));
      const today = new Date().toISOString().slice(0, 10);
      const scope = monthFilter === 'all' ? 'all-months' : monthFilter;
      const path = await saveTransactionsCsv(csv, `transactions-${scope}-${today}.csv`);
      if (path) setExportStatus(`Exported ${txns.length} transaction${txns.length !== 1 ? 's' : ''} to ${path.split('/').pop()}`);
    } catch (e) {
      setExportStatus(`Export failed: ${String(e)}`);
    }
  }

  function copyDisplayed() {
    const { html, text } = transactionsToClipboardTable(txns, (id) => catMap.get(id), (id) => splitsMap.get(id));
    const ok = copyRichText(html, text);
    setExportStatus(ok
      ? `Copied ${txns.length} transaction${txns.length !== 1 ? 's' : ''} as a table — paste into a document or spreadsheet`
      : 'Copy failed');
  }

  const uncatCount = useMemo(
    () => allTransactions.filter((t) => !t.isTransfer && !txnIsCategorized(t, splitsMap)).length,
    [allTransactions, splitsMap],
  );

  async function assignCategory(txnId: number, categoryId: number | null) {
    const t = allTransactions.find((x) => x.id === txnId);
    const offer = allSuggestions.get(txnId);
    await updateTransaction(txnId, { categoryId });
    // Track how often each suggestion turns out right (Settings shows the tally).
    if (t && t.categoryId == null && categoryId != null && offer) {
      const offered: { source: 'history' | 'ai'; categoryId: number }[] = [];
      if (offer.history) offered.push({ source: 'history', categoryId: offer.history.categoryId });
      if (offer.ai) offered.push({ source: 'ai', categoryId: offer.ai.categoryId });
      await logSuggestionOutcome(t.descriptor, categoryId, offered);
    }
  }

  function openRuleModal(txn: Transaction) {
    setRuleModal(txn);
    setRulePattern(txn.descriptor);
    setRuleType('exact');
    setRuleCatId(txn.categoryId ?? '');
    setRuleAmount(txn.amount ? String(txn.amount) : '');
    setRuleAmountRequired(false);
    setRuleIsSplit(false);
    setRuleMarkTransfer(false);
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

    if (ruleMarkTransfer) {
      await withUndo('Create transfer rule', async () => {
        await addCategoryRule({ matchType: ruleType, pattern: rulePattern.toLowerCase(), categoryId: 0, amountMatch: amountVal, markTransfer: true });
        const count = await bulkMarkTransferByDescriptor(rulePattern, ruleType, amountVal);
        setRuleModal(null);
        alert(`Rule created. ${count} transaction${count !== 1 ? 's' : ''} marked as transfer.`);
      });
      return;
    }

    if (ruleIsSplit) {
      const validSplits = ruleSplits.filter((s) => s.categoryId !== '' && s.amount.trim() !== '');
      if (validSplits.length < 2) return;
      if (hasDollarSplit && !amountVal) return; // $ splits require amount
      if (ruleSplitType === '%') {
        const pct = validSplits.reduce((sum, s) => sum + (parseFloat(s.amount) || 0), 0);
        if (Math.abs(pct - 100) >= 0.01) return; // percent splits must total 100
      }
      const primaryCatId = validSplits[0].categoryId as number;
      const splitItems = validSplits.map((s) => ({
        categoryId: s.categoryId as number,
        ...(ruleSplitType === '%' ? { percent: parseFloat(s.amount) } : { amount: parseFloat(s.amount) }),
      }));
      await withUndo('Create split rule', async () => {
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
      });
    } else {
      if (!ruleCatId) return;
      await withUndo('Create rule', async () => {
        await addCategoryRule({
          matchType: ruleType,
          pattern: rulePattern.toLowerCase(),
          categoryId: ruleCatId as number,
          amountMatch: amountVal,
        });
        const count = await bulkCategorizeByDescriptor(rulePattern, ruleCatId as number, ruleType, amountVal ?? undefined);
        setRuleModal(null);
        alert(`Rule created. ${count} transactions categorized.`);
      });
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

  async function toggleStar(txn: Transaction) {
    await updateTransaction(txn.id, { starred: !txn.starred });
  }

  function startEditStarNote(txn: Transaction) {
    setEditingStarNoteId(txn.id);
    setEditingStarNoteText(txn.starNote ?? '');
  }

  async function saveStarNote() {
    if (editingStarNoteId === null) return;
    await updateTransaction(editingStarNoteId, {
      starNote: editingStarNoteText.trim() || null,
    });
    setEditingStarNoteId(null);
    setEditingStarNoteText('');
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
        <button
          className={`btn ${transferFilter ? 'btn-primary' : 'btn-ghost'}`}
          style={{ fontSize: '0.875rem', padding: '0.3rem 0.6rem' }}
          onClick={() => setTransferFilter(!transferFilter)}
        >
          Transfers
        </button>
        <button
          className={`btn ${starredFilter ? 'btn-primary' : 'btn-ghost'}`}
          style={{ fontSize: '0.875rem', padding: '0.3rem 0.6rem' }}
          onClick={() => setStarredFilter(!starredFilter)}
        >
          ★ Starred
        </button>
        <SearchableSelect
          options={filterCategoryOptions}
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
          className="btn btn-ghost btn-sm"
          onClick={() => { void exportDisplayed(); }}
          disabled={txns.length === 0}
          title="Export the transactions currently shown (respects all filters and search) to CSV"
          style={{ marginLeft: 'auto' }}
        >
          Export CSV
        </button>
        <button
          className="btn btn-ghost btn-sm"
          onClick={copyDisplayed}
          disabled={txns.length === 0}
          title="Copy the transactions currently shown (same columns as Export CSV) as a table you can paste into a document or spreadsheet"
        >
          Copy table
        </button>
        {txnAiLookupEnabled && unlabelledCount > 0 && (
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => { void labelMerchants(); }}
            disabled={labelling}
            title="Ask the local model what kind of business each new merchant is (restaurant, hardware store, …), so first-time merchants can get suggestions based on how you file similar businesses"
          >
            {labelling ? 'Labelling…' : `AI: label ${unlabelledCount} merchant${unlabelledCount !== 1 ? 's' : ''}`}
          </button>
        )}
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => setShowAddForm(!showAddForm)}
        >
          {showAddForm ? 'Cancel' : '+ Add'}
        </button>
      </div>

      {labelStatus && (
        <div className="card" style={{ fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <span style={{ flex: 1 }}>{labelStatus}</span>
          {!labelling && <button className="btn btn-ghost btn-sm" onClick={() => setLabelStatus(null)}>×</button>}
        </div>
      )}

      {exportStatus && (
        <div className="card" style={{ fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <span style={{ flex: 1 }}>{exportStatus}</span>
          <button className="btn btn-ghost btn-sm" onClick={() => setExportStatus(null)}>×</button>
        </div>
      )}

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
          <tbody ref={tbodyRef}>
            {win.padTop > 0 && (
              <tr data-spacer="1" aria-hidden="true" style={{ height: win.padTop }}><td colSpan={6} style={{ padding: 0, border: 'none' }} /></tr>
            )}
            {txns.slice(win.start, win.end).map((t, i) => {
              const suggestion = t.categoryId == null ? allSuggestions.get(t.id) : undefined;
              const chipCat = suggestion ? (suggestion.history?.categoryId ?? suggestion.ai?.categoryId) : undefined;
              return (
                <TxnRow
                  key={t.id}
                  t={t}
                  sig={txnRowSignature(t)}
                  rowClass={rowClasses[win.start + i]}
                  splits={splitsMap.get(t.id)}
                  isEditingCategory={editingCategoryId === t.id}
                  suggestionCatId={chipCat}
                  suggestionName={chipCat != null ? catMap.get(chipCat) : undefined}
                  suggestionTitle={suggestion ? suggestionTitleFor(suggestion) : undefined}
                  suggestionFromAi={suggestion != null && suggestion.history == null}
                  catMap={catMap}
                  catColorMap={catColorMap}
                  categoryOptions={categoryOptions}
                  aiLookupEnabled={!!txnAiLookupEnabled}
                  actions={rowActions}
                />
              );
            })}
            {win.padBottom > 0 && (
              <tr data-spacer="1" aria-hidden="true" style={{ height: win.padBottom }}><td colSpan={6} style={{ padding: 0, border: 'none' }} /></tr>
            )}
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
              {!ruleIsSplit && !ruleMarkTransfer && (
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

            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.65rem' }}>
              <input type="checkbox" id="rule-transfer-cb" checked={ruleMarkTransfer} onChange={(e) => { setRuleMarkTransfer(e.target.checked); if (e.target.checked) setRuleIsSplit(false); }} />
              <label htmlFor="rule-transfer-cb" style={{ fontSize: '0.85rem', cursor: 'pointer' }}>Mark as transfer (not spending or income)</label>
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
                      Total: ${total.toFixed(2)} / ${txnAmt.toFixed(2)}{!ok && ' — the remainder goes to the last category'}
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
                {ruleMarkTransfer ? 'Create Transfer Rule' : ruleIsSplit ? 'Create Split Rule' : 'Create & Apply'}
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

      {editingStarNoteId !== null && (
        <div className="modal-overlay" onClick={() => setEditingStarNoteId(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{editingStarNoteText.trim() ? 'View / Edit Star Note' : 'Add Star Note'}</h3>
            <div className="field">
              <textarea
                value={editingStarNoteText}
                onChange={(e) => setEditingStarNoteText(e.target.value)}
                placeholder="Enter star note..."
                rows={3}
                style={{ resize: 'vertical', width: '100%' }}
                autoFocus
              />
            </div>
            <div className="modal-actions" style={{ justifyContent: 'space-between' }}>
              <div>
                {editingStarNoteText.trim() && (
                  <button
                    className="btn btn-danger btn-sm"
                    onClick={async () => {
                      await updateTransaction(editingStarNoteId, { starNote: null });
                      setEditingStarNoteId(null);
                    }}
                  >
                    Delete
                  </button>
                )}
              </div>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button className="btn btn-ghost" onClick={() => setEditingStarNoteId(null)}>Cancel</button>
                <button className="btn btn-primary" onClick={saveStarNote}>Save</button>
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
                {isCredit(moveMonthTxn) ? '+' : '-'}${formatAmount(moveMonthTxn.amount)} — currently {moveMonthTxn.txnDate}
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

      <DescriptorTooltip ref={tooltipRef} />

      {lookupTxn && (
        <TransactionLookup
          transaction={lookupTxn}
          suggester={suggester}
          onClose={() => setLookupTxn(null)}
        />
      )}

      {explainTxn && (
        <SuggestionDetails
          transaction={allTransactions.find((x) => x.id === explainTxn.id) ?? explainTxn}
          trace={suggester.explain(explainTxn.descriptor, explainTxn.amount, { categoryName: (id) => catMap.get(id) ?? `#${id}` })}
          lookup={appData.merchantLookups?.[parseDescriptor(explainTxn.descriptor).key]}
          aiLookupEnabled={!!txnAiLookupEnabled}
          catMap={catMap}
          catColorMap={catColorMap}
          onUse={(catId) => { void assignCategory(explainTxn.id, catId); setExplainTxn(null); }}
          onRunLookup={() => { const t = explainTxn; setExplainTxn(null); onNeedOllama?.(); setLookupTxn(t); }}
          onClose={() => setExplainTxn(null)}
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
