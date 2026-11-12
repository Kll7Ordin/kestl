import { useState, useEffect, useRef } from 'react';
import { getData, subscribe, upsertBudget, deleteBudget, updateBudgetNote, addBudgetGroup, updateBudgetGroup, deleteBudgetGroup, reorderBudgetsInGroup, addCategory, updateCategoryNote, updateCategoryName, updateCategoryIsIncome, withUndo, getColorThresholds, copyBudgetToMonths, getDisplaySettings, updateDisplaySettings, setMonthIncomplete, type Category, type BudgetGroup, type ExperimentalBudget } from '../db';
import { ImportBudgetCard } from './ImportBudgetCard';
import { SearchableSelect } from './SearchableSelect';
import { monthLabel } from '../logic/dateUtils';
import { formatAmount } from '../utils/format';
import { buildRows, type BudgetRow, type TargetMode } from '../logic/budgetRows';
import { applySandboxToMonth } from '../logic/sandbox';
import { BudgetTable } from './BudgetTable';
import { budgetDiffColor } from '../utils/budgetFormat';
import { MonthSideArrows } from './MonthSideNav';
import { useMonthStepper } from './useMonthStepper';
import { projectCurrentMonth, type MonthProjection } from '../logic/forecast';

function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
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
  const [allIncomeReceived, setAllIncomeReceived] = useState(0);
  const [uncatTotal, setUncatTotal] = useState(0);
  const [offBudgetTotal, setOffBudgetTotal] = useState(0);
  const [projection, setProjection] = useState<MonthProjection | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [colorThresholds, setColorThresholdsState] = useState(() => getColorThresholds());
  const [ytdColumnsVisible, setYtdColumnsVisible] = useState(() => getDisplaySettings().ytdColumnsVisible);
  const [ytdMode, setYtdMode] = useState<'ytd' | 'rolling12'>(() => getDisplaySettings().ytdMode);
  const [targetMode, setTargetMode] = useState<TargetMode>(() => getDisplaySettings().targetMode ?? 'atTime');
  const containerRef = useRef<HTMLDivElement>(null);
  const stepMonth = useMonthStepper(month, setMonth, containerRef, rows);
  const [showPickExperimental, setShowPickExperimental] = useState(false);
  const [showPickMonth, setShowPickMonth] = useState(false);
  const [confirmOverwrite, setConfirmOverwrite] = useState<{ type: 'pickMonth' | 'experimental'; sourceMonth?: string; expId?: number } | null>(null);
  const [experimentalBudgets, setExperimentalBudgets] = useState<ExperimentalBudget[]>([]);
  const [totalBudgetRows, setTotalBudgetRows] = useState(0);

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
      setTargetMode(ds.targetMode ?? 'atTime');
      const result = buildRows(month, d.categories, d.budgetGroups ?? [], ds.ytdMode, ds.targetMode ?? 'atTime');
      setRows(result.rows);
      setAllIncomeReceived(result.allIncomeReceived);
      setUncatTotal(result.uncatTotal);
      setOffBudgetTotal(result.offBudgetTotal);
      setProjection(month === currentMonth() ? projectCurrentMonth(d, month) : null);
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


  async function removeBudgetItem(categoryId: number) { await deleteBudget(month, categoryId); }

  async function saveTarget(categoryId: number, newTarget: number, pastMonthsToo: boolean) {
    const row = rows.find((r) => r.categoryId === categoryId);
    await withUndo('Edit budget target', async () => {
      await upsertBudget(month, categoryId, newTarget, row?.groupId);
      if (pastMonthsToo) {
        const d = getData();
        const pastBudgets = d.budgets.filter((b) => b.month < month && b.categoryId === categoryId);
        for (const b of pastBudgets) {
          await upsertBudget(b.month, categoryId, newTarget, b.groupId);
        }
      }
    });
  }

  // Income table's inline target edit
  async function saveEdit(categoryId: number) {
    const newTarget = parseFloat(editTarget);
    if (!isNaN(newTarget)) await saveTarget(categoryId, newTarget, editPastMonths);
    setEditId(null);
    setEditPastMonths(false);
  }

  async function reorderGroups(groupIdsInOrder: number[]) {
    await withUndo('Reorder budget groups', async () => {
      for (let i = 0; i < groupIdsInOrder.length; i++) {
        const g = budgetGroups.find((x) => x.id === groupIdsInOrder[i]);
        if (g && g.sortOrder !== i) await updateBudgetGroup(g.id, { sortOrder: i });
      }
    });
  }

  async function copyFromMonth(sourceMonth: string) {
    await copyBudgetToMonths(sourceMonth, [month]);
    const sourceCount = getData().budgets.filter((b) => b.month === month).length;
    alert(`Copied ${sourceCount} budget items from ${monthLabel(sourceMonth)}.`);
    setConfirmOverwrite(null);
    setShowPickMonth(false);
  }

  async function copyFromExperimental(expId: number) {
    const exp = (getData().experimentalBudgets ?? []).find((b: ExperimentalBudget) => b.id === expId);
    if (!exp) return;
    await applySandboxToMonth(exp, month);
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
  const totalRemaining = regularRows.reduce((s, r) => s + Math.max(0, r.target + r.carry - r.spent), 0);
  const spentFromSavings = savingsRows.reduce((s, r) => s + r.spent, 0);
  const totalIncome = incomeRows.reduce((s, r) => s + r.target, 0);
  const totalReceived = allIncomeReceived;
  const yetToReceive = totalIncome > 0 ? totalIncome - totalReceived : 0;
  const net = totalIncome - totalTarget;
  const budgetedCatIds = new Set(rows.map((r) => r.categoryId));

  const [y, mon] = month.split('-').map(Number);
  const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const curYear = new Date().getFullYear();

  return (
    <div ref={containerRef} style={{ maxWidth: 1400, margin: '0 auto', position: 'relative' }}>
      <MonthSideArrows month={month} onStep={stepMonth} />
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
        <label
          style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.8rem', cursor: 'pointer' }}
          title="Leave this month out of YTD, 12M and Year View totals"
        >
          <input
            type="checkbox"
            checked={(getData().incompleteMonths ?? []).includes(month)}
            onChange={(e) => { void setMonthIncomplete(month, e.target.checked); }}
          />
          Incomplete month
        </label>
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
        const netMtd = totalReceived - totalSpent;
        const mtdCardCount = 2 + (incomeRows.length > 0 ? 3 : 0);

        // Pro-rate the monthly target by how far through the month we are.
        // Past months: fraction = 1. Future months: fraction = 0 (no color).
        const today = new Date();
        const todayMonth = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
        const monthFraction = month < todayMonth ? 1
          : month > todayMonth ? 0
          : today.getDate() / new Date(y, mon, 0).getDate();
        const proratedTarget = totalTarget * monthFraction;
        const spentDiff = totalSpent - proratedTarget;
        const spentColor = monthFraction === 0 ? 'inherit' : budgetDiffColor(spentDiff, proratedTarget, colorThresholds);
        return (
        <div style={{ display: 'grid', gridTemplateColumns: `${budgetCardCount}fr ${mtdCardCount}fr`, gap: '1rem', marginBottom: '1rem' }}>
          {/* Budget */}
          <div style={{ background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: '0.875rem 0 0.875rem 0', overflow: 'hidden' }}>
            <div style={{ fontSize: '0.68rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-3)', marginBottom: '0.6rem', paddingLeft: '0.875rem' }}>Budget</div>
            <div style={{ display: 'grid', gridTemplateColumns: `repeat(${budgetCardCount}, 1fr)`, gap: 0 }}>
              {totalIncome > 0 && (
                <div className="summary-card" style={{ borderRadius: 0, border: 'none', borderRight: '1px solid var(--border)' }}>
                  <span className="summary-label">Income</span>
                  <span className="summary-value" style={{ color: '#16a34a' }}>${formatAmount(totalIncome, 0)}</span>
                </div>
              )}
              <div className="summary-card" style={{ borderRadius: 0, border: 'none', borderRight: '1px solid var(--border)' }}>
                <span className="summary-label">Expenses</span>
                <span className="summary-value negative">${formatAmount(totalTarget, 0)}</span>
              </div>
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
                <span className="summary-value" style={{ color: spentColor }}>${formatAmount(totalSpent, 0)}</span>
                {spendFromSavingsGroupIds.size > 0 && spentFromSavings > 0 && (
                  <span style={{ fontSize: '0.65rem', color: 'var(--text-3)', marginTop: '0.1rem' }}>+${formatAmount(spentFromSavings, 0)} from savings</span>
                )}
              </div>
              <div className="summary-card" style={{ borderRadius: 0, border: 'none', borderRight: incomeRows.length > 0 ? '1px solid var(--border)' : 'none' }}>
                <span className="summary-label">Remaining</span>
                <span className="summary-value">${formatAmount(totalRemaining, 0)}</span>
              </div>
              {incomeRows.length > 0 && (
                <div className="summary-card" style={{ borderRadius: 0, border: 'none', borderRight: '1px solid var(--border)' }}>
                  <span className="summary-label">Received</span>
                  <span className="summary-value">${formatAmount(totalReceived, 0)}</span>
                </div>
              )}
              {incomeRows.length > 0 && (
                <div className="summary-card" style={{ borderRadius: 0, border: 'none', borderRight: '1px solid var(--border)' }}>
                  <span className="summary-label">Yet to Receive</span>
                  <span className="summary-value">${formatAmount(yetToReceive, 0)}</span>
                </div>
              )}
              {incomeRows.length > 0 && (
                <div className="summary-card" style={{ borderRadius: 0, border: 'none' }}>
                  <span className="summary-label">Net</span>
                  <span className="summary-value" style={{ color: netMtd >= 0 ? '#16a34a' : '#dc2626' }}>
                    {netMtd >= 0 ? '+' : '-'}${formatAmount(Math.abs(netMtd), 0)}
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>
        );
      })()}

      {projection && (
        <div style={{ fontSize: '0.8rem', marginBottom: '0.75rem', color: 'var(--text-2)' }}>
          Projected month-end:{' '}
          <strong style={{ color: projection.projectedNet >= 0 ? '#16a34a' : '#dc2626' }}>
            {projection.projectedNet >= 0 ? '+' : '−'}${formatAmount(Math.abs(projection.projectedNet), 0)}
          </strong>
        </div>
      )}

      <BudgetTable
        rows={expenseRows}
        groups={budgetGroups}
        colorThresholds={colorThresholds}
        ytdMode={ytdMode}
        onYtdModeChange={(m) => { setYtdMode(m); updateDisplaySettings({ ytdMode: m }); }}
        ytdColumnsVisible={ytdColumnsVisible}
        onYtdColumnsVisibleChange={(v) => { setYtdColumnsVisible(v); updateDisplaySettings({ ytdColumnsVisible: v }); }}
        targetMode={targetMode}
        onTargetModeChange={(m) => { setTargetMode(m); updateDisplaySettings({ targetMode: m }); }}
        betweenTotalAndTable={uncatTotal > 0 && (
          // Uncategorized sum banner — below summary, above budget rows
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
        aboveTable={expenseRows.length === 0 && (
          <div style={{ marginBottom: '1rem', display: 'flex', gap: '0.5rem', justifyContent: 'center', flexWrap: 'wrap' }}>
            <button className="btn btn-primary" onClick={() => requestCopy('pickMonth')}>Copy budget from a different month</button>
            <button className="btn btn-ghost" onClick={() => requestCopy('experimental')}>Copy from Budget Sandbox</button>
          </div>
        )}
        onReorder={(changes) => {
          void withUndo('Move budget item', async () => {
            for (const c of changes) await reorderBudgetsInGroup(month, c.groupId, c.categoryIds);
          });
        }}
        onReorderGroups={(ids) => { void reorderGroups(ids); }}
        onSaveTarget={(catId, amount, pastToo) => { void saveTarget(catId, amount, pastToo); }}
        allowPastMonths
        onDeleteRow={(catId) => { void removeBudgetItem(catId); }}
        onRenameRow={(catId, name) => { void updateCategoryName(catId, name); }}
        onSaveGroup={(id, patch) => { void updateBudgetGroup(id, patch); }}
        onDeleteGroup={(id) => { void deleteBudgetGroup(id); }}
        onGroupNote={(id, note) => { void updateBudgetGroup(id, { note }); }}
        onCategoryNote={(catId, note) => { void updateCategoryNote(catId, note); }}
        onLineNote={(catId, note) => { void updateBudgetNote(month, catId, note); }}
        lineNoteLabel="This month"
        onOpenRow={onNavigateToTransactions ? (catId) => onNavigateToTransactions(month, catId) : undefined}
        onOpenAll={onNavigateToTransactions ? () => onNavigateToTransactions(month) : undefined}
        onRowTrend={onNavigateToYear ? (catId) => onNavigateToYear(catId, undefined) : undefined}
        onGroupTrend={onNavigateToYear ? (gid) => onNavigateToYear(undefined, gid) : undefined}
      />


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
            <SearchableSelect options={categories.filter((c) => !c.archived && !budgetedCatIds.has(c.id)).map((c) => ({ value: c.id, label: c.name }))}
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
                      {monthLabel(m)}
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

    </div>
  );
}