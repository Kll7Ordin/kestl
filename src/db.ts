import { invoke } from '@tauri-apps/api/core';
import { buildSeedData, buildDemoData } from './seed';
import { currentMonthStr, monthsBetween, prevMonth } from './logic/dateUtils';
import { isEncryptedFile, createSessionKey, encryptWithKey, decryptWithPassword, type SessionKey } from './utils/crypto';
import { isCredit, isPaypalLinked } from './logic/txnKind';
import { removeExistingDuplicates } from './logic/duplicates';
import type { LookupReport } from './logic/lookup';

export interface Category {
  id: number;
  name: string;
  isIncome?: boolean; // if true, shown in Income section and excluded from expense remaining calc
  color?: string;     // hex color for UI chips
  note?: string;      // optional hover tooltip shown in budget view
  savingsBucketId?: number | null; // if set, transactions categorized here fill this savings bucket
  archived?: boolean; // hidden from pickers; history still shows
  rollover?: boolean; // unspent/overspent budget carries into the next month
  rolloverStartMonth?: string; // YYYY-MM the carry starts from
  excludeFromOffBudget?: boolean; // not counted in "spending outside this month's budget"
}

// Palette: 30 visually distinct colors via golden-angle hue spread
export const CATEGORY_PALETTE: string[] = [
  '#d64141','#4dcb71','#7f28bd','#cbbb4d','#41bdd6','#b13377',
  '#66d641','#524dcb','#bd5a28','#4dcb9c','#ca41d6','#97b133',
  '#418cd6','#cb4d67','#28bd34','#7c4dcb','#d6a541','#33b1ac',
  '#d641b1','#86cb4d','#2840bd','#cb5d4d','#41d680','#8d33b1',
  '#cbcb4d','#41a8d6','#d6416e','#4dbd99','#bd9128','#6441d6',
];

function pickDistinctColor(existingCategories: Category[]): string {
  const used = new Set(existingCategories.map((c) => c.color).filter(Boolean));
  const unused = CATEGORY_PALETTE.find((c) => !used.has(c));
  if (unused) return unused;
  return CATEGORY_PALETTE[existingCategories.length % CATEGORY_PALETTE.length];
}

export async function updateCategoryColor(id: number, color: string): Promise<void> {
  pushUndoSnapshot('Update category color');
  const cat = data.categories.find((c) => c.id === id);
  if (cat) { cat.color = color; await persist(); }
}

export async function updateCategoryNote(id: number, note: string): Promise<void> {
  pushUndoSnapshot('Update category note');
  const cat = data.categories.find((c) => c.id === id);
  if (cat) { cat.note = note || undefined; await persist(); }
}

export async function updateCategoryName(id: number, name: string): Promise<void> {
  pushUndoSnapshot('Update category name');
  const cat = data.categories.find((c) => c.id === id);
  if (cat && name.trim()) { cat.name = name.trim(); await persist(); }
}

export async function updateCategoryBucket(id: number, bucketId: number | null): Promise<void> {
  pushUndoSnapshot('Update category bucket');
  const cat = data.categories.find((c) => c.id === id);
  if (cat) { cat.savingsBucketId = bucketId ?? undefined; await persist(); }
}

export async function updateCategoryIsIncome(id: number, isIncome: boolean): Promise<void> {
  pushUndoSnapshot('Update category is income');
  const cat = data.categories.find((c) => c.id === id);
  if (cat) { cat.isIncome = isIncome || undefined; await persist(); }
}

export interface SplitRuleItem {
  categoryId: number;
  amount?: number;   // fixed $ amount
  percent?: number;  // percentage 0-100 (takes precedence if set)
}

export interface CategoryRule {
  id: number;
  matchType: 'exact' | 'contains';
  pattern: string;
  categoryId: number;
  amountMatch?: number | null; // optional: rule only applies if txn amount equals this (within 0.01)
  splits?: SplitRuleItem[];    // if set, transaction is split into these categories instead
  markTransfer?: boolean;      // if set, the rule marks matching transactions as transfers (categoryId is unused)
}

export interface BudgetGroup {
  id: number;
  name: string;
  sortOrder: number;
  note?: string;
  spendFromSavings?: boolean;
}

export interface Budget {
  id: number;
  month: string;
  categoryId: number;
  targetAmount: number;
  groupId?: number | null;
  sortOrder?: number;
  note?: string; // per-month note for this budget entry
}

export interface Transaction {
  id: number;
  source: string;
  sourceRef: string;
  txnDate: string;
  originalTxnDate?: string; // preserved when date is moved via UI; used for duplicate detection
  amount: number;
  instrument: string;
  descriptor: string;
  categoryId: number | null;
  linkedTransactionId: number | null;
  ignoreInBudget: boolean;
  comment: string | null;
  starred?: boolean;
  starNote?: string | null;
  isTransfer?: boolean; // movement between your own accounts; excluded from spend, income and suggestions
}

export interface TransactionSplit {
  id: number;
  transactionId: number;
  categoryId: number;
  amount: number;
  txnDate?: string; // optional override — counts this portion in a different month
}

export interface SavingsBucket {
  id: number;
  name: string;
}

export interface SavingsEntry {
  id: number;
  entryDate: string;
  bucketId: number;
  amount: number;
  notes: string;
  source: 'manual' | 'auto_schedule';
  scheduleId: number | null;
}

export interface SavingsSchedule {
  id: number;
  bucketId: number;
  dayOfMonth: number;
  amount: number;
  startMonth: string;
  active: boolean;
}

export interface RecurringTemplate {
  id: number;
  descriptor: string;
  amount: number;
  instrument: string;
  categoryId: number | null;
  dayOfMonth: number;
  active: boolean;
  ignoreInBudget?: boolean; // true = income/credit transaction
  startMonth?: string;      // YYYY-MM: first month to generate
  skippedMonths?: string[]; // months whose occurrence was deleted/skipped (tombstones)
  pausedAt?: string;        // YYYY-MM when the template was paused
}

export interface SplitTemplate {
  id: number;
  name: string;
  items: { categoryName: string; amount: number }[];
}

export interface AmazonOrder {
  orderNum: string;
  itemName: string;
  orderDate: string;
  amount: number;
  status: 'delivered' | 'returned' | 'cancelled';
}

export interface AISettings {
  ollamaUrl: string;
  model: string;
}

export interface CustomParser {
  id: string;
  name: string;
  instrument: string;
  code: string;        // TypeScript function body — evaled at runtime
  sampleLines: string; // First few lines of sample file, for reference
  createdAt: string;
}

/**
 * What happened to a category suggestion once the user picked a category for that transaction.
 * Used to compare how often the history chip and the ? lookup are right.
 */
export interface AICategoryFeedback {
  descriptor: string;       // lowercased descriptor
  suggestedCategoryId: number;
  acceptedCategoryId: number | null; // the category the user picked (null = cleared)
  outcome: 'accepted' | 'rejected';
  /** Which suggestion: the history chip or the ? lookup. Missing on entries from before 2.11. */
  source?: 'history' | 'ai';
  /** YYYY-MM-DD the choice was made. */
  at?: string;
}

export interface ExperimentalBudgetItem {
  categoryId: number;
  categoryName: string;
  groupId: number | null;
  groupName: string | null;
  targetAmount: number;
  sortOrder?: number;
  isIncome?: boolean;
}

export interface ExperimentalBudget {
  id: number;
  name: string;
  createdAt: string;
  items: ExperimentalBudgetItem[];
}

export interface MergeLog {
  id: number;
  timestamp: string;
  targetCategoryId: number;
  sourceCategoryIds: number[];
  affectedTransactionIds: number[];
  affectedSplitIds: number[];
  affectedRuleIds: number[];
  affectedBudgetIds?: number[];
  affectedRecurringIds?: number[];
}

export interface AppData {
  nextId: number;
  categories: Category[];
  categoryRules: CategoryRule[];
  budgetGroups: BudgetGroup[];
  budgets: Budget[];
  transactions: Transaction[];
  transactionSplits: TransactionSplit[];
  savingsBuckets: SavingsBucket[];
  savingsEntries: SavingsEntry[];
  savingsSchedules: SavingsSchedule[];
  recurringTemplates: RecurringTemplate[];
  splitTemplates?: SplitTemplate[];
  savingsLoanAmount?: number;
  amazonOrders?: AmazonOrder[];
  aiSettings?: AISettings;
  customParsers?: CustomParser[];
  aiCategoryFeedback?: AICategoryFeedback[];
  /** Merchant key (logic/suggest.ts parseDescriptor) → kind of business, labelled by the local model. */
  merchantTypes?: Record<string, string>;
  /** Merchant key → the last ? lookup for that merchant (search, AI reading, recommended category). */
  merchantLookups?: Record<string, LookupReport>;
  experimentalBudgets?: ExperimentalBudget[];
  completedMigrations?: string[];
  colorThresholds?: ColorThresholds;
  displaySettings?: DisplaySettings;
  mortgage?: MortgageConfig;
  mortgageLedger?: MortgageLedgerEntry[];
  mergeLogs?: MergeLog[];
  backupSettings?: BackupSettings;
}

export interface ColorThresholds {
  orangePct: number; // % over budget (e.g. 1 = 1% over = 101%)
  orangeAbs: number; // $ over budget (must exceed BOTH pct and abs to cross threshold)
  redPct: number;
  redAbs: number;
}

