import { useState, useSyncExternalStore } from 'react';
import {
  getData, subscribe,
  saveExperimentalBudget, deleteExperimentalBudget,
  addCategory, updateCategoryIsIncome, addBudgetGroup, withUndo,
  type ExperimentalBudget, type ExperimentalBudgetItem, type BudgetGroup,
} from '../db';
import { SearchableSelect } from './SearchableSelect';
import { formatAmount } from '../utils/format';
import { INCOME_CATEGORY_NAMES } from '../seed';
import { ImportBudgetCard } from './ImportBudgetCard';

function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function isCatIncome(catId: number, categories: ReturnType<typeof getData>['categories']): boolean {
  const cat = categories.find((c) => c.id === catId);
  return cat?.isIncome === true || (cat != null && INCOME_CATEGORY_NAMES.has(cat.name));
}

const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

// Group expense items by groupId, returns [{group, items}] sorted by group sortOrder, then ungrouped
function groupItems(
  items: ExperimentalBudgetItem[],
  budgetGroups: BudgetGroup[],
): { group: BudgetGroup | null; items: ExperimentalBudgetItem[] }[] {
  const grouped = new Map<number | null, ExperimentalBudgetItem[]>();
  for (const item of items) {
    const key = item.groupId ?? null;
    const arr = grouped.get(key) ?? [];
    arr.push(item);
    grouped.set(key, arr);
  }
  const result: { group: BudgetGroup | null; items: ExperimentalBudgetItem[] }[] = [];
  for (const g of [...budgetGroups].sort((a, b) => a.sortOrder - b.sortOrder)) {
    const arr = grouped.get(g.id) ?? [];
    if (arr.length > 0) result.push({ group: g, items: arr.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)) });
  }
  const ungrouped = grouped.get(null) ?? [];
  if (ungrouped.length > 0) result.push({ group: null, items: ungrouped.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)) });
  return result;
}

