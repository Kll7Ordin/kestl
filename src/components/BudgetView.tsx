import { useState, useEffect, useRef } from 'react';
import { flushSync, createPortal } from 'react-dom';
import { getData, subscribe, upsertBudget, deleteBudget, updateBudgetNote, addBudgetGroup, updateBudgetGroup, deleteBudgetGroup, reorderBudgetsInGroup, addCategory, updateCategoryNote, updateCategoryName, updateCategoryIsIncome, pushUndoSnapshot, getColorThresholds, copyBudgetToMonths, getDisplaySettings, updateDisplaySettings, type ColorThresholds, type Category, type TransactionSplit, type BudgetGroup, type ExperimentalBudget } from '../db';
import { ImportBudgetCard } from './ImportBudgetCard';
import { SearchableSelect } from './SearchableSelect';
import { formatAmount } from '../utils/format';
import { INCOME_CATEGORY_NAMES } from '../seed';

function formatDiff(n: number): string {
  const r = Math.round(n);
  if (r === 0) return '—';
  return `${r > 0 ? '+' : '-'}$${formatAmount(Math.abs(n), 0)}`;
}


function budgetDiffColor(diff: number, target: number, t: ColorThresholds): string {
  if (Math.abs(diff) < 0.5) return '#166534'; // zero = dark green
  if (diff < 0) return '#16a34a'; // under budget = medium green
  const overPct = target > 0 ? (diff / target) * 100 : 100;
  if (overPct > t.redPct && diff > t.redAbs) return '#dc2626';
  if (overPct > t.orangePct && diff > t.orangeAbs) return '#d97706';
  return '#16a34a'; // over but below both thresholds = still green
}

function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

interface BudgetRow {
  categoryId: number;
  categoryName: string;
  note?: string;
  budgetNote?: string;
  target: number;
  spent: number;
  ytd: number;
  ytdTarget: number;
  ytdDiff: number;
  ytdAvgDiff: number;
  relevantMonthCount: number;
  isIncome?: boolean;
  groupId?: number | null;
  sortOrder?: number;
}

const _catMap = new Map<number, string>();

function buildRows(month: string, categories: Category[], _budgetGroups: BudgetGroup[], ytdMode: 'ytd' | 'rolling12'): { rows: BudgetRow[]; priorMonthCount: number; allIncomeReceived: number } {
  const d = getData();
  const budgets = d.budgets.filter((b) => b.month === month);
  _catMap.clear();
  for (const c of categories) _catMap.set(c.id, c.name);

  const [yearNum, monthNum] = month.split('-').map(Number);
  const monthStart = `${month}-01`;
  const monthEnd = `${month}-31`;

  const priorMonths: string[] = [];
  if (ytdMode === 'rolling12') {
    for (let i = 12; i >= 1; i--) {
      const pd = new Date(yearNum, monthNum - 1 - i, 1);
      priorMonths.push(`${pd.getFullYear()}-${String(pd.getMonth() + 1).padStart(2, '0')}`);
    }
  } else {
    for (let m = 1; m < monthNum; m++) {
      priorMonths.push(`${yearNum}-${String(m).padStart(2, '0')}`);
    }
  }

  // Months that had at least one transaction globally (user was actively tracking)
  const monthsWithTxns = new Set<string>();
  for (const t of d.transactions) monthsWithTxns.add(t.txnDate.slice(0, 7));

  const splitsByTxn = new Map<number, TransactionSplit[]>();
  for (const s of d.transactionSplits) {
    const arr = splitsByTxn.get(s.transactionId) ?? [];
    arr.push(s);
    splitsByTxn.set(s.transactionId, arr);
  }

  function accumulateRange(rangeStart: string, rangeEnd: string, spendMap: Map<number, number>, incomeMap: Map<number, number>) {
    for (const t of d.transactions) {
      const txnSplits = splitsByTxn.get(t.id);
      if (txnSplits && txnSplits.length > 0) {
        for (const s of txnSplits) {
          const effectiveDate = s.txnDate ?? t.txnDate;
          if (effectiveDate < rangeStart || effectiveDate > rangeEnd) continue;
          const map = t.ignoreInBudget ? incomeMap : spendMap;
          // Credits may be stored as negative amounts; income is always a positive quantity.
          const contribution = t.ignoreInBudget ? Math.abs(s.amount) : s.amount;
          map.set(s.categoryId, (map.get(s.categoryId) ?? 0) + contribution);
        }
      } else if (t.categoryId) {
        if (t.txnDate < rangeStart || t.txnDate > rangeEnd) continue;
        const map = t.ignoreInBudget ? incomeMap : spendMap;
        const contribution = t.ignoreInBudget ? Math.abs(t.amount) : t.amount;
        map.set(t.categoryId, (map.get(t.categoryId) ?? 0) + contribution);
      }
    }
  }

  const spendByCategory = new Map<number, number>();
  const incomeByCategory = new Map<number, number>();
  accumulateRange(monthStart, monthEnd, spendByCategory, incomeByCategory);

  const ytdSpendMap = new Map<number, number>();
  const ytdIncomeMap = new Map<number, number>();
  for (const pm of priorMonths) {
    accumulateRange(`${pm}-01`, `${pm}-31`, ytdSpendMap, ytdIncomeMap);
  }

  const rows = budgets.map((b) => {
    const cat = categories.find((c) => c.id === b.categoryId);
    const isIncome = cat?.isIncome === true || (cat != null && INCOME_CATEGORY_NAMES.has(cat.name));
    const grossSpent = spendByCategory.get(b.categoryId) ?? 0;
    const credits = incomeByCategory.get(b.categoryId) ?? 0;
    const ytdGross = ytdSpendMap.get(b.categoryId) ?? 0;
    const ytdCredits = ytdIncomeMap.get(b.categoryId) ?? 0;
    const ytd = isIncome ? (ytdIncomeMap.get(b.categoryId) ?? 0) : ytdGross - ytdCredits;

    // Relevant prior months: this category had a budget AND the month had any transactions
    const catBudgetByMonth = new Map<string, number>();
    for (const b2 of d.budgets) {
      if (b2.categoryId === b.categoryId) catBudgetByMonth.set(b2.month, b2.targetAmount);
    }
    const relevantPriorMonths = priorMonths.filter((pm) => monthsWithTxns.has(pm) && catBudgetByMonth.has(pm));
    const ytdTarget = relevantPriorMonths.reduce((s, pm) => s + (catBudgetByMonth.get(pm) ?? 0), 0);
    const ytdDiff = ytd - ytdTarget;
    const relevantMonthCount = relevantPriorMonths.length;
    const ytdAvgDiff = relevantMonthCount > 0 ? ytdDiff / relevantMonthCount : 0;

    return {
      categoryId: b.categoryId,
      categoryName: _catMap.get(b.categoryId) ?? '?',
      note: cat?.note,
      budgetNote: b.note,
      target: b.targetAmount,
      spent: isIncome ? credits : grossSpent - credits,
      ytd, ytdTarget, ytdDiff, ytdAvgDiff, relevantMonthCount, isIncome,
      groupId: b.groupId ?? null,
      sortOrder: (b as { sortOrder?: number }).sortOrder ?? 0,
    };
  });
  // Sum income received from ALL income categories, regardless of whether a budget entry exists
  const allIncomeCatIds = new Set(
    categories.filter((c) => c.isIncome || INCOME_CATEGORY_NAMES.has(c.name)).map((c) => c.id)
  );
  let allIncomeReceived = 0;
  for (const [catId, amount] of incomeByCategory) {
    if (allIncomeCatIds.has(catId)) allIncomeReceived += amount;
  }

  return { rows, priorMonthCount: priorMonths.length, allIncomeReceived };
}

function groupRows(rows: BudgetRow[], groups: BudgetGroup[]): { group: BudgetGroup | null; rows: BudgetRow[] }[] {
  const ungrouped = rows.filter((r) => !r.groupId).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  const byGroup = new Map<number, BudgetRow[]>();
  for (const r of rows) {
    if (r.groupId != null) {
      const arr = byGroup.get(r.groupId) ?? [];
      arr.push(r);
      byGroup.set(r.groupId, arr);
    }
  }
  for (const arr of byGroup.values()) arr.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  const result: { group: BudgetGroup | null; rows: BudgetRow[] }[] = [];
  for (const g of [...groups].sort((a, b) => a.sortOrder - b.sortOrder)) {
    result.push({ group: g, rows: byGroup.get(g.id) ?? [] });
  }
  result.push({ group: null, rows: ungrouped });
  return result;
}

interface BudgetViewProps {
  search?: string;
  onNavigateToTransactions?: (month: string, categoryId?: number, offBudget?: boolean, uncategorized?: boolean) => void;
  onNavigateToYear?: (categoryId?: number, groupId?: number) => void;
}

const BUDGET_MONTH_KEY = 'budget-app-budget-month';