export const DEFAULT_COLOR_THRESHOLDS: ColorThresholds = {
  orangePct: 1,
  orangeAbs: 1,
  redPct: 10,
  redAbs: 25,
};

export interface DisplaySettings {
  ytdColumnsVisible: boolean;
  ytdMode: 'ytd' | 'rolling12';
  experimentalEnabled?: boolean;
  showMortgageTab?: boolean;
  txnAiLookupEnabled?: boolean;
}

export interface BackupSettings {
  enabled: boolean;
  maxCount: number;
}

export const DEFAULT_DISPLAY_SETTINGS: DisplaySettings = {
  ytdColumnsVisible: true,
  ytdMode: 'ytd',
};

function emptyData(): AppData {
  return {
    nextId: 1,
    categories: [],
    categoryRules: [],
    budgetGroups: [],
    budgets: [],
    transactions: [],
    transactionSplits: [],
    savingsBuckets: [],
    savingsEntries: [],
    savingsSchedules: [],
    recurringTemplates: [],
    splitTemplates: [],
    experimentalBudgets: [],
  };
}

let data: AppData = emptyData();
let filePath: string | null = null;
let listeners: Array<() => void> = [];
let sessionPassword: string | null = null; // never written to disk
let sessionKey: SessionKey | null = null;  // derived once per session; reused for every save

// ── Undo: one snapshot per user action, up to 10 ───────────────────────────────
const UNDO_LIMIT = 10;
const _undoStack: { label: string; snap: string }[] = [];
let _undoListeners: Array<() => void> = [];
let _undoSuppress = 0;

function notifyUndo() { for (const fn of _undoListeners) fn(); }

export function pushUndoSnapshot(label: string): void {
  if (_undoSuppress > 0) return;
  _undoStack.push({ label, snap: JSON.stringify(data) });
  if (_undoStack.length > UNDO_LIMIT) _undoStack.shift();
  notifyUndo();
}

/** Run `fn` as ONE undoable user action: pushes a single snapshot, then suppresses nested ones. */
export async function withUndo<T>(label: string, fn: () => Promise<T>): Promise<T> {
  pushUndoSnapshot(label);
  _undoSuppress++;
  try { return await fn(); } finally { _undoSuppress--; }
}

/** Run background jobs (startup cleanup, recurring generation) without creating undo snapshots. */
export async function withoutUndo<T>(fn: () => Promise<T>): Promise<T> {
  _undoSuppress++;
  try { return await fn(); } finally { _undoSuppress--; }
}

export async function undo(): Promise<boolean> {
  const entry = _undoStack.pop();
  if (!entry) return false;
  data = { ...emptyData(), ...JSON.parse(entry.snap) };
  await persist();
  notifyUndo();
  return true;
}

export function canUndo(): boolean { return _undoStack.length > 0; }

export function getUndoLabel(): string | null {
  return _undoStack.length > 0 ? _undoStack[_undoStack.length - 1].label : null;
}

export function subscribeUndo(fn: () => void): () => void {
  _undoListeners = [..._undoListeners, fn];
  return () => { _undoListeners = _undoListeners.filter((l) => l !== fn); };
}

/** Test-only: replace in-memory data. Never call from app code. */
export function __setDataForTests(d: AppData): void {
  data = { ...emptyData(), ...structuredClone(d) };
  filePath = null;
  sessionPassword = null;
  sessionKey = null;
  _undoStack.length = 0;
  resetSaveState();
}

/** Test-only: pretend a file is open so the save pipeline runs (with `invoke` mocked). */
export function __setFilePathForTests(p: string | null): void {
  filePath = p;
  resetSaveState();
}

function nextMonthStr(m: string): string {
  const [y, mo] = m.split('-').map(Number);
  const d = new Date(y, mo, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function nextId(): number {
  return data.nextId++;
}

// ── Save pipeline: UI updates immediately, disk write is debounced, atomic and conflict-checked ──
export type SaveStatus = 'idle' | 'pending' | 'saving' | 'error' | 'conflict';
interface SaveInfo { status: SaveStatus; error?: string; lastSavedAt?: number }
let saveInfo: SaveInfo = { status: 'idle' };
let saveListeners: Array<() => void> = [];
let lastKnownMtime: number | null = null;
let dirty = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let saveInFlight: Promise<void> | null = null;
let notifyQueued = false;
let retryCount = 0;
let saveCount = 0;
const SAVE_DEBOUNCE_MS = 400;
const RETRY_DELAYS_MS = [2000, 5000, 15000];

const ARRAY_KEYS = ['categories', 'categoryRules', 'budgetGroups', 'budgets', 'transactions', 'transactionSplits',
  'savingsBuckets', 'savingsEntries', 'savingsSchedules', 'recurringTemplates', 'splitTemplates',
  'amazonOrders', 'customParsers', 'experimentalBudgets', 'mortgageLedger', 'mergeLogs', 'aiCategoryFeedback'] as const;

/** Give every array a new reference so React memos keyed on them re-run. */
function refreshRefs() {
  const next: AppData = { ...data };
  for (const k of ARRAY_KEYS) {
    const v = next[k];
    if (Array.isArray(v)) (next as unknown as Record<string, unknown>)[k] = [...v];
  }
  data = next;
}

function queueNotify() {
  if (notifyQueued) return;
  notifyQueued = true;
  queueMicrotask(() => { notifyQueued = false; for (const fn of listeners) fn(); });
}

function setSaveInfo(patch: SaveInfo) {
  saveInfo = { ...saveInfo, error: undefined, ...patch };
  for (const fn of saveListeners) fn();
}

function resetSaveState() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  dirty = false;
  retryCount = 0;
  lastKnownMtime = null;
  saveInfo = { status: 'idle' };
  for (const fn of saveListeners) fn();
}

export function getSaveStatus(): SaveInfo { return saveInfo; }
export function getSaveCount(): number { return saveCount; }
export function subscribeSaveStatus(fn: () => void): () => void {
  saveListeners = [...saveListeners, fn];
  return () => { saveListeners = saveListeners.filter((l) => l !== fn); };
}

function scheduleSave(delay = SAVE_DEBOUNCE_MS) {
  dirty = true;
  if (saveInfo.status === 'conflict') return;
  if (saveInfo.status !== 'pending' && saveInfo.status !== 'saving') setSaveInfo({ status: 'pending' });
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveTimer = null; void runSave(); }, delay);
}

/** Called by every mutator. Updates the UI right away; the disk write happens later. */
async function persist(): Promise<void> {
  refreshRefs();
  queueNotify();
  if (filePath) scheduleSave();
}

async function doSave(): Promise<void> {
  const path = filePath;
  if (!path) return;
  dirty = false;
  setSaveInfo({ status: 'saving' });
  try {
    let content = sessionKey ? JSON.stringify(data) : JSON.stringify(data, null, 2);
    if (sessionKey) content = await encryptWithKey(content, sessionKey);
    const mtime = await invoke<number>('save_data', { path, data: content, expectedMtime: lastKnownMtime });
    if (filePath !== path) return; // file was switched while saving
    lastKnownMtime = mtime;
    saveCount++;
    retryCount = 0;
    if (dirty) setSaveInfo({ status: 'pending', lastSavedAt: Date.now() });
    else setSaveInfo({ status: 'idle', lastSavedAt: Date.now() });
  } catch (e) {
    if (filePath !== path) return;
    dirty = true;
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('CONFLICT')) {
      setSaveInfo({ status: 'conflict' });
    } else {
      setSaveInfo({ status: 'error', error: msg });
      if (retryCount < RETRY_DELAYS_MS.length) {
        const delay = RETRY_DELAYS_MS[retryCount++];
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => { saveTimer = null; void runSave(); }, delay);
      }
    }
  }
}

async function runSave(): Promise<void> {
  if (saveInFlight) await saveInFlight;
  if (!dirty || !filePath || saveInfo.status === 'conflict') return;
  if (saveInFlight) return; // another caller started one while we waited
  saveInFlight = doSave().finally(() => { saveInFlight = null; });
  await saveInFlight;
}

/** Write any pending changes now. Throws if the final status is error or conflict. */
export async function flushSave(): Promise<void> {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  for (let i = 0; i < 5; i++) {
    if (saveInFlight) await saveInFlight;
    if (!dirty || !filePath) break;
    if (saveInfo.status === 'conflict') break;
    await runSave();
    if (saveInfo.status === 'error') break;
  }
  if (saveInfo.status === 'error') throw new Error(saveInfo.error ?? 'Save failed');
  if (saveInfo.status === 'conflict') throw new Error('CONFLICT');
}

/** Retry after an error: reset the backoff and write now. */
export async function retrySave(): Promise<void> {
  retryCount = 0;
  dirty = true;
  if (saveInfo.status === 'error') setSaveInfo({ status: 'pending' });
  await flushSave();
}

export async function resolveConflict(choice: 'overwrite' | 'reload'): Promise<void> {
  if (!filePath) return;
  if (choice === 'overwrite') {
    lastKnownMtime = null;
    dirty = true;
    setSaveInfo({ status: 'pending' });
    await flushSave();
  } else {
    await loadFromFile(filePath, sessionPassword ?? undefined, { discardUnsaved: true });
  }
}

export function subscribe(fn: () => void): () => void {
  listeners = [...listeners, fn];
  return () => { listeners = listeners.filter((l) => l !== fn); };
}

export function getData(): AppData {
  return data;
}