export function ExperimentalBudgetsView() {
  const appData = useSyncExternalStore(subscribe, getData);
  const { categories, budgets, budgetGroups = [], experimentalBudgets = [] } = appData;

  const catMap = new Map(categories.map((c) => [c.id, c.name]));

  // Months that have budget data
  const budgetMonths = [...new Set(budgets.map((b) => b.month))].sort().reverse();

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);

  // Create form
  const [showCreate, setShowCreate] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createFromMonth, setCreateFromMonth] = useState(currentMonth());

  // Edit item inline: key = `${catId}`
  const [editItemCatId, setEditItemCatId] = useState<number | null>(null);
  const [editTarget, setEditTarget] = useState('');

  // Rename
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState('');

  // Add item
  const [showAddSection, setShowAddSection] = useState<'income' | 'expense' | null>(null);
  const [addCatId, setAddCatId] = useState<number | ''>('');
  const [addTarget, setAddTarget] = useState('');
  const [addGroupId, setAddGroupId] = useState<number | null>(null);
  const [addNewCatName, setAddNewCatName] = useState('');

  // New group
  const [showNewGroup, setShowNewGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');

  async function handleCreate() {
    const name = createName.trim();
    if (!name) return;

    const monthBudgets = budgets.filter((b) => b.month === createFromMonth);
    const items: ExperimentalBudgetItem[] = monthBudgets.map((b) => {
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

    const saved = await saveExperimentalBudget({ name, createdAt: new Date().toISOString(), items });
    setSelectedId(saved.id);
    setShowCreate(false);
    setCreateName('');
  }

  async function handleDelete(id: number) {
    await deleteExperimentalBudget(id);
    if (selectedId === id) setSelectedId(null);
    setConfirmDeleteId(null);
  }

  async function saveItemEdit(budget: ExperimentalBudget, catId: number) {
    const amount = parseFloat(editTarget);
    if (isNaN(amount)) { setEditItemCatId(null); return; }
    const updatedItems = budget.items.map((item) =>
      item.categoryId === catId ? { ...item, targetAmount: amount } : item
    );
    await saveExperimentalBudget({ ...budget, items: updatedItems });
    setEditItemCatId(null);
  }

  async function moveItemToGroup(budget: ExperimentalBudget, catId: number, groupId: number | null) {
    const grp = groupId != null ? budgetGroups.find((g) => g.id === groupId) : null;
    const lastOrder = budget.items
      .filter((i) => !i.isIncome && (i.groupId ?? null) === groupId)
      .reduce((m, i) => Math.max(m, i.sortOrder ?? 0), -1);
    const updatedItems = budget.items.map((item) =>
      item.categoryId === catId
        ? { ...item, groupId, groupName: grp?.name ?? null, sortOrder: lastOrder + 1 }
        : item
    );
    await saveExperimentalBudget({ ...budget, items: updatedItems });
  }

  async function handleAddGroup() {
    const name = newGroupName.trim();
    if (!name) return;
    const existing = budgetGroups.find((g) => norm(g.name) === norm(name));
    const id = existing?.id ?? await addBudgetGroup(name);
    if (showAddSection === 'expense') setAddGroupId(id);
    setNewGroupName('');
    setShowNewGroup(false);
  }

  async function deleteItem(budget: ExperimentalBudget, catId: number) {
    const updatedItems = budget.items.filter((item) => item.categoryId !== catId);
    await saveExperimentalBudget({ ...budget, items: updatedItems });
  }

  async function handleAddItem(budget: ExperimentalBudget) {
    const newName = addNewCatName.trim();
    if ((addCatId === '' && !newName) || !addTarget) return;
    const amount = parseFloat(addTarget);
    if (isNaN(amount)) return;
    const incomeSection = showAddSection === 'income';
    // Typing the name of a category that already exists reuses it instead of making a duplicate.
    const existing = addCatId === '' ? categories.find((c) => norm(c.name) === norm(newName)) : undefined;
    if (existing && budget.items.some((i) => i.categoryId === existing.id)) {
      alert(`“${existing.name}” is already in this sandbox.`);
      return;
    }
    await withUndo('Add sandbox item', async () => {
      let catId: number;
      let catName: string;
      if (addCatId !== '') {
        catId = addCatId as number;
        catName = catMap.get(catId) ?? '?';
      } else if (existing) {
        catId = existing.id;
        catName = existing.name;
      } else {
        catId = await addCategory(newName);
        if (incomeSection) await updateCategoryIsIncome(catId, true);
        catName = newName;
      }
      if (budget.items.some((i) => i.categoryId === catId)) return;
      const income = incomeSection ? true : isCatIncome(catId, getData().categories);
      const grp = !income && addGroupId != null ? budgetGroups.find((g) => g.id === addGroupId) : null;
      const newItem: ExperimentalBudgetItem = {
        categoryId: catId,
        categoryName: catName,
        groupId: income ? null : addGroupId,
        groupName: grp?.name ?? null,
        targetAmount: amount,
        isIncome: income || undefined,
      };
      await saveExperimentalBudget({ ...budget, items: [...budget.items, newItem] });
    });
    setAddCatId('');
    setAddNewCatName('');
    setAddTarget('');
    setShowAddSection(null);
  }

  async function handleRename(budget: ExperimentalBudget) {
    const name = renameValue.trim();
    if (!name) return;
    await saveExperimentalBudget({ ...budget, name });
    setRenamingId(null);
  }

  const selectedBudget = experimentalBudgets.find((b) => b.id === selectedId) ?? null;

  // For selected budget: split into income and expense items
  const incomeItems = selectedBudget?.items.filter((i) => i.isIncome) ?? [];
  const expenseItems = selectedBudget?.items.filter((i) => !i.isIncome) ?? [];
  const groupedExpenses = selectedBudget ? groupItems(expenseItems, budgetGroups) : [];
  const totalIncome = incomeItems.reduce((s, i) => s + i.targetAmount, 0);
  const totalExpenses = expenseItems.reduce((s, i) => s + i.targetAmount, 0);

  // Categories not yet in selected budget (for add form)
  const usedCatIds = new Set(selectedBudget?.items.map((i) => i.categoryId) ?? []);
  const availableCats = categories.filter((c) => !usedCatIds.has(c.id) && !c.archived);

  function startEdit(item: ExperimentalBudgetItem) {
    setEditItemCatId(item.categoryId);
    setEditTarget(String(item.targetAmount));
  }

  return (
    <div>
      <h1 className="view-title">Budget Sandbox</h1>
      <p style={{ fontSize: '0.85rem', opacity: 0.7, marginBottom: '1rem' }}>
        Create named budget snapshots to try out different plans without affecting your real budget.
        Apply them to any month from the Budget tab.
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
              Creates a snapshot of that month's items. Income and expense categories are preserved from your category settings.
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
                  <tr key={eb.id} className={i % 2 === 0 ? 'budget-row-even' : 'budget-row-odd'}>
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

      {/* Selected budget detail */}
      {selectedBudget && (
        <div>
          {/* Totals summary */}
          <div style={{ display: 'flex', gap: '1rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 160, background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: '0.75rem 1rem' }}>
              <div style={{ fontSize: '0.68rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-3)', marginBottom: '0.3rem' }}>Total Income</div>
              <div style={{ fontSize: '1.3rem', fontWeight: 700, color: '#16a34a' }}>${formatAmount(totalIncome, 0)}</div>
            </div>
            <div style={{ flex: 1, minWidth: 160, background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: '0.75rem 1rem' }}>
              <div style={{ fontSize: '0.68rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-3)', marginBottom: '0.3rem' }}>Total Expenses</div>
              <div style={{ fontSize: '1.3rem', fontWeight: 700, color: '#dc2626' }}>${formatAmount(totalExpenses, 0)}</div>
            </div>
            <div style={{ flex: 1, minWidth: 160, background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: '0.75rem 1rem' }}>
              <div style={{ fontSize: '0.68rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-3)', marginBottom: '0.3rem' }}>Net</div>
              <div style={{ fontSize: '1.3rem', fontWeight: 700, color: totalIncome - totalExpenses >= 0 ? '#16a34a' : '#dc2626' }}>${formatAmount(totalIncome - totalExpenses, 0)}</div>
            </div>
          </div>

          {/* Income section */}
          <div className="card" style={{ marginBottom: '1rem' }}>
            <div className="section-title" style={{ marginTop: 0 }}>Income</div>
            {incomeItems.length === 0 && (
              <div style={{ color: 'var(--text-3)', fontSize: '0.85rem', marginBottom: '0.5rem' }}>No income items yet.</div>
            )}
            {incomeItems.length > 0 && (
              <table className="data-table" style={{ marginBottom: '0.75rem' }}>
                <thead>
                  <tr><th>Category</th><th className="num">Target ($)</th><th></th></tr>
                </thead>
                <tbody>
                  {incomeItems.map((item, i) => (
                    <tr key={item.categoryId} className={i % 2 === 0 ? 'budget-row-even' : 'budget-row-odd'}>
                      <td>{item.categoryName}</td>
                      <td className="num budget-num">
                        {editItemCatId === item.categoryId ? (
                          <input type="number" value={editTarget}
                            onChange={(e) => setEditTarget(e.target.value)}
                            onBlur={() => saveItemEdit(selectedBudget, item.categoryId)}
                            onKeyDown={(e) => { if (e.key === 'Enter') saveItemEdit(selectedBudget, item.categoryId); if (e.key === 'Escape') setEditItemCatId(null); }}
                            style={{ width: 80, fontSize: '0.88rem' }} autoFocus />
                        ) : (
                          <span style={{ cursor: 'pointer' }} onClick={() => startEdit(item)}>
                            ${formatAmount(item.targetAmount, 0)}
                          </span>
                        )}
                      </td>
                      <td><button className="btn btn-danger btn-sm" onClick={() => deleteItem(selectedBudget, item.categoryId)}>&times;</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {showAddSection === 'income' ? (
              <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-end', gap: '0.5rem' }}>
                <div className="field">
                  <label>Category</label>
                  <SearchableSelect
                    options={availableCats.map((c) => ({ value: c.id, label: c.name }))}
                    value={addCatId} onChange={(v) => { setAddCatId(v === '' ? '' : Number(v)); if (v !== '') setAddNewCatName(''); }}
                    placeholder="Select category…" />
                </div>
                <div className="field">
                  <label>…or new category</label>
                  <input value={addNewCatName} onChange={(e) => { setAddNewCatName(e.target.value); if (e.target.value) setAddCatId(''); }}
                    onKeyDown={(e) => e.key === 'Enter' && handleAddItem(selectedBudget)}
                    placeholder="New category name" style={{ width: 170 }} />
                </div>
                <div className="field">
                  <label>Target ($)</label>
                  <input type="number" value={addTarget} onChange={(e) => setAddTarget(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleAddItem(selectedBudget)}
                    placeholder="0" style={{ width: 80 }} />
                </div>
                <button className="btn btn-primary" onClick={() => handleAddItem(selectedBudget)} disabled={(addCatId === '' && !addNewCatName.trim()) || !addTarget}>Add</button>
                <button className="btn btn-ghost" onClick={() => setShowAddSection(null)}>Cancel</button>
              </div>
            ) : (
              <button className="btn btn-ghost btn-sm" onClick={() => { setShowAddSection('income'); setAddCatId(''); setAddNewCatName(''); setAddTarget(''); }}>+ Add income item</button>
            )}
          </div>

          {/* Expense groups */}
          <div className="card" style={{ marginBottom: '1rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
              <div className="section-title" style={{ margin: 0 }}>Expenses</div>
              <div style={{ marginLeft: 'auto', display: 'flex', gap: '0.35rem', alignItems: 'center' }}>
                {showNewGroup ? (
                  <>
                    <input value={newGroupName} onChange={(e) => setNewGroupName(e.target.value)} autoFocus
                      onKeyDown={(e) => { if (e.key === 'Enter') handleAddGroup(); if (e.key === 'Escape') setShowNewGroup(false); }}
                      placeholder="Group name" style={{ width: 150, fontSize: '0.85rem' }} />
                    <button className="btn btn-primary btn-sm" onClick={handleAddGroup} disabled={!newGroupName.trim()}>Add group</button>
                    <button className="btn btn-ghost btn-sm" onClick={() => setShowNewGroup(false)}>Cancel</button>
                  </>
                ) : (
                  <button className="btn btn-ghost btn-sm" title="New groups appear here once a category is moved into them"
                    onClick={() => { setShowNewGroup(true); setNewGroupName(''); }}>+ New group</button>
                )}
              </div>
            </div>
            {expenseItems.length === 0 && (
              <div style={{ color: 'var(--text-3)', fontSize: '0.85rem', marginBottom: '0.5rem' }}>No expense items yet.</div>
            )}
            {groupedExpenses.map(({ group, items: grpItems }) => (
              <div key={group?.id ?? 'ungrouped'} style={{ marginBottom: '0.75rem' }}>
                <div style={{ fontSize: '0.78rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--text-3)', padding: '0.25rem 0', borderBottom: '1px solid var(--border)', marginBottom: '0.25rem', display: 'flex', justifyContent: 'space-between' }}>
                  <span>{group?.name ?? 'Ungrouped'}</span>
                  <span>${formatAmount(grpItems.reduce((s, i) => s + i.targetAmount, 0), 0)}</span>
                </div>
                <table className="data-table">
                  <tbody>
                    {grpItems.map((item, i) => (
                      <tr key={item.categoryId} className={i % 2 === 0 ? 'budget-row-even' : 'budget-row-odd'}>
                        <td>{item.categoryName}</td>
                        <td className="num budget-num">
                          {editItemCatId === item.categoryId ? (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-end' }}>
                              <input type="number" value={editTarget}
                                onChange={(e) => setEditTarget(e.target.value)}
                                onKeyDown={(e) => { if (e.key === 'Enter') saveItemEdit(selectedBudget, item.categoryId); if (e.key === 'Escape') setEditItemCatId(null); }}
                                style={{ width: 80, fontSize: '0.88rem' }} autoFocus />
                              <div style={{ display: 'flex', gap: 4 }}>
                                <button className="btn btn-primary btn-sm" onClick={() => saveItemEdit(selectedBudget, item.categoryId)}>Save</button>
                                <button className="btn btn-ghost btn-sm" onClick={() => setEditItemCatId(null)}>Cancel</button>
                              </div>
                            </div>
                          ) : (
                            <span style={{ cursor: 'pointer' }} onClick={() => startEdit(item)}>
                              ${formatAmount(item.targetAmount, 0)}
                            </span>
                          )}
                        </td>
                        <td style={{ width: 1, whiteSpace: 'nowrap' }}>
                          <select value={item.groupId ?? ''} title="Move to another group"
                            onChange={(e) => moveItemToGroup(selectedBudget, item.categoryId, e.target.value === '' ? null : Number(e.target.value))}
                            style={{ fontSize: '0.75rem', padding: '0.15rem 0.3rem', maxWidth: 150 }}>
                            <option value="">Ungrouped</option>
                            {budgetGroups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                          </select>
                        </td>
                        <td style={{ width: 1 }}><button className="btn btn-danger btn-sm" onClick={() => deleteItem(selectedBudget, item.categoryId)}>&times;</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
            {showAddSection === 'expense' ? (
              <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-end', gap: '0.5rem', marginTop: '0.5rem' }}>
                <div className="field">
                  <label>Category</label>
                  <SearchableSelect
                    options={availableCats.filter((c) => !isCatIncome(c.id, categories)).map((c) => ({ value: c.id, label: c.name }))}
                    value={addCatId} onChange={(v) => { setAddCatId(v === '' ? '' : Number(v)); if (v !== '') setAddNewCatName(''); }}
                    placeholder="Select category…" />
                </div>
                <div className="field">
                  <label>…or new category</label>
                  <input value={addNewCatName} onChange={(e) => { setAddNewCatName(e.target.value); if (e.target.value) setAddCatId(''); }}
                    onKeyDown={(e) => e.key === 'Enter' && handleAddItem(selectedBudget)}
                    placeholder="New category name" style={{ width: 170 }} />
                </div>
                <div className="field">
                  <label>Group</label>
                  <select value={addGroupId ?? ''} onChange={(e) => setAddGroupId(e.target.value === '' ? null : Number(e.target.value))}
                    style={{ padding: '0.35rem 0.5rem', fontSize: '0.9rem' }}>
                    <option value="">Ungrouped</option>
                    {budgetGroups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label>Target ($)</label>
                  <input type="number" value={addTarget} onChange={(e) => setAddTarget(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleAddItem(selectedBudget)}
                    placeholder="0" style={{ width: 80 }} />
                </div>
                <button className="btn btn-primary" onClick={() => handleAddItem(selectedBudget)} disabled={(addCatId === '' && !addNewCatName.trim()) || !addTarget}>Add</button>
                <button className="btn btn-ghost" onClick={() => setShowAddSection(null)}>Cancel</button>
              </div>
            ) : (
              <button className="btn btn-ghost btn-sm" style={{ marginTop: '0.25rem' }} onClick={() => { setShowAddSection('expense'); setAddCatId(''); setAddNewCatName(''); setAddTarget(''); setAddGroupId(null); }}>+ Add expense item</button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