export function BudgetView({ search = '', onNavigateToTransactions, onNavigateToYear }: BudgetViewProps) {
  const [month, setMonthRaw] = useState(() => sessionStorage.getItem(BUDGET_MONTH_KEY) || currentMonth());

  function setMonth(m: string) {
    sessionStorage.setItem(BUDGET_MONTH_KEY, m);
    setMonthRaw(m);
  }
  const [rows, setRows] = useState<BudgetRow[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [budgetGroups, setBudgetGroups] = useState<BudgetGroup[]>([]);
  const [newCatId, setNewCatId] = useState<number | ''>('');
  const [newTarget, setNewTarget] = useState('');
  const [newCatName, setNewCatName] = useState(''); // for inline category creation
  const [newCatIsIncome, setNewCatIsIncome] = useState(false);
  const [showAddGroup, setShowAddGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupSpendFromSavings, setNewGroupSpendFromSavings] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [editTarget, setEditTarget] = useState('');
  const [editPastMonths, setEditPastMonths] = useState(false);
  const [editingGroupName, setEditingGroupName] = useState('');
  const [editingGroupSpendFromSavings, setEditingGroupSpendFromSavings] = useState(false);
  const [groupSettingsGroupId, setGroupSettingsGroupId] = useState<number | null>(null);
  const [catRenameId, setCatRenameId] = useState<number | null>(null);
  const [catRenameName, setCatRenameName] = useState('');
  const [priorMonthCount, setPriorMonthCount] = useState(0);
  const [allIncomeReceived, setAllIncomeReceived] = useState(0);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [editNoteId, setEditNoteId] = useState<number | null>(null);
  const [editNoteText, setEditNoteText] = useState('');
  const [editBudgetNoteId, setEditBudgetNoteId] = useState<number | null>(null);
  const [editBudgetNoteText, setEditBudgetNoteText] = useState('');
  const [editGroupNoteId, setEditGroupNoteId] = useState<number | null>(null);
  const [editGroupNoteText, setEditGroupNoteText] = useState('');
  const [confirmDeleteGroupId, setConfirmDeleteGroupId] = useState<number | null>(null);
  const [colorThresholds, setColorThresholdsState] = useState(() => getColorThresholds());
  const [ytdColumnsVisible, setYtdColumnsVisible] = useState(() => getDisplaySettings().ytdColumnsVisible);
  const [ytdMode, setYtdMode] = useState<'ytd' | 'rolling12'>(() => getDisplaySettings().ytdMode);

  // Item drag state — uses direct DOM for transforms during drag (no re-renders)
  const _moveRef = useRef<((e: MouseEvent) => void) | null>(null);
  const _upRef = useRef<((e: MouseEvent) => void) | null>(null);
  const tableBodyRef = useRef<HTMLTableSectionElement>(null);
  const budgetTableRef = useRef<HTMLTableElement>(null);
  const ghostElRef = useRef<HTMLDivElement>(null);
  const dragInfoRef = useRef<{
    catId: number;
    sourceGroupId: number | null;
    sourceIdx: number;
    hoverIdx: number;
    flatPositions: { catId: number; groupId: number | null; el: HTMLElement; centerY: number }[];
    rowEl: HTMLElement;
    rowHeight: number;
    zoom: number;
  } | null>(null);
  const [dragCatId, setDragCatId] = useState<number | null>(null);
  const [ghostInfo, setGhostInfo] = useState<{
    label: string; target: number; spent: number;
  } | null>(null);

  // Group drag state
  const [dragGroupId, setDragGroupId] = useState<number | null>(null);
  const dragGroupIdRef = useRef<number | null>(null);
  const _groupMoveRef = useRef<((e: MouseEvent) => void) | null>(null);
  const _groupUpRef = useRef<((e: MouseEvent) => void) | null>(null);
  const [groupGhostLabel, setGroupGhostLabel] = useState<string | null>(null);
  const groupGhostElRef = useRef<HTMLDivElement>(null);

  useEffect(() => () => {
    if (_moveRef.current) document.removeEventListener('mousemove', _moveRef.current);
    if (_upRef.current) document.removeEventListener('mouseup', _upRef.current);
    if (_groupMoveRef.current) document.removeEventListener('mousemove', _groupMoveRef.current);
    if (_groupUpRef.current) document.removeEventListener('mouseup', _groupUpRef.current);
  }, []);

  const [barCapInfo, setBarCapInfo] = useState({ overflow: 600, catWidth: 400 });
  const [showPickExperimental, setShowPickExperimental] = useState(false);
  const [showPickMonth, setShowPickMonth] = useState(false);
  const [confirmOverwrite, setConfirmOverwrite] = useState<{ type: 'pickMonth' | 'experimental'; sourceMonth?: string; expId?: number } | null>(null);
  const [experimentalBudgets, setExperimentalBudgets] = useState<ExperimentalBudget[]>([]);
  const [totalBudgetRows, setTotalBudgetRows] = useState(0);

  // Keep --bar-max-overflow in sync with column positions
  const ytdColumnsVisibleRef = useRef(ytdColumnsVisible);
  ytdColumnsVisibleRef.current = ytdColumnsVisible;
  useEffect(() => {
    function measure() {
      const table = budgetTableRef.current;
      if (!table) return;
      const catTh = table.querySelector('th[data-col="category"]') as HTMLElement | null;
      const avgTh = table.querySelector('th[data-col="avg"]') as HTMLElement | null;
      const ytdTh = table.querySelector('th[data-col="ytd"]') as HTMLElement | null;
      const ytdDiffTh = table.querySelector('th[data-col="ytd-diff"]') as HTMLElement | null;
      if (!catTh) return;
      const catRect = catTh.getBoundingClientRect();
      let midpoint: number;
      if (!ytdColumnsVisibleRef.current && ytdDiffTh) {
        // Columns hidden — bar can extend through the empty YTD space
        midpoint = ytdDiffTh.getBoundingClientRect().right - 4;
      } else if (avgTh && ytdTh) {
        // Columns visible — anchor to gap between Avg and YTD
        const avgRect = avgTh.getBoundingClientRect();
        const ytdRect = ytdTh.getBoundingClientRect();
        midpoint = (avgRect.right + ytdRect.left) / 2;
      } else {
        midpoint = catRect.right + 32;
      }
      const overflow = Math.max(0, midpoint - catRect.right + 18);
      table.style.setProperty('--bar-max-overflow', `${overflow}px`);
      setBarCapInfo({ overflow, catWidth: catRect.width });
    }
    measure();
    const ro = new ResizeObserver(measure);
    if (budgetTableRef.current) ro.observe(budgetTableRef.current);
    return () => ro.disconnect();
  }, [priorMonthCount, ytdColumnsVisible]);

  useEffect(() => {
    function refresh() {
      const d = getData();
      const ds = getDisplaySettings();
      setCategories(d.categories);
      setBudgetGroups(d.budgetGroups ?? []);
      setExperimentalBudgets(d.experimentalBudgets ?? []);
      setTotalBudgetRows(d.budgets.length);
      setYtdColumnsVisible(ds.ytdColumnsVisible);
      setYtdMode(ds.ytdMode);
      const result = buildRows(month, d.categories, d.budgetGroups ?? [], ds.ytdMode);
      setRows(result.rows);
      setPriorMonthCount(result.priorMonthCount);
      setAllIncomeReceived(result.allIncomeReceived);
      setColorThresholdsState(getColorThresholds());
    }
    refresh();
    return subscribe(refresh);
  }, [month]);

  async function addBudgetItem() {
    if (!newTarget) return;
    let catId = newCatId as number;
    if (!catId) {
      if (!newCatName.trim()) return;
      catId = await addCategory(newCatName.trim());
      if (newCatIsIncome) await updateCategoryIsIncome(catId, true);
      setNewCatName('');
      setNewCatIsIncome(false);
    }
    await upsertBudget(month, catId, parseFloat(newTarget));
    setNewCatId(''); setNewTarget('');
  }

  async function addGroup() {
    if (!newGroupName.trim()) return;
    const id = await addBudgetGroup(newGroupName.trim());
    if (newGroupSpendFromSavings) await updateBudgetGroup(id, { spendFromSavings: true });
    setNewGroupName(''); setNewGroupSpendFromSavings(false); setShowAddGroup(false);
  }

  function openGroupSettings(group: BudgetGroup) {
    setGroupSettingsGroupId(group.id);
    setEditingGroupName(group.name);
    setEditingGroupSpendFromSavings(group.spendFromSavings ?? false);
  }

  async function saveGroupSettings() {
    if (groupSettingsGroupId == null) return;
    const name = editingGroupName.trim();
    if (name) await updateBudgetGroup(groupSettingsGroupId, { name, spendFromSavings: editingGroupSpendFromSavings });
    setGroupSettingsGroupId(null);
  }

  async function saveCatRename() {
    if (catRenameId == null || !catRenameName.trim()) return;
    await updateCategoryName(catRenameId, catRenameName.trim());
    setCatRenameId(null);
  }


  async function handleDrop(draggedCategoryId: number, targetGroupId: number | null, beforeCategoryId: number | null) {
    const draggedRow = expenseRows.find((r) => r.categoryId === draggedCategoryId);
    if (!draggedRow) return;
    // Sort by sortOrder to match display order — critical for correct insertion
    const sortBySortOrder = (a: BudgetRow, b: BudgetRow) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
    const targetGroupRows = (targetGroupId == null
      ? expenseRows.filter((r) => !r.groupId)
      : expenseRows.filter((r) => r.groupId === targetGroupId)
    ).sort(sortBySortOrder);
    const targetIds = targetGroupRows.map((r) => r.categoryId);
    const isSameGroup = (draggedRow.groupId ?? null) === targetGroupId;
    let newOrder: number[];
    if (isSameGroup) {
      const without = targetIds.filter((id) => id !== draggedCategoryId);
      const insertIdx = beforeCategoryId == null ? without.length : without.indexOf(beforeCategoryId);
      if (insertIdx < 0) return;
      newOrder = [...without.slice(0, insertIdx), draggedCategoryId, ...without.slice(insertIdx)];
    } else {
      const oldGroupId = draggedRow.groupId ?? null;
      const oldGroupRows = (oldGroupId == null ? expenseRows.filter((r) => !r.groupId) : expenseRows.filter((r) => r.groupId === oldGroupId)).sort(sortBySortOrder);
      const oldOrder = oldGroupRows.map((r) => r.categoryId).filter((id) => id !== draggedCategoryId);
      const insertIdx = beforeCategoryId == null ? targetIds.length : targetIds.indexOf(beforeCategoryId);
      const safeIdx = insertIdx < 0 ? targetIds.length : insertIdx;
      newOrder = [...targetIds.slice(0, safeIdx), draggedCategoryId, ...targetIds.slice(safeIdx)];
      await reorderBudgetsInGroup(month, oldGroupId, oldOrder);
    }
    await reorderBudgetsInGroup(month, targetGroupId, newOrder);
  }

  function startRowDrag(e: React.MouseEvent, row: BudgetRow, groupId: number | null) {
    e.preventDefault();
    e.stopPropagation();
    if (_moveRef.current) document.removeEventListener('mousemove', _moveRef.current);
    if (_upRef.current) document.removeEventListener('mouseup', _upRef.current);

    const rowEl = (e.currentTarget as HTMLElement).closest('tr') as HTMLElement;
    const rowRect = rowEl.getBoundingClientRect();
    const tableEl = tableBodyRef.current!;

    // Detect CSS zoom for transform calculations (transforms are in pre-zoom space)
    const appEl = rowEl.closest('.app') as HTMLElement | null;
    const zoom = appEl ? parseFloat(appEl.style.zoom || '1') : 1;

    // Capture positions of all category rows at drag start
    const allCatRows = Array.from(tableEl.querySelectorAll('tr[data-catid]')) as HTMLElement[];
    const flatPositions = allCatRows.map(el => {
      const rect = el.getBoundingClientRect();
      return {
        catId: Number(el.dataset.catid),
        groupId: el.dataset.groupid === 'null' ? null : Number(el.dataset.groupid),
        el,
        centerY: rect.top + rect.height / 2,
      };
    });
    const sourceIdx = flatPositions.findIndex(p => p.catId === row.categoryId);

    dragInfoRef.current = {
      catId: row.categoryId, sourceGroupId: groupId,
      sourceIdx, hoverIdx: sourceIdx,
      flatPositions, rowEl, rowHeight: rowRect.height, zoom,
    };

    // Prepare rows for animation
    allCatRows.forEach(el => {
      if (el !== rowEl) {
        el.style.transition = 'transform 150ms cubic-bezier(0.25, 0.1, 0.25, 1)';
        el.style.willChange = 'transform';
      }
    });

    // Prevent text selection during drag
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'grabbing';

    // Use flushSync so the ghost DOM element exists immediately (no lag on first frame)
    flushSync(() => {
      setDragCatId(row.categoryId);
      setGhostInfo({
        label: row.categoryName, target: row.target, spent: row.spent,
      });
    });

    _moveRef.current = (me: MouseEvent) => {
      const dd = dragInfoRef.current;
      if (!dd) return;

      // Position ghost at cursor (portaled to body, outside zoom — use native coords directly)
      if (ghostElRef.current) {
        ghostElRef.current.style.left = `${me.clientX + 12}px`;
        ghostElRef.current.style.top = `${me.clientY - 18}px`;
      }

      // Compute hover index — centerY is in zoom-local coords, me.clientY is viewport
      const ghostCenterY = me.clientY / dd.zoom;
      let hoverIdx = dd.sourceIdx;
      for (let i = 0; i < dd.flatPositions.length; i++) {
        const pos = dd.flatPositions[i];
        const prevCY = i > 0 ? dd.flatPositions[i - 1].centerY : -Infinity;
        const nextCY = i < dd.flatPositions.length - 1 ? dd.flatPositions[i + 1].centerY : Infinity;
        if (ghostCenterY >= (prevCY + pos.centerY) / 2 && ghostCenterY < (pos.centerY + nextCY) / 2) {
          hoverIdx = i;
          break;
        }
      }

      if (hoverIdx !== dd.hoverIdx) {
        dd.hoverIdx = hoverIdx;
        const shiftPx = dd.rowHeight;
        for (let i = 0; i < dd.flatPositions.length; i++) {
          if (i === dd.sourceIdx) continue;
          let ty = 0;
          if (hoverIdx > dd.sourceIdx && i > dd.sourceIdx && i <= hoverIdx) ty = -shiftPx;
          else if (hoverIdx < dd.sourceIdx && i >= hoverIdx && i < dd.sourceIdx) ty = shiftPx;
          dd.flatPositions[i].el.style.transform = ty ? `translateY(${ty}px)` : '';
        }
      }
    };

    _upRef.current = () => {
      document.removeEventListener('mousemove', _moveRef.current!);
      document.removeEventListener('mouseup', _upRef.current!);
      _moveRef.current = null; _upRef.current = null;
      document.body.style.userSelect = '';
      document.body.style.cursor = '';

      const dd = dragInfoRef.current;
      if (dd) {
        dd.flatPositions.forEach(p => { p.el.style.transform = ''; p.el.style.transition = ''; p.el.style.willChange = ''; });
        const hoverIdx = dd.hoverIdx;
        if (hoverIdx !== dd.sourceIdx) {
          const targetGroupId = dd.flatPositions[hoverIdx].groupId;
          const isCrossGroup = targetGroupId !== dd.sourceGroupId;
          let beforeCatId: number | null;
          if (hoverIdx > dd.sourceIdx) {
            if (isCrossGroup) {
              // Cross-group: insert AT the hovered row's position in the target group
              beforeCatId = dd.flatPositions[hoverIdx].catId;
            } else {
              // Same-group: insert after hovered position (before the next row in same group)
              let next: number | null = null;
              for (let i = hoverIdx + 1; i < dd.flatPositions.length; i++) {
                if (i === dd.sourceIdx) continue;
                if (dd.flatPositions[i].groupId === targetGroupId) next = dd.flatPositions[i].catId;
                break;
              }
              beforeCatId = next;
            }
          } else {
            beforeCatId = dd.flatPositions[hoverIdx].catId;
          }
          handleDrop(dd.catId, targetGroupId, beforeCatId);
        }
      }
      setDragCatId(null);
      setGhostInfo(null);
      dragInfoRef.current = null;
    };

    document.addEventListener('mousemove', _moveRef.current);
    document.addEventListener('mouseup', _upRef.current);
  }

  function startGroupDrag(e: React.MouseEvent, group: BudgetGroup) {
    e.preventDefault();
    e.stopPropagation();
    if (_groupMoveRef.current) document.removeEventListener('mousemove', _groupMoveRef.current);
    if (_groupUpRef.current) document.removeEventListener('mouseup', _groupUpRef.current);
    dragGroupIdRef.current = group.id;
    setDragGroupId(group.id);
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'grabbing';

    // Render ghost (portaled to body, outside zoom) — position via ref using native mouse coords
    flushSync(() => setGroupGhostLabel(`⊞ ${group.name}`));

    _groupMoveRef.current = (me: MouseEvent) => {
      if (groupGhostElRef.current) {
        groupGhostElRef.current.style.left = `${me.clientX + 12}px`;
        groupGhostElRef.current.style.top = `${me.clientY - 10}px`;
      }
    };
    _groupUpRef.current = async (ue: MouseEvent) => {
      document.removeEventListener('mousemove', _groupMoveRef.current!);
      document.removeEventListener('mouseup', _groupUpRef.current!);
      _groupMoveRef.current = null; _groupUpRef.current = null;
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      setGroupGhostLabel(null);
      const draggingId = dragGroupIdRef.current;
      dragGroupIdRef.current = null;
      setDragGroupId(null);
      if (!draggingId) return;
      const el = document.elementFromPoint(ue.clientX, ue.clientY);
      const targetRow = el?.closest('[data-grouphdr-id]') as HTMLElement | null;
      if (!targetRow) return;
      const targetId = Number(targetRow.dataset.grouphdrId);
      if (isNaN(targetId) || targetId === draggingId) return;
      // Reorder: move dragging group to target's position
      const sorted = [...budgetGroups].sort((a, b) => a.sortOrder - b.sortOrder);
      const fromIdx = sorted.findIndex((g) => g.id === draggingId);
      const toIdx = sorted.findIndex((g) => g.id === targetId);
      if (fromIdx < 0 || toIdx < 0) return;
      const reordered = [...sorted];
      const [moved] = reordered.splice(fromIdx, 1);
      reordered.splice(toIdx, 0, moved);
      for (let i = 0; i < reordered.length; i++) {
        if (reordered[i].sortOrder !== i) await updateBudgetGroup(reordered[i].id, { sortOrder: i });
      }
    };
    document.addEventListener('mousemove', _groupMoveRef.current);
    document.addEventListener('mouseup', _groupUpRef.current);
  }

  async function removeBudgetItem(categoryId: number) { await deleteBudget(month, categoryId); }

  async function saveEdit(categoryId: number) {
    const row = rows.find((r) => r.categoryId === categoryId);
    const newTarget = parseFloat(editTarget);
    pushUndoSnapshot();
    await upsertBudget(month, categoryId, newTarget, row?.groupId);
    if (editPastMonths) {
      const d = getData();
      const pastBudgets = d.budgets.filter((b) => b.month < month && b.categoryId === categoryId);
      for (const b of pastBudgets) {
        await upsertBudget(b.month, categoryId, newTarget, b.groupId);
      }
    }
    setEditId(null);
    setEditPastMonths(false);
  }

  async function copyFromMonth(sourceMonth: string) {
    await copyBudgetToMonths(sourceMonth, [month]);
    const sourceCount = getData().budgets.filter((b) => b.month === month).length;
    const label = new Date(sourceMonth + '-01').toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    alert(`Copied ${sourceCount} budget items from ${label}.`);
    setConfirmOverwrite(null);
    setShowPickMonth(false);
  }

  async function copyFromExperimental(expId: number) {
    const expBudgets = getData().experimentalBudgets ?? [];
    const exp = expBudgets.find((b: ExperimentalBudget) => b.id === expId);
    if (!exp) return;
    for (const item of exp.items) {
      await upsertBudget(month, item.categoryId, item.targetAmount, item.groupId);
    }
    setConfirmOverwrite(null);
    setShowPickExperimental(false);
  }

  function requestCopy(type: 'pickMonth' | 'experimental', expId?: number) {
    if (type === 'pickMonth') {
      setShowPickMonth(true);
      return;
    }
    if (expenseRows.length > 0) {
      setConfirmOverwrite({ type, expId });
      if (type === 'experimental' && expId == null) {
        setShowPickExperimental(true);
      }
    } else {
      if (expId != null) copyFromExperimental(expId);
      else setShowPickExperimental(true);
    }
  }

  const sq = search.trim().toLowerCase();
  const searchFilter = (r: BudgetRow) => !sq || r.categoryName.toLowerCase().includes(sq);
  const expenseRows = rows.filter((r) => !r.isIncome && searchFilter(r));
  const incomeRows = rows.filter((r) => r.isIncome && searchFilter(r));

  // Identify groups marked as "Spend from Savings"
  const spendFromSavingsGroupIds = new Set(budgetGroups.filter((g) => g.spendFromSavings).map((g) => g.id));
  const savingsRows = expenseRows.filter((r) => r.groupId != null && spendFromSavingsGroupIds.has(r.groupId));
  const regularRows = expenseRows.filter((r) => r.groupId == null || !spendFromSavingsGroupIds.has(r.groupId));

  const totalTarget = regularRows.reduce((s, r) => s + r.target, 0);
  const totalSpent = regularRows.reduce((s, r) => s + r.spent, 0);
  const spentFromSavings = savingsRows.reduce((s, r) => s + r.spent, 0);
  const totalIncome = incomeRows.reduce((s, r) => s + r.target, 0);
  const totalReceived = allIncomeReceived;
  const yetToReceive = totalIncome > 0 ? totalIncome - totalReceived : 0;
  const net = totalIncome - totalTarget;
  const grouped = groupRows(expenseRows, budgetGroups);

  const COLS = 7;
  const [y, mon] = month.split('-').map(Number);
  const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const curYear = new Date().getFullYear();

  // Uncategorized transactions for the current month
  const uncatTotal = (() => {
    const d = getData();
    const monthStart = `${month}-01`;
    const monthEnd = `${month}-31`;
    const splitsByTxn2 = new Map<number, { categoryId: number }[]>();
    for (const s of d.transactionSplits) {
      const arr = splitsByTxn2.get(s.transactionId) ?? [];
      arr.push(s);
      splitsByTxn2.set(s.transactionId, arr);
    }
    let total = 0;
    for (const t of d.transactions) {
      if (t.txnDate < monthStart || t.txnDate > monthEnd) continue;
      if (t.ignoreInBudget) continue;
      const splits = splitsByTxn2.get(t.id);
      if (splits && splits.length > 0) continue; // split = categorized
      if (t.categoryId == null) total += t.amount;
    }
    return total;
  })();

  // Spending in categories that are NOT in the current month's budget
  const offBudgetTotal = (() => {
    const d = getData();
    const budgetCatIds = new Set(d.budgets.filter((b) => b.month === month).map((b) => b.categoryId));
    const monthStart = `${month}-01`;
    const monthEnd = `${month}-31`;
    const splitsByTxn2 = new Map<number, { categoryId: number; amount: number }[]>();
    for (const s of d.transactionSplits) {
      const arr = splitsByTxn2.get(s.transactionId) ?? [];
      arr.push(s);
      splitsByTxn2.set(s.transactionId, arr);
    }
    const incomeCatIds = new Set(
      d.categories.filter((c) => c.isIncome || INCOME_CATEGORY_NAMES.has(c.name)).map((c) => c.id)
    );
    let total = 0;
    for (const t of d.transactions) {
      if (t.txnDate < monthStart || t.txnDate > monthEnd) continue;
      if (t.ignoreInBudget) continue;
      const splits = splitsByTxn2.get(t.id);
      if (splits && splits.length > 0) {
        for (const s of splits) {
          if (!budgetCatIds.has(s.categoryId) && !incomeCatIds.has(s.categoryId)) total += s.amount;
        }
      } else if (t.categoryId != null && !budgetCatIds.has(t.categoryId) && !incomeCatIds.has(t.categoryId)) {
        total += t.amount;
      }
    }
    return total;
  })();

  return (
    <div style={{ maxWidth: 1400, margin: '0 auto' }}>
      {/* Title + month navigation on same row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1.25rem', flexWrap: 'wrap' }}>
        <h1 className="view-title" style={{ margin: 0, flexShrink: 0 }}>Monthly Budget</h1>
        <div className="month-nav" style={{ margin: 0, marginBottom: 0 }}>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => {
            const d = new Date(y, mon - 2, 1);
            setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
          }}>‹</button>
          <div style={{ display: 'flex', gap: '0.25rem', alignItems: 'center' }}>
            <select value={String(mon).padStart(2, '0')} onChange={(e) => setMonth(`${y}-${e.target.value}`)}
              style={{ fontWeight: 600, fontSize: '0.95rem', padding: '0.25rem 0.3rem' }}>
              {MONTH_NAMES.map((name, idx) => (
                <option key={idx} value={String(idx + 1).padStart(2, '0')}>{name}</option>
              ))}
            </select>
            <select value={String(y)} onChange={(e) => setMonth(`${e.target.value}-${String(mon).padStart(2, '0')}`)}
              style={{ fontWeight: 600, fontSize: '0.95rem', padding: '0.25rem 0.3rem' }}>
              {[curYear - 2, curYear - 1, curYear, curYear + 1].map((yr) => (
                <option key={yr} value={String(yr)}>{yr}</option>
              ))}
            </select>
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => {
            const d = new Date(y, mon, 1);
            setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
          }}>›</button>
        </div>
      </div>

      {/* Import Budget — shown only when no budget has been set yet */}
      {totalBudgetRows === 0 && (
        <div className="card" style={{ marginBottom: '1rem', borderLeft: '3px solid var(--accent)' }}>
          <div className="section-title" style={{ marginTop: 0 }}>Get started: Import Budget</div>
          <p style={{ fontSize: '0.85rem', opacity: 0.75, marginBottom: '0.75rem' }}>
            No budget yet. Import from a spreadsheet to create a draft, then apply it to this month.
          </p>
          <ImportBudgetCard compact />
        </div>
      )}

      {/* Summary bubbles — equal-width sub-cards via shared grid */}
      {(() => {
        const budgetCardCount = totalIncome > 0 ? 3 : 2;
        const mtdCardCount = 2 + (spendFromSavingsGroupIds.size > 0 ? 1 : 0) + (incomeRows.length > 0 ? 2 : 0);
        return (
        <div style={{ display: 'grid', gridTemplateColumns: `${budgetCardCount}fr ${mtdCardCount}fr`, gap: '1rem', marginBottom: '1rem' }}>
          {/* Budget */}
          <div style={{ background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: '0.875rem 0 0.875rem 0', overflow: 'hidden' }}>
            <div style={{ fontSize: '0.68rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-3)', marginBottom: '0.6rem', paddingLeft: '0.875rem' }}>Budget</div>
            <div style={{ display: 'grid', gridTemplateColumns: `repeat(${budgetCardCount}, 1fr)`, gap: 0 }}>
              <div className="summary-card" style={{ borderRadius: 0, border: 'none', borderRight: '1px solid var(--border)' }}>
                <span className="summary-label">Expenses</span>
                <span className="summary-value negative">${formatAmount(totalTarget, 0)}</span>
              </div>
              {totalIncome > 0 && (
                <div className="summary-card" style={{ borderRadius: 0, border: 'none', borderRight: '1px solid var(--border)' }}>
                  <span className="summary-label">Income</span>
                  <span className="summary-value" style={{ color: '#16a34a' }}>${formatAmount(totalIncome, 0)}</span>
                </div>
              )}
              <div className="summary-card" style={{ borderRadius: 0, border: 'none' }}>
                <span className="summary-label">Net</span>
                <span className="summary-value" style={{ color: net >= 0 ? '#16a34a' : '#dc2626' }}>${formatAmount(net, 0)}</span>
              </div>
            </div>
          </div>

          {/* Month to Date */}
          <div style={{ background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: '0.875rem 0 0.875rem 0', overflow: 'hidden' }}>
            <div style={{ fontSize: '0.68rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-3)', marginBottom: '0.6rem', paddingLeft: '0.875rem' }}>Month to Date</div>
            <div style={{ display: 'grid', gridTemplateColumns: `repeat(${mtdCardCount}, 1fr)`, gap: 0 }}>
              <div className="summary-card" style={{ borderRadius: 0, border: 'none', borderRight: '1px solid var(--border)' }}>
                <span className="summary-label">Spent</span>
                <span className="summary-value" style={{ color: '#3b82f6' }}>${formatAmount(totalSpent, 0)}</span>
              </div>
              {spendFromSavingsGroupIds.size > 0 && (
                <div className="summary-card" style={{ borderRadius: 0, border: 'none', borderRight: '1px solid var(--border)' }}>
                  <span className="summary-label">From Savings</span>
                  <span className="summary-value" style={{ color: '#3b82f6' }}>${formatAmount(spentFromSavings, 0)}</span>
                </div>
              )}
              <div className="summary-card" style={{ borderRadius: 0, border: 'none', borderRight: incomeRows.length > 0 ? '1px solid var(--border)' : 'none' }}>
                <span className="summary-label">Remaining</span>
                <span className="summary-value" style={{ color: '#b45309' }}>${formatAmount(Math.max(0, totalTarget - totalSpent), 0)}</span>
              </div>
              {incomeRows.length > 0 && (
                <div className="summary-card" style={{ borderRadius: 0, border: 'none', borderRight: '1px solid var(--border)' }}>
                  <span className="summary-label">Received</span>
                  <span className="summary-value" style={{ color: '#3b82f6' }}>${formatAmount(totalReceived, 0)}</span>
                </div>
              )}
              {incomeRows.length > 0 && (
                <div className="summary-card" style={{ borderRadius: 0, border: 'none' }}>
                  <span className="summary-label">Yet to Receive</span>
                  <span className="summary-value" style={{ color: '#b45309' }}>${formatAmount(yetToReceive, 0)}</span>
                </div>
              )}
            </div>
          </div>
        </div>
        );
      })()}

      {/* Uncategorized sum banner — below summary, above budget rows */}
      {uncatTotal > 0 && (
        <div
          className="card"
          style={{ borderLeft: '3px solid #fbbf24', marginBottom: '0.75rem', padding: '0.6rem 1rem', display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap', cursor: onNavigateToTransactions ? 'pointer' : 'default' }}
          onClick={() => onNavigateToTransactions?.(month, undefined, false, true)}
          title={onNavigateToTransactions ? 'View uncategorized transactions' : undefined}
        >
          <span style={{ fontWeight: 400, fontSize: '0.8rem' }}>Uncategorized this month:</span>
          <span style={{ color: '#d97706', fontWeight: 700, fontSize: '0.8rem' }}>${formatAmount(uncatTotal, 0)}</span>
          {onNavigateToTransactions && <span style={{ fontSize: '0.75rem', opacity: 0.5 }}>→</span>}
        </div>
      )}

      {/* Expense table — single table so columns align across all groups */}
      <div className="card">
        {expenseRows.length === 0 && (
          <div style={{ marginBottom: '1rem', display: 'flex', gap: '0.5rem', justifyContent: 'center', flexWrap: 'wrap' }}>
            <button className="btn btn-primary" onClick={() => requestCopy('pickMonth')}>Copy budget from a different month</button>
            <button className="btn btn-ghost" onClick={() => requestCopy('experimental')}>Copy from Budget Sandbox</button>
          </div>
        )}
        <div className="section-title" style={{ marginTop: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <span>Expenses</span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: '0.25rem' }}>
            <button
              className="btn btn-ghost btn-sm"
              title={ytdMode === 'rolling12' ? 'Switch to year-to-date' : 'Switch to rolling 12 months'}
              style={{ fontSize: '0.65rem', padding: '0.1rem 0.4rem', opacity: 0.55 }}
              onClick={() => { const m = ytdMode === 'rolling12' ? 'ytd' : 'rolling12'; setYtdMode(m); updateDisplaySettings({ ytdMode: m }); }}
            >
              {ytdMode === 'rolling12' ? '12M' : 'YTD'}
            </button>
            <button
              className="btn btn-ghost btn-sm"
              title={ytdColumnsVisible ? 'Hide period columns' : 'Show period columns'}
              style={{ fontSize: '0.65rem', padding: '0.1rem 0.4rem', opacity: ytdColumnsVisible ? 0.55 : 0.25 }}
              onClick={() => { const v = !ytdColumnsVisible; setYtdColumnsVisible(v); updateDisplaySettings({ ytdColumnsVisible: v }); }}
            >
              👁
            </button>
          </div>
        </div>
        <table className="data-table budget-table" ref={budgetTableRef}>
          <thead>
            <tr>
              <th style={{ width: 24 }}></th>
              <th data-col="category">Category</th>
              <th className="num" style={{ fontSize: '0.65rem', width: 72, padding: '0.55rem 6px' }}>Target</th>
              <th className="num" data-col="avg" style={{ fontSize: '0.65rem', width: 64, padding: '0.55rem 14px 0.55rem 6px' }}>Avg ±/mo</th>
              <th className="num" data-col="ytd" style={{ opacity: ytdColumnsVisible ? 0.4 : 1, fontSize: '0.65rem', width: 68, padding: '0.55rem 6px 0.55rem 12px', borderLeft: ytdColumnsVisible ? '2px solid var(--border)' : 'none' }}><span style={{ visibility: ytdColumnsVisible ? 'visible' : 'hidden' }}>{ytdMode === 'rolling12' ? '12M' : 'YTD'}</span></th>
              <th className="num" data-col="ytd-target" style={{ opacity: ytdColumnsVisible ? 0.4 : 1, fontSize: '0.65rem', width: 68, padding: '0.55rem 6px' }}><span style={{ visibility: ytdColumnsVisible ? 'visible' : 'hidden' }}>{ytdMode === 'rolling12' ? '12M Tgt' : 'YTD Tgt'}</span></th>
              <th className="num" data-col="ytd-diff" style={{ opacity: ytdColumnsVisible ? 0.4 : 1, fontSize: '0.65rem', width: 68, padding: '0.55rem 6px' }}><span style={{ visibility: ytdColumnsVisible ? 'visible' : 'hidden' }}>{ytdMode === 'rolling12' ? '12M Diff' : 'YTD Diff'}</span></th>
            </tr>
          </thead>
          <tbody ref={tableBodyRef}>
            {grouped.flatMap(({ group, rows: grpRows }) => {
              const thisGroupId = group?.id ?? null;
              const groupTarget = grpRows.reduce((s, r) => s + r.target, 0);
              // Hide ungrouped section entirely when empty and not dragging
              if (group === null && grpRows.length === 0 && !ghostInfo) return [];

              const result: React.ReactNode[] = [];

              result.push(
                // Group header row
                <tr key={`hdr-${group?.id ?? 'ug'}`} className="budget-group-header"
                    data-grouphdr-id={group?.id ?? undefined}
                    style={{ opacity: dragGroupId === group?.id ? 0.4 : 1 }}>
                  <td
                    style={{ width: 24, paddingLeft: 4, paddingRight: 4, background: 'var(--bg-3)', borderTop: '1px solid var(--border)',
                      cursor: group ? 'grab' : 'default', userSelect: 'none', WebkitUserSelect: 'none' } as React.CSSProperties}
                    onMouseDown={group ? (e) => startGroupDrag(e, group) : undefined}
                    title={group ? 'Drag to reorder group' : undefined}
                  >
                    {group && (
                      <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor" style={{ display: 'block', opacity: 0.4, pointerEvents: 'none' }}>
                        {([2,7,12] as number[]).map(cy => ([1,6] as number[]).map(cx => (
                          <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={1.4} />
                        )))}
                      </svg>
                    )}
                  </td>
                  <td colSpan={COLS - 1} style={{ padding: '0.75rem 0.75rem 0.4rem 0.1rem', background: 'var(--bg-3)', borderTop: '1px solid var(--border)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      {group ? (
                        <span style={{ fontSize: '0.8rem', fontWeight: 600 }}>{group.name}</span>
                      ) : (
                        <span style={{ opacity: 0.6, fontSize: '0.8rem' }}>Ungrouped</span>
                      )}
                      <span style={{ fontSize: '0.75rem', fontWeight: 400, opacity: 0.55 }}>
                        ${formatAmount(groupTarget, 0)}
                      </span>
                      {group && (
                        <span
                          className={`budget-cat-icons${confirmDeleteGroupId === group.id || editGroupNoteId === group.id ? ' budget-cat-icons-active' : ''}`}
                          style={{ display: 'inline-flex', alignItems: 'center', gap: 2, marginLeft: 4 }}
                        >
                          <button
                            className="btn btn-ghost btn-sm"
                            title="Group settings (rename, spend from savings)"
                            onClick={() => openGroupSettings(group)}
                            style={{ opacity: 0.5, fontSize: '0.8rem', padding: '0.1rem 0.3rem' }}
                          >⚙</button>
                          {onNavigateToYear && (
                            <span
                              title={`View ${group.name} trend in Year view`}
                              style={{ cursor: 'pointer', opacity: 0.35, fontSize: '0.7rem', flexShrink: 0 }}
                              onClick={() => onNavigateToYear(undefined, group.id)}
                            >📈</span>
                          )}
                          {confirmDeleteGroupId === group.id ? (
                            <span style={{ display: 'flex', gap: 2, alignItems: 'center', flexShrink: 0 }}>
                              <span style={{ fontSize: '0.65rem', color: 'var(--text-2)' }}>Delete?</span>
                              <button className="btn btn-danger btn-sm" style={{ fontSize: '0.65rem', padding: '0.1rem 0.25rem' }} onClick={() => { deleteBudgetGroup(group.id); setConfirmDeleteGroupId(null); }}>Yes</button>
                              <button className="btn btn-ghost btn-sm" style={{ fontSize: '0.65rem', padding: '0.1rem 0.25rem' }} onClick={() => setConfirmDeleteGroupId(null)}>No</button>
                            </span>
                          ) : (
                            <span
                              title="Delete group"
                              style={{ cursor: 'pointer', opacity: 0.3, fontSize: '0.75rem', flexShrink: 0, lineHeight: 1, userSelect: 'none', padding: '0.1rem 0.15rem' }}
                              onClick={() => setConfirmDeleteGroupId(group.id)}
                            >&times;</span>
                          )}
                          {editGroupNoteId === group.id ? (
                            <input
                              autoFocus
                              type="text"
                              value={editGroupNoteText}
                              onChange={(e) => setEditGroupNoteText(e.target.value)}
                              onBlur={() => { updateBudgetGroup(group.id, { note: editGroupNoteText || undefined }); setEditGroupNoteId(null); }}
                              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') { if (e.key === 'Enter') updateBudgetGroup(group.id, { note: editGroupNoteText || undefined }); setEditGroupNoteId(null); } }}
                              onClick={(e) => e.stopPropagation()}
                              placeholder="Add note..."
                              style={{ fontSize: '0.78rem', width: 140, padding: '1px 4px' }}
                            />
                          ) : (
                            <span
                              title={group.note ? `Note: ${group.note}` : 'Add note'}
                              style={{ cursor: 'pointer', opacity: group.note ? 0.8 : 0.25, fontSize: '0.75rem' }}
                              onClick={(e) => { e.stopPropagation(); setEditGroupNoteId(group.id); setEditGroupNoteText(group.note ?? ''); }}
                            >
                              {group.note ? '📝' : '＋'}
                            </span>
                          )}
                        </span>
                      )}
                    </div>
                  </td>
                </tr>
              );

              // Data rows
              grpRows.forEach((r, rowIdx) => {
                const isDragged = dragCatId === r.categoryId;

                result.push(
                  <tr key={r.categoryId}
                    data-catid={r.categoryId}
                    data-groupid={thisGroupId ?? 'null'}
                    className={rowIdx % 2 === 0 ? 'budget-row-even' : 'budget-row-odd'}
                    style={{ opacity: isDragged ? 0 : 1 }}>
                      {/* Drag handle */}
                      <td style={{ cursor: 'grab', userSelect: 'none', WebkitUserSelect: 'none', width: 24, paddingLeft: 4, paddingRight: 4 } as React.CSSProperties}
                        onMouseDown={(e) => startRowDrag(e, r, thisGroupId)}>
                        <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor" style={{ display: 'block', opacity: 0.4, pointerEvents: 'none' }}>
                          {([2,7,12] as number[]).map(y => ([1,6] as number[]).map(x => (
                            <circle key={`${x}-${y}`} cx={x} cy={y} r={1.4} />
                          )))}
                        </svg>
                      </td>
                      {/* Category cell — name + centered spent/left + target + avg */}
                      <td style={{ overflow: 'visible', padding: 0, position: 'relative', zIndex: 3 }}>
                        <div style={{ display: 'flex', alignItems: 'center', padding: '7px 10px 2px 32px', position: 'relative', minHeight: 30 }}>
                          {/* Left: name + control icons */}
                          <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                            <span style={{ fontSize: '0.8rem' }} title={[r.note && `Always: ${r.note}`, r.budgetNote && `This month: ${r.budgetNote}`].filter(Boolean).join('\n') || undefined}>{r.categoryName}{r.budgetNote && <span style={{ marginLeft: 3, fontSize: '0.65rem', opacity: 0.6 }}>📌</span>}</span>
                            <span className={`budget-cat-icons${confirmDeleteId === r.categoryId || editNoteId === r.categoryId || editBudgetNoteId === r.categoryId ? ' budget-cat-icons-active' : ''}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                              <span title="Rename category" style={{ cursor: 'pointer', opacity: 0.3, fontSize: '0.68rem', flexShrink: 0, lineHeight: 1 }}
                                onClick={() => { setCatRenameId(r.categoryId); setCatRenameName(r.categoryName); }}>⚙</span>
                              {onNavigateToYear && (
                                <span title={`View ${r.categoryName} trend in Year view`}
                                  style={{ cursor: 'pointer', opacity: 0.35, fontSize: '0.7rem', flexShrink: 0 }}
                                  onClick={() => onNavigateToYear(r.categoryId, undefined)}>📈</span>
                              )}
                              {confirmDeleteId === r.categoryId ? (
                                <span style={{ display: 'flex', gap: 2, alignItems: 'center', flexShrink: 0 }}>
                                  <span style={{ fontSize: '0.65rem', color: 'var(--text-2)' }}>Delete?</span>
                                  <button className="btn btn-danger btn-sm" style={{ fontSize: '0.65rem', padding: '0.1rem 0.25rem' }} onClick={() => { removeBudgetItem(r.categoryId); setConfirmDeleteId(null); }}>Yes</button>
                                  <button className="btn btn-ghost btn-sm" style={{ fontSize: '0.65rem', padding: '0.1rem 0.25rem' }} onClick={() => setConfirmDeleteId(null)}>No</button>
                                </span>
                              ) : (
                                <span title="Delete" style={{ cursor: 'pointer', opacity: 0.25, fontSize: '0.75rem', flexShrink: 0, lineHeight: 1, userSelect: 'none' }}
                                  onClick={() => setConfirmDeleteId(r.categoryId)}>×</span>
                              )}
                              {editNoteId === r.categoryId ? (
                                <input autoFocus type="text" value={editNoteText}
                                  onChange={(e) => setEditNoteText(e.target.value)}
                                  onBlur={() => { updateCategoryNote(r.categoryId, editNoteText); setEditNoteId(null); }}
                                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') { if (e.key === 'Enter') updateCategoryNote(r.categoryId, editNoteText); setEditNoteId(null); } }}
                                  placeholder="Category description..." style={{ fontSize: '0.78rem', width: 140, padding: '1px 4px' }} />
                              ) : (
                                <span title={r.note ? `Description: ${r.note}` : 'Add category description'}
                                  style={{ cursor: 'pointer', opacity: r.note ? 0.8 : 0.25, fontSize: '0.75rem', flexShrink: 0 }}
                                  onClick={() => { setEditNoteId(r.categoryId); setEditNoteText(r.note ?? ''); }}>
                                  {r.note ? '🏷' : '＋'}
                                </span>
                              )}
                              {editBudgetNoteId === r.categoryId ? (
                                <input autoFocus type="text" value={editBudgetNoteText}
                                  onChange={(e) => setEditBudgetNoteText(e.target.value)}
                                  onBlur={() => { updateBudgetNote(month, r.categoryId, editBudgetNoteText); setEditBudgetNoteId(null); }}
                                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') { if (e.key === 'Enter') updateBudgetNote(month, r.categoryId, editBudgetNoteText); setEditBudgetNoteId(null); } }}
                                  placeholder="This month..." style={{ fontSize: '0.78rem', width: 140, padding: '1px 4px' }} />
                              ) : (
                                <span title={r.budgetNote ? `This month: ${r.budgetNote}` : 'Add note for this month'}
                                  style={{ cursor: 'pointer', opacity: r.budgetNote ? 0.8 : 0.2, fontSize: '0.75rem', flexShrink: 0 }}
                                  onClick={() => { setEditBudgetNoteId(r.categoryId); setEditBudgetNoteText(r.budgetNote ?? ''); }}>
                                  {r.budgetNote ? '📌' : '＋'}
                                </span>
                              )}
                            </span>
                          </div>
                          {/* Centre: spent / left — absolute, centred horizontally over bar */}
                          {(r.target > 0 || r.spent > 0) && (
                            <span
                              style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)', fontSize: '0.8rem', whiteSpace: 'nowrap', cursor: onNavigateToTransactions ? 'pointer' : 'default', userSelect: 'none' }}
                              onClick={() => onNavigateToTransactions?.(month, r.categoryId)}
                            >
                              <strong>${formatAmount(r.spent, 0)}</strong>
                              <span style={{ opacity: 0.5 }}>{r.target > 0 ? ' spent · ' : ' spent'}</span>
                              {r.target > 0 && (r.spent > r.target ? (
                                <><strong style={{ color: budgetDiffColor(r.spent - r.target, r.target, colorThresholds) }}>${formatAmount(r.spent - r.target, 0)}</strong><span style={{ opacity: 0.5 }}> over</span></>
                              ) : (
                                <><strong style={{ color: '#16a34a' }}>${formatAmount(r.target - r.spent, 0)}</strong><span style={{ opacity: 0.5 }}> left</span></>
                              ))}
                            </span>
                          )}
                        </div>
                        {/* Progress bar — in flow, directly below text */}
                        {r.target > 0 && (() => {
                          const ratio = r.spent / r.target;
                          const overAmt = r.spent - r.target;
                          const overPct = (ratio - 1) * 100;
                          const barColor = ratio > 1 && overPct > colorThresholds.redPct && overAmt > colorThresholds.redAbs
                            ? '#dc2626'
                            : ratio > 1 && overPct > colorThresholds.orangePct && overAmt > colorThresholds.orangeAbs
                              ? '#d97706'
                              : ratio === 1.0 ? '#166534' : '#16a34a';
                          const trackWidth = Math.max(100, barCapInfo.catWidth - 28);
                          const maxScale = (trackWidth + barCapInfo.overflow) / trackWidth;
                          const isCapped = ratio > 1 && ratio > maxScale;
                          // scaleX operates at compositing stage, bypassing WebKit table-cell clipping
                          const fillScale = isCapped ? maxScale : Math.max(0, ratio);
                          return (
                            <div
                              style={{ position: 'relative', marginTop: 1, marginLeft: 32, marginRight: 10, marginBottom: 12, height: 6, cursor: onNavigateToTransactions ? 'pointer' : 'default' }}
                              onClick={() => onNavigateToTransactions?.(month, r.categoryId)}
                            >
                              {/* Track */}
                              <div style={{ position: 'absolute', inset: 0, background: 'var(--bar-track)', borderRadius: 99 }} />
                              {/* Fill — always 100% wide, scaled via transform (bypasses table-cell clipping) */}
                              <div style={{
                                position: 'absolute', left: 0, top: 0, height: '100%', width: '100%',
                                background: barColor,
                                borderRadius: ratio > 1 ? '99px 0 0 99px' : 99,
                                transformOrigin: 'left center',
                                transform: `scaleX(${fillScale})`,
                              }}>
                                {isCapped && (
                                  <div style={{
                                    position: 'absolute', right: -8, top: '50%',
                                    transform: `translateY(-50%) scaleX(${1 / fillScale})`,
                                    width: 0, height: 0,
                                    borderTop: '6px solid transparent', borderBottom: '6px solid transparent',
                                    borderLeft: `8px solid ${barColor}`, opacity: 0.7,
                                  }} />
                                )}
                              </div>
                              {/* End marker — always visible; white overlay when over-budget so it shows above the fill */}
                              <div style={{ position: 'absolute', right: -1, top: '50%', transform: 'translateY(-50%)', width: 3, height: 16, background: ratio > 1 ? 'rgba(255,255,255,0.85)' : 'var(--bar-track-end)', borderRadius: 2, zIndex: 3 }} />
                            </div>
                          );
                        })()}
                      </td>
                      {/* Target column */}
                      <td className="num" style={{ fontSize: '0.8rem', width: 72, padding: '7px 6px 0', verticalAlign: 'top', position: 'relative', zIndex: 2 }}>
                        {editId === r.categoryId ? (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 3, alignItems: 'flex-end' }}>
                            <input type="number" value={editTarget} onChange={(e) => setEditTarget(e.target.value)}
                              onBlur={(e) => { if (!e.relatedTarget || !(e.relatedTarget as HTMLElement).closest('.edit-past-check')) saveEdit(r.categoryId); }}
                              onKeyDown={(e) => { if (e.key === 'Enter') saveEdit(r.categoryId); if (e.key === 'Escape') { setEditId(null); setEditPastMonths(false); } }}
                              style={{ width: 68, fontSize: '0.8rem' }} autoFocus />
                            <label className="edit-past-check" style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: '0.65rem', color: 'var(--text-2)', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                              <input type="checkbox" checked={editPastMonths} onChange={(e) => setEditPastMonths(e.target.checked)} style={{ width: 11, height: 11 }} />
                              Past months too
                            </label>
                          </div>
                        ) : (
                          <span style={{ fontWeight: 700, cursor: 'pointer' }}
                            onClick={() => { setEditId(r.categoryId); setEditTarget(String(r.target)); setEditPastMonths(false); }}>
                            ${formatAmount(r.target, 0)}
                          </span>
                        )}
                      </td>
                      {/* Avg ±/mo column */}
                      <td className="num" style={{ fontSize: '0.8rem', fontWeight: 600, width: 64, padding: '7px 14px 0 6px', verticalAlign: 'top', color: budgetDiffColor(r.ytdAvgDiff, r.relevantMonthCount > 0 ? r.ytdTarget / r.relevantMonthCount : r.target, colorThresholds) }}>
                        {formatDiff(r.ytdAvgDiff)}
                      </td>
                      {/* Period columns — dim when visible; full opacity when hidden so row stripe background is unaffected */}
                      <td className="num" style={{ opacity: ytdColumnsVisible ? 0.4 : 1, fontSize: '0.8rem', fontWeight: 400, padding: '7px 6px 0 12px', verticalAlign: 'top', width: 68, borderLeft: ytdColumnsVisible ? '2px solid var(--border)' : 'none' }}><span style={{ visibility: ytdColumnsVisible ? 'visible' : 'hidden' }}>${formatAmount(r.ytd, 0)}</span></td>
                      <td className="num" style={{ opacity: ytdColumnsVisible ? 0.4 : 1, fontSize: '0.8rem', fontWeight: 400, padding: '7px 6px 0', verticalAlign: 'top', width: 68 }}><span style={{ visibility: ytdColumnsVisible ? 'visible' : 'hidden' }}>${formatAmount(r.ytdTarget, 0)}</span></td>
                      <td className="num" style={{ opacity: ytdColumnsVisible ? 0.4 : 1, fontSize: '0.8rem', fontWeight: 400, padding: '7px 6px 0', verticalAlign: 'top', width: 68 }}><span style={{ visibility: ytdColumnsVisible ? 'visible' : 'hidden' }}>{formatDiff(r.ytdDiff)}</span></td>
                  </tr>
                );
              });

              // Empty group message (named groups only)
              if (grpRows.length === 0 && group !== null) {
                result.push(
                  <tr key={`empty-${thisGroupId}`}>
                    <td colSpan={COLS} style={{ textAlign: 'center', padding: '0.6rem', color: 'var(--text-3)', fontSize: '0.8rem' }}>
                      Drag items here or add above
                    </td>
                  </tr>
                );
              }

              return result;
            })}
          </tbody>
        </table>
      </div>

      {/* Income table */}
      {incomeRows.length > 0 && (
        <div className="card" style={{ marginBottom: '0.75rem' }}>
          <div className="section-title" style={{ marginTop: 0 }}>Income</div>
          <table className="data-table">
            <thead>
              <tr>
                <th>Category</th>
                <th className="num">Expected</th>
                <th className="num">Received</th>
              </tr>
            </thead>
            <tbody>
              {incomeRows.map((r) => (
                <tr key={r.categoryId}>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <span>{r.categoryName}</span>
                      {confirmDeleteId === r.categoryId ? (
                        <span style={{ display: 'flex', gap: 2, alignItems: 'center', flexShrink: 0 }}>
                          <span style={{ fontSize: '0.65rem', color: 'var(--text-2)' }}>Delete?</span>
                          <button className="btn btn-danger btn-sm" style={{ fontSize: '0.65rem', padding: '0.1rem 0.25rem' }} onClick={() => { removeBudgetItem(r.categoryId); setConfirmDeleteId(null); }}>Yes</button>
                          <button className="btn btn-ghost btn-sm" style={{ fontSize: '0.65rem', padding: '0.1rem 0.25rem' }} onClick={() => setConfirmDeleteId(null)}>No</button>
                        </span>
                      ) : (
                        <span
                          title="Delete"
                          style={{ cursor: 'pointer', opacity: 0.25, fontSize: '0.75rem', flexShrink: 0, lineHeight: 1, userSelect: 'none' }}
                          onClick={() => setConfirmDeleteId(r.categoryId)}
                        >×</span>
                      )}
                    </div>
                  </td>
                  <td className="num">
                    {editId === r.categoryId ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, alignItems: 'flex-end' }}>
                        <input type="number" value={editTarget} onChange={(e) => setEditTarget(e.target.value)}
                          onBlur={(e) => { if (!e.relatedTarget || !(e.relatedTarget as HTMLElement).closest('.edit-past-check')) saveEdit(r.categoryId); }}
                          onKeyDown={(e) => { if (e.key === 'Enter') saveEdit(r.categoryId); if (e.key === 'Escape') { setEditId(null); setEditPastMonths(false); } }}
                          style={{ width: 72, fontSize: '0.88rem' }} autoFocus />
                        <label className="edit-past-check" style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: '0.7rem', color: 'var(--text-2)', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                          <input type="checkbox" checked={editPastMonths} onChange={(e) => setEditPastMonths(e.target.checked)} style={{ width: 11, height: 11 }} />
                          Past months too
                        </label>
                      </div>
                    ) : (
                      <span onClick={() => { setEditId(r.categoryId); setEditTarget(String(r.target)); setEditPastMonths(false); }} style={{ cursor: 'pointer' }}>
                        ${formatAmount(r.target, 0)}
                      </span>
                    )}
                  </td>
                  <td className={`num ${r.spent > 0 && r.spent >= r.target ? 'positive' : ''}`}>${formatAmount(r.spent, 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Manage groups + add item */}
      <div className="card">
        <div className="section-title" style={{ marginTop: 0 }}>Budget groups</div>
        <div style={{ marginBottom: '1rem' }}>
          {showAddGroup ? (
            <div className="row" style={{ alignItems: 'flex-end' }}>
              <div className="field">
                <label>Group name</label>
                <input value={newGroupName} onChange={(e) => setNewGroupName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && addGroup()} placeholder="Enter name" autoFocus />
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.85rem', cursor: 'pointer', marginBottom: '0.65rem', whiteSpace: 'nowrap' }}>
                <input type="checkbox" checked={newGroupSpendFromSavings} onChange={(e) => setNewGroupSpendFromSavings(e.target.checked)} />
                Spend from Savings
              </label>
              <button className="btn btn-primary" onClick={addGroup} style={{ marginBottom: '0.65rem' }}>Create</button>
              <button className="btn btn-ghost" onClick={() => { setShowAddGroup(false); setNewGroupName(''); setNewGroupSpendFromSavings(false); }} style={{ marginBottom: '0.65rem' }}>Cancel</button>
            </div>
          ) : (
            <button className="btn btn-ghost" onClick={() => setShowAddGroup(true)}>+ Add group</button>
          )}
        </div>
        <div className="section-title">Add budget item</div>
        <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>Existing category</label>
            <SearchableSelect options={categories.map((c) => ({ value: c.id, label: c.name }))}
              value={newCatId}
              onChange={(v) => { setNewCatId(v === '' ? '' : Number(v)); if (v !== '') setNewCatName(''); }}
              placeholder="Select..." />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', padding: '0 0.25rem', opacity: 0.4, fontSize: '0.8rem', marginBottom: '0.65rem' }}>or</div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>New category name</label>
            <input
              value={newCatName}
              onChange={(e) => { setNewCatName(e.target.value); if (e.target.value) setNewCatId(''); }}
              placeholder="Type to create new…"
              onKeyDown={(e) => e.key === 'Enter' && addBudgetItem()}
            />
          </div>
          {newCatName.trim() && (
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.82rem', cursor: 'pointer', whiteSpace: 'nowrap', marginBottom: '0.65rem' }}>
              <input type="checkbox" checked={newCatIsIncome} onChange={(e) => setNewCatIsIncome(e.target.checked)} />
              Income
            </label>
          )}
          <div className="field" style={{ marginBottom: 0 }}>
            <label>Target ($)</label>
            <input type="number" value={newTarget} onChange={(e) => setNewTarget(e.target.value)} placeholder="0"
              onKeyDown={(e) => e.key === 'Enter' && addBudgetItem()} />
          </div>
          <button className="btn btn-primary" onClick={addBudgetItem}
            style={{ marginBottom: '0.65rem' }}
            disabled={!newTarget || (!newCatId && !newCatName.trim())}>
            Add
          </button>
        </div>
      </div>

      {/* Bottom copy buttons — shown when month already has budget items */}
      {expenseRows.length > 0 && (
        <div className="card" style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '0.82rem', color: 'var(--text-3)', marginBottom: '0.5rem' }}>Replace this month's budget</div>
          <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'center', flexWrap: 'wrap' }}>
            <button className="btn btn-ghost btn-sm" onClick={() => requestCopy('pickMonth')}>Copy budget from a different month</button>
            <button className="btn btn-ghost btn-sm" onClick={() => requestCopy('experimental')}>Copy from Budget Sandbox</button>
          </div>
        </div>
      )}

      {/* Off-budget spending banner */}
      {offBudgetTotal > 0 && (
        <div
          className="card"
          style={{ borderLeft: '3px solid #6366f1', padding: '0.6rem 1rem', display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap', cursor: onNavigateToTransactions ? 'pointer' : 'default' }}
          onClick={() => onNavigateToTransactions?.(month, undefined, true)}
        >
          <span style={{ fontSize: '0.85rem', opacity: 0.8 }}>Spending outside this month's budget categories:</span>
          <span style={{ fontWeight: 700, color: '#6366f1' }}>${formatAmount(offBudgetTotal, 0)}</span>
          {onNavigateToTransactions && <span style={{ fontSize: '0.8rem', opacity: 0.5, marginLeft: 'auto' }}>View in Txns →</span>}
        </div>
      )}

      {/* Month picker modal */}
      {showPickMonth && (() => {
        const availableMonths = [...new Set(getData().budgets.map((b) => b.month))]
          .filter((m) => m !== month)
          .sort((a, b) => b.localeCompare(a));
        return (
          <div className="modal-overlay">
            <div className="modal" style={{ maxWidth: 380 }}>
              <h3 style={{ marginTop: 0 }}>Copy budget from…</h3>
              {availableMonths.length === 0 ? (
                <p style={{ color: 'var(--text-3)' }}>No other months with budget data found.</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', marginBottom: '1rem', maxHeight: 320, overflowY: 'auto' }}>
                  {availableMonths.map((m) => (
                    <button key={m} className="btn btn-ghost" style={{ textAlign: 'left', justifyContent: 'flex-start' }}
                      onClick={() => {
                        setShowPickMonth(false);
                        if (expenseRows.length > 0) {
                          setConfirmOverwrite({ type: 'pickMonth', sourceMonth: m });
                        } else {
                          copyFromMonth(m);
                        }
                      }}>
                      {new Date(m + '-01').toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
                    </button>
                  ))}
                </div>
              )}
              <div className="modal-actions">
                <button className="btn btn-ghost" onClick={() => setShowPickMonth(false)}>Cancel</button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Experimental budget picker modal */}
      {showPickExperimental && (
        <div className="modal-overlay">
          <div className="modal" style={{ maxWidth: 440 }}>
            <h3 style={{ marginTop: 0 }}>Pick Budget Sandbox</h3>
            {experimentalBudgets.length === 0 ? (
              <p style={{ color: 'var(--text-3)' }}>No sandbox budgets saved yet. Go to the <strong>Budget Sandbox</strong> tab to create one.</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '1rem' }}>
                {experimentalBudgets.map((eb) => (
                  <button key={eb.id} className="btn btn-ghost" style={{ textAlign: 'left', justifyContent: 'flex-start' }}
                    onClick={() => {
                      if (expenseRows.length > 0) {
                        setConfirmOverwrite({ type: 'experimental', expId: eb.id });
                        setShowPickExperimental(false);
                      } else {
                        setShowPickExperimental(false);
                        copyFromExperimental(eb.id);
                      }
                    }}>
                    <span style={{ fontWeight: 600 }}>{eb.name}</span>
                    <span style={{ fontSize: '0.8rem', color: 'var(--text-3)', marginLeft: '0.5rem' }}>
                      {eb.items.length} items · {eb.createdAt.slice(0, 10)}
                    </span>
                  </button>
                ))}
              </div>
            )}
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => setShowPickExperimental(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Overwrite confirmation modal */}
      {confirmOverwrite && (
        <div className="modal-overlay">
          <div className="modal" style={{ maxWidth: 380 }}>
            <h3 style={{ marginTop: 0 }}>Overwrite Budget?</h3>
            <p>This will overwrite all existing budget items for <strong>{month}</strong>. Are you sure?</p>
            <div className="modal-actions">
              <button className="btn btn-primary" onClick={() => {
                if (confirmOverwrite.type === 'pickMonth' && confirmOverwrite.sourceMonth) copyFromMonth(confirmOverwrite.sourceMonth);
                else if (confirmOverwrite.expId != null) copyFromExperimental(confirmOverwrite.expId);
                else { setConfirmOverwrite(null); setShowPickExperimental(true); }
              }}>
                Yes, overwrite
              </button>
              <button className="btn btn-ghost" onClick={() => setConfirmOverwrite(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Item drag ghost — portaled to body (outside zoom), positioned via ref */}
      {ghostInfo && createPortal(
        <div ref={ghostElRef} style={{
          position: 'fixed',
          left: -9999,
          top: -9999,
          pointerEvents: 'none',
          zIndex: 9999,
          background: '#ffffff',
          border: '2px solid #1a9e8b',
          borderRadius: 8,
          padding: '0.45rem 0.85rem',
          display: 'flex',
          alignItems: 'center',
          gap: '0.75rem',
          boxShadow: '0 8px 32px rgba(0,0,0,0.18), 0 2px 8px rgba(0,0,0,0.10)',
          color: '#1a2332',
          userSelect: 'none',
          whiteSpace: 'nowrap',
        }}>
          <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor" style={{ opacity: 0.3, flexShrink: 0 }}>
            {([2,7,12] as number[]).map(cy => ([1,6] as number[]).map(cx => (
              <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={1.4} />
            )))}
          </svg>
          <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>{ghostInfo.label}</span>
          <span style={{ fontSize: '0.85rem', color: '#666' }}>
            ${formatAmount(ghostInfo.target, 0)}
          </span>
          <span style={{ fontSize: '0.82rem', color: ghostInfo.spent > ghostInfo.target ? '#dc2626' : '#16a34a' }}>
            spent ${formatAmount(ghostInfo.spent, 0)}
          </span>
        </div>,
        document.body,
      )}

      {/* Group drag ghost — portaled to body (outside zoom), positioned via ref */}
      {groupGhostLabel && createPortal(
        <div ref={groupGhostElRef} style={{
          position: 'fixed',
          left: -9999,
          top: -9999,
          pointerEvents: 'none',
          zIndex: 9999,
          background: '#ffffff',
          border: '2px solid #1a9e8b',
          borderRadius: 8,
          padding: '0.3rem 0.75rem',
          fontSize: '0.88rem',
          fontWeight: 600,
          boxShadow: '0 6px 24px rgba(0,0,0,0.22)',
          color: '#1a2332',
          whiteSpace: 'nowrap',
          transform: 'rotate(1.5deg)',
          opacity: 0.92,
          userSelect: 'none',
        }}>
          {groupGhostLabel}
        </div>,
        document.body,
      )}

      {/* Group settings modal */}
      {groupSettingsGroupId != null && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => setGroupSettingsGroupId(null)}>
          <div style={{ background: 'var(--card-bg)', borderRadius: 'var(--radius-lg)', padding: '1.5rem', width: 340, maxWidth: '90vw' }}
            onClick={(e) => e.stopPropagation()}>
            <h3 style={{ margin: '0 0 1rem' }}>Group Settings</h3>
            <div className="field" style={{ marginBottom: '0.75rem' }}>
              <label>Name</label>
              <input value={editingGroupName} onChange={(e) => setEditingGroupName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && saveGroupSettings()} autoFocus />
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', marginBottom: '1.25rem', fontSize: '0.9rem' }}>
              <input type="checkbox" checked={editingGroupSpendFromSavings} onChange={(e) => setEditingGroupSpendFromSavings(e.target.checked)} />
              Spend from Savings
              <span style={{ fontSize: '0.75rem', color: 'var(--text-3)' }}>
                (spending won't count against monthly budget)
              </span>
            </label>
            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost" onClick={() => setGroupSettingsGroupId(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={saveGroupSettings}>Save</button>
            </div>
          </div>
        </div>
      )}

      {/* Category rename modal */}
      {catRenameId != null && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => setCatRenameId(null)}>
          <div style={{ background: 'var(--card-bg)', borderRadius: 'var(--radius-lg)', padding: '1.5rem', width: 300, maxWidth: '90vw' }}
            onClick={(e) => e.stopPropagation()}>
            <h3 style={{ margin: '0 0 1rem' }}>Rename Category</h3>
            <div className="field" style={{ marginBottom: '1.25rem' }}>
              <label>Name</label>
              <input value={catRenameName} onChange={(e) => setCatRenameName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && saveCatRename()} autoFocus />
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost" onClick={() => setCatRenameId(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={saveCatRename}>Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