export async function getLastFilePath(): Promise<string | null> {
  return invoke<string | null>('get_last_file_path');
}

function resetForNewFile() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  _undoStack.length = 0;
  notifyUndo();
  resetSaveState();
}

export async function loadFromFile(
  path: string,
  password?: string,
  opts: { discardUnsaved?: boolean } = {},
): Promise<void> {
  // Make sure the file we're leaving is fully written before touching anything.
  if (filePath && !opts.discardUnsaved) await flushSave();

  const raw = await invoke<string>('load_data', { path });
  let jsonStr = raw;
  let newKey: SessionKey | null = null;
  let newPassword: string | null = null;
  let needsUpgrade = false;
  if (isEncryptedFile(raw)) {
    if (!password) throw new Error('FILE_ENCRYPTED');
    const r = await decryptWithPassword(raw, password);
    jsonStr = r.plaintext;
    newKey = r.sessionKey;
    newPassword = password;
    needsUpgrade = r.needsUpgrade;
  }
  const parsed = JSON.parse(jsonStr);
  const mtime = await invoke<number | null>('file_mtime', { path });

  // Everything succeeded — now switch state.
  resetForNewFile();
  sessionKey = newKey;
  sessionPassword = newPassword;
  data = { ...emptyData(), ...parsed };
  if (!data.recurringTemplates) data.recurringTemplates = [];
  if (!data.splitTemplates) data.splitTemplates = [];
  if (!data.budgetGroups) data.budgetGroups = [];
  if (!data.experimentalBudgets) data.experimentalBudgets = [];
  // Normalize transaction fields that may be missing in older records
  for (const t of data.transactions) {
    if (t.instrument == null) t.instrument = '';
    if (t.descriptor == null) t.descriptor = '';
    if (t.source == null) t.source = '';
    if (t.sourceRef == null) t.sourceRef = '';
  }
  filePath = path;
  lastKnownMtime = mtime;
  await invoke('set_file_path', { path });
  refreshRefs();
  for (const fn of listeners) fn();
  if (needsUpgrade) { await persist(); await flushSave(); }
}

export function isCurrentFileEncrypted(): boolean {
  return sessionPassword !== null;
}

export async function enableEncryption(password: string): Promise<void> {
  if (!password) throw new Error('Password cannot be empty');
  sessionKey = await createSessionKey(password);
  sessionPassword = password;
  await persist();
  await flushSave();
}

export async function changeEncryptionPassword(oldPassword: string, newPassword: string): Promise<void> {
  if (sessionPassword !== oldPassword) throw new Error('Current password is incorrect');
  if (!newPassword) throw new Error('New password cannot be empty');
  sessionKey = await createSessionKey(newPassword);
  sessionPassword = newPassword;
  await persist();
  await flushSave();
}

export async function disableEncryption(): Promise<void> {
  sessionKey = null;
  sessionPassword = null;
  await persist();
  await flushSave();
}

export async function checkFileEncrypted(path: string): Promise<boolean> {
  try {
    const raw = await invoke<string>('load_data', { path });
    return isEncryptedFile(raw);
  } catch {
    return false;
  }
}

async function startFreshFile(path: string, fresh: AppData): Promise<void> {
  if (filePath) await flushSave();
  resetForNewFile();
  sessionKey = null;
  sessionPassword = null;
  data = fresh;
  filePath = path;
  lastKnownMtime = null;
  await persist();
  await flushSave();
  await invoke('set_file_path', { path });
}

export async function createNewFile(path: string): Promise<void> {
  await startFreshFile(path, buildSeedData());
}

export async function createDemoFile(path: string): Promise<void> {
  await startFreshFile(path, buildDemoData());
}

export async function fileExists(path: string): Promise<boolean> {
  return invoke<boolean>('file_exists', { path });
}

export function getFilePath(): string | null {
  return filePath;
}

export interface CleanupResult { id: string; changed: number }

/** Run a one-time migration (gated by data.completedMigrations). */
export const REMOVE_RENAMED_DUPLICATES = 'removeRenamedBankDuplicates';

export function isMigrationDone(id: string): boolean {
  return data.completedMigrations?.includes(id) ?? false;
}

function migrate(results: CleanupResult[], id: string, fn: () => number): void {
  if (!data.completedMigrations) data.completedMigrations = [];
  if (data.completedMigrations.includes(id)) return;
  const changed = fn();
  data.completedMigrations.push(id);
  results.push({ id, changed });
}

function readLocal(key: string): string | null {
  try { return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null; } catch { return null; }
}

