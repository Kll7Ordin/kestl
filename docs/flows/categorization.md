# Categorization flow

There are two distinct categorization mechanisms. **Rule-based assignment** runs at import time inside `categorizeTransactionsInPlace()` and assigns a `categoryId` (or records a split action) before transactions are persisted. **Suggestion scoring** runs on demand via `computeGuessScores()` / `guessCategory()` for transactions that didn't match any rule — it compares against all existing categorized transactions and produces a ranked score map.

## Decision flow

```mermaid
flowchart TD
    A["Incoming transaction\ndescriptor + amount"] --> B["normalize()\ntrim + lowercase + collapse whitespace"]

    B --> C{"Match any CategoryRule?\ncategorize.ts:169\niterate in array order, last match wins"}

    C -->|"matched"| D{"Rule has splits array\nlength >= 2?"}
    D -->|"yes"| E["Record SplitAction\ntxnIndex + resolved amounts\nno categoryId set"]
    D -->|"no"| F["Set txn.categoryId\n= rule.categoryId"]

    C -->|"no rule matched"| G["computeGuessScores()\ncategorize.ts:56\nscan all categorized transactions"]

    G --> T1["Tier 1 — 40 pts\nnorm === tNorm\nexact normalized match"]
    G --> T2["Tier 2 — 25 pts\nstripIds matches\nremoves 6+ digit seqs and #ref tokens\nrequires stripped.length > 2"]
    G --> T3["Tier 3 — 10 pts\ndiceSimilarity >= 0.6\nDice coefficient on trigrams"]
    G --> T4["Tier 4 — 1 pt each\nshared meaningful keywords\nlen >= 3, not in NOISE_WORDS"]

    T1 --> ACC["Accumulate score\nper categoryId"]
    T2 --> ACC
    T3 --> ACC
    T4 --> ACC

    ACC --> WIN["guessCategory()\nreturn highest-scoring categoryId\nor null if no matches"]
```

## Rule matching details

Rules are stored in `AppData.categoryRules` and iterated in array order. **Last match wins** — a rule at the end of the list overrides earlier ones. There is no automatic sorting by length or specificity; ordering is fully user-controlled.

`matchType: 'exact'` — `normalize(rule.pattern) === normalize(txn.descriptor)`
`matchType: 'contains'` — `normalize(txn.descriptor).includes(normalize(rule.pattern))`

Optional `amountMatch` — must be within `$0.01` of `txn.amount`.

## Scoring details

**Noise word filtering (Tier 4)** — the `NOISE_WORDS` set (`categorize.ts:25`) excludes common filler: articles, prepositions, payment-type words (`pos`, `purchase`, `debit`, `credit`, `transfer`, `deposit`, `withdrawal`, `payment`), Canadian provincial abbreviations (`bc`, `ab`, `on`, `qc`, …), and corporate suffixes (`inc`, `ltd`, `corp`, `co`, `company`).

**Trigram similarity (Tier 3)** — `diceSimilarity(a, b)` computes `(2 × |intersection|) / (|trigramsA| + |trigramsB|)` where each trigram set is built from all 3-character substrings. Threshold is `0.6`.

**Batch variant** — `batchGetGuessScores()` (`categorize.ts:108`) pre-processes the full transaction corpus once, then scores multiple query descriptors against it. Used when computing suggestions for many transactions simultaneously to avoid redundant `normalize`/`stripIds` work.

## Files involved

| File | Role |
|---|---|
| `src/logic/categorize.ts` | All categorization logic: `categorizeTransactionsInPlace`, `computeGuessScores`, `guessCategory`, `batchGetGuessScores`, `runRuleOnHistory`, `createRuleAndApply` |
| `src/db.ts` | Stores `categoryRules` and `transactions`; `getData()` is called to read both |
| `src/components/ImportView.tsx` | Calls `categorizeTransactionsInPlace()` before inserting transactions |
| `src/components/TransactionView.tsx` | Calls `batchGetGuessScores()` to render suggestion chips on uncategorized rows |
| `src/components/SettingsView.tsx` | Calls `runRuleOnHistory()` when user applies a rule retroactively |
