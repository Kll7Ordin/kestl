import { useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  getData, subscribe,
  saveExperimentalBudget, deleteExperimentalBudget,
  addCategory, updateCategoryIsIncome, withUndo, getColorThresholds, getDisplaySettings, updateDisplaySettings,
  type ExperimentalBudget, type ExperimentalBudgetItem, type SandboxGroup,
} from '../db';
import { SearchableSelect } from './SearchableSelect';
import { formatAmount } from '../utils/format';
import { INCOME_CATEGORY_NAMES } from '../seed';
import { ImportBudgetCard } from './ImportBudgetCard';
import { BudgetTable } from './BudgetTable';
import { MonthSideArrows } from './MonthSideNav';
import { useMonthStepper } from './useMonthStepper';
import { buildSandboxRows } from '../logic/budgetRows';
import { normalizeSandbox, sandboxGroupsFromLive, nextSandboxGroupId } from '../logic/sandbox';
import { monthLabel } from '../logic/dateUtils';

function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function isCatIncome(catId: number, categories: ReturnType<typeof getData>['categories']): boolean {
  const cat = categories.find((c) => c.id === catId);
  return cat?.isIncome === true || (cat != null && INCOME_CATEGORY_NAMES.has(cat.name));
}

const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

const bubbleStyle = { background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: '0.875rem 0', overflow: 'hidden' } as const;
const bubbleTitleStyle = { fontSize: '0.68rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-3)', marginBottom: '0.6rem', paddingLeft: '0.875rem' } as const;
const cellDivider = { borderRadius: 0, border: 'none', borderRight: '1px solid var(--border)' } as const;
const cellLast = { borderRadius: 0, border: 'none' } as const;