/** Startup data cleanup — idempotent fixes plus one-time migrations. Returns what changed. */
export async function startupCleanup(): Promise<CleanupResult[]> {
  const results: CleanupResult[] = [];
  if (!data.completedMigrations) data.completedMigrations = [];
  let colorized = 0;

  // 1. (every launch, idempotent) Clear stale links pointing to deleted transactions
  {
    const txnMap = new Set(data.transactions.map((t) => t.id));
    let n = 0;
    for (const t of data.transactions) {
      if (t.linkedTransactionId && t.linkedTransactionId > 0 && !txnMap.has(t.linkedTransactionId)) {
        t.linkedTransactionId = null;
        n++;
      }
    }
    if (n > 0) results.push({ id: 'clearStaleLinks', changed: n });
  }

  // 2. One-time: bidirectional refund links — negate the refund (higher id = later import)
  migrate(results, 'fixBidirectionalRefundSigns', () => {
    const txnMap = new Map(data.transactions.map((t) => [t.id, t]));
    const seen = new Set<number>();
    let n = 0;
    for (const t of data.transactions) {
      if (!t.linkedTransactionId || t.linkedTransactionId <= 0) continue;
      const linked = txnMap.get(t.linkedTransactionId);
      if (linked && !seen.has(t.id) && linked.linkedTransactionId === t.id
          && t.amount > 0 && linked.amount > 0 && Math.abs(t.amount - linked.amount) < 0.02) {
        seen.add(t.id); seen.add(linked.id);
        const refund = t.id > linked.id ? t : linked;
        refund.amount = -Math.abs(refund.amount);
        n++;
      }
    }
    return n;
  });

  // 3. One-time: PayPal transactions wrongly marked as credits
  migrate(results, 'fixPaypalIgnoreFlag', () => {
    let n = 0;
    for (const t of data.transactions) {
      if (t.instrument === 'PayPal' && isCredit(t) && t.amount > 0 && t.linkedTransactionId === null) {
        t.ignoreInBudget = false; n++;
      }
    }
    return n;
  });

  // 4. One-time: recurring transactions from negative-amount templates
  migrate(results, 'fixRecurringNegativeAmounts', () => {
    let n = 0;
    for (const t of data.transactions) {
      if (t.source !== 'recurring') continue;
      const tmpl = data.recurringTemplates.find((r) => String(r.id) === t.sourceRef);
      if (tmpl && tmpl.amount < 0 && t.amount > 0) {
        t.amount = -Math.abs(t.amount); t.ignoreInBudget = false; n++;
      }
    }
    return n;
  });

  // 5. (every launch, idempotent) Amazon: extract order# from descriptor into sourceRef
  {
    let n = 0;
    for (const t of data.transactions) {
      if (t.source === 'amazon_paste' && t.sourceRef === 'paste') {
        const m = t.descriptor.match(/#([\d-]+)$/);
        if (m) { t.sourceRef = m[1]; n++; }
      }
    }
    if (n > 0) results.push({ id: 'amazonSourceRef', changed: n });
  }

  // 6. One-time: stale Amazon refund records zero out the original payment
  migrate(results, 'migrateStaleAmazonRefunds', () => {
    let n = 0;
    const staleRefundTxns = data.transactions.filter(
      (t) => t.source === 'amazon_payment' && t.amount > 0 && isCredit(t) && (t.comment ?? '').includes('Refund'),
    );
    const refundStaleIds = new Set<number>();
    const refundsByOrder = new Map<string, typeof staleRefundTxns>();
    for (const r of staleRefundTxns) {
      const arr = refundsByOrder.get(r.sourceRef) ?? [];
      arr.push(r);
      refundsByOrder.set(r.sourceRef, arr);
    }
    for (const [orderNum, refunds] of refundsByOrder) {
      const originals = data.transactions.filter(
        (t) => t.source === 'amazon_payment' && t.sourceRef === orderNum && t.amount > 0 && !refunds.some((r) => r.id === t.id),
      );
      for (const orig of originals) { orig.amount = 0; orig.ignoreInBudget = true; n++; }
      for (const r of refunds) refundStaleIds.add(r.id);
      n += refunds.length;
    }
    if (refundStaleIds.size > 0) {
      data.transactions = data.transactions.filter((t) => !refundStaleIds.has(t.id));
      data.transactionSplits = data.transactionSplits.filter((s) => !refundStaleIds.has(s.transactionId));
    }
    return n;
  });

  // 7. One-time: remove zero-amount transactions (keeps intentionally-zeroed Amazon orders).
  // Parsers now drop zero-amount rows at import so this never needs to run again.
  migrate(results, 'removeZeroAmountTxns', () => {
    const before = data.transactions.length;
    data.transactions = data.transactions.filter(
      (t) => t.amount !== 0 || ((t.source === 'amazon_payment' || t.source === 'amazon_order') && isCredit(t)),
    );
    return before - data.transactions.length;
  });

  // 7b. One-time: remove duplicate PayPal-linked re-imports (same date+amount+sourceRef, keep lowest id)
  migrate(results, 'dedupePaypalReimports', () => {
    const sourceKeys = new Map<string, number>();
    const dupIds = new Set<number>();
    for (const t of [...data.transactions].sort((a, b) => a.id - b.id)) {
      if (!isPaypalLinked(t)) continue;
      const key = `${t.txnDate}|${t.sourceRef}|${t.amount}`;
      if (sourceKeys.has(key)) dupIds.add(t.id); else sourceKeys.set(key, t.id);
    }
    if (dupIds.size === 0) return 0;
    const before = data.transactions.length;
    data.transactions = data.transactions.filter((t) => !dupIds.has(t.id));
    data.transactionSplits = data.transactionSplits.filter((s) => !dupIds.has(s.transactionId));
    return before - data.transactions.length;
  });

  // 8a. One-time: remove bank_csv duplicates from overlapping statements
  migrate(results, 'deduplicateBankCsvTxns', () => {
    const normInst2 = (s: string) => s.split(' - ')[0].trim().toLowerCase();
    const normDesc2 = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();
    const splitsByTxnId = new Map<number, boolean>();
    for (const s of data.transactionSplits) splitsByTxnId.set(s.transactionId, true);
    const isCat = (t: Transaction) => t.categoryId != null || splitsByTxnId.has(t.id);

    const bankTxns = [...data.transactions].filter((t) => t.source === 'bank_csv' && t.instrument).sort((a, b) => a.id - b.id);
    const csvDupIds = new Set<number>();
    const seen2: { date: string; amount: number; instrument: string; desc: string; id: number }[] = [];

    for (const t of bankTxns) {
      if (csvDupIds.has(t.id)) continue;
      const date = t.originalTxnDate ?? t.txnDate;
      const inst = normInst2(t.instrument);
      const desc = normDesc2(t.descriptor);
      let foundDup = false;
      for (const s of seen2) {
        if (s.amount !== t.amount || s.instrument !== inst || s.date !== date) continue;
        const minLen = Math.min(desc.length, s.desc.length);
        if (minLen < 6) continue;
        if (desc.slice(0, 6) !== s.desc.slice(0, 6)) continue;
        const tCat = isCat(t);
        const sCat = isCat(data.transactions.find((x) => x.id === s.id)!);
        if (!tCat && sCat) {
          csvDupIds.add(t.id);
        } else if (tCat && !sCat) {
          csvDupIds.add(s.id);
          seen2.splice(seen2.indexOf(s), 1);
          seen2.push({ date, amount: t.amount, instrument: inst, desc, id: t.id });
        } else if (desc.length > s.desc.length) {
          csvDupIds.add(s.id);
          seen2.splice(seen2.indexOf(s), 1);
          seen2.push({ date, amount: t.amount, instrument: inst, desc, id: t.id });
        } else {
          csvDupIds.add(t.id);
        }
        foundDup = true;
        break;
      }
      if (!foundDup) seen2.push({ date, amount: t.amount, instrument: inst, desc, id: t.id });
    }
    if (csvDupIds.size > 0) {
      data.transactions = data.transactions.filter((t) => !csvDupIds.has(t.id));
      data.transactionSplits = data.transactionSplits.filter((s) => !csvDupIds.has(s.transactionId));
    }
    return csvDupIds.size;
  });

  // 8c. One-time: remove copies of the same card charge that Scotia renamed between statements
  // ("penna co" / "sp penna co."), which import-time duplicate detection used to miss.
  migrate(results, REMOVE_RENAMED_DUPLICATES, () => removeExistingDuplicates(data));

  // 8b. One-time: strip " - identifier" suffixes from instrument names
  migrate(results, 'stripInstrumentIdentifiers', () => {
    let n = 0;
    for (const t of data.transactions) {
      if (t.instrument && t.instrument.includes(' - ')) { t.instrument = t.instrument.split(' - ')[0].trim(); n++; }
    }
    return n;
  });

  // 8. One-time: zero out amazon payments for cancelled/returned orders (addAmazonOrders handles new ones)
  migrate(results, 'zeroCancelledAmazonOrders', () => {
    let n = 0;
    const cancelledOrderNums = new Set(
      (data.amazonOrders ?? []).filter((o) => o.status === 'returned' || o.status === 'cancelled').map((o) => o.orderNum),
    );
    for (const t of data.transactions) {
      if ((t.source === 'amazon_payment' || t.source === 'amazon_order') &&
          t.sourceRef && cancelledOrderNums.has(t.sourceRef) && t.amount > 0) {
        t.amount = 0; t.ignoreInBudget = true; n++;
      }
    }
    return n;
  });

  // 10a-pre. rename legacy instrument names
  migrate(results, 'normalizeInstrumentNames', () => {
    let n = 0;
    for (const t of data.transactions) {
      if (t.instrument === 'Card') { t.instrument = 'Scotiabank Credit Card CSV'; n++; }
      else if (t.instrument === 'Chequing') { t.instrument = 'Scotiabank Chequing CSV'; n++; }
    }
    return n;
  });

  // 10a. delete all savings schedules
  migrate(results, 'deleteAllSavingsSchedules', () => {
    const n = data.savingsSchedules.length;
    data.savingsSchedules = [];
    return n;
  });

  // 11. apply all existing split rules to matching transactions
  migrate(results, 'applySplitRules', () => {
    let n = 0;
    const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();
    for (const rule of data.categoryRules) {
      if (!rule.splits || rule.splits.length < 2) continue;
      const ruleNorm = norm(rule.pattern);
      for (const txn of data.transactions) {
        const txnNorm = norm(txn.descriptor);
        const descMatch = rule.matchType === 'exact' ? txnNorm === ruleNorm : txnNorm.includes(ruleNorm);
        const amountOk = rule.amountMatch == null || Math.abs(rule.amountMatch - txn.amount) < 0.01;
        if (!descMatch || !amountOk) continue;
        data.transactionSplits = data.transactionSplits.filter((s) => s.transactionId !== txn.id);
        for (const s of rule.splits) {
          const amt = s.percent != null ? txn.amount * s.percent / 100 : (s.amount ?? 0);
          data.transactionSplits.push({ id: nextId(), transactionId: txn.id, categoryId: s.categoryId, amount: amt });
        }
        n++;
      }
    }
    return n;
  });

  // 12. bank CSV credits stored negative
  migrate(results, 'bankCsvCreditsNegative', () => {
    let n = 0;
    for (const t of data.transactions) {
      if (t.source === 'bank_csv' && isCredit(t) && t.amount > 0) { t.amount = -t.amount; n++; }
    }
    return n;
  });

  // 14. repair references to categories that no longer exist (old deletes left them dangling)
  migrate(results, 'repairOrphanCategoryRefs', () => {
    const valid = new Set(data.categories.map((c) => c.id));
    let n = 0;
    for (const t of data.transactions) {
      if (t.categoryId != null && !valid.has(t.categoryId)) { t.categoryId = null; n++; }
    }
    const before = data.budgets.length;
    data.budgets = data.budgets.filter((b) => valid.has(b.categoryId));
    n += before - data.budgets.length;
    const badSplitTxns = new Set(data.transactionSplits.filter((s) => !valid.has(s.categoryId)).map((s) => s.transactionId));
    if (badSplitTxns.size > 0) {
      data.transactionSplits = data.transactionSplits.filter((s) => !badSplitTxns.has(s.transactionId));
      for (const t of data.transactions) {
        if (badSplitTxns.has(t.id)) t.categoryId = null;
      }
      n += badSplitTxns.size;
    }
    const rulesBefore = data.categoryRules.length;
    data.categoryRules = data.categoryRules.filter(
      (r) => r.markTransfer || (valid.has(r.categoryId) && (r.splits ?? []).every((s) => valid.has(s.categoryId))),
    );
    n += rulesBefore - data.categoryRules.length;
    for (const rt of data.recurringTemplates) {
      if (rt.categoryId != null && !valid.has(rt.categoryId)) { rt.categoryId = null; n++; }
    }
    if (data.mortgage) {
      if (data.mortgage.paymentCategoryId != null && !valid.has(data.mortgage.paymentCategoryId)) { delete data.mortgage.paymentCategoryId; n++; }
      if (data.mortgage.prepaymentCategoryId != null && !valid.has(data.mortgage.prepaymentCategoryId)) { delete data.mortgage.prepaymentCategoryId; n++; }
    }
    return n;
  });

  // 15. recurring templates only generate from their start month (no backfill from the earliest txn)
  migrate(results, 'recurringStartMonth', () => {
    let n = 0;
    for (const tmpl of data.recurringTemplates) {
      if (tmpl.startMonth) continue;
      let earliest: string | null = null;
      for (const t of data.transactions) {
        if (t.source === 'recurring' && t.sourceRef === String(tmpl.id)) {
          const m = t.txnDate.slice(0, 7);
          if (earliest === null || m < earliest) earliest = m;
        }
      }
      tmpl.startMonth = earliest ?? currentMonthStr();
      n++;
    }
    return n;
  });

  // 16. feature flags / backup settings used to live in localStorage; they belong to the file
  migrate(results, 'moveLocalSettingsIntoFile', () => {
    const enabledRaw = readLocal('budget-app-backup-enabled');
    const countRaw = readLocal('budget-app-backup-count');
    const count = parseInt(countRaw ?? '', 10);
    data.backupSettings = {
      enabled: enabledRaw === 'false' ? false : true, // a missing value used to display as ON
      maxCount: Number.isFinite(count) && count > 0 ? count : 5,
    };
    const dir = readLocal('budget-app-backup-dir');
    if (dir && filePath) {
      try { localStorage.setItem(`kestl-backup-dir:${filePath}`, dir); } catch { /* ignore */ }
    }
    const ds: DisplaySettings = { ...getDisplaySettings() };
    const exp = readLocal('budget-app-experimental');
    const mort = readLocal('budget-app-show-mortgage-tab');
    const ai = readLocal('budget-app-txn-ai-lookup');
    if (exp !== null) ds.experimentalEnabled = exp === 'true';
    if (mort !== null) ds.showMortgageTab = mort === 'true';
    if (ai !== null) ds.txnAiLookupEnabled = ai === 'true';
    data.displaySettings = ds;
    return 1;
  });

  // 17. "Transfer - Do Not Count" starts out excluded from the off-budget spending total
  migrate(results, 'excludeTransferFromOffBudget', () => {
    let n = 0;
    for (const c of data.categories) {
      if (c.name.trim().replace(/\s+/g, ' ').toLowerCase() === 'transfer - do not count') { c.excludeFromOffBudget = true; n++; }
    }
    return n;
  });

  // 13. (every launch) backfill category colors for categories that don't have one yet
  for (const c of data.categories) {
    if (!c.color) { c.color = pickDistinctColor(data.categories); colorized++; }
  }
  if (colorized > 0) results.push({ id: 'backfillCategoryColors', changed: colorized });

  if (results.length > 0) {
    console.info('[startupCleanup]', results);
    await withoutUndo(persist);
  }
  return results;
}

// --- Categories ---
export async function addCategory(name: string): Promise<number> {
  pushUndoSnapshot('Add category');
  const id = nextId();
  const color = pickDistinctColor(data.categories);
  data.categories.push({ id, name, color });
  await persist();
  return id;
}

export interface CategoryUsage {
  transactions: number;
  splits: number;
  budgets: number;
  rules: number;
  recurring: number;
  experimental: number;
  mortgage: number;
  total: number;
}

export function getCategoryUsage(id: number): CategoryUsage {
  const transactions = data.transactions.filter((t) => t.categoryId === id).length;
  const splits = data.transactionSplits.filter((s) => s.categoryId === id).length;
  const budgets = data.budgets.filter((b) => b.categoryId === id).length;
  const rules = data.categoryRules.filter((r) => r.categoryId === id || (r.splits ?? []).some((x) => x.categoryId === id)).length;
  const recurring = data.recurringTemplates.filter((r) => r.categoryId === id).length;
  const experimental = (data.experimentalBudgets ?? []).reduce(
    (n, b) => n + b.items.filter((i) => i.categoryId === id).length, 0);
  const mortgage = data.mortgage && (data.mortgage.paymentCategoryId === id || data.mortgage.prepaymentCategoryId === id) ? 1 : 0;
  return {
    transactions, splits, budgets, rules, recurring, experimental, mortgage,
    total: transactions + splits + budgets + rules + recurring + experimental + mortgage,
  };
}

/** Categories that may be chosen for new assignments (archived ones are hidden). */
export function getSelectableCategories(d: AppData = data): Category[] {
  return d.categories.filter((c) => !c.archived);
}

/** Only categories with no references can be deleted; otherwise archive or merge them. */
export async function deleteCategory(id: number): Promise<void> {
  if (getCategoryUsage(id).total > 0) throw new Error('Category is in use — archive or merge it instead');
  pushUndoSnapshot('Delete category');
  data.categories = data.categories.filter((c) => c.id !== id);
  await persist();
}

export async function setCategoryRollover(id: number, on: boolean): Promise<void> {
  pushUndoSnapshot(on ? 'Turn on rollover' : 'Turn off rollover');
  const cat = data.categories.find((c) => c.id === id);
  if (!cat) return;
  cat.rollover = on || undefined;
  // Start from the current month so turning it on doesn't pull in years of history.
  cat.rolloverStartMonth = on ? currentMonthStr() : undefined;
  await persist();
}

export async function setCategoryExcludeFromOffBudget(id: number, on: boolean): Promise<void> {
  pushUndoSnapshot(on ? 'Exclude from off-budget total' : 'Include in off-budget total');
  const cat = data.categories.find((c) => c.id === id);
  if (cat) { cat.excludeFromOffBudget = on || undefined; await persist(); }
}

export async function setCategoryArchived(id: number, archived: boolean): Promise<void> {
  pushUndoSnapshot(archived ? 'Archive category' : 'Unarchive category');
  const cat = data.categories.find((c) => c.id === id);
  if (cat) { cat.archived = archived || undefined; await persist(); }
}

/**
 * Merge one or more source categories into a target category. Transactions, splits, rules,
 * budgets (amounts are added), recurring templates, sandbox budgets, mortgage links, AI feedback
 * and savings-bucket links are all re-pointed. Source categories are then deleted.
 */
export async function mergeCategories(sourceIds: number[], targetId: number): Promise<void> {
  pushUndoSnapshot('Merge categories');
  const sources = sourceIds.filter((id) => id !== targetId);
  const sourceSet = new Set(sources);
  const target = data.categories.find((c) => c.id === targetId);

  const affectedTransactionIds: number[] = [];
  const affectedSplitIds: number[] = [];
  const affectedRuleIds: number[] = [];
  const affectedBudgetIds: number[] = [];
  const affectedRecurringIds: number[] = [];

  for (const t of data.transactions) {
    if (t.categoryId != null && sourceSet.has(t.categoryId)) {
      affectedTransactionIds.push(t.id);
      t.categoryId = targetId;
    }
  }
  for (const s of data.transactionSplits) {
    if (sourceSet.has(s.categoryId)) { affectedSplitIds.push(s.id); s.categoryId = targetId; }
  }
  for (const r of data.categoryRules) {
    let ruleAffected = false;
    if (sourceSet.has(r.categoryId)) { r.categoryId = targetId; ruleAffected = true; }
    if (r.splits) {
      for (const sp of r.splits) {
        if (sourceSet.has(sp.categoryId)) { sp.categoryId = targetId; ruleAffected = true; }
      }
    }
    if (ruleAffected) affectedRuleIds.push(r.id);
  }

  // Budgets: per month, add source amounts into the target budget (never drop amounts).
  const months = new Set(data.budgets.filter((b) => sourceSet.has(b.categoryId)).map((b) => b.month));
  for (const month of months) {
    const srcBudgets = data.budgets.filter((b) => b.month === month && sourceSet.has(b.categoryId));
    let tgt = data.budgets.find((b) => b.month === month && b.categoryId === targetId);
    for (const sb of srcBudgets) {
      affectedBudgetIds.push(sb.id);
      if (tgt) {
        tgt.targetAmount = Math.round((tgt.targetAmount + sb.targetAmount) * 100) / 100;
        data.budgets = data.budgets.filter((b) => b.id !== sb.id);
      } else {
        sb.categoryId = targetId;
        tgt = sb;
      }
    }
  }

  for (const rt of data.recurringTemplates) {
    if (rt.categoryId != null && sourceSet.has(rt.categoryId)) { rt.categoryId = targetId; affectedRecurringIds.push(rt.id); }
  }

  const targetName = target?.name ?? '';
  for (const eb of data.experimentalBudgets ?? []) {
    const merged = new Map<number, ExperimentalBudgetItem>();
    for (const item of eb.items) {
      if (sourceSet.has(item.categoryId)) { item.categoryId = targetId; item.categoryName = targetName || item.categoryName; }
      const prev = merged.get(item.categoryId);
      if (prev) prev.targetAmount = Math.round((prev.targetAmount + item.targetAmount) * 100) / 100;
      else merged.set(item.categoryId, item);
    }
    eb.items = [...merged.values()];
  }

  if (data.mortgage) {
    if (data.mortgage.paymentCategoryId != null && sourceSet.has(data.mortgage.paymentCategoryId)) data.mortgage.paymentCategoryId = targetId;
    if (data.mortgage.prepaymentCategoryId != null && sourceSet.has(data.mortgage.prepaymentCategoryId)) data.mortgage.prepaymentCategoryId = targetId;
  }

  for (const f of data.aiCategoryFeedback ?? []) {
    if (sourceSet.has(f.suggestedCategoryId)) f.suggestedCategoryId = targetId;
    if (f.acceptedCategoryId != null && sourceSet.has(f.acceptedCategoryId)) f.acceptedCategoryId = targetId;
  }
  if (data.merchantLookups) {
    for (const r of Object.values(data.merchantLookups)) {
      if (r.category.categoryId != null && sourceSet.has(r.category.categoryId)) r.category.categoryId = targetId;
    }
    data.merchantLookups = { ...data.merchantLookups };
  }

  if (target && target.savingsBucketId == null) {
    const inherit = data.categories.find((c) => sourceSet.has(c.id) && c.savingsBucketId != null);
    if (inherit) target.savingsBucketId = inherit.savingsBucketId;
  }

  if (!data.mergeLogs) data.mergeLogs = [];
  data.mergeLogs.push({
    id: nextId(),
    timestamp: new Date().toISOString(),
    targetCategoryId: targetId,
    sourceCategoryIds: sources,
    affectedTransactionIds,
    affectedSplitIds,
    affectedRuleIds,
    affectedBudgetIds,
    affectedRecurringIds,
  });

  data.categories = data.categories.filter((c) => !sourceSet.has(c.id));
  data.budgets = data.budgets.filter((b) => !sourceSet.has(b.categoryId));
  await persist();
}

// --- Category Rules ---
export async function addCategoryRule(rule: Omit<CategoryRule, 'id'>): Promise<number> {
  pushUndoSnapshot('Add category rule');
  const id = nextId();
  data.categoryRules.push({ id, ...rule });
  await persist();
  return id;
}

export async function updateCategoryRule(id: number, updates: Partial<Omit<CategoryRule, 'id'>>): Promise<void> {
  pushUndoSnapshot('Update category rule');
  const idx = data.categoryRules.findIndex((r) => r.id === id);
  if (idx === -1) return;
  data.categoryRules = data.categoryRules.map((r) => r.id === id ? { ...r, ...updates } : r);
  await persist();
}

export async function deleteCategoryRule(id: number): Promise<void> {
  pushUndoSnapshot('Delete category rule');
  data.categoryRules = data.categoryRules.filter((r) => r.id !== id);
  await persist();
}

export async function reorderCategoryRules(orderedIds: number[]): Promise<void> {
  pushUndoSnapshot('Reorder category rules');
  const ruleMap = new Map(data.categoryRules.map((r) => [r.id, r]));
  data.categoryRules = orderedIds.map((id) => ruleMap.get(id)!).filter(Boolean);
  await persist();
}

export async function setSavingsLoanAmount(amount: number): Promise<void> {
  pushUndoSnapshot('Set savings loan amount');
  data.savingsLoanAmount = amount;
  await persist();
}

// --- Budget Groups ---
export async function addBudgetGroup(name: string): Promise<number> {
  pushUndoSnapshot('Add budget group');
  const maxOrder = data.budgetGroups.reduce((m, g) => Math.max(m, g.sortOrder), -1);
  const id = nextId();
  data.budgetGroups.push({ id, name, sortOrder: maxOrder + 1 });
  await persist();
  return id;
}

export async function updateBudgetGroup(id: number, updates: Partial<BudgetGroup>): Promise<void> {
  pushUndoSnapshot('Update budget group');
  const g = data.budgetGroups.find((x) => x.id === id);
  if (g) Object.assign(g, updates);
  await persist();
}

export async function deleteBudgetGroup(id: number): Promise<void> {
  pushUndoSnapshot('Delete budget group');
  data.budgetGroups = data.budgetGroups.filter((g) => g.id !== id);
  for (const b of data.budgets) {
    if (b.groupId === id) b.groupId = null;
  }
  await persist();
}

// --- Budgets ---
export async function upsertBudget(month: string, categoryId: number, targetAmount: number, groupId?: number | null, sortOrder?: number): Promise<void> {
  const existing = data.budgets.find((b) => b.month === month && b.categoryId === categoryId);
  if (existing) {
    existing.targetAmount = targetAmount;
    if (groupId !== undefined) existing.groupId = groupId;
    if (sortOrder !== undefined) existing.sortOrder = sortOrder;
  } else {
    const group = groupId ?? null;
    const inGroup = data.budgets.filter((b) => b.month === month && (b.groupId ?? null) === group);
    const maxOrder = inGroup.reduce((m, b) => Math.max(m, b.sortOrder ?? 0), -1);
    const order = sortOrder ?? maxOrder + 1;
    data.budgets.push({ id: nextId(), month, categoryId, targetAmount, groupId: group, sortOrder: order });
  }
  await persist();
}

export async function reorderBudgetsInGroup(month: string, groupId: number | null, categoryIdsInOrder: number[]): Promise<void> {
  pushUndoSnapshot('Reorder budgets in group');
  for (let i = 0; i < categoryIdsInOrder.length; i++) {
    const b = data.budgets.find((x) => x.month === month && x.categoryId === categoryIdsInOrder[i]);
    if (b) {
      b.groupId = groupId;
      b.sortOrder = i;
    }
  }
  await persist();
}

export async function updateBudgetNote(month: string, categoryId: number, note: string): Promise<void> {
  pushUndoSnapshot('Update budget note');
  const b = data.budgets.find((x) => x.month === month && x.categoryId === categoryId);
  if (b) { b.note = note || undefined; await persist(); }
}

export async function deleteBudget(month: string, categoryId: number): Promise<void> {
  pushUndoSnapshot('Delete budget');
  data.budgets = data.budgets.filter((b) => !(b.month === month && b.categoryId === categoryId));
  await persist();
}

export async function copyBudgetToMonths(sourceMonth: string, targetMonths: string[]): Promise<void> {
  pushUndoSnapshot('Copy budget to months');
  const source = data.budgets.filter((b) => b.month === sourceMonth);
  for (const target of targetMonths) {
    // Remove all existing budget entries for the target month
    data.budgets = data.budgets.filter((b) => b.month !== target);
    // Copy each entry from the source month
    for (const b of source) {
      data.budgets.push({
        id: nextId(),
        month: target,
        categoryId: b.categoryId,
        targetAmount: b.targetAmount,
        groupId: b.groupId ?? null,
        sortOrder: b.sortOrder,
      });
    }
  }
  await persist();
}

/** Remember deleted recurring occurrences so they are not regenerated. */
function tombstoneRecurring(txns: Transaction[]) {
  for (const t of txns) {
    if (t.source !== 'recurring') continue;
    const tmpl = data.recurringTemplates.find((r) => String(r.id) === t.sourceRef);
    if (!tmpl) continue;
    const m = t.txnDate.slice(0, 7);
    const skipped = tmpl.skippedMonths ?? [];
    if (!skipped.includes(m)) tmpl.skippedMonths = [...skipped, m].sort();
  }
}

// --- Transactions ---
export async function addTransaction(txn: Omit<Transaction, 'id'>): Promise<number> {
  pushUndoSnapshot('Add transaction');
  const id = nextId();
  data.transactions.push({ id, ...txn });
  await persist();
  return id;
}

export async function updateTransaction(id: number, updates: Partial<Transaction>): Promise<void> {
  pushUndoSnapshot('Update transaction');
  const txn = data.transactions.find((t) => t.id === id);
  if (txn) Object.assign(txn, updates);
  await persist();
}

export async function bulkAddTransactions(txns: Omit<Transaction, 'id'>[]): Promise<number[]> {
  pushUndoSnapshot('Bulk add transactions');
  const ids: number[] = [];
  for (const t of txns) {
    const id = nextId();
    data.transactions.push({ id, ...t });
    ids.push(id);
  }
  await persist();
  return ids;
}

export async function deleteTransactions(ids: number[]): Promise<void> {
  pushUndoSnapshot('Delete transactions');
  const idSet = new Set(ids);
  tombstoneRecurring(data.transactions.filter((t) => idSet.has(t.id)));
  data.transactions = data.transactions.filter((t) => !idSet.has(t.id));
  data.transactionSplits = data.transactionSplits.filter((s) => !idSet.has(s.transactionId));
  await persist();
}

/** Permanently delete transactions (and their splits) for a given month, optionally filtered by instrument.
 *  When instrument is 'PayPal', reverts PayPal-linked bank transactions to their original state
 *  instead of deleting them, and deletes any remaining pure PayPal-instrument transactions.
 *  Does not affect category rules. */
export async function purgeTransactionsByMonth(month: string, instrument?: string): Promise<number> {
  pushUndoSnapshot('Purge transactions by month');
  const prefix = `${month}-`;
  let affected = 0;

  if (instrument === 'PayPal') {
    const inMonth = data.transactions.filter((t) => t.txnDate.startsWith(prefix));

    for (const t of inMonth) {
      if (isPaypalLinked(t)) {
        // Clear PayPal-linked state; descriptor already contains the enriched PayPal info
        t.linkedTransactionId = null;
        t.categoryId = null;
        affected++;
      } else if (t.instrument === 'PayPal') {
        tombstoneRecurring([t]);
        data.transactions = data.transactions.filter((x) => x.id !== t.id);
        data.transactionSplits = data.transactionSplits.filter((s) => s.transactionId !== t.id);
        affected++;
      }
    }
  } else {
    const toDelete = data.transactions
      .filter((t) => t.txnDate.startsWith(prefix) && (!instrument || t.instrument === instrument))
      .map((t) => t.id);
    const ids = new Set(toDelete);
    tombstoneRecurring(data.transactions.filter((t) => ids.has(t.id)));
    data.transactions = data.transactions.filter((t) => !ids.has(t.id));
    data.transactionSplits = data.transactionSplits.filter((s) => !ids.has(s.transactionId));
    affected = toDelete.length;
  }

  await persist();
  return affected;
}

/** Permanently delete all transactions (and their splits) for a given instrument, across all months. */
export async function purgeTransactionsByInstrument(instrument: string): Promise<number> {
  pushUndoSnapshot('Purge transactions by instrument');
  const toDelete = data.transactions
    .filter((t) => t.instrument === instrument)
    .map((t) => t.id);
  const ids = new Set(toDelete);
  tombstoneRecurring(data.transactions.filter((t) => ids.has(t.id)));
  data.transactions = data.transactions.filter((t) => !ids.has(t.id));
  data.transactionSplits = data.transactionSplits.filter((s) => !ids.has(s.transactionId));
  await persist();
  return toDelete.length;
}

// --- Transaction Splits ---
export async function setSplits(transactionId: number, splits: Omit<TransactionSplit, 'id' | 'transactionId'>[]): Promise<void> {
  pushUndoSnapshot('Set splits');
  data.transactionSplits = data.transactionSplits.filter((s) => s.transactionId !== transactionId);
  for (const s of splits) {
    data.transactionSplits.push({ id: nextId(), transactionId, ...s });
  }
  await persist();
}

/** Replace the splits of many transactions with ONE save. */
export async function setSplitsBulk(
  entries: { transactionId: number; splits: Omit<TransactionSplit, 'id' | 'transactionId'>[] }[],
): Promise<void> {
  if (entries.length === 0) return;
  pushUndoSnapshot('Set splits');
  const ids = new Set(entries.map((e) => e.transactionId));
  data.transactionSplits = data.transactionSplits.filter((s) => !ids.has(s.transactionId));
  for (const e of entries) {
    for (const sp of e.splits) data.transactionSplits.push({ id: nextId(), transactionId: e.transactionId, ...sp });
  }
  await persist();
}

export async function clearSplits(transactionId: number): Promise<void> {
  pushUndoSnapshot('Clear splits');
  data.transactionSplits = data.transactionSplits.filter((s) => s.transactionId !== transactionId);
  await persist();
}

// --- Savings ---
export async function addSavingsBucket(name: string): Promise<number> {
  pushUndoSnapshot('Add savings bucket');
  const id = nextId();
  data.savingsBuckets.push({ id, name });
  await persist();
  return id;
}

export async function deleteSavingsBucket(id: number): Promise<void> {
  pushUndoSnapshot('Delete savings bucket');
  data.savingsBuckets = data.savingsBuckets.filter((b) => b.id !== id);
  for (const c of data.categories) if (c.savingsBucketId === id) c.savingsBucketId = undefined;
  data.savingsEntries = data.savingsEntries.filter((e) => e.bucketId !== id);
  data.savingsSchedules = data.savingsSchedules.filter((s) => s.bucketId !== id);
  await persist();
}

export async function addSavingsEntry(entry: Omit<SavingsEntry, 'id'>): Promise<void> {
  pushUndoSnapshot('Add savings entry');
  data.savingsEntries.push({ id: nextId(), ...entry });
  await persist();
}

export async function bulkAddSavingsEntries(entries: Omit<SavingsEntry, 'id'>[]): Promise<void> {
  if (entries.length === 0) return;
  pushUndoSnapshot('Add savings entries');
  for (const e of entries) data.savingsEntries.push({ id: nextId(), ...e });
  await persist();
}

export async function deleteSavingsEntry(id: number): Promise<void> {
  pushUndoSnapshot('Delete savings entry');
  data.savingsEntries = data.savingsEntries.filter((e) => e.id !== id);
  await persist();
}

/** Remove all auto-generated schedule entries. Use this when switching to transaction-based contributions. */
export async function clearAutoScheduleEntries(): Promise<number> {
  pushUndoSnapshot('Clear auto schedule entries');
  const before = data.savingsEntries.length;
  data.savingsEntries = data.savingsEntries.filter((e) => e.source !== 'auto_schedule');
  const removed = before - data.savingsEntries.length;
  if (removed > 0) await persist();
  return removed;
}

export async function addSavingsSchedule(sched: Omit<SavingsSchedule, 'id'>): Promise<void> {
  pushUndoSnapshot('Add savings schedule');
  data.savingsSchedules.push({ id: nextId(), ...sched });
  await persist();
}

export async function updateSavingsSchedule(id: number, updates: Partial<SavingsSchedule>): Promise<void> {
  pushUndoSnapshot('Update savings schedule');
  const s = data.savingsSchedules.find((x) => x.id === id);
  if (s) Object.assign(s, updates);
  await persist();
}

export async function deleteSavingsSchedule(id: number): Promise<void> {
  pushUndoSnapshot('Delete savings schedule');
  data.savingsSchedules = data.savingsSchedules.filter((s) => s.id !== id);
  await persist();
}

export async function deleteAllSavingsSchedules(): Promise<number> {
  pushUndoSnapshot('Delete all savings schedules');
  const count = data.savingsSchedules.length;
  data.savingsSchedules = [];
  if (count > 0) await persist();
  return count;
}

// --- Recurring Templates ---
export async function addRecurringTemplate(t: Omit<RecurringTemplate, 'id'>): Promise<number> {
  pushUndoSnapshot('Add recurring template');
  const id = nextId();
  data.recurringTemplates.push({ id, ...t, startMonth: t.startMonth ?? currentMonthStr() });
  await persist();
  return id;
}

export async function deleteRecurringTemplate(id: number): Promise<void> {
  pushUndoSnapshot('Delete recurring template');
  data.recurringTemplates = data.recurringTemplates.filter((t) => t.id !== id);
  await persist();
}

export async function updateRecurringTemplate(id: number, updates: Partial<RecurringTemplate>): Promise<void> {
  pushUndoSnapshot('Update recurring template');
  const t = data.recurringTemplates.find((x) => x.id === id);
  if (t) {
    const wasActive = t.active;
    Object.assign(t, updates);
    if (updates.active !== undefined && updates.active !== wasActive) {
      const cur = currentMonthStr();
      if (!updates.active) {
        t.pausedAt = cur;
      } else if (t.pausedAt) {
        // Resuming: months strictly after pausedAt up to the month BEFORE the current one are skipped.
        const skipped = new Set(t.skippedMonths ?? []);
        const last = prevMonth(cur);
        for (const m of monthsBetween(nextMonthStr(t.pausedAt), last)) skipped.add(m);
        t.skippedMonths = [...skipped].sort();
        t.pausedAt = undefined;
      }
    }
  }
  await persist();
}

// --- Amazon Orders (reference data for product names) ---

export function getAmazonOrder(orderNum: string): AmazonOrder | undefined {
  return (data.amazonOrders ?? []).find((o) => o.orderNum === orderNum);
}

export async function addAmazonOrders(orders: AmazonOrder[]): Promise<{ added: number; linked: number }> {
  pushUndoSnapshot('Add amazon orders');
  if (!data.amazonOrders) data.amazonOrders = [];
  const existingMap = new Map(data.amazonOrders.map((o) => [o.orderNum, o]));

  let added = 0;
  const toBackfill: AmazonOrder[] = [];
  const toZeroOut: AmazonOrder[] = []; // returned/cancelled orders that need existing payments zeroed

  for (const order of orders) {
    const existing = existingMap.get(order.orderNum);
    const isReturnedOrCancelled = order.status === 'returned' || order.status === 'cancelled';
    if (!existing) {
      data.amazonOrders.push(order);
      existingMap.set(order.orderNum, order);
      added++;
      if (order.itemName) toBackfill.push(order);
      if (isReturnedOrCancelled) toZeroOut.push(order);
    } else {
      if (order.itemName && order.itemName !== existing.itemName) {
        existing.itemName = order.itemName;
        toBackfill.push(existing);
      }
      if (order.status !== existing.status) {
        const wasReturned = existing.status === 'returned' || existing.status === 'cancelled';
        existing.status = order.status;
        if (isReturnedOrCancelled && !wasReturned) toZeroOut.push(existing);
      }
    }
  }

  // Backfill descriptors for added/updated orders
  let linked = 0;
  for (const order of toBackfill) {
    const txns = data.transactions.filter(
      (t) => (t.source === 'amazon_payment' || t.source === 'amazon_order') && t.sourceRef === order.orderNum,
    );
    for (const t of txns) {
      t.descriptor = `Amazon | ${order.itemName} | #${order.orderNum}`;
      linked++;
    }
  }

  // Zero out transactions for returned/cancelled orders
  for (const order of toZeroOut) {
    const txns = data.transactions.filter(
      (t) => (t.source === 'amazon_payment' || t.source === 'amazon_order') &&
        t.sourceRef === order.orderNum && t.amount > 0,
    );
    for (const t of txns) {
      t.amount = 0;
      t.ignoreInBudget = true;
    }
  }

  await persist();
  return { added, linked };
}

// --- Split Templates ---
export async function addSplitTemplate(template: Omit<SplitTemplate, 'id'>): Promise<void> {
  pushUndoSnapshot('Add split template');
  const id = nextId();
  data.splitTemplates = data.splitTemplates ?? [];
  data.splitTemplates.push({ id, ...template });
  await persist();
}

// --- Utility: persist without generating new data (for logic modules) ---
export async function persistData(): Promise<void> {
  await persist();
}

// --- AI Settings ---
export function getAISettings(): AISettings {
  return data.aiSettings ?? { ollamaUrl: 'http://localhost:11434', model: 'qwen2.5:7b' };
}

export async function updateAISettings(settings: AISettings): Promise<void> {
  data.aiSettings = settings;
  await persist();
}

// --- Merchant types (AI labels used by category suggestions) ---
export function getMerchantTypes(): Record<string, string> {
  return data.merchantTypes ?? {};
}

export async function addMerchantTypes(labels: Record<string, string>): Promise<void> {
  if (Object.keys(labels).length === 0) return;
  // New object so memos keyed on it re-run.
  data.merchantTypes = { ...data.merchantTypes, ...labels };
  await persist();
}

/** The user picked a merchant type by hand (? lookup window). */
export async function setMerchantType(merchantKey: string, type: string): Promise<void> {
  pushUndoSnapshot('Set merchant type');
  data.merchantTypes = { ...data.merchantTypes, [merchantKey]: type };
  await persist();
}

// --- ? lookups (one saved result per merchant) ---
const MAX_MERCHANT_LOOKUPS = 1000;

export function getMerchantLookup(merchantKey: string): LookupReport | undefined {
  return data.merchantLookups?.[merchantKey];
}

/** Save a finished lookup. Never touches any transaction's category. */
export async function saveMerchantLookup(merchantKey: string, report: LookupReport): Promise<void> {
  const next = { ...data.merchantLookups, [merchantKey]: report };
  const keys = Object.keys(next);
  if (keys.length > MAX_MERCHANT_LOOKUPS) {
    keys.sort((a, b) => next[a].at.localeCompare(next[b].at));
    for (const k of keys.slice(0, keys.length - MAX_MERCHANT_LOOKUPS)) delete next[k];
  }
  data.merchantLookups = next;
  await persist();
}

export function getColorThresholds(): ColorThresholds {
  return data.colorThresholds ?? { ...DEFAULT_COLOR_THRESHOLDS };
}

export async function setColorThresholds(t: ColorThresholds): Promise<void> {
  data.colorThresholds = t;
  await persist();
}

export function getDisplaySettings(): DisplaySettings {
  return { ...DEFAULT_DISPLAY_SETTINGS, ...data.displaySettings };
}

export async function updateDisplaySettings(patch: Partial<DisplaySettings>): Promise<void> {
  data.displaySettings = { ...getDisplaySettings(), ...patch };
  await persist();
}

export function getBackupSettings(): BackupSettings {
  return { enabled: true, maxCount: 5, ...data.backupSettings };
}

export async function updateBackupSettings(patch: Partial<BackupSettings>): Promise<void> {
  data.backupSettings = { ...getBackupSettings(), ...patch };
  await persist();
}

// --- AI Category Feedback ---
export function getAICategoryFeedback(): AICategoryFeedback[] {
  return data.aiCategoryFeedback ?? [];
}

/**
 * Record, for each suggestion that was on offer, whether the category the user picked matched it.
 * Call when the user categorizes a transaction that had a history and/or ? lookup suggestion.
 */
export async function logSuggestionOutcome(
  descriptor: string,
  chosenCategoryId: number | null,
  offered: { source: 'history' | 'ai'; categoryId: number }[],
): Promise<void> {
  if (offered.length === 0) return;
  const at = new Date().toISOString().slice(0, 10);
  const entries: AICategoryFeedback[] = offered.map((o) => ({
    descriptor: descriptor.toLowerCase(),
    suggestedCategoryId: o.categoryId,
    acceptedCategoryId: chosenCategoryId,
    outcome: o.categoryId === chosenCategoryId ? 'accepted' : 'rejected',
    source: o.source,
    at,
  }));
  data.aiCategoryFeedback = [...(data.aiCategoryFeedback ?? []), ...entries].slice(-500);
  await persist();
}

// --- Custom Parsers ---
export function getCustomParsers(): CustomParser[] {
  return data.customParsers ?? [];
}

export async function saveCustomParser(parser: CustomParser): Promise<void> {
  pushUndoSnapshot('Save custom parser');
  if (!data.customParsers) data.customParsers = [];
  const idx = data.customParsers.findIndex((p) => p.id === parser.id);
  if (idx >= 0) data.customParsers[idx] = parser;
  else data.customParsers.push(parser);
  await persist();
}

export async function deleteCustomParser(id: string): Promise<void> {
  pushUndoSnapshot('Delete custom parser');
  data.customParsers = (data.customParsers ?? []).filter((p) => p.id !== id);
  await persist();
}

/**
 * Execute a custom parser in an isolated Web Worker (no Tauri IPC access). Terminated after 10 s
 * so an infinite loop can't freeze the app. Rows are re-validated here in the main thread.
 */
export function executeCustomParser(
  code: string,
  text: string,
  filename: string,
): Promise<Omit<Transaction, 'id'>[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./workers/parserWorker.ts', import.meta.url), { type: 'module' });
    const finish = () => { clearTimeout(timer); worker.terminate(); };
    const timer = setTimeout(() => {
      finish();
      reject(new Error('Custom parser timed out after 10 seconds (infinite loop?)'));
    }, 10_000);
    worker.onmessage = (e: MessageEvent<{ ok: boolean; rows?: unknown; error?: string }>) => {
      finish();
      if (!e.data.ok) { reject(new Error(e.data.error ?? 'Parser failed')); return; }
      try { resolve(validateParsedRows(e.data.rows)); } catch (err) { reject(err); }
    };
    worker.onerror = (e) => {
      finish();
      reject(new Error(e.message || 'Custom parser crashed'));
    };
    worker.postMessage({ code, text, filename });
  });
}

