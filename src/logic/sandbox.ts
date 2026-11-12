import {
  getData, upsertBudget, addBudgetGroup, updateBudgetGroup, withUndo,
  type BudgetGroup, type ExperimentalBudget, type SandboxGroup,
} from '../db';

const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * Sandboxes made before sandbox groups existed point straight at the live budget groups.
 * Give them their own copy of those groups so editing a sandbox never touches the live budget.
 */
export function normalizeSandbox(eb: ExperimentalBudget, liveGroups: BudgetGroup[]): ExperimentalBudget & { groups: SandboxGroup[] } {
  if (eb.groups) return eb as ExperimentalBudget & { groups: SandboxGroup[] };
  return { ...eb, groups: sandboxGroupsFromLive(liveGroups, eb.items) };
}

/** Copies the live groups (plus any the items mention that no longer exist) for a new sandbox. */
export function sandboxGroupsFromLive(liveGroups: BudgetGroup[], items: ExperimentalBudget['items']): SandboxGroup[] {
  const groups: SandboxGroup[] = [...liveGroups]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((g, i) => ({ id: g.id, name: g.name, sortOrder: i, note: g.note, spendFromSavings: g.spendFromSavings }));
  for (const item of items) {
    if (item.groupId != null && !groups.some((g) => g.id === item.groupId)) {
      groups.push({ id: item.groupId, name: item.groupName ?? 'Group', sortOrder: groups.length });
    }
  }
  return groups;
}

export function nextSandboxGroupId(groups: SandboxGroup[]): number {
  return groups.reduce((m, g) => Math.max(m, g.id), 0) + 1;
}

/**
 * Writes a sandbox's targets into a month. Sandbox groups are matched to live groups by name;
 * a group with no live match is created.
 */
export async function applySandboxToMonth(sandbox: ExperimentalBudget, month: string): Promise<number> {
  let applied = 0;
  await withUndo('Apply budget sandbox', async () => {
    const eb = normalizeSandbox(sandbox, getData().budgetGroups ?? []);
    const liveIdBySandboxId = new Map<number, number>();
    for (const sg of eb.groups) {
      if (!eb.items.some((i) => !i.isIncome && i.groupId === sg.id)) continue;
      const live = (getData().budgetGroups ?? []).find((g) => norm(g.name) === norm(sg.name));
      let id = live?.id;
      if (id == null) {
        id = await addBudgetGroup(sg.name);
        if (sg.spendFromSavings) await updateBudgetGroup(id, { spendFromSavings: true });
      }
      liveIdBySandboxId.set(sg.id, id);
    }
    const catIds = new Set(getData().categories.map((c) => c.id));
    for (const item of eb.items) {
      if (!catIds.has(item.categoryId)) continue;
      const groupId = item.isIncome || item.groupId == null ? null : liveIdBySandboxId.get(item.groupId) ?? null;
      await upsertBudget(month, item.categoryId, item.targetAmount, groupId, item.sortOrder);
      applied++;
    }
  });
  return applied;
}