export function ExperimentalBudgetsView() {
  const appData = useSyncExternalStore(subscribe, getData);
  const { categories, budgets, budgetGroups = [], experimentalBudgets = [] } = appData;
  const catMap = new Map(categories.map((c) => [c.id, c.name]));

  // Months that have budget data
  const budgetMonths = [...new Set(budgets.map((b) => b.month))].sort().reverse();

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [month, setMonth] = useState(currentMonth());
  const [ytdMode, setYtdMode] = useState(() => getDisplaySettings().ytdMode);
  const [ytdColumnsVisible, setYtdColumnsVisible] = useState(() => getDisplaySettings().ytdColumnsVisible);

  // Create form
  const [showCreate, setShowCreate] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createFromMonth, setCreateFromMonth] = useState(currentMonth());

  // Rename sandbox
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState('');

  // Income inline edit
  const [editIncomeId, setEditIncomeId] = useState<number | null>(null);
  const [editIncomeTarget, setEditIncomeTarget] = useState('');

  // Add item / group
  const [addCatId, setAddCatId] = useState<number | ''>('');
  const [addNewCatName, setAddNewCatName] = useState('');
  const [addIsIncome, setAddIsIncome] = useState(false);
  const [addTarget, setAddTarget] = useState('');
  const [showAddGroup, setShowAddGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupSavings, setNewGroupSavings] = useState(false);

  // Tagging historical categories onto a line
  const [tagItemId, setTagItemId] = useState<number | null>(null);

  const rawSelected = experimentalBudgets.find((b) => b.id === selectedId) ?? null;
  const sandbox = rawSelected ? normalizeSandbox(rawSelected, budgetGroups) : null;

  const containerRef = useRef<HTMLDivElement>(null);
  const result = useMemo(
    () => (sandbox ? buildSandboxRows(sandbox, month, categories, ytdMode) : null),
    // appData changes identity on every save, which covers the sandbox and the transactions
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [appData, selectedId, month, ytdMode],
  );
  const rows = result?.rows ?? null;
  const stepMonth = useMonthStepper(month, setMonth, containerRef, rows);

  /** Applies `fn` to the latest copy of the selected sandbox and saves it (one undo step). */
  async function update(fn: (eb: ExperimentalBudget & { groups: SandboxGroup[] }) => ExperimentalBudget) {
    const latest = (getData().experimentalBudgets ?? []).find((b) => b.id === selectedId);
    if (!latest) return;
    await saveExperimentalBudget(fn(normalizeSandbox(latest, getData().budgetGroups ?? [])));
  }
  const mapItems = (eb: ExperimentalBudget, fn: (i: ExperimentalBudgetItem) => ExperimentalBudgetItem) => ({ ...eb, items: eb.items.map(fn) });

  async function handleCreate() {
    const name = createName.trim();
    if (!name) return;
    const items: ExperimentalBudgetItem[] = budgets.filter((b) => b.month === createFromMonth).map((b) => {
      const income = isCatIncome(b.categoryId, categories);
      const grp = budgetGroups.find((g) => g.id === b.groupId);
      return {
        categoryId: b.categoryId,
        categoryName: catMap.get(b.categoryId) ?? '?',
        groupId: income ? null : (b.groupId ?? null),
        groupName: income ? null : (grp?.name ?? null),
        targetAmount: b.targetAmount,
        sortOrder: b.sortOrder,
        isIncome: income,
      };
    });
    const saved = await saveExperimentalBudget({
      name, createdAt: new Date().toISOString(), items, groups: sandboxGroupsFromLive(budgetGroups, items),
    });
    setSelectedId(saved.id);
    setShowCreate(false);
    setCreateName('');
  }

  async function handleDelete(id: number) {
    await deleteExperimentalBudget(id);
    if (selectedId === id) setSelectedId(null);
    setConfirmDeleteId(null);
  }

  async function handleRename(budget: ExperimentalBudget) {
    const name = renameValue.trim();
    if (name) await saveExperimentalBudget({ ...budget, name });
    setRenamingId(null);
  }

  async function addGroup() {
    const name = newGroupName.trim();
    if (!name) return;
    await update((eb) => ({
      ...eb,
      groups: [...eb.groups, {
        id: nextSandboxGroupId(eb.groups), name,
        sortOrder: eb.groups.reduce((m, g) => Math.max(m, g.sortOrder), -1) + 1,
        spendFromSavings: newGroupSavings || undefined,
      }],
    }));
    setNewGroupName(''); setNewGroupSavings(false); setShowAddGroup(false);
  }

  async function addItem() {
    if (!sandbox) return;
    const newName = addNewCatName.trim();
    const amount = parseFloat(addTarget);
    if ((addCatId === '' && !newName) || isNaN(amount)) return;
    // Typing the name of a category that already exists reuses it instead of making a duplicate.
    const existing = addCatId === '' ? categories.find((c) => norm(c.name) === norm(newName)) : undefined;
    if (existing && sandbox.items.some((i) => i.categoryId === existing.id)) {
      alert(`“${existing.name}” is already in this sandbox.`);
      return;
    }
    await withUndo('Add sandbox item', async () => {
      let catId: number;
      let catName: string;
      if (addCatId !== '') {
        catId = addCatId;
        catName = catMap.get(catId) ?? '?';
      } else if (existing) {
        catId = existing.id;
        catName = existing.name;
      } else {
        catId = await addCategory(newName);
        if (addIsIncome) await updateCategoryIsIncome(catId, true);
        catName = newName;
      }
      const income = addIsIncome || isCatIncome(catId, getData().categories);
      await update((eb) => {
        if (eb.items.some((i) => i.categoryId === catId)) return eb;
        const lastOrder = eb.items.filter((i) => !i.isIncome && i.groupId == null).reduce((m, i) => Math.max(m, i.sortOrder ?? 0), -1);
        return {
          ...eb,
          items: [...eb.items, {
            categoryId: catId, categoryName: catName, groupId: null, groupName: null,
            targetAmount: amount, sortOrder: lastOrder + 1, isIncome: income || undefined,
          }],
        };
      });
    });
    setAddCatId(''); setAddNewCatName(''); setAddTarget(''); setAddIsIncome(false);
  }

  async function saveIncomeEdit(catId: number) {
    const amount = parseFloat(editIncomeTarget);
    if (!isNaN(amount)) await update((eb) => mapItems(eb, (i) => (i.categoryId === catId ? { ...i, targetAmount: amount } : i)));
    setEditIncomeId(null);
  }

  // ── Derived for the selected sandbox ──
  const expenseRows = rows?.filter((r) => !r.isIncome) ?? [];
  const incomeRows = rows?.filter((r) => r.isIncome) ?? [];
  const savingsGroupIds = new Set(sandbox?.groups.filter((g) => g.spendFromSavings).map((g) => g.id) ?? []);
  const regularRows = expenseRows.filter((r) => r.groupId == null || !savingsGroupIds.has(r.groupId));
  const totalIncome = incomeRows.reduce((s, r) => s + r.target, 0);
  const totalExpenses = regularRows.reduce((s, r) => s + r.target, 0);
  const totalSpent = regularRows.reduce((s, r) => s + r.spent, 0);
  const totalRemaining = regularRows.reduce((s, r) => s + Math.max(0, r.target - r.spent), 0);
  const net = totalIncome - totalExpenses;

  // Every category this sandbox already counts (own or tagged) — a category may only feed one line
  const coveredCatIds = new Set(sandbox?.items.flatMap((i) => [i.categoryId, ...(i.sourceCategoryIds ?? [])]) ?? []);
  const availableCats = categories.filter((c) => !coveredCatIds.has(c.id) && !c.archived);
  const tagItem = sandbox?.items.find((i) => i.categoryId === tagItemId) ?? null;

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      {sandbox && <MonthSideArrows month={month} onStep={stepMonth} />}
      <h1 className="view-title">Budget Sandbox</h1>
      <p style={{ fontSize: '0.85rem', opacity: 0.7, marginBottom: '1rem' }}>
        Try out different plans without affecting your real budget. Changes here (names, groups, order) stay in the
        sandbox until you apply it to a month from the Budget tab.
      </p>

      {/* Import Budget from XLSX */}
      <div className="card" style={{ marginBottom: '1rem' }}>
        <div className="section-title" style={{ marginTop: 0 }}>Import Budget from XLSX</div>
        <ImportBudgetCard />
      </div>

      {/* Create form */}
      <div className="card" style={{ marginBottom: '1rem' }}>
        {!showCreate ? (
          <button className="btn btn-primary" onClick={() => { setShowCreate(true); setCreateName(''); setCreateFromMonth(budgetMonths[0] ?? currentMonth()); }}>
            + Create New Budget Sandbox
          </button>
        ) : (
          <div>
            <div className="section-title" style={{ marginTop: 0 }}>New Budget Sandbox</div>
            <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-end', gap: '0.75rem', marginBottom: '0.75rem' }}>
              <div className="field">
                <label>Name</label>
                <input value={createName} onChange={(e) => setCreateName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
                  placeholder="e.g. Tight Budget, Vacation Month" autoFocus />
              </div>
              <div className="field">
                <label>Copy from month</label>
                <select value={createFromMonth} onChange={(e) => setCreateFromMonth(e.target.value)}
                  style={{ padding: '0.35rem 0.5rem', fontSize: '0.9rem' }}>
                  {budgetMonths.map((m) => <option key={m} value={m}>{m}</option>)}
                  {budgetMonths.length === 0 && <option value={currentMonth()}>{currentMonth()} (empty)</option>}
                </select>
              </div>
              <button className="btn btn-primary" style={{ flex: '0 0 auto' }} onClick={handleCreate} disabled={!createName.trim()}>Create</button>
              <button className="btn btn-ghost" style={{ flex: '0 0 auto' }} onClick={() => setShowCreate(false)}>Cancel</button>
            </div>
            <p style={{ fontSize: '0.82rem', opacity: 0.65 }}>
              Copies that month's items and your budget groups into the sandbox.
            </p>
          </div>
        )}
      </div>

      {/* Budget list */}
      {experimentalBudgets.length === 0 && !showCreate && (
        <div className="card" style={{ textAlign: 'center', color: 'var(--text-3)', padding: '2rem' }}>
          No budget sandboxes yet. Create one above to get started.
        </div>
      )}

      {experimentalBudgets.length > 0 && (
        <div className="card" style={{ marginBottom: '1rem' }}>
          <div className="section-title" style={{ marginTop: 0 }}>Saved Budgets</div>
          <table className="data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th className="num">Income</th>
                <th className="num">Expenses</th>
                <th>Created</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {[...experimentalBudgets].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((eb, i) => {
                const ebIncome = eb.items.filter((it) => it.isIncome).reduce((s, it) => s + it.targetAmount, 0);
                const ebExpenses = eb.items.filter((it) => !it.isIncome).reduce((s, it) => s + it.targetAmount, 0);
                return (
                  <tr key={eb.id} className={i % 2 === 0 ? 'budget-row-even' : 'budget-row-odd'}
                    style={selectedId === eb.id ? { outline: '2px solid var(--accent)', outlineOffset: -2 } : undefined}>
                    <td>
                      {renamingId === eb.id ? (
                        <input value={renameValue} onChange={(e) => setRenameValue(e.target.value)}
                          onBlur={() => handleRename(eb)}
                          onKeyDown={(e) => { if (e.key === 'Enter') handleRename(eb); if (e.key === 'Escape') setRenamingId(null); }}
                          autoFocus style={{ fontSize: '0.9rem', padding: '0.2rem 0.4rem' }} />
                      ) : (
                        <button className="btn btn-ghost btn-sm" style={{ fontWeight: 600, textAlign: 'left' }}
                          onClick={() => setSelectedId(selectedId === eb.id ? null : eb.id)}>
                          {eb.name}
                        </button>
                      )}
                    </td>
                    <td className="num positive">{ebIncome > 0 ? `$${formatAmount(ebIncome, 0)}` : '—'}</td>
                    <td className="num">{ebExpenses > 0 ? `$${formatAmount(ebExpenses, 0)}` : '—'}</td>
                    <td style={{ fontSize: '0.82rem', color: 'var(--text-3)' }}>{eb.createdAt.slice(0, 10)}</td>
                    <td>
                      <div style={{ display: 'flex', gap: '0.25rem', justifyContent: 'flex-end' }}>
                        <button className="btn btn-ghost btn-sm" title="Rename"
                          onClick={() => { setRenamingId(eb.id); setRenameValue(eb.name); }}>✎</button>
                        {confirmDeleteId === eb.id ? (
                          <>
                            <button className="btn btn-danger btn-sm" onClick={() => handleDelete(eb.id)}>Delete</button>
                            <button className="btn btn-ghost btn-sm" onClick={() => setConfirmDeleteId(null)}>Cancel</button>
                          </>
                        ) : (
                          <button className="btn btn-danger btn-sm" onClick={() => setConfirmDeleteId(eb.id)}>&times;</button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Selected sandbox — laid out like the live budget */}
      {sandbox && result && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
            <h2 style={{ margin: 0, fontSize: '1.2rem' }}>{sandbox.name}</h2>
            <div className="month-nav" style={{ margin: 0 }}>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => stepMonth(-1)}>‹</button>
              <span style={{ fontWeight: 600, fontSize: '0.95rem', minWidth: 120, textAlign: 'center' }}>{monthLabel(month)}</span>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => stepMonth(1)}>›</button>
            </div>
            <span style={{ fontSize: '0.78rem', color: 'var(--text-3)' }}>
              Spending, 12M/3M and {ytdMode === 'rolling12' ? '12M' : 'YTD'} figures are measured from this month, against the sandbox targets.
            </span>
          </div>

          {/* Summary bubbles */}
          <div style={{ display: 'grid', gridTemplateColumns: `${totalIncome > 0 ? 3 : 2}fr ${incomeRows.length > 0 ? 3 : 2}fr`, gap: '1rem', marginBottom: '1rem' }}>
            <div style={bubbleStyle}>
              <div style={bubbleTitleStyle}>Budget</div>
              <div style={{ display: 'grid', gridTemplateColumns: `repeat(${totalIncome > 0 ? 3 : 2}, 1fr)` }}>
                {totalIncome > 0 && (
                  <div className="summary-card" style={cellDivider}>
                    <span className="summary-label">Income</span>
                    <span className="summary-value" style={{ color: '#16a34a' }}>${formatAmount(totalIncome, 0)}</span>
                  </div>
                )}
                <div className="summary-card" style={cellDivider}>
                  <span className="summary-label">Expenses</span>
                  <span className="summary-value negative">${formatAmount(totalExpenses, 0)}</span>
                </div>
                <div className="summary-card" style={cellLast}>
                  <span className="summary-label">Net</span>
                  <span className="summary-value" style={{ color: net >= 0 ? '#16a34a' : '#dc2626' }}>${formatAmount(net, 0)}</span>
                </div>
              </div>
            </div>
            <div style={bubbleStyle}>
              <div style={bubbleTitleStyle}>{monthLabel(month)} under this plan</div>
              <div style={{ display: 'grid', gridTemplateColumns: `repeat(${incomeRows.length > 0 ? 3 : 2}, 1fr)` }}>
                <div className="summary-card" style={cellDivider}>
                  <span className="summary-label">Spent</span>
                  <span className="summary-value">${formatAmount(totalSpent, 0)}</span>
                </div>
                <div className="summary-card" style={incomeRows.length > 0 ? cellDivider : cellLast}>
                  <span className="summary-label">Remaining</span>
                  <span className="summary-value">${formatAmount(totalRemaining, 0)}</span>
                </div>
                {incomeRows.length > 0 && (
                  <div className="summary-card" style={cellLast}>
                    <span className="summary-label">Received</span>
                    <span className="summary-value">${formatAmount(result.allIncomeReceived, 0)}</span>
                  </div>
                )}
              </div>
            </div>
          </div>

          <BudgetTable
            rows={expenseRows}
            groups={sandbox.groups}
            colorThresholds={getColorThresholds()}
            ytdMode={ytdMode}
            onYtdModeChange={(m) => { setYtdMode(m); updateDisplaySettings({ ytdMode: m }); }}
            ytdColumnsVisible={ytdColumnsVisible}
            onYtdColumnsVisibleChange={(v) => { setYtdColumnsVisible(v); updateDisplaySettings({ ytdColumnsVisible: v }); }}
            betweenTotalAndTable={(result.offBudgetTotal > 0 || result.offBudgetAvg12 > 0 || result.uncatTotal > 0) && (
              <div className="card" style={{ borderLeft: '3px solid #6366f1', marginBottom: '0.75rem', padding: '0.6rem 1rem', display: 'flex', alignItems: 'center', gap: '1.25rem', flexWrap: 'wrap', fontSize: '0.8rem' }}>
                <span title="Spending in categories this sandbox doesn't include or tag">
                  <span style={{ opacity: 0.8 }}>Outside this sandbox's categories: </span>
                  <strong style={{ color: '#6366f1' }}>${formatAmount(result.offBudgetTotal, 0)}</strong>
                  <span style={{ opacity: 0.6 }}> this month · </span>
                  <strong style={{ color: '#6366f1' }}>${formatAmount(result.offBudgetAvg12, 0)}</strong>
                  <span style={{ opacity: 0.6 }}>/mo avg (12M)</span>
                </span>
                {result.uncatTotal > 0 && (
                  <span>
                    <span style={{ opacity: 0.8 }}>Uncategorized this month: </span>
                    <strong style={{ color: '#d97706' }}>${formatAmount(result.uncatTotal, 0)}</strong>
                  </span>
                )}
              </div>
            )}
            onReorder={(changes) => {
              void update((eb) => {
                const placed = new Map<number, { groupId: number | null; sortOrder: number }>();
                for (const c of changes) c.categoryIds.forEach((id, i) => placed.set(id, { groupId: c.groupId, sortOrder: i }));
                return mapItems(eb, (item) => {
                  const p = placed.get(item.categoryId);
                  if (!p) return item;
                  const groupName = eb.groups.find((g) => g.id === p.groupId)?.name ?? null;
                  return { ...item, groupId: p.groupId, groupName, sortOrder: p.sortOrder };
                });
              });
            }}
            onReorderGroups={(ids) => {
              void update((eb) => ({ ...eb, groups: eb.groups.map((g) => ({ ...g, sortOrder: ids.indexOf(g.id) < 0 ? g.sortOrder : ids.indexOf(g.id) })) }));
            }}
            onSaveTarget={(catId, amount) => { void update((eb) => mapItems(eb, (i) => (i.categoryId === catId ? { ...i, targetAmount: amount } : i))); }}
            onDeleteRow={(catId) => { void update((eb) => ({ ...eb, items: eb.items.filter((i) => i.categoryId !== catId) })); }}
            onRenameRow={(catId, name) => { void update((eb) => mapItems(eb, (i) => (i.categoryId === catId ? { ...i, categoryName: name } : i))); }}
            onSaveGroup={(id, patch) => {
              void update((eb) => ({
                ...mapItems(eb, (i) => (i.groupId === id ? { ...i, groupName: patch.name } : i)),
                groups: eb.groups.map((g) => (g.id === id ? { ...g, name: patch.name, spendFromSavings: patch.spendFromSavings || undefined } : g)),
              }));
            }}
            onDeleteGroup={(id) => {
              void update((eb) => ({
                ...mapItems(eb, (i) => (i.groupId === id ? { ...i, groupId: null, groupName: null } : i)),
                groups: eb.groups.filter((g) => g.id !== id),
              }));
            }}
            onGroupNote={(id, note) => { void update((eb) => ({ ...eb, groups: eb.groups.map((g) => (g.id === id ? { ...g, note } : g)) })); }}
            onLineNote={(catId, note) => { void update((eb) => mapItems(eb, (i) => (i.categoryId === catId ? { ...i, note: note || undefined } : i))); }}
            lineNoteLabel="Note"
            renderRowExtras={(r) => {
              const tags = (r.sourceCategoryIds ?? []).map((id) => catMap.get(id) ?? '?');
              // Untagged: hidden until the row is hovered, like the other row icons
              return (
                <span className={tags.length > 0 ? undefined : 'budget-cat-icons'}>
                  <span
                    title={tags.length > 0 ? `Also counts spending from: ${tags.join(', ')}` : 'Count spending from other (e.g. old) categories in this line'}
                    style={{ cursor: 'pointer', fontSize: '0.7rem', opacity: tags.length > 0 ? 0.75 : 0.3, marginLeft: 2, whiteSpace: 'nowrap' }}
                    onClick={() => setTagItemId(r.categoryId)}
                  >
                    🔗{tags.length > 0 && <span style={{ marginLeft: 2 }}>{tags.length}</span>}
                  </span>
                </span>
              );
            }}
          />

          {/* Income */}
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
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span>{r.categoryName}</span>
                          <span title="Remove" style={{ cursor: 'pointer', opacity: 0.25, fontSize: '0.75rem', userSelect: 'none' }}
                            onClick={() => { void update((eb) => ({ ...eb, items: eb.items.filter((i) => i.categoryId !== r.categoryId) })); }}>×</span>
                        </div>
                      </td>
                      <td className="num">
                        {editIncomeId === r.categoryId ? (
                          <input type="number" value={editIncomeTarget} onChange={(e) => setEditIncomeTarget(e.target.value)}
                            onBlur={() => saveIncomeEdit(r.categoryId)}
                            onKeyDown={(e) => { if (e.key === 'Enter') saveIncomeEdit(r.categoryId); if (e.key === 'Escape') setEditIncomeId(null); }}
                            style={{ width: 72, fontSize: '0.88rem' }} autoFocus />
                        ) : (
                          <span style={{ cursor: 'pointer' }} onClick={() => { setEditIncomeId(r.categoryId); setEditIncomeTarget(String(r.target)); }}>
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

          {/* Groups + add item */}
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
                    <input type="checkbox" checked={newGroupSavings} onChange={(e) => setNewGroupSavings(e.target.checked)} />
                    Spend from Savings
                  </label>
                  <button className="btn btn-primary" onClick={addGroup} style={{ marginBottom: '0.65rem' }}>Create</button>
                  <button className="btn btn-ghost" onClick={() => { setShowAddGroup(false); setNewGroupName(''); setNewGroupSavings(false); }} style={{ marginBottom: '0.65rem' }}>Cancel</button>
                </div>
              ) : (
                <button className="btn btn-ghost" onClick={() => setShowAddGroup(true)}>+ Add group</button>
              )}
            </div>
            <div className="section-title">Add budget item</div>
            <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <div className="field" style={{ marginBottom: 0 }}>
                <label>Existing category</label>
                <SearchableSelect options={availableCats.map((c) => ({ value: c.id, label: c.name }))}
                  value={addCatId}
                  onChange={(v) => { setAddCatId(v === '' ? '' : Number(v)); if (v !== '') setAddNewCatName(''); }}
                  placeholder="Select..." />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', padding: '0 0.25rem', opacity: 0.4, fontSize: '0.8rem', marginBottom: '0.65rem' }}>or</div>
              <div className="field" style={{ marginBottom: 0 }}>
                <label>New category name</label>
                <input value={addNewCatName}
                  onChange={(e) => { setAddNewCatName(e.target.value); if (e.target.value) setAddCatId(''); }}
                  placeholder="Type to create new…"
                  onKeyDown={(e) => e.key === 'Enter' && addItem()} />
              </div>
              {addNewCatName.trim() && (
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.82rem', cursor: 'pointer', whiteSpace: 'nowrap', marginBottom: '0.65rem' }}>
                  <input type="checkbox" checked={addIsIncome} onChange={(e) => setAddIsIncome(e.target.checked)} />
                  Income
                </label>
              )}
              <div className="field" style={{ marginBottom: 0 }}>
                <label>Target ($)</label>
                <input type="number" value={addTarget} onChange={(e) => setAddTarget(e.target.value)} placeholder="0"
                  onKeyDown={(e) => e.key === 'Enter' && addItem()} />
              </div>
              <button className="btn btn-primary" onClick={addItem} style={{ marginBottom: '0.65rem' }}
                disabled={!addTarget || (addCatId === '' && !addNewCatName.trim())}>
                Add
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Tag historical categories onto a line */}
      {tagItem && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => setTagItemId(null)}>
          <div style={{ background: 'var(--card-bg)', borderRadius: 'var(--radius-lg)', padding: '1.5rem', width: 420, maxWidth: '90vw' }}
            onClick={(e) => e.stopPropagation()}>
            <h3 style={{ margin: '0 0 0.5rem' }}>Count other categories in “{tagItem.categoryName}”</h3>
            <p style={{ fontSize: '0.82rem', color: 'var(--text-2)', margin: '0 0 1rem' }}>
              Spending in these categories is added to this line's spent, 12M/3M and {ytdMode === 'rolling12' ? '12M' : 'YTD'} figures —
              useful when an old category is being folded into a new one. Your transactions aren't changed.
            </p>
            {(tagItem.sourceCategoryIds ?? []).length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem', marginBottom: '0.75rem' }}>
                {(tagItem.sourceCategoryIds ?? []).map((id) => (
                  <span key={id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'var(--bg-3)', border: '1px solid var(--border)', borderRadius: 99, padding: '0.15rem 0.55rem', fontSize: '0.8rem' }}>
                    {catMap.get(id) ?? '?'}
                    <span style={{ cursor: 'pointer', opacity: 0.5 }} title="Remove"
                      onClick={() => {
                        void update((eb) => mapItems(eb, (i) => {
                          if (i.categoryId !== tagItem.categoryId) return i;
                          const next = (i.sourceCategoryIds ?? []).filter((x) => x !== id);
                          return { ...i, sourceCategoryIds: next.length > 0 ? next : undefined };
                        }));
                      }}>×</span>
                  </span>
                ))}
              </div>
            )}
            <div className="field" style={{ marginBottom: '1rem' }}>
              <label>Add a category</label>
              <SearchableSelect
                options={categories
                  .filter((c) => !coveredCatIds.has(c.id))
                  .map((c) => ({ value: c.id, label: c.archived ? `${c.name} (archived)` : c.name }))}
                value=""
                onChange={(v) => {
                  if (v === '') return;
                  const id = Number(v);
                  void update((eb) => mapItems(eb, (i) => (i.categoryId === tagItem.categoryId
                    ? { ...i, sourceCategoryIds: [...(i.sourceCategoryIds ?? []), id] }
                    : i)));
                }}
                placeholder="Search categories..." />
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button className="btn btn-primary" onClick={() => setTagItemId(null)}>Done</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