function validateParsedRows(rows: unknown): Omit<Transaction, 'id'>[] {
  if (!Array.isArray(rows)) return [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] as Record<string, unknown>;
    if (typeof r?.txnDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.txnDate)) {
      throw new Error(`Row ${i + 1}: txnDate "${String(r?.txnDate)}" is not YYYY-MM-DD. Check your date parsing logic.`);
    }
    if (typeof r.amount !== 'number' || !Number.isFinite(r.amount)) {
      throw new Error(`Row ${i + 1}: amount "${String(r.amount)}" is not a finite number.`);
    }
    if (typeof r.descriptor !== 'string') {
      throw new Error(`Row ${i + 1}: descriptor must be a string.`);
    }
  }
  return rows as Omit<Transaction, 'id'>[];
}

// --- Experimental Budgets ---
export function getExperimentalBudgets(): ExperimentalBudget[] {
  return data.experimentalBudgets ?? [];
}

export async function saveExperimentalBudget(budget: Omit<ExperimentalBudget, 'id'> & { id?: number }): Promise<ExperimentalBudget> {
  pushUndoSnapshot('Save experimental budget');
  if (!data.experimentalBudgets) data.experimentalBudgets = [];
  if (budget.id != null) {
    const idx = data.experimentalBudgets.findIndex((b) => b.id === budget.id);
    if (idx >= 0) {
      const updated = { ...budget, id: budget.id! } as ExperimentalBudget;
      data.experimentalBudgets[idx] = updated;
      await persist();
      return updated;
    }
  }
  const nb: ExperimentalBudget = { ...budget, id: nextId() };
  data.experimentalBudgets.push(nb);
  await persist();
  return nb;
}

