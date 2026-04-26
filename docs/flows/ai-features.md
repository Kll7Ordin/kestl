# AI features

All AI features call a local [Ollama](https://ollama.com) instance over HTTP. No data leaves the machine. The default model is `qwen2.5:7b`; this is configurable in Settings → AI.

**Required setup:** Ollama running at `http://localhost:11434` (default) with a model pulled. The app can install and start Ollama on Linux directly from Settings or the parser generator UI.

---

## 1. Custom parser generation

User uploads a sample CSV → LLM writes a `parseTransactions(text, filename)` JavaScript function → the app evals it in-memory → user previews results → save or retry with feedback.

```mermaid
flowchart LR
    A["Upload sample CSV\nParserGenerator.tsx"] --> B["checkOllama()\nllm.ts — verify reachable"]
    B -->|"not running"| C["Prompt: Start / Install Ollama"]
    B -->|"ok"| D["generateParser()\nllm.ts"]
    D --> E["POST /api/chat\nOllama — PARSER_SYSTEM_PROMPT\nfirst 25 lines of sample"]
    E --> F["JS function string\nparseTransactions(text, filename)"]
    F --> G["executeCustomParser()\ndb.ts — eval in sandbox"]
    G --> H["Preview table\ndate / descriptor / amount / type"]
    H -->|"looks right"| I["saveCustomParser()\ndb.ts"]
    H -->|"wrong"| J["Feedback text\n+ previous code sent back to LLM"]
    J --> D
    I --> K[("AppData.customParsers")]
```

**Key detail:** if the generated parser returns 0 results on the real file but works on the sample, the app auto-detects this and offers "Fix with feedback" rather than silently failing. The retry path sends the original sample, the broken code, and the user's description of the problem to the LLM together.

---

## 2. Transaction deep dive

User clicks `?` on a transaction → `lookupTransaction()` runs a web search and asks the LLM to identify the merchant and pick a category. The user can accept the suggested category with one click.

```mermaid
flowchart LR
    A["Click ? on transaction\nTransactionLookup.tsx"] --> B["lookupTransaction()\nllm.ts"]
    B --> C["cleanDescriptorForSearch()\nllm.ts — strip POS codes, trailing numbers"]
    C --> D["search_ddg()\ninvoke Tauri — DuckDuckGo HTML"]
    D --> E["Web snippets\nup to 6 results"]
    B --> F["History frequency analysis\ndescFreq + wordFreq maps\nfrom categorized transactions"]
    E --> G["POST /api/chat\nOllama — structured JSON prompt\ntemperature 0.1"]
    F --> G
    G --> H["LookupResult\ncategoryId + categoryName + info"]
    H --> I["Display in modal\nmerchant info + suggested category chip"]
    I -->|"user clicks chip"| J["updateTransaction()\ndb.ts — assign categoryId"]
```

**Key detail:** the web search is always run before the LLM call (not as a tool call) because small local models like `qwen2.5:7b` reliably call tools when the context is short. The LLM receives both the search results and the history-based suggestion in a single prompt and responds with JSON only.

---

## 3. Structured budget questions (AIPanel)

The AI button opens `AIPanel.tsx`, which presents four pre-defined question types. The app builds the full data answer itself (`buildStructuredAnswer()`) and asks the LLM only for a 1–2 sentence interpretation. This makes answers accurate even with small models.

```mermaid
flowchart LR
    A["Select question type\nAIPanel.tsx\n4 options: planned_comparison\nover_budget / category_high / category_low"] --> B["answerStructuredQuestion()\nllm.ts"]
    B --> C["buildStructuredAnswer()\nllm.ts — pure data computation\nno LLM involved"]
    C --> D["Preamble: real numbers\nfrom AppData — targets, actuals, diffs"]
    D --> E["POST /api/chat\nOllama — short interpretation prompt\ntemperature 0.3"]
    E --> F["1-2 sentence commentary"]
    F --> G["preamble + commentary\nrendered in AIPanel"]
```

**Four question types:**
- `planned_comparison` — compares budget targets between two months (requires `monthA`, `monthB`)
- `over_budget` — lists categories that exceeded their target in a given month
- `category_high` — shows all transactions for a category in a month, largest first
- `category_low` — shows a category's transactions vs the prior 3 months; identifies missing descriptors

**Key detail:** `sendChat()` is defined in `llm.ts` (full tool-calling chat loop with all six tools) but is not called by any component in the current codebase. `AIPanel.tsx` uses only `answerStructuredQuestion()`.

---

## Files involved

| File | Role |
|---|---|
| `src/logic/llm.ts` | `generateParser()`, `lookupTransaction()`, `answerStructuredQuestion()`, `buildStructuredAnswer()`, `checkOllama()`, `cleanDescriptorForSearch()`, `sendChat()` (unused) |
| `src/components/ParserGenerator.tsx` | Parser generation UI — 4-step flow: create → preview → confirm → wrong |
| `src/components/TransactionLookup.tsx` | Deep-dive modal — calls `lookupTransaction()`, renders result, applies category |
| `src/components/AIPanel.tsx` | Structured question panel — renders 4 question-type buttons, calls `answerStructuredQuestion()` |
| `src/db.ts` | `executeCustomParser()`, `saveCustomParser()`, `updateTransaction()`, `getAISettings()` |
| `src-tauri/src/lib.rs` | `search_ddg` (DuckDuckGo), `find_ollama`, `install_ollama`, `start_ollama` |
