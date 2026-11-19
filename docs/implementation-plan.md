# kestl — Reliability, Performance & Feature Implementation Plan

This plan comes from a full code review (Nov 2026). It is written so another engineer or model can carry it out **without the original review session**. Each task lists the problem, the files involved, the exact change, and how to verify it.

Out of scope (deliberately excluded): account balances / statement reconciliation, rule preview / hit counts, and feature-sprawl triage.

---

## 0. Ground rules (read first)

1. **Read `CLAUDE.md`** at the repo root. In particular:
   - **Never edit version numbers** (`tauri.conf.json`, `Cargo.toml`, `package.json`). release-please owns them.
   - **Conventional Commits** for every commit (`fix:`, `feat:`, `refactor:`, `test:`, `chore:`, `docs:`). Suggested messages are given per task. Only commit when the user asks you to.
2. **Never test against the user's real `.budget`/`.json` data file.** Use the demo file (FileSetup → "Create demo file"), or a copy of a real file in a scratch directory.
3. **Don't touch** the untracked `kestl_*.deb` files or `graph.svg`. `CLAUDE.md` may have uncommitted edits by the user. Leave them alone.
4. **The working tree has an uncommitted change in `src/logic/categorize.ts`** (`recategorizeAll` now applies split rules by calling `setSplits` in a loop). Task 3.5 replaces this with a batched version. Keep the intent (split rules should apply in `recategorizeAll`) and drop the per-iteration save.
5. **File format must stay backward compatible.** Older data files must load. New fields are always optional (`field?: T`) and get defaults in `loadFromFile`. One-time data changes go through `data.completedMigrations` (see `startupCleanup` in `src/db.ts`).
6. After each phase run:
   ```bash
   npm run build          # tsc -b && vite build — must pass
   npm run lint
   npm test               # added in Phase 0
   (cd src-tauri && cargo check)
   ```
   Then check the touched features manually in `npm run tauri:dev` with a demo file.
7. Keep `docs/architecture.md`, `docs/flows/save-load.md`, `docs/flows/state-ownership.md` and `CLAUDE.md` (the "Persistence pattern", "Undo" and "State management" sections) accurate as you change behavior. Phase 1 especially invalidates them.

### Phase order and dependencies

| Phase | Theme | Depends on |
|---|---|---|
| 0 | Test harness | — |
| 1 | Persistence core: safe saves, background saving, undo, stale UI | 0 |
| 2 | Backups and per-file settings | 1 |
| 3 | Data integrity: startup cleanup, categories, recurring, splits | 1 |
| 4 | Performance: shared spend calculations | 1 (B1 array refresh), 0 |
| 5 | Security and robustness | — (Task 5.1 can be done any time) |
| 6 | Features: transfers, rollover, forecast | 3, 4 |

Phases 1–3 fix data-loss bugs and come first. Within a phase, do the tasks in order.

---

## Phase 0 — Test harness (review item E3)

### 0.1 Add Vitest
- `npm i -D vitest@^3` (compatible with Vite 7).
- `package.json` scripts: `"test": "vitest run"`, `"test:watch": "vitest"`.
- Add a `test` block in `vite.config.ts`: `test: { environment: 'node', include: ['src/**/*.test.ts'] }`. Add `/// <reference types="vitest/config" />` at the top so TypeScript accepts the `test` key.
- Make sure `tsc -b` doesn't break. If test files cause type errors in `tsconfig.app.json`, either add `"types": ["vitest/globals"]` or import `describe/it/expect` from `vitest` explicitly (preferred).

### 0.2 Test seam in `db.ts`
Tests must be able to set state without disk. `persist()` already returns early when `filePath` is null, and that must stay true after Phase 1. Add:
```ts
/** Test-only: replace in-memory data. Never call from app code. */
export function __setDataForTests(d: AppData): void {
  data = { ...emptyData(), ...structuredClone(d) };
  filePath = null;
  sessionPassword = null;
  _undoStack.length = 0;
}
```
`@tauri-apps/api/core` imports fine in Node. `invoke` is never reached while `filePath` is null.

### 0.3 Fixture builder
Create `src/test/fixtures.ts` with small builder helpers (`makeTxn(partial)`, `makeCategory`, `makeBudget`, `makeSplit`) and one canonical fixture `richFixture()` that includes:
- debits and credits (credits have `ignoreInBudget: true` and a **negative** amount, as the CSV parser stores them: `src/parsers/csv.ts:161`)
- an income category (`isIncome: true`)
- a split transaction, including one split with a `txnDate` override into the next month
- an uncategorized debit, and a debit in a category with no budget that month (off-budget)
- a refund (negative amount, `ignoreInBudget: false`, linked to its original)
- a "spend from savings" group
- transactions across a year boundary (Dec → Jan)

`demo-data.json` (repo root) has no splits, so use it only as a secondary smoke fixture.

### 0.4 First test files (characterization: lock in current behavior)
Write these **before** changing the code they cover:
- `src/logic/duplicates.test.ts`: exact re-import, sourceRef match, pending→captured within 5 days, prefix match, and the count-based rule (N in DB absorbs exactly N incoming).
- `src/logic/categorize.test.ts`: exact vs contains, last match wins, `amountMatch` tolerance, splits produce a `SplitAction`, `guessCategory` tiers.
- `src/components/budgetMath.test.ts`: needs `buildRows` exported. Move `buildRows` out of `BudgetView.tsx` into `src/logic/budgetRows.ts` unchanged (pure move) and export it. Snapshot its output for 2–3 months of `richFixture()` with `vi.setSystemTime(new Date('2026-03-15'))`.
- Same for YearView: extract the body of the `data` `useMemo` (`YearView.tsx:102`) into `src/logic/yearData.ts` as `computeYearData(appData, opts)` (pure move) and snapshot it.

These snapshots are the safety net for the Phase 4 rewrite.

Commits: `test: add vitest harness and fixtures`, `refactor: extract buildRows and computeYearData into logic modules`, `test: characterization tests for duplicates, categorize, budget math`.

---

## Phase 1 — Persistence core (A2, A3, A4, B1, C1, D2, E4)

This is the most important phase. It rewrites how saving works in `src/db.ts` and `src-tauri/src/lib.rs`.