export async function deleteExperimentalBudget(id: number): Promise<void> {
  pushUndoSnapshot('Delete experimental budget');
  if (!data.experimentalBudgets) return;
  data.experimentalBudgets = data.experimentalBudgets.filter((b) => b.id !== id);
  await persist();
}

// --- Mortgage ---

export type PrepayFrequency = 'monthly' | 'biweekly' | 'semi-monthly' | 'annually' | 'semi-annually';

export interface MortgageConfig {
  outstandingBalance: number;
  originalAmount: number;
  startDate?: string; // ISO date
  annualRate: number; // decimal e.g. 0.055 for 5.5%
  paymentFrequency: 'monthly' | 'biweekly' | 'semi-monthly';
  regularPayment: number;
  lastBalanceDate?: string; // ISO date when outstanding balance was last set

  // Mortgage type
  mortgageType: 'variable' | 'fixed';
  maturityDate?: string; // for fixed mortgages
  rateChangeBehavior: 'change_payment' | 'change_payoff'; // default: change_payment

  // Category links
  paymentCategoryId?: number; // required - category for regular mortgage payments
  prepaymentCategoryId?: number; // optional - dedicated prepayment category

  // Regular prepayment schedule
  prepayAmount?: number;
  prepayFrequency?: PrepayFrequency;
}

