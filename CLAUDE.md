# Claude Code Guidelines for kestl

## Versioning — DO NOT manually edit version numbers

Version numbers are managed automatically by **release-please**. The single source of truth is:

```
src-tauri/tauri.conf.json  →  "version": "x.y.z"
```

`src-tauri/Cargo.toml` and the UI version display are kept in sync automatically:
- `Cargo.toml` is updated by release-please alongside `tauri.conf.json`
- The UI reads `__APP_VERSION__` injected by Vite at build time from `tauri.conf.json`

**Never manually edit version numbers in any file.** release-please reads commit messages to determine the bump and opens a PR to do it.

## Commit messages — always use Conventional Commits

Every commit must follow the [Conventional Commits](https://www.conventionalcommits.org/) format:

```
<type>[optional scope]: <description>

[optional body]
```

| Prefix | Effect | Example |
|--------|--------|---------|
| `fix:` | patch bump (1.2.x) | `fix: duplicate detection for pending transactions` |
| `feat:` | minor bump (1.x.0) | `feat: add parser rename in settings` |
| `feat!:` or `BREAKING CHANGE:` | major bump (x.0.0) | `feat!: new data format` |
| `chore:`, `docs:`, `refactor:`, `test:` | no bump | `chore: update dependencies` |

release-please reads these prefixes to build the CHANGELOG and decide the version bump.

## Release flow

See `.github/workflows/release-please.yml` and `release.yml` for the full pipeline.

---

## Directory map

### `src/` (React/TypeScript frontend)

```
src/
├── App.tsx                     # Root router — renders the active view
├── db.ts                       # ALL in-memory state + persistence (2400 lines — the heart of the app)
├── seed.ts                     # Default categories/budgets for new files; demo data
├── main.tsx                    # React entry point
├── global.d.ts                 # __APP_VERSION__ and other global type declarations
│
├── components/
│   ├── ImportView.tsx           # CSV/Amazon/PayPal import UI; orchestrates the full import pipeline
│   ├── BudgetView.tsx           # Monthly budget overview (spend vs target per category)
│   ├── TransactionView.tsx      # Transaction list; inline categorization and editing
│   ├── SettingsView.tsx         # Encryption, category rules, budget groups, parser management
│   ├── SavingsView.tsx          # Savings buckets and entry log
│   ├── YearView.tsx             # Year-to-date summary across months
│   ├── AIPanel.tsx              # Chat interface to the local Ollama assistant
│   ├── TransactionLookup.tsx    # ? window: step-by-step lookup, recommends only (never sets a category itself)
│   ├── SuggestionDetails.tsx    # ⓘ window: why the suggestion chip guessed (or didn't); no AI
│   ├── ParserGenerator.tsx      # LLM-powered builder for custom CSV parsers
│   ├── SplitEditor.tsx          # UI for splitting a transaction across categories
│   ├── MortgageTool.tsx         # Mortgage balance tracking and amortization
│   ├── ToolsView.tsx            # Launcher for MortgageTool and other utilities
│   ├── ExperimentalBudgetsView.tsx  # Named budget templates (import/export/apply)
│   ├── FileSetup.tsx            # First-run: create or open a .budget file
│   ├── PasswordPrompt.tsx       # Password entry for encrypted files
│   ├── ImportBudgetCard.tsx     # Single budget line item used inside ImportView
│   ├── SearchableSelect.tsx     # Reusable filterable dropdown
│   └── DateInput.tsx            # Date picker widget
│
├── logic/
│   ├── categorize.ts            # Rule matching + 4-tier fuzzy scoring (import-time and on-demand)
│   ├── duplicates.ts            # Count-based duplicate detection for incoming CSV rows
│   ├── matching.ts              # PayPal-to-bank-debit linking
│   ├── refunds.ts               # Refund candidate detection and month-date adjustment
│   ├── llm.ts                   # Ollama API calls: chat, ollamaJson, searchWeb, generateParser
│   ├── lookup.ts                # ? lookup pipeline: history → AI query → search → AI reading → AI category
│   ├── recurring.ts             # Generates transactions from RecurringTemplate records
│   ├── savings.ts               # Savings balance calculations
│   └── dateUtils.ts             # Date arithmetic helpers
│
├── parsers/
│   ├── csv.ts                   # Built-in Scotiabank CSV parser (chequing + credit card)
│   ├── paypal.ts                # PayPal activity paste parser
│   ├── amazon.ts                # Amazon orders & payments HTML/CSV parser
│   └── xlsx.ts                  # Excel import for budget templates and rule sets
│
└── utils/
    ├── crypto.ts                # AES-256-GCM encryption (PBKDF2-SHA256, 100k iterations)
    ├── format.ts                # Currency/number formatting helpers
    └── export.ts                # CSV export
```

### `src-tauri/src/` (Rust backend)

```
src-tauri/src/
├── main.rs     # App entry point — just calls lib::run()
└── lib.rs      # All Tauri command handlers, AppState, config I/O (389 lines)
```

---

## Tauri IPC command surface

All commands are in `src-tauri/src/lib.rs` (388 lines — read it directly for signatures). Invoked from the frontend with `invoke('command_name', { ...args })`. Covers file management, Ollama install/start, and DuckDuckGo search (`search_ddg`, used by TransactionLookup).

**Config file path:** `~/.config/budget-app/config.json` — stores only `{ "last_file": "/path/to/file.budget" }`.

---

## State management

### Where budget data lives in memory

`src/db.ts` is a module-level singleton — not React context, not Zustand. The entire app state (`data`, `filePath`, `sessionPassword`) is one mutable object declared at `db.ts:255`.

React components read state via `useSyncExternalStore(subscribe, getData)`. `persist()` gives `data` **and every top-level array** a new reference (`refreshRefs()`), so `useMemo`/`WeakMap` caches keyed on `data.transactions` etc. invalidate correctly. Inside `db.ts` always read `data.x` after an `await`, never a captured local array.

### `AppData` interface (db.ts:198)

Field names are self-descriptive; read the interface directly at `db.ts:198` rather than mirroring it here. See "Adding a new persistent field to AppData" below for the three-step pattern when extending it.

### Persistence pattern

Every mutation function in `db.ts` follows:
```typescript
export async function addTransaction(txn: Omit<Transaction, 'id'>): Promise<number> {
  pushUndoSnapshot('Add transaction');   // one snapshot per user action, with a label
  const id = nextId();
  data.transactions.push({ id, ...txn });
  await persist();                       // updates the UI now; the disk write is debounced
  return id;
}
```

`persist()` only refreshes array references, notifies listeners and calls `scheduleSave()` (400 ms debounce). The background save (`runSave`):
1. `JSON.stringify` (pretty for plaintext, compact before encrypting)
2. If encrypted: `encryptWithKey(json, sessionKey)` — the PBKDF2 key is derived **once per session**, each save uses a fresh IV
3. `invoke('save_data', { path, data, expectedMtime })` — atomic (temp file + rename) and conflict-checked; a changed mtime rejects with `CONFLICT`
4. Status (`idle | pending | saving | error | conflict`) is exposed via `getSaveStatus()` / `subscribeSaveStatus()`

Call `await flushSave()` when something must be on disk now (switching files, backups, window close). Saves are serialized; errors retry with backoff.

### Load / startup

`loadFromFile()` (db.ts:320):
1. `await flushSave()` for the file being left, then `invoke('load_data', { path })` reads the raw string
2. Detect encrypted (`isEncryptedFile` checks for `budgetEncV1` key)
3. Decrypt with `decryptWithPassword` (keeps the session key; v1 files are re-saved once as v2)
4. `data = { ...emptyData(), ...parsed }` — missing fields get defaults (handles old file formats)
5. Normalize missing transaction fields (`instrument`, `descriptor`, etc.)
6. `runStartupJobs()` (`src/startup.ts`, called by App and after switching files) runs `startupCleanup()` → `processRecurringTemplates()` → `processSchedules()` → `flushSave()` → `runBackup('startup')`, strictly in sequence. Data fixes in `startupCleanup()` are one-time migrations keyed in `completedMigrations`.

### Undo

`_undoStack` holds up to 10 `{ label, snap }` entries. **One user action = one snapshot**: every user-initiated mutator calls `pushUndoSnapshot('<label>')`; multi-step actions wrap themselves in `withUndo(label, fn)` (one snapshot, nested ones suppressed). Background jobs use `withoutUndo`. Loading another file clears the stack. `undo()` pops, restores and `persist()`s.

### Encryption

`utils/crypto.ts` — AES-256-GCM with PBKDF2-SHA256 (600,000 iterations for v2; v1 files used 100,000 and are upgraded on first save). On-disk format:
```json
{ "budgetEncV1": 2, "kdf": "PBKDF2-SHA256", "iterations": 600000, "salt": "<base64>", "iv": "<base64>", "data": "<base64 ciphertext>" }
```
`sessionPassword` lives only in memory and is never written anywhere.

---

## Key data flows

See the `kestl-data-flows` skill for diagrams of the CSV import pipeline, category suggestion scoring tiers, and the save/load cycle.

---

## Conventions

### Naming

| Pattern | Meaning |
|---|---|
| `add*()`, `update*()`, `delete*()`, `set*()` in db.ts | Async mutators — always call `persist()` |
| `get*()`, `find*()`, `detect*()`, `compute*()` | Read-only, synchronous |
| `txn` | A `Transaction` object |
| `cat` / `catId` | Category / category ID |
| `norm` / `normalized` | `s.trim().replace(/\s+/g, ' ').toLowerCase()` — always this exact transform |
| `descriptor` | Raw merchant string from the bank |
| `instrument` | Parser name string (e.g. `"Scotiabank Credit Card CSV"`) |
| `rule` | A `CategoryRule` object |

### Where to add a new built-in parser

See the `kestl-extension-points` skill.

### Where rules vs. scoring live

| Concern | Location |
|---|---|
| Rule-based categorization at import time | `categorizeTransactionsInPlace()` — `logic/categorize.ts:156` |
| Apply a rule retroactively to history | `runRuleOnHistory()` — `logic/categorize.ts:259` |
| History-based suggestions (merchant parsing, weighted vote) | `parseDescriptor()` / `buildSuggester()` — `logic/suggest.ts` |
| AI merchant labels (kind of business, saved in `AppData.merchantTypes`) | `classifyMerchants()` — `logic/aiSuggest.ts` |
| Why the chip did/didn't guess (trace + notes) | `buildSuggester().explain()` — `logic/suggest.ts` |
| `?` lookup (AI query, web search, AI reading, AI category; saved per merchant in `AppData.merchantLookups`) | `runLookup()` — `logic/lookup.ts` |
| Bulk categorize by pattern (no rule saved) | `bulkCategorizeByDescriptor()` — `logic/categorize.ts:215` |
| Create rule + apply immediately | `createRuleAndApply()` — `logic/categorize.ts:290` |

### Rule matching semantics

- `matchType: 'exact'` — `normalize(rule.pattern) === normalize(txn.descriptor)`
- `matchType: 'contains'` — `normalize(txn.descriptor).includes(normalize(rule.pattern))`
- `amountMatch` — optional; must be within `$0.01`
- All rules iterate in array order; **last match wins** (allows override rules at the end)
- Rules with `splits` (≥2 items) record a `SplitAction` instead of setting `categoryId`

### Adding a new persistent field to AppData, or a new Tauri command

See the `kestl-extension-points` skill.

### Split transactions

**If a transaction has splits, the splits are used for totals and the parent `categoryId` is ignored.** Use `isCategorized(t, splitsIndex)` (`logic/spend.ts`) — a transaction is categorized if it has a category OR splits. Rule runs (`recategorizeAll`, `runRuleOnHistory`) skip transactions that already have splits. Split amounts are rounded to cents and any remainder goes to the last split (`resolveSplits`). A split transaction has `categoryId = null` at the parent level; the budget amounts come from `transactionSplits` rows. `TransactionSplit.txnDate` is an optional override — if set, that split portion counts toward a different month than the parent transaction. This is used for mortgage principal vs. interest splits that cross month boundaries.

### Transaction kinds

`ignoreInBudget` means **credit** (money in), despite its name — use `isCredit(t)` / `isPaypalLinked(t)` from `logic/txnKind.ts` for reads. `isTransfer` marks movement between your own accounts: it is excluded from every aggregate, suggestion corpus and savings balance. All "spent per category per month" math lives in `logic/spend.ts` (`getMonthAggregates`, cached per array reference); don't re-implement it.

### Categories

Categories in use can't be deleted — archive them (`setCategoryArchived`, hidden from pickers via `!c.archived`) or merge them (`mergeCategories` adds budgets and re-points every reference).