### Current behavior (for reference)
- `persist()` (`db.ts:321`) runs on every mutation: `JSON.stringify(data, null, 2)` → if encrypted, derive a PBKDF2 key (100k iterations, new salt **every save**) and AES-GCM encrypt → `invoke('save_data')` → `data = { ...data }` → notify listeners. Callers `await` it, so the UI waits for the disk.
- `save_data` (`lib.rs:59`) is a **synchronous** Tauri command (runs on the main thread) doing `fs::write`, which is not atomic.
- Saves aren't queued. At startup, `startupCleanup()`, `processRecurringTemplates()` and `processSchedules()` run without being awaited (`App.tsx:136-141`), so saves overlap. With encryption, an older snapshot can finish writing after a newer one.
- `data = { ...data }` is a shallow copy. Nested arrays keep the same reference when mutated in place, so `useMemo([..., data.transactions])` doesn't re-run (e.g. `TransactionView.tsx:190, 209`: uncategorized count and suggestions go stale after `updateTransaction`).

### 1.1 Rust: atomic, async, conflict-aware save (A4, E4)
In `src-tauri/src/lib.rs`:

```rust
use std::io::Write;
use std::path::Path;

fn mtime_ms(p: &Path) -> std::io::Result<u64> {
    let m = fs::metadata(p)?.modified()?;
    Ok(m.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64)
}

fn atomic_write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("data");
    let tmp = path.with_file_name(format!(".{}.tmp", file_name));
    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    fs::rename(&tmp, path)?; // replaces existing on Unix and Windows
    #[cfg(unix)]
    if let Some(dir) = path.parent() {
        if let Ok(d) = fs::File::open(dir) { let _ = d.sync_all(); }
    }
    Ok(())
}

/// Returns the new mtime (ms). If `expected_mtime` is given and the file on disk
/// has a different mtime, returns Err("CONFLICT") without writing.
#[tauri::command]
async fn save_data(path: String, data: String, expected_mtime: Option<u64>) -> Result<u64, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = Path::new(&path);
        if let Some(exp) = expected_mtime {
            if let Ok(cur) = mtime_ms(p) {
                if cur != exp { return Err("CONFLICT".to_string()); }
            }
        }
        atomic_write(p, data.as_bytes()).map_err(|e| e.to_string())?;
        mtime_ms(p).map_err(|e| e.to_string())
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn file_mtime(path: String) -> Option<u64> { mtime_ms(Path::new(&path)).ok() }
```
- Register `file_mtime` in `generate_handler!`.
- Make `load_data` `async` + `spawn_blocking` too (large files would otherwise block the main thread).
- Use `atomic_write` in `save_bytes` and `save_base64` as well.
- Existing JS callers that don't pass `expectedMtime` (exports in `SettingsView.tsx:722, 749`) keep working. Tauri maps a missing `Option` arg to `None`. The return type changes from `()` to `u64`, which callers ignore.

### 1.2 Crypto: cache the key per session, raise iterations (C1, D2)
In `src/utils/crypto.ts`:
- Add an envelope version 2: `{ "budgetEncV1": 2, "kdf": "PBKDF2-SHA256", "iterations": 600000, "salt", "iv", "data" }`. Keep the `budgetEncV1` key name so `isEncryptedFile` still works. Older app versions will show "Unsupported encryption version" instead of a misleading "wrong password".
- New API:
  ```ts
  export interface SessionKey { key: CryptoKey; salt: Uint8Array; iterations: number }
  export async function createSessionKey(password: string, salt?: Uint8Array, iterations = 600_000): Promise<SessionKey>
  export async function encryptWithKey(plaintext: string, sk: SessionKey): Promise<string> // fresh random 12-byte IV per call, writes v2 envelope
  export async function decryptWithPassword(json: string, password: string): Promise<{ plaintext: string; sessionKey: SessionKey; needsUpgrade: boolean }>
  ```
  `decryptWithPassword` reads `budgetEncV1` (1 → 100,000 iterations, 2 → `iterations` field). If v1, after decrypting it creates a **new** v2 `SessionKey` (new salt, 600k) and returns `needsUpgrade: true`, so the caller saves once to upgrade the file.
- Reusing one key with a random 96-bit IV per save is safe for AES-GCM at this volume.
- Keep `encryptData`/`decryptData` working, because `SettingsView.tsx:736` uses `encryptData` for encrypted archives. Have them delegate to the new functions.
- Fix `bufToB64`, which builds the string one character at a time (slow for multi-MB data). Encode in chunks:
  ```ts
  let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  ```

### 1.3 db.ts: background save pipeline (A4, C1)
Replace `persist()` and its surrounding state. Target design:

```ts
export type SaveStatus = 'idle' | 'pending' | 'saving' | 'error' | 'conflict';
let saveStatus: { status: SaveStatus; error?: string; lastSavedAt?: number } = { status: 'idle' };
let saveListeners: Array<() => void> = [];
let sessionKey: SessionKey | null = null;     // replaces deriving a key per save
let lastKnownMtime: number | null = null;
let dirty = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let saveInFlight: Promise<void> | null = null;
let notifyQueued = false;
const SAVE_DEBOUNCE_MS = 400;

const ARRAY_KEYS = ['categories','categoryRules','budgetGroups','budgets','transactions','transactionSplits',
  'savingsBuckets','savingsEntries','savingsSchedules','recurringTemplates','splitTemplates',
  'amazonOrders','customParsers','experimentalBudgets','mortgageLedger','mergeLogs'] as const;

function refreshRefs() {           // B1: new references for every array so memos re-run
  const next: AppData = { ...data };
  for (const k of ARRAY_KEYS) { const v = next[k]; if (Array.isArray(v)) (next as any)[k] = [...v]; }
  data = next;
}

function queueNotify() {
  if (notifyQueued) return;
  notifyQueued = true;
  queueMicrotask(() => { notifyQueued = false; for (const fn of listeners) fn(); });
}

/** Called by every mutator. Updates the UI right away; disk write happens later. */
async function persist(): Promise<void> {
  refreshRefs();
  queueNotify();
  if (filePath) scheduleSave();
}
```
- `scheduleSave()`: set `dirty = true`, set status `pending` (unless status is `conflict`), restart a 400 ms debounce timer that calls `runSave()`.
- `runSave()`: if a save is in flight, wait for it first. Then if `!dirty`, or no `filePath`, or status is `conflict`, return. Otherwise set `dirty = false`, take the content (`JSON.stringify(data, null, 2)` for plaintext files, which are meant to be human-readable; compact `JSON.stringify(data)` before encrypting), encrypt with `sessionKey` if set, then `invoke<number>('save_data', { path, data, expectedMtime: lastKnownMtime })`.
  - On success: `lastKnownMtime = result`, status → `idle` (or `pending` if `dirty` became true meanwhile, then schedule again).
  - On `CONFLICT`: status → `conflict`. Stop autosaving. Keep `dirty = true`.
  - On any other error: `dirty = true`, status → `error` with the message, retry with backoff (2 s, 5 s, 15 s, then stop and stay on `error`).