export interface MortgageLedgerEntry {
  id: number;
  date: string; // ISO date
  type: 'opening_balance' | 'payment' | 'prepayment' | 'balance_reset';
  amount: number; // positive = reduction applied
  balance: number; // outstanding balance AFTER this entry
  interestPortion?: number; // for payment entries
  principalPortion?: number; // for payment entries
  notes?: string;
  linkedTransactionId?: number; // if sourced from main ledger
}

export function getMortgageConfig(): MortgageConfig | null {
  return data.mortgage ?? null;
}

export async function setMortgageConfig(config: MortgageConfig | null): Promise<void> {
  pushUndoSnapshot('Set mortgage config');
  if (config === null) {
    delete data.mortgage;
  } else {
    data.mortgage = config;
  }
  await persist();
}

export function getMortgageLedger(): MortgageLedgerEntry[] {
  return data.mortgageLedger ?? [];
}

export async function addMortgageLedgerEntry(
  entry: Omit<MortgageLedgerEntry, 'id'>,
): Promise<MortgageLedgerEntry> {
  if (!data.mortgageLedger) data.mortgageLedger = [];
  const id = data.nextId++;
  const saved: MortgageLedgerEntry = { ...entry, id };
  data.mortgageLedger.push(saved);
  data.mortgageLedger.sort((a, b) => a.date.localeCompare(b.date));
  await persist();
  return saved;
}

export async function deleteMortgageLedgerEntry(id: number): Promise<void> {
  pushUndoSnapshot('Delete mortgage ledger entry');
  if (!data.mortgageLedger) return;
  data.mortgageLedger = data.mortgageLedger.filter((e) => e.id !== id);
  await persist();
}

export async function deleteMortgage(): Promise<void> {
  pushUndoSnapshot('Delete mortgage');
  delete data.mortgage;
  delete data.mortgageLedger;
  await persist();
}