- `export async function flushSave(): Promise<void>`: cancel the timer, wait for any save in flight, run `runSave()` if dirty, and throw if the final status is `error` or `conflict`.
- `export function getSaveStatus()` / `subscribeSaveStatus(fn)` for the UI.
- `export async function resolveConflict(choice: 'overwrite' | 'reload')`: `overwrite` sets `lastKnownMtime = null`, status `pending`, and flushes. `reload` calls `loadFromFile(filePath, ...)` using the cached key's password (see 1.4).
- Keep `persistData()` as an alias of `persist()` (used by `logic/matching.ts`, `logic/refunds.ts`, `logic/categorize.ts`).
- **Audit for stale array references.** After this change, `data.transactions` etc. become a new array on every `persist()`. Any code that does `const { transactions } = getData()`, then awaits a mutator, then **pushes into or reassigns** the captured array will lose writes. Changing fields on objects inside the array is still fine, because the objects are shared. Grep `getData()` across `src/logic` and `src/components` and check each site that pushes after an `await`. Known sites to check: `logic/recurring.ts`, `logic/savings.ts`, `logic/matching.ts`, `logic/refunds.ts`, `components/ImportView.tsx`. Inside `db.ts`, always reference `data.x` after an await, never a captured local.

### 1.4 Loading, file switching, encryption toggles
- `loadFromFile(path, password?)`:
  1. **First** `await flushSave()` for the current file if one is open, and show an error if that fails.
  2. Reset: `_undoStack.length = 0` and notify undo listeners (**fixes A2**: undo after switching files used to write the old file's data into the new file). Also reset `saveStatus`, `dirty`, timers and `sessionKey`.
  3. Read via `load_data`, then `lastKnownMtime = await invoke('file_mtime', { path })`.
  4. If encrypted, use `decryptWithPassword`. Store `sessionKey`, and keep `sessionPassword` (still needed by `changeEncryptionPassword` and conflict reload). If `needsUpgrade`, call `persist()` after loading.
  5. Notify through `refreshRefs()` + listeners.
- `createNewFile` / `createDemoFile`: same reset. `lastKnownMtime = null` before the first save.
- `enableEncryption(pw)`: `sessionKey = await createSessionKey(pw)`, `sessionPassword = pw`, `persist()`, `await flushSave()`.
- `changeEncryptionPassword`: same with the new password.
- `disableEncryption`: `sessionKey = null`, `sessionPassword = null`, persist, flush.
- `checkFileEncrypted` is unchanged.

### 1.5 Run startup jobs in sequence, and on file switch
Create `src/startup.ts`:
```ts
export async function runStartupJobs(): Promise<void> {
  await startupCleanup();
  await processRecurringTemplates();
  await processSchedules();
  await flushSave();
  await runBackup('startup'); // Phase 2; until then omit this line
}
```
- `App.tsx:136`: replace the four unawaited calls with `runStartupJobs()` and show a non-blocking error if it throws.
- `SettingsView.tsx` "Open different file" (`:1272`) and the encrypted-file path (`:781`): after a successful `loadFromFile`, call `runStartupJobs()` too. Today switching files skips cleanup and recurring generation.
- Delete `runStartupBackup` from `App.tsx` (replaced in Phase 2).

### 1.6 Flush on window close
In `App.tsx` (one-time `useEffect`):
```ts
import { getCurrentWindow } from '@tauri-apps/api/window';
const unlisten = getCurrentWindow().onCloseRequested(async (event) => {
  try { await flushSave(); } catch { event.preventDefault(); /* show "Unsaved changes — Retry / Quit anyway" modal */ }
});
```
In Tauri v2 the JS `onCloseRequested` awaits the handler and then calls `destroy()`, which needs the `core:window:allow-destroy` permission. Add it to `src-tauri/capabilities/default.json`. Check in `tauri:dev` that the window still closes normally and that a pending edit made just before closing is on disk.

### 1.7 Save status UI (A4, E4)
- In the tab bar's right side (`App.tsx`, next to Undo) add a small indicator driven by `useSyncExternalStore(subscribeSaveStatus, getSaveStatus)`:
  - `idle`: "Saved" (muted)
  - `pending`/`saving`: "Saving…"
  - `error`: red "Save failed: Retry" button that calls `flushSave()`, with the error in a tooltip
- When status is `conflict`, show a modal: *"This file was changed outside kestl (another device, a sync app, or another window). Reload from disk (your unsaved changes here are lost) / Overwrite with my version."* Call `resolveConflict`.

### 1.8 Undo rework (A3)
Problem: snapshots are only taken before deletes and reorders. Undo restores the whole app to that point, which silently discards every later edit that didn't take a snapshot (e.g. 30 categorizations).

Change it to "every user action can be undone, one action at a time":
- `_undoStack: { label: string; snap: string }[]`, limit **10**. `pushUndoSnapshot(label: string)` stores compact `JSON.stringify(data)`. Add `getUndoLabel(): string | null`.
- Call `pushUndoSnapshot('<label>')` at the start of **every user-initiated mutator**: all `add*/update*/delete*/set*/bulk*/merge*/reorder*/copy*/purge*` in `db.ts`, plus bulk operations in `logic/categorize.ts` (`bulkCategorizeByDescriptor`, `bulkApplySplitRule`, `runRuleOnHistory`, `recategorizeAll`, `createRuleAndApply`), `logic/matching.ts` and `logic/refunds.ts` link/unlink functions, and ImportView's commit step. **One user action = one snapshot.** Bulk functions push once and then use internal non-snapshotting helpers (see 3.5).
- **Don't** snapshot for: `startupCleanup`, `processRecurringTemplates`, `processSchedules`, AI feedback logging, display/AI/colour settings, or encryption toggles.
- Update the existing caller `BudgetView.tsx:580` to pass a label.
- `undo()`: pop, `data = { ...emptyData(), ...JSON.parse(snap) }`, `persist()`. The new pipeline handles the save.
- Undo button tooltip: `Undo: ${label}`.
- Measure: log how long `JSON.stringify(data)` takes on a large file (copy a real file with years of data). If it's over ~50 ms per action, note it in the PR. Don't optimize further unless needed.

### 1.9 Tests for Phase 1
- Saving is debounced: several mutations in a row cause one `save_data` call. Mock `invoke` with `vi.mock('@tauri-apps/api/core')` and set the file path through a test hook.
- Conflict: `invoke` rejects with `CONFLICT` → status becomes `conflict` and no more saves are attempted.
- `refreshRefs`: after `updateTransaction`, `getData().transactions !== before`.
- Undo restores only the last action. The stack is cleared on `loadFromFile`.
- Crypto: v1 envelope decrypts. Round trip through v2. Wrong password throws.

Commits: `fix: atomic, conflict-checked file saves`, `perf: debounce saves and cache encryption key`, `fix: clear undo history when switching files`, `feat: per-action undo with labels`, `feat: save status indicator and external-change detection`.

---

## Phase 2 — Backups and settings stored in the file (A1, A5, E9)

### Current bugs
- **A1:** `SettingsView.tsx:675` shows backups as ON by default (`stored === null ? true`), but `App.tsx:53` only backs up if localStorage says exactly `'true'` **and** a backup folder is set. A user who never pressed save in backup settings has **never had a backup**.
- **A5:** backups are written as plaintext JSON even when the file is encrypted (`App.tsx:59`).
- Backups only run at startup.

### 2.1 Rust `backup_file`
```rust
#[tauri::command]
async fn backup_file(src: String, dir: String, stamp: String, max_count: u32) -> Result<String, String>
```
- Check that `stamp` only contains `[0-9T-]` (the JS side passes e.g. `2026-11-08T14-03-22`).
- `create_dir_all(dir)`. Destination is `dir/kestl-backup-{stamp}.{ext of src}`. Write it by **copying the saved file** (`fs::copy`), so an encrypted data file gives an encrypted backup automatically (**fixes A5**).
- Prune: list files in `dir` whose names start with `kestl-backup-` or `qbdgt-backup-` (legacy). Sort by mtime and delete the oldest until `count <= max_count`.
- Return the destination path. Run inside `spawn_blocking`.

### 2.2 `src/backup.ts`
```ts
export async function runBackup(reason: 'startup' | 'interval' | 'pre-import' | 'pre-merge' | 'pre-purge'): Promise<void>
```
- Settings come from `getBackupSettings()` (2.3). Return if disabled.
- `await flushSave()` first, then `invoke('backup_file', { src: filePath, dir, stamp, maxCount })`.
- Keep `lastBackupAt` / `lastBackupError` in module state with a subscribe function, and show both in Settings.
- **Schedule:** at startup (from `runStartupJobs`); then every 30 minutes **if** at least one save happened since the last backup (count saves in db.ts's save pipeline and expose `getSaveCount()`); and before risky operations: ImportView commit, `mergeCategories`, `purgeTransactionsByMonth`, `purgeTransactionsByInstrument`. Call these from the UI handlers before the mutator, not inside db.ts, to avoid an import cycle.

### 2.3 Settings that belong to the file (E9)
Settings currently in localStorage are lost when the file moves to another machine. Split them:
- **Move into the file** by extending `AppData`:
  ```ts
  backupSettings?: { enabled: boolean; maxCount: number };   // defaults { enabled: true, maxCount: 5 }
  ```
  and extend `DisplaySettings` (`db.ts:251`) with `experimentalEnabled?: boolean; showMortgageTab?: boolean; txnAiLookupEnabled?: boolean`.
- **Keep per machine (localStorage):** zoom, dark mode, and the backup **folder**, stored per data file: key `kestl-backup-dir:${filePath}`, default `${dirname(filePath)}/kestl-backups`.
- **One-time migration** in `startupCleanup`, id `'moveLocalSettingsIntoFile'`. If the old localStorage keys exist (`budget-app-backup-enabled`, `budget-app-backup-count`, `budget-app-backup-dir`, `budget-app-experimental`, `budget-app-show-mortgage-tab`, `budget-app-txn-ai-lookup`), copy them into the file or the per-file dir key, but **force `enabled: true`** when the old value was missing. Leave the old keys in place, which is harmless.
- Update readers and writers: `App.tsx` (`EXPERIMENTAL_KEY`, `MORTGAGE_TAB_KEY`, `TXN_AI_LOOKUP_KEY`), `MortgageTool.tsx:163, 422`, `SettingsView.tsx:670-685`.

### 2.4 Settings UI for backups
- Toggle (default on), max count (default 5), folder picker, "Back up now" button, "Last backup: <time> / error".
- If the current file is encrypted, check existing backups in the folder by reading each `kestl-backup-*`/`qbdgt-backup-*` file through `load_data` and testing it with `isEncryptedFile`. Usually there are 10 or fewer. If any are plaintext, show: *"N older backups in this folder are not encrypted."* with a **"Delete unencrypted backups"** button that needs a confirm click. Never delete them automatically.

Commits: `fix: backups now run by default and stay encrypted`, `feat: periodic and pre-import backups`, `refactor: store feature flags and backup settings in the data file`.

---

## Phase 3 — Data integrity (A6, A7, A8, B3, B4, B5, E10)

### 3.1 Make the startup "fixes" one-time migrations (A6)
In `startupCleanup()` (`db.ts:426`), several steps run on **every launch** and keep overwriting user edits. Change each one as follows:

| Step (comment in code) | Problem | Change |
|---|---|---|
| 1. Clear stale links | Safe to repeat | Keep as is |
| 2. Bidirectional refund sign fix | Flips refund signs again on every launch | Gate behind migration id `fixBidirectionalRefundSigns` |
| 3. PayPal `ignoreInBudget` reset | Undoes the user's manual flag on every launch | Gate: `fixPaypalIgnoreFlag` |
| 4. Recurring negative-amount fix | Overrides user edits | Gate: `fixRecurringNegativeAmounts` |
| 5. Amazon sourceRef from descriptor | Safe to repeat | Keep |
| 6. Stale Amazon refund records | Deletes records | Gate: `migrateStaleAmazonRefunds` |
| 7. Remove zero-amount transactions | **Deletes the user's $0 records on every launch** | Gate: `removeZeroAmountTxns`. Also drop zero-amount rows at import time in `parsers/csv.ts` and `parsers/paypal.ts` so it never needs to run again |
| 7 (second). PayPal re-import dedupe | Deletes records | Gate: `dedupePaypalReimports` |
| 8. Zero out cancelled Amazon orders | Already handled in `addAmazonOrders` | Gate: `zeroCancelledAmazonOrders` |
| 10a. `deleteAllSavingsSchedules` | Has a redundant `if (!data.completedMigrations)` | Tidy only |
| 13. Colour backfill | Uses index-based colour | Use `pickDistinctColor` |

Existing users have effectively already run these steps, so running each once more under a migration flag is a no-op or the same fix. Make `startupCleanup` return `{ id: string; changed: number }[]` and `console.info` it, which makes debugging easier later.

### 3.2 Category integrity: delete, merge, archive (A7, E10)
**Add `archived?: boolean` to `Category`.**
- `getCategoryUsage(id)` in `db.ts` returns counts for: transactions (`categoryId`), splits, budgets, rules (`categoryId` and `splits[].categoryId`), recurring templates, experimental budget items, mortgage (`paymentCategoryId`, `prepaymentCategoryId`).
- `deleteCategory(id)`: if usage is non-zero, **throw** (the UI shouldn't allow it). Only categories with no references can be deleted.
- `setCategoryArchived(id, archived)`.
- SettingsView delete button (`SettingsView.tsx:151`): if the category is in use, show a modal: *"Used by N transactions, M budgets… Archive it (keeps history, hides it from pickers), Merge into… or Cancel."*
- **Archived categories are hidden** from every place a category is *chosen*: assigning a transaction, rule creation, split editor, recurring template form, BudgetView "add budget item", ImportView, and the suggestion corpus (`batchGetGuessScores` should skip transactions whose category is archived, and never suggest an archived category). Find these with `grep -rn "categories.map\|categoryOptions" src/components` (~34 sites). Create one helper `getSelectableCategories()` and use it everywhere.
- Archived categories **still show** wherever existing data is displayed (transaction rows, past budget rows, YearView).
- Settings category list: add a collapsed "Archived (N)" section with Unarchive.

**Fix `mergeCategories` (`db.ts:721`):**
- Budgets: for each month, if the target already has a budget, **add** the source amounts to it. Otherwise re-point the first source budget to the target and add the rest. Never just delete budget amounts.
- Also re-point: `recurringTemplates[].categoryId`, `experimentalBudgets[].items[]` (`categoryId` and `categoryName`, then dedupe by summing), `mortgage.paymentCategoryId` / `prepaymentCategoryId`, `aiCategoryFeedback` ids, and `categories[].savingsBucketId` (if the target has none, inherit it).
- Extend `MergeLog` with any new affected collections.

**One-time repair migration `repairOrphanCategoryRefs`** (deleting categories used to leave dangling references):
- transactions with a `categoryId` not in `categories` → `null` (they show up as uncategorized)
- budgets with a missing category → delete
- splits with a missing category → delete **all** splits of that transaction and set `categoryId = null`, so the user re-splits it
- rules with a missing `categoryId` or split category → delete
- recurring templates → `categoryId = null`
- mortgage ids → unset
- Log counts.

**Also fix `deleteSavingsBucket`** (`db.ts:993`): clear `savingsBucketId` on categories that point to it.

### 3.3 Recurring transactions (A8)
Problems: `processRecurringTemplates` (`logic/recurring.ts`) generates from the **earliest transaction month in the whole file**, so a new template backfills years. Deleted occurrences come back on every launch. Pausing and resuming backfills the paused months. Each generated transaction saves the file separately.

Changes:
- `RecurringTemplate` gets `startMonth?: string` (YYYY-MM), `skippedMonths?: string[]` and `pausedAt?: string` (YYYY-MM).
- `addRecurringTemplate`: default `startMonth` = current month. Optionally add a "Start month" input to the template form in `SettingsView.tsx:626`, defaulting to the current month.
- One-time migration `recurringStartMonth`: for each template without `startMonth`, use the earliest month of its existing generated transactions (`source === 'recurring' && sourceRef === String(id)`), or the current month if there are none.
- `dateUtils.ts`: add `monthsBetween(start: string, end: string): string[]`.
- New `processRecurringTemplates()`:
  - Build a `Set` of existing keys `${sourceRef}|${YYYY-MM}` in one pass.
  - For each active template, generate for `monthsBetween(startMonth, currentMonth)` excluding `skippedMonths` and existing keys.
  - Collect everything and call `bulkAddTransactions` **once**.
- **Tombstones:** in `deleteTransactions`, `purgeTransactionsByMonth` and `purgeTransactionsByInstrument`, for each deleted transaction with `source === 'recurring'`, add its month to the matching template's `skippedMonths` (deduplicated).
- **Pause/resume:** in `SettingsView.handleToggleTemplate`, or better inside `updateRecurringTemplate` when `active` changes:
  - pausing sets `pausedAt = currentMonth`
  - resuming adds the months strictly after `pausedAt` up to the month **before** the current one to `skippedMonths`, then clears `pausedAt`
- Same batching for `processSchedules` (`logic/savings.ts`): add `bulkAddSavingsEntries` to db.ts, and use a `Set` instead of `.some()` per month.
- Tests: new template doesn't backfill; a deleted occurrence stays deleted; pause/resume skips the gap; generation is idempotent.

### 3.4 Splits (B3)
How it works today: **if a transaction has splits, the splits are used for totals and the parent `categoryId` is ignored** (see `accumulateRange` in BudgetView). `SplitEditor` doesn't clear the parent `categoryId`. Make this rule explicit and fix the code that breaks it:
- Write the rule in `CLAUDE.md` under "Split transactions".
- Add `isCategorized(t, splitsIndex)` (Phase 4 `spend.ts`, or a temporary helper in `categorize.ts`) = `t.categoryId != null || (splitsIndex.get(t.id)?.length ?? 0) > 0`.
- `recategorizeAll` and `runRuleOnHistory` (when `!includeAlreadyCategorized`): skip transactions that already have splits. Today `recategorizeAll` re-splits them every time it runs, because split parents have `categoryId === null`.
- `TransactionView` "uncategorized" filter and suggestions (`TransactionView.tsx:191`): exclude transactions that have splits.
- `resolveSplits` (`categorize.ts:189`): round each amount to cents, then compute `diff = round2(txnAmount − Σ)`. If `|diff| ≥ 0.005`, add it to the **last** split. This covers percent splits that leave stray cents, and fixed-dollar rules applied to a transaction of a different amount.
- Rule modal (`TransactionView.tsx` around line 239): percent splits must total 100. For fixed-dollar splits, if they don't sum to the rule's amount, show *"The remainder goes to the last category."*
- Tests for rounding and remainder.

### 3.5 Batch the loops that save once per item (B4)
- In `db.ts`, add `setSplitsBulk(entries: { transactionId: number; splits: Omit<TransactionSplit,'id'|'transactionId'>[] }[])`. It does one `filter` to remove the old splits for all of those IDs, pushes the new ones, and calls `persist()` once.
- Use it in:
  - `recategorizeAll`: fold in the uncommitted working-tree change (applying split rules) and collect the split entries instead of `await setSplits` inside the loop
  - `bulkApplySplitRule`
  - `runRuleOnHistory`
  - `ImportView.tsx:127-131` and `:329-332`
- Each of these user-facing functions pushes **one** undo snapshot (see 1.8).

### 3.6 Remove dead code (B5)
`loadDefaultBudget()` (`db.ts:1153`, hard-coded months `'2026-01'..'2026-03'`) and `addDefaultBudgetForMonth()` (`db.ts:1138`) aren't called anywhere. Delete both, and remove any `seed.ts` imports that become unused.

Commits: `fix: startup cleanup no longer overwrites user edits on every launch`, `feat: archive categories; deleting a category in use is blocked`, `fix: merging categories keeps budgets and all references`, `fix: recurring transactions start at creation month and stay deleted`, `fix: split rounding and avoid re-splitting split transactions`, `perf: batch split updates into a single save`, `chore: remove unused default budget loaders`.

---

## Phase 4 — Performance: one shared spend calculation (B2, C2, C3, C4)

### Problem
The "spent per category per month" calculation exists in at least six slightly different copies:
- `buildRows` / `accumulateRange` (now `logic/budgetRows.ts` after Phase 0)
- `uncatTotal` and `offBudgetTotal` (`BudgetView.tsx:~655-700`), recomputed on **every render**, including mouse moves during drags
- `computeYearData` (`logic/yearData.ts`)
- `getBucketBalance` (`logic/savings.ts`)
- TransactionView filters

Each copy regroups splits by transaction. `buildRows` scans all transactions once per prior month (up to 13 passes) and scans all budgets once per row.

### 4.1 `src/logic/spend.ts`
```ts
export interface MonthAgg {
  debitByCat: Map<number, number>;   // non-credit amounts (signed; refunds are negative)
  creditByCat: Map<number, number>;  // credit amounts as positive numbers (Math.abs)
  uncategorizedDebit: number;        // non-credit, no splits, categoryId == null
}
export function getSplitsIndex(d: AppData): Map<number, TransactionSplit[]>;
export function getMonthAggregates(d: AppData): Map<string /*YYYY-MM*/, MonthAgg>;
export function isCategorized(t: Transaction, splits: Map<number, TransactionSplit[]>): boolean;
```
- **Rules must match the current `accumulateRange` exactly.** A split portion is assigned to month `(s.txnDate ?? t.txnDate).slice(0,7)`; a non-split categorized transaction to `t.txnDate.slice(0,7)`. Credit (`ignoreInBudget`) adds `Math.abs(amount)` to `creditByCat`. A debit adds the signed amount to `debitByCat`.
- **Caching:** use a `WeakMap` keyed on the `d.transactionSplits` array (for the index) and on the `d.transactions` array plus the splits array (for the aggregates). This only works because Phase 1 `refreshRefs()` gives each array a new reference on every change. Don't start this phase before Phase 1 is done.
- One pass over all transactions builds every month.

### 4.2 Port the consumers
- `buildRows`: use `getMonthAggregates`. Prior-month totals become map lookups and sums. Build `budgetsByCat: Map<catId, Map<month, target>>` once instead of scanning `d.budgets` per row (`budgetRows` line ~110). Replace `categories.find` inside `.map` with a Map. Also return `uncatTotal` and `offBudgetTotal` from it, so BudgetView computes them in `refresh()` (inside its `subscribe` effect) instead of on every render.
- `computeYearData`: use the aggregates. YearView has extra rules (only budgeted categories count as "actual", Occasional/spend-from-savings groups go to "savings", income categories). Keep those rules and only change where the per-category numbers come from.
- `getBucketBalance`: filters by **day** (`openDate`), so it can't use month aggregates. Use `getSplitsIndex` only.
- `TransactionView`: replace the local `splitsMap` with `getSplitsIndex(appData)`. Use `isCategorized` for the uncategorized filter and count.
- **The Phase 0 snapshot tests must pass unchanged.** If a snapshot differs, decide whether the old behavior was a bug, write down the decision in the commit body, and update the snapshot.

### 4.3 Smaller performance items (C4)
- TransactionView: when the result has more than 300 rows (e.g. "all months"), render the first 300 plus a "Show more (N remaining)" button that adds 300 each click. Reset the limit when filters change. Don't add a virtualization library.
- `batchGetGuessScores` (`categorize.ts:108`): add a fast path. Build `Map<norm, Map<catId,count>>` and `Map<stripped, Map<catId,count>>` from the corpus once, so tiers 1–2 become lookups. Only run the trigram/keyword scan over corpus entries that didn't match exactly. **Scores must be identical.** Add a test comparing old and new output on the fixture before removing the old loop.
- Ollama chat helpers: no performance change, but see 5.4.

Commits: `refactor: single shared spend aggregation used by budget, year, savings and transactions`, `perf: memoize budget totals and paginate long transaction lists`, `perf: index exact matches in category suggestions`.

---

## Phase 5 — Security and robustness (D1, D3, B6)

### 5.1 Run custom parsers in a Web Worker (D1)
Today `executeCustomParser` (`db.ts:1335`) runs AI-generated code with `new Function` in the main window. That code can call every Tauri command, including `save_data`/`save_base64` on any path and `start_ollama` with any binary path, which means running any program.
- Move `sandboxParseDate` and a pure `runParserCode(code, text, filename)` (the current body plus row validation) into `src/parsers/sandbox.ts`.
- Create `src/workers/parserWorker.ts`:
  ```ts
  import { runParserCode } from '../parsers/sandbox';
  self.onmessage = (e: MessageEvent<{ code: string; text: string; filename: string }>) => {
    try { self.postMessage({ ok: true, rows: runParserCode(e.data.code, e.data.text, e.data.filename) }); }
    catch (err) { self.postMessage({ ok: false, error: String(err instanceof Error ? err.message : err) }); }
  };
  ```
- `executeCustomParser` becomes `async`. It creates `new Worker(new URL('./workers/parserWorker.ts', import.meta.url), { type: 'module' })`, posts the message, and resolves or rejects. It **terminates the worker after 10 s** (protects against infinite loops) and always terminates it when finished.
- Re-check in the main thread that every row has a `YYYY-MM-DD` `txnDate`, a finite number `amount` and a string `descriptor`.
- Update callers to `await`: `ImportView.tsx:239`, `ParserGenerator.tsx:153, 158, 178`. The line 178 call is a validation inside try/catch, so keep that behavior.
- Check that the Tauri IPC bridge (`__TAURI_INTERNALS__`) isn't available inside the worker: temporarily log `typeof (self as any).__TAURI_INTERNALS__` in dev.

### 5.2 Content Security Policy
`tauri.conf.json` has `"csp": null`. Set:
```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:;
font-src 'self' data:; worker-src 'self' blob:; connect-src 'self' ipc: http://ipc.localhost http: https:
```
- `connect-src` allows `http:`/`https:` because the Ollama URL is user-configurable. The main gain is blocking injected scripts.
- If the parser worker's `new Function` is blocked, add `'unsafe-eval'` to `script-src` and note why in a comment in the PR. The worker isolation in 5.1 is the main protection.
- Test in `tauri:dev` **and** a production build (`npm run tauri:build`, or at least `vite build` + `tauri dev` against `dist`): app load, charts, Ollama chat, DDG lookup, custom parser import, file dialogs, exports.

### 5.3 Restrict the Rust commands
- `start_ollama`: **remove the `binary_path` parameter.** Inside the command, resolve the binary with the existing `find_ollama()` logic and return an error if it isn't found. Update callers: `App.tsx:261`, `ParserGenerator.tsx:61`, `SettingsView.tsx:425`. Callers can drop the `binaryPath` they currently pass around.
- `save_data`, `save_bytes`, `save_base64`: reject relative paths and any path containing a `..` component. Allow only the extensions the app actually writes. Build that list by grepping `invoke('save_` call sites and every `save({ filters })` dialog, e.g. `json`, `budget`, `xlsx`, `csv`, `md`, `zip`, plus the `.tmp` used internally by `atomic_write` (that one is internal and doesn't go through the check).
- `install_ollama` (D3): after downloading, **check the SHA-256**.
  - Take the resolved final URL of the download (`response.url()`, e.g. `.../releases/download/v0.X.Y/ollama-linux-amd64.tar.zst`) and replace the file name with `sha256sum.txt`, so both files come from the same release.
  - Fetch it, find the line ending in the asset file name (lines may have a `./` prefix), and compare it to the `sha2::Sha256` digest of the downloaded bytes. Add `sha2 = "0.10"` to `Cargo.toml` dependencies; this does not touch the version field.
  - If the checksum file can't be fetched or the hashes differ, return an error such as *"Couldn't verify the download. Install Ollama manually from ollama.com."*
  - Also stream the download to a temp file instead of holding the whole archive in memory (`Vec<u8>`), hashing as it streams.

### 5.4 Small robustness fixes (B6)
- `search_ddg` (`lib.rs:~326`): the hand-written URL encoding writes the Unicode codepoint (`%{:02X}` of `c as u32`), which is wrong for any non-ASCII character. Replace it with `client.get("https://html.duckduckgo.com/html/").query(&[("q", &query)])`.
- `strip_html`: also decode `&#x27;`, `&#x2F;` and numeric entities (`&#NNN;`).
- Ollama timeouts in `logic/llm.ts`: add `ollamaFetch(url, init, timeoutMs)` using `AbortSignal.timeout`. Use **180 s** for `/api/chat` (lines ~430, 601, 712 already has 30 s so align it, 951, 1070), **5 s** for `/api/tags` (line 49), and no timeout for `/api/pull` (it streams for a long time). Show "Ollama didn't respond in time" for `TimeoutError`.

Commits: `fix: run custom parsers in an isolated worker`, `fix: enable content security policy`, `fix: restrict file and process commands`, `fix: verify Ollama download checksum`, `fix: correct DuckDuckGo query encoding and add LLM timeouts`.

---

## Phase 6 — Features (E2, E5, E6)

### 6.1 Clearer transaction types and transfers (E2)
`ignoreInBudget` (83 uses in 16 files) actually means **"this is a credit"** (money in). Credits subtract from spend in their category, or count as income in income categories (see `accumulateRange`). There is no way to mark a **transfer between your own accounts** (e.g. a credit-card payment from chequing), so transfers either count as spending or have to be left uncategorized. `linkedTransactionId === -1` is also a hidden marker meaning "linked to PayPal".

Step 1, rename through helpers only (no behavior change):
- `src/logic/txnKind.ts`: `export const isCredit = (t: Pick<Transaction,'ignoreInBudget'>) => t.ignoreInBudget;` and `export const isPaypalLinked = (t) => t.linkedTransactionId === -1;`.
- Replace all **reads** of `t.ignoreInBudget` / `=== -1` with these helpers. Leave writes as they are. Keep the stored field name, for file compatibility.
- Document in `CLAUDE.md`: "`ignoreInBudget` means *credit*, despite its name."
- Tests must pass unchanged.

Step 2, add transfers:
- `Transaction.isTransfer?: boolean`.
- `spend.ts`: transfers are excluded from every aggregate (spend, credits, uncategorized, off-budget), from the suggestion corpus, and from savings bucket balances.
- TransactionView row menu: "Mark as transfer" / "Unmark". Show a greyed-out row with a "Transfer" badge. Add a "Transfers" filter. Transfers don't count as uncategorized.
- Rules: `CategoryRule.markTransfer?: boolean`. When true, the rule sets `isTransfer` instead of a category (`categorizeTransactionsInPlace`, `runRuleOnHistory`, `recategorizeAll`, `bulkCategorizeByDescriptor`). Add a "Mark as transfer" option to the rule modal.
- Optionally suggest transfers during import: a debit in account A and a credit of the same amount in account B within 3 days. Show the pairs in the import review with a "Mark both as transfer" button. Only do this if time allows.

Commits: `refactor: name credit and PayPal-link checks`, `feat: mark transactions as transfers between accounts`.

### 6.2 Per-category rollover (E5)
- `Category.rollover?: boolean`, `Category.rolloverStartMonth?: string`. When rollover is turned on, set the start month to the current month, so turning it on doesn't pull in years of history.
- `spend.ts`: `getRolloverCarry(d, catId, month): number` = Σ over months `m` with `rolloverStartMonth ≤ m < month` of `(target_m − net_spent_m)`. `target_m` is that month's budget (0 if none). `net_spent_m` uses the same rules as the budget row's `spent`. Expense categories only.
- BudgetView row: when rollover is on, show a "+$X carried" / "−$X carried" chip next to the target. The remaining amount and colour thresholds use `available = target + carry − spent`. Add a toggle in the category's row menu and in Settings → Categories.
- Totals: `totalRemaining` uses `available` for rollover categories.
- Tests: carry builds up over 3 months, overspending carries a negative amount, and it starts at `rolloverStartMonth`.

Commit: `feat: per-category budget rollover`.

### 6.3 Forecast (E6)
`src/logic/forecast.ts`:
- `projectCurrentMonth(d, month)` returns `{ received, expectedIncomeRemaining, spent, plannedRemaining, projectedNet }`:
  - `expectedIncomeRemaining` = Σ max(0, income target − received) per income category
  - `plannedRemaining` = Σ max(0, target − spent) over expense categories, excluding spend-from-savings groups
  - `projectedNet = received + expectedIncomeRemaining − spent − plannedRemaining`
- `forecastMonths(d, n = 3)`: for each future month, use that month's budgets if they exist, otherwise the most recent month that has budgets. Planned income and expense come from the targets. Add active recurring templates whose `categoryId` has **no** budget in that month (to avoid counting twice); negative template amounts count as income. Return `{ month, income, expense, net }[]`.
- UI: BudgetView summary gets a "Projected month-end: $X" line (current month only). YearView gets a small "Next 3 months" table.
- Tests with the fixture.

Commit: `feat: month-end projection and 3-month forecast`.

---

## Appendix A — Review item → task map

| Review item | Task(s) |
|---|---|
| A1 backups never run by default | 2.1–2.4 |
| A2 undo after file switch writes the wrong file | 1.4 |
| A3 undo discards later edits | 1.8 |
| A4 non-atomic and overlapping saves | 1.1, 1.3, 1.5, 1.6 |
| A5 plaintext backups of encrypted files | 2.1, 2.4 |
| A6 startup fixes run every launch | 3.1 |
| A7 category delete/merge leaves orphans | 3.2 |
| A8 recurring backfill / resurrection | 3.3 |
| B1 stale memoized UI | 1.3 (`refreshRefs`) |
| B2 duplicated spend math | 4.1–4.2 |
| B3 split edge cases | 3.4 |
| B4 save per loop iteration | 3.5 (plus 1.3 makes each save cheap) |
| B5 hard-coded months | 3.6 |
| B6 DDG encoding, no LLM timeouts | 5.4 |
| C1 full save + PBKDF2 per click | 1.2, 1.3, 1.1 (async command) |
| C2 BudgetView recomputation | 4.2 |
| C3 repeated splits grouping | 4.1 |
| C4 recurring `.some`, long lists, suggestion scan | 3.3, 4.3 |
| D1 parser code has full IPC access, CSP off | 5.1, 5.2, 5.3 |
| D2 PBKDF2 iterations | 1.2 |
| D3 unverified Ollama download | 5.3 |
| E2 transaction type / transfers | 6.1 |
| E3 tests | Phase 0 (and tests in each phase) |
| E4 external change detection | 1.1, 1.3, 1.7 |
| E5 rollover | 6.2 |
| E6 forecast | 6.3 |
| E9 settings in localStorage | 2.3 |
| E10 archive categories | 3.2 |

## Appendix B — Correction to the original review
The review said split rules can "double-count" when a parent keeps its `categoryId`. That's **not** the case for budget totals, because splits take precedence over the parent's `categoryId` in every total. The actual split problems are the ones in 3.4: re-splitting in `recategorizeAll`, uncategorized checks that ignore splits, and rounding/remainder.

## Appendix C — Manual test checklist (run with a demo file after each phase)
- [ ] Open the demo file, categorize 5 transactions quickly. The UI updates instantly, "Saving…" changes to "Saved", and the file on disk matches after 1 s.
- [ ] Turn on encryption, then edit. Saves stay fast (no ~100–300 ms pause per click). Close and reopen with the password.
- [ ] Open a v1-encrypted file (made with the old build). It loads, and after the first save the envelope is `budgetEncV1: 2`.
- [ ] Edit the data file in a text editor while the app is open, then edit in the app. The conflict modal appears, and both choices work.
- [ ] Undo: delete a transaction, categorize another, undo → only the categorization is undone. Undo again → the deleted transaction comes back.
- [ ] Switch files in Settings, press Ctrl+Z → nothing happens (the history is empty).
- [ ] Close the window right after an edit → the edit is on disk.
- [ ] Fresh profile (clear localStorage): a backup appears in `<data dir>/kestl-backups` at startup. For an encrypted file the backup is encrypted. Pruning keeps 5.
- [ ] Create a recurring template → only the current month is generated. Delete it → it stays deleted after restart.
- [ ] Try to delete a category that's in use → archive/merge modal. Archived category is gone from pickers and still shown on old transactions.
- [ ] Merge two categories that both have budgets in the same month → the amounts are added together.
- [ ] Import a CSV with a custom parser → works. A parser containing `while(true){}` fails after 10 s without freezing the app.
- [ ] Budget, Year, Savings and Transactions totals are unchanged from before Phase 4 on the demo file.
