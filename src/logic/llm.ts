import { invoke } from '@tauri-apps/api/core';
import {
  getData,
  updateTransaction,
  addCategoryRule,
  upsertBudget,
  type AppData,
  type AISettings,
  type CustomParser,
  type AICategoryFeedback,
} from '../db';

export { type AISettings };

export interface DDGResult {
  title: string;
  snippet: string;
}

export interface OllamaModel {
  name: string;
  size: number;
}

export const DEFAULT_AI_SETTINGS: AISettings = {
  ollamaUrl: 'http://localhost:11434',
  model: 'qwen2.5:7b',
};

export const RECOMMENDED_MODELS = [
  { name: 'qwen2.5:7b', label: 'Qwen 2.5 7B — recommended (~4.7GB VRAM)' },
  { name: 'qwen2.5-coder:7b', label: 'Qwen 2.5 Coder 7B (~4.7GB VRAM)' },
  { name: 'llama3.2:3b', label: 'Llama 3.2 3B — fast, lower quality (~2GB VRAM)' },
  { name: 'mistral:7b', label: 'Mistral 7B (~4.1GB VRAM)' },
  { name: 'qwen2.5:14b', label: 'Qwen 2.5 14B — best quality (needs 12GB+ VRAM)' },
];

export async function checkOllama(url: string): Promise<boolean> {
  try {
    const resp = await fetch(`${url}/api/version`, { signal: AbortSignal.timeout(3000) });
    return resp.ok;
  } catch {
    return false;
  }
}

export async function listModels(url: string): Promise<string[]> {
  try {
    const resp = await fetch(`${url}/api/tags`);
    const json = await resp.json();
    return (json.models ?? []).map((m: { name: string }) => m.name);
  } catch {
    return [];
  }
}

export async function pullModel(
  url: string,
  model: string,
  onProgress: (status: string, pct?: number) => void,
): Promise<boolean> {
  try {
    const resp = await fetch(`${url}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: model, stream: true }),
    });
    if (!resp.body) return false;
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const line of dec.decode(value).split('\n').filter(Boolean)) {
        try {
          const obj = JSON.parse(line);
          if (obj.total && obj.completed) {
            onProgress(obj.status ?? 'Downloading…', Math.round((obj.completed / obj.total) * 100));
          } else if (obj.status) {
            onProgress(obj.status);
            if (obj.status === 'success') return true;
          }
        } catch { /* skip */ }
      }
    }
    return true;
  } catch {
    return false;
  }
}

// Clean a bank descriptor into a human-readable search query
export function cleanDescriptorForSearch(descriptor: string): string {
  let q = descriptor
    .replace(/^(POS\s+|PURCHASE\s+|DEBIT\s+|CREDIT\s+|VISA\s+|MC\s+|MASTERCARD\s+|INTERAC\s+|SQ\s*\*|AMEX\s+|PYMT\s+|ACH\s+)+/gi, '')
    .replace(/\s+\d{6,}(\s+\d{4,})*\s*$/g, '')  // trailing long numbers
    .replace(/\s+[A-Z]{2}\s+\d{5}(\s*$)/g, '')   // US state + zip
    .replace(/\s+[A-Z]{2,3}\s*$/g, '')            // trailing state/country code
    .trim();
  // Take at most 4 words
  const words = q.split(/\s+/).filter((w) => w.length > 1);
  if (words.length > 4) q = words.slice(0, 4).join(' ');
  return q || descriptor.split(/\s+/).slice(0, 3).join(' ');
}

// --- Tool definitions ---
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_transactions',
      description: 'Query transactions from the budget app. Returns matching transactions with amounts and categories.',
      parameters: {
        type: 'object',
        properties: {
          descriptor_contains: { type: 'string', description: 'Filter by descriptor text (case-insensitive substring match)' },
          month: { type: 'string', description: 'Filter by month in YYYY-MM format' },
          limit: { type: 'number', description: 'Max results to return (default 30, max 100)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_budget_summary',
      description: 'Get spending vs budget targets for a given month.',
      parameters: {
        type: 'object',
        properties: {
          month: { type: 'string', description: 'Month in YYYY-MM format. Omit for current month.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_transaction',
      description: 'Update fields on a specific transaction. Only include fields you want to change. Always confirm with the user before calling this unless they explicitly asked you to make the change.',
      parameters: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'number', description: 'Transaction ID' },
          categoryId: { type: 'number', description: 'New category ID. Use null to remove category.' },
          comment: { type: 'string', description: 'Comment text. Use null to clear.' },
          ignoreInBudget: { type: 'boolean', description: 'If true, exclude this transaction from budget calculations.' },
          descriptor: { type: 'string', description: 'New descriptor/description text.' },
          txnDate: { type: 'string', description: 'New date in YYYY-MM-DD format.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_web',
      description: 'Search DuckDuckGo for information about a transaction descriptor to identify an unknown merchant or service. Strip POS codes and account numbers before searching.',
      parameters: {
        type: 'object',
        required: ['query'],
        properties: {
          query: { type: 'string', description: 'Clean search query — remove POS codes, card numbers, merchant IDs, and location abbreviations.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_category_rule',
      description: 'Add a categorization rule so future transactions from this merchant are automatically categorized. Only add if the user confirms or explicitly asks.',
      parameters: {
        type: 'object',
        required: ['pattern', 'categoryId', 'matchType'],
        properties: {
          pattern: { type: 'string', description: 'Lowercase pattern to match against transaction descriptors' },
          categoryId: { type: 'number', description: 'ID of the category to assign' },
          matchType: { type: 'string', enum: ['exact', 'contains'], description: 'Whether to require exact match or just containment' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_budget_target',
      description: 'Change the budget target amount for a category in a given month.',
      parameters: {
        type: 'object',
        required: ['month', 'categoryId', 'targetAmount'],
        properties: {
          month: { type: 'string', description: 'YYYY-MM format' },
          categoryId: { type: 'number', description: 'Category ID' },
          targetAmount: { type: 'number', description: 'New target amount in dollars' },
        },
      },
    },
  },
];

function currentMonthStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function buildSystemPrompt(appData: AppData): string {
  const catList = appData.categories
    .map((c) => `  ${c.id}: ${c.name}${c.isIncome ? ' (income)' : ''}`)
    .join('\n');

  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
  const cutoff = sixMonthsAgo.toISOString().slice(0, 10);

  const catMap = new Map(appData.categories.map((c) => [c.id, c.name]));
  const recentTxns = appData.transactions
    .filter((t) => t.txnDate >= cutoff)
    .slice(-300)
    .map((t) => {
      const cat = t.categoryId ? (catMap.get(t.categoryId) ?? '?') : 'uncategorized';
      const sign = t.ignoreInBudget || t.amount < 0 ? '+' : '-';
      return `  [${t.id}] ${t.txnDate} ${sign}$${Math.abs(t.amount).toFixed(2)} "${t.descriptor}" cat:${cat} via:${t.instrument}${t.comment ? ` note:"${t.comment}"` : ''}`;
    })
    .join('\n');

  const curMonth = currentMonthStr();

  const budgetGroups = appData.budgetGroups ?? [];
  const groupMap = new Map(budgetGroups.map((g) => [g.id, g.name]));
  const currentBudgets = appData.budgets
    .filter((b) => b.month === curMonth)
    .map((b) => {
      const catName = appData.categories.find((c) => c.id === b.categoryId)?.name ?? '?';
      const grpName = b.groupId ? (groupMap.get(b.groupId) ?? 'ungrouped') : 'ungrouped';
      return `  ${catName} (group: ${grpName}): target $${b.targetAmount}`;
    })
    .join('\n');

  return `You are the built-in financial assistant for a personal desktop budgeting app. Current month: ${curMonth}.

## HOW THIS APP WORKS
- **Transactions**: Every expense/income imported from bank CSV files. Each has a descriptor (merchant name), amount (positive = expense, negative = credit/refund), date, instrument (which card/account), and optionally a category.
- **Categories**: User-defined labels (e.g. "Groceries", "Gas"). Assigned to transactions manually or via category rules.
- **Budget**: Monthly spending targets per category. Set by the user. "Spent" = actual transactions in that category this month. "Remaining" = target minus spent.
- **Groups**: Categories are organized into budget groups (e.g. "Fixed", "Variable", "Occasional"). The "Occasional" group is special — its spending comes from savings, not the monthly budget.
- **ignoreInBudget = true**: Credits, refunds, income transfers — excluded from spending totals. Negative amounts are also credits.
- **YTD**: Year-to-date spending vs target, starting from January.
- **Instruments**: Which account the transaction came from — e.g. "Card" = Visa, "Chequing" = bank account.
- **Category Rules**: Patterns that auto-assign categories when transactions are imported.

## YOUR JOB
Answer questions about the user's specific spending, budget, and transactions using the data below and the tools available.
- Be specific: use real amounts, real category names, real transaction descriptors from the data.
- Do NOT give generic financial advice. Use the actual numbers.
- When asked about a month, call get_budget_summary for that month first.
- When asked about a specific merchant or transaction, call get_transactions.
- Format amounts as $X (whole dollars). Only show cents if they matter.
- Keep answers to 2-4 sentences unless the user asks for a list.

## CURRENT MONTH BUDGET (${curMonth})
${currentBudgets || '  (no budget set for this month)'}

## CATEGORIES
${catList}

## RECENT TRANSACTIONS (last 6 months, newest first)
${recentTxns || '  (none)'}

## TOOLS
- get_budget_summary(month): returns target vs spent for every category in that month
- get_transactions(descriptor_contains, month, limit): search transactions by keyword or month
- update_transaction(id, categoryId/comment/descriptor/txnDate): modify a transaction — ALWAYS confirm first
- search_web(query): look up an unknown merchant online
- add_category_rule(pattern, categoryId, matchType): auto-categorize future imports
- update_budget_target(month, categoryId, targetAmount): change a budget target

## RULES
- Never dump all data unprompted — answer the specific question asked
- If you don't have enough data, call a tool to get it
- Confirm before modifying anything
- If asked "how much did I spend on X", call get_transactions or get_budget_summary — don't guess`;
}

async function executeTool(
  name: string,
  args: Record<string, unknown>,
  appData: AppData,
): Promise<string> {
  switch (name) {
    case 'get_transactions': {
      let txns = appData.transactions;
      if (args.descriptor_contains) {
        const q = String(args.descriptor_contains).toLowerCase();
        txns = txns.filter((t) => t.descriptor.toLowerCase().includes(q));
      }
      if (args.month) {
        const m = String(args.month);
        txns = txns.filter((t) => t.txnDate.startsWith(m));
      }
      const limit = Math.min(Number(args.limit) || 30, 100);
      txns = [...txns].sort((a, b) => b.txnDate.localeCompare(a.txnDate)).slice(0, limit);
      const catMap = new Map(appData.categories.map((c) => [c.id, c.name]));
      return JSON.stringify(
        txns.map((t) => ({
          id: t.id,
          date: t.txnDate,
          amount: t.amount,
          descriptor: t.descriptor,
          category: t.categoryId ? (catMap.get(t.categoryId) ?? null) : null,
          instrument: t.instrument,
          ignoreInBudget: t.ignoreInBudget,
          comment: t.comment,
        })),
      );
    }

    case 'get_budget_summary': {
      const month = String(args.month || currentMonthStr());
      const txns = appData.transactions.filter(
        (t) => t.txnDate.startsWith(month) && !t.ignoreInBudget && t.amount > 0,
      );
      const spending = new Map<number, number>();
      for (const t of txns) {
        if (t.categoryId) spending.set(t.categoryId, (spending.get(t.categoryId) ?? 0) + t.amount);
      }
      const catMap = new Map(appData.categories.map((c) => [c.id, c.name]));
      const budgets = appData.budgets
        .filter((b) => b.month === month)
        .map((b) => ({
          category: catMap.get(b.categoryId) ?? '?',
          categoryId: b.categoryId,
          target: b.targetAmount,
          spent: +(spending.get(b.categoryId) ?? 0).toFixed(2),
          remaining: +(b.targetAmount - (spending.get(b.categoryId) ?? 0)).toFixed(2),
        }));
      const uncategorizedSpend = txns
        .filter((t) => !t.categoryId)
        .reduce((sum, t) => sum + t.amount, 0);
      return JSON.stringify({ month, budgets, uncategorizedSpend: +uncategorizedSpend.toFixed(2) });
    }

    case 'update_transaction': {
      const { id, ...rest } = args as { id: number } & Record<string, unknown>;
      const changes: Partial<{
        categoryId: number | null;
        comment: string | null;
        ignoreInBudget: boolean;
        descriptor: string;
        txnDate: string;
      }> = {};
      if ('categoryId' in rest) changes.categoryId = rest.categoryId as number | null;
      if ('comment' in rest) changes.comment = rest.comment as string | null;
      if ('ignoreInBudget' in rest) changes.ignoreInBudget = Boolean(rest.ignoreInBudget);
      if ('descriptor' in rest) changes.descriptor = String(rest.descriptor);
      if ('txnDate' in rest) changes.txnDate = String(rest.txnDate);
      await updateTransaction(id, changes);
      return JSON.stringify({ success: true, message: `Transaction ${id} updated.` });
    }

    case 'search_web': {
      try {
        const results = await invoke<DDGResult[]>('search_ddg', { query: String(args.query) });
        if (!results || results.length === 0) return JSON.stringify({ results: [], note: 'No results found.' });
        return JSON.stringify({ results });
      } catch (e) {
        return JSON.stringify({ error: String(e), note: 'Search failed.' });
      }
    }

    case 'add_category_rule': {
      await addCategoryRule({
        matchType: args.matchType as 'exact' | 'contains',
        pattern: String(args.pattern).toLowerCase(),
        categoryId: Number(args.categoryId),
        amountMatch: null,
      });
      return JSON.stringify({ success: true });
    }

    case 'update_budget_target': {
      await upsertBudget(String(args.month), Number(args.categoryId), Number(args.targetAmount));
      return JSON.stringify({ success: true });
    }

    default:
      return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
}

export interface LLMMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  name?: string;
}

interface OllamaMsg {
  role: string;
  content: string;
  tool_calls?: Array<{ function: { name: string; arguments: unknown } }>;
  tool_call_id?: string;
  name?: string;
}

/**
 * Send a message to the LLM. Pass the full conversation history.
 * Returns the updated history (includes tool messages) and the final text response.
 */
export async function sendChat(
  history: LLMMessage[],
  userMessage: string,
  settings: AISettings,
  onToolStatus: (status: string) => void,
  appData?: AppData,
): Promise<{ assistantText: string; newHistory: LLMMessage[] }> {
  const data = appData ?? getData();
  const systemPrompt = buildSystemPrompt(data);

  const conv: OllamaMsg[] = [
    { role: 'system', content: systemPrompt },
    ...history.map((m) => ({ role: m.role, content: m.content, tool_call_id: m.tool_call_id, name: m.name })),
    { role: 'user', content: userMessage },
  ];

  const newHistory: LLMMessage[] = [...history, { role: 'user', content: userMessage }];

  for (let i = 0; i < 6; i++) {
    const resp = await fetch(`${settings.ollamaUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: settings.model,
        messages: conv,
        tools: TOOLS,
        stream: false,
        options: { temperature: 0.3 },
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Ollama error ${resp.status}: ${errText}`);
    }

    const result = await resp.json();
    const msg: OllamaMsg = result.message;
    conv.push(msg);

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      const text = msg.content ?? '';
      newHistory.push({ role: 'assistant', content: text });
      return { assistantText: text, newHistory };
    }

    // Execute tool calls
    for (const tc of msg.tool_calls) {
      const toolName = tc.function.name;
      const toolArgs =
        typeof tc.function.arguments === 'string'
          ? JSON.parse(tc.function.arguments)
          : (tc.function.arguments as Record<string, unknown>);

      onToolStatus(`Using tool: ${toolName}…`);
      const toolResult = await executeTool(toolName, toolArgs, data);

      const toolMsg: OllamaMsg = { role: 'tool', content: toolResult, name: toolName };
      conv.push(toolMsg);
      newHistory.push({ role: 'tool', content: toolResult, name: toolName });
    }
  }

  const fallback = 'I was unable to complete your request after several attempts.';
  newHistory.push({ role: 'assistant', content: fallback });
  return { assistantText: fallback, newHistory };
}

export interface LookupResult {
  categoryId: number | null;
  categoryName: string | null;
  info: string;
}

/**
 * Single-shot lookup: identify a transaction using past history + web search.
 * Returns a structured result with a specific category suggestion + merchant info.
 */
export async function lookupTransaction(
  descriptor: string,
  amount: number,
  date: string,
  instrument: string,
  settings: AISettings,
  onToolStatus: (status: string) => void,
): Promise<LookupResult> {
  const data = getData();
  const catMap = new Map(data.categories.map((c) => [c.id, c.name]));

  // Fuzzy history match — same algorithm as TransactionView chips
  function normDesc(d: string): string {
    return d.toLowerCase().replace(/\d{4,}/g, '').replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim().split(' ').slice(0, 5).join(' ');
  }
  const descNorm = normDesc(descriptor);
  const descWords = descNorm.split(' ').filter((w) => w.length >= 4);

  // Build frequency maps from all categorized transactions
  const descFreq = new Map<string, Map<number, number>>();
  const wordFreq = new Map<string, Map<number, number>>();
  for (const t of data.transactions) {
    if (t.categoryId == null || t.ignoreInBudget) continue;
    const key = normDesc(t.descriptor);
    if (!key) continue;
    if (!descFreq.has(key)) descFreq.set(key, new Map());
    const dm = descFreq.get(key)!;
    dm.set(t.categoryId, (dm.get(t.categoryId) ?? 0) + 1);
    for (const w of key.split(' ').filter((w) => w.length >= 4)) {
      if (!wordFreq.has(w)) wordFreq.set(w, new Map());
      const wm = wordFreq.get(w)!;
      wm.set(t.categoryId, (wm.get(t.categoryId) ?? 0) + 1);
    }
  }

  // Determine history-based suggestion
  let historyCategoryId: number | null = null;
  let historyCategoryName: string | null = null;
  const exactFreq = descFreq.get(descNorm);
  if (exactFreq && exactFreq.size > 0) {
    historyCategoryId = [...exactFreq.entries()].sort((a, b) => b[1] - a[1])[0][0];
    historyCategoryName = catMap.get(historyCategoryId) ?? null;
  } else if (descWords.length > 0) {
    const combined = new Map<number, number>();
    for (const w of descWords) {
      const wf = wordFreq.get(w);
      if (!wf) continue;
      for (const [catId, cnt] of wf) combined.set(catId, (combined.get(catId) ?? 0) + cnt);
    }
    if (combined.size > 0) {
      historyCategoryId = [...combined.entries()].sort((a, b) => b[1] - a[1])[0][0];
      historyCategoryName = catMap.get(historyCategoryId) ?? null;
    }
  }

  // Collect similar past transactions with exact descriptor match (for context)
  const descLower = descriptor.toLowerCase();
  const similarTxns = data.transactions
    .filter((t) => t.descriptor.toLowerCase() === descLower && t.categoryId != null)
    .slice(-8)
    .map((t) => `  ${t.txnDate} $${Math.abs(t.amount).toFixed(2)} → ${catMap.get(t.categoryId!) ?? '?'}`);

  const searchQuery = cleanDescriptorForSearch(descriptor);

  // Build category list
  const catList = data.categories
    .filter((c) => !c.isIncome)
    .map((c) => `${c.id}: ${c.name}`)
    .join('\n');

  // Always run web search upfront — don't rely on the model to call the tool
  // (small local models like qwen often fail to use tools correctly)
  onToolStatus(`Searching for "${searchQuery}"…`);
  let webResults = '';
  try {
    webResults = await executeTool('search_web', { query: searchQuery }, data);
  } catch { /* search failure is non-fatal */ }

  const historyBlock = historyCategoryName
    ? `HISTORY: Past transactions matching this descriptor were categorized as "${historyCategoryName}".`
    : `HISTORY: No past transactions found matching this descriptor.`;

  const webBlock = webResults && !webResults.includes('"error"')
    ? `WEB SEARCH RESULTS for "${searchQuery}":\n${webResults}`
    : `WEB SEARCH: No results found.`;

  const question = `Identify this bank transaction and suggest a budget category.

TRANSACTION: "${descriptor}"
AMOUNT: $${Math.abs(amount).toFixed(2)} on ${date} via ${instrument}
${similarTxns.length > 0 ? `EXACT PAST MATCHES:\n${similarTxns.join('\n')}\n` : ''}
${historyBlock}

${webBlock}

AVAILABLE CATEGORIES (you MUST use one of these exact IDs):
${catList}

Based on the history and web results above, respond with JSON only:
{"categoryId": <integer id from list above, or null only if you truly cannot determine>, "categoryName": "<exact name for that id>", "info": "<2-3 sentences: what this merchant sells and why you picked this category>"}`;

  const conv: OllamaMsg[] = [
    {
      role: 'system',
      content: 'You are a bank transaction classifier. You are given search results and transaction history. Pick the best category from the provided list and respond with JSON only. No markdown, no explanation outside the JSON.',
    },
    { role: 'user', content: question },
  ];

  onToolStatus('Analyzing…');

  for (let i = 0; i < 3; i++) {
    const resp = await fetch(`${settings.ollamaUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: settings.model,
        messages: conv,
        stream: false,
        options: { temperature: 0.1 },
      }),
    });

    if (!resp.ok) throw new Error(`Ollama error ${resp.status}`);

    const result = await resp.json();
    const msg: OllamaMsg = result.message;
    conv.push(msg);

    const content = msg.content ?? '';
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as { categoryId?: number | null; categoryName?: string | null; info?: string };
        const finalCatId = (parsed.categoryId != null && catMap.has(parsed.categoryId))
          ? parsed.categoryId
          : historyCategoryId;
        const finalCatName = finalCatId ? (catMap.get(finalCatId) ?? null) : null;
        return { categoryId: finalCatId, categoryName: finalCatName, info: parsed.info ?? content };
      }
    } catch { /* fall through */ }

    // Non-JSON response — use what we have
    if (content.length > 10) {
      return { categoryId: historyCategoryId, categoryName: historyCategoryName, info: content };
    }
    // Empty response — retry
    conv.push({ role: 'user', content: 'Please respond with the JSON only, no other text.' });
  }

  return {
    categoryId: historyCategoryId,
    categoryName: historyCategoryName,
    info: historyCategoryName
      ? `Based on your transaction history, this is likely "${historyCategoryName}".`
      : 'Unable to determine category from history or web search.',
  };
}

// --- Category suggestions ---

export interface CategorySuggestion {
  txnId: number;
  categoryId: number;
  categoryName: string;
}

/**
 * Ask the LLM to suggest categories for a batch of uncategorized transactions.
 * Uses historical categorizations and past feedback — no web search.
 * Returns only confident suggestions; uncertain ones are omitted.
 */
export async function suggestCategories(
  transactions: Array<{ id: number; descriptor: string; amount: number; txnDate: string }>,
  categories: Array<{ id: number; name: string }>,
  settings: AISettings,
  feedback?: AICategoryFeedback[],
): Promise<CategorySuggestion[]> {
  if (transactions.length === 0) return [];

  const appData = getData();
  const catMap = new Map(categories.map((c) => [c.id, c.name]));

  // Build historical examples from already-categorized transactions
  const catById = new Map(appData.categories.map((c) => [c.id, c.name]));
  const historicalExamples = appData.transactions
    .filter((t) => t.categoryId != null && !t.ignoreInBudget)
    .slice(-200)
    .map((t) => `"${t.descriptor}" → ${catById.get(t.categoryId!) ?? '?'}`)
    .join('\n');

  // Past feedback: patterns where AI suggestions were accepted or corrected
  const feedbackLines = (feedback ?? [])
    .slice(-100)
    .map((f) => {
      const sug = catById.get(f.suggestedCategoryId) ?? '?';
      if (f.outcome === 'accepted') return `  "${f.descriptor}" → ${sug} ✓`;
      const accepted = f.acceptedCategoryId ? (catById.get(f.acceptedCategoryId) ?? '?') : 'none';
      return `  "${f.descriptor}" → suggested ${sug} but user chose ${accepted} ✗`;
    })
    .join('\n');

  const catList = categories.map((c) => `${c.id}: ${c.name}`).join('\n');
  const txnList = transactions
    .map((t) => `${t.id}: "${t.descriptor}" $${t.amount.toFixed(2)}`)
    .join('\n');

  const prompt = `You are categorizing bank transactions. Use historical patterns and your knowledge of merchants — do NOT search the web.

Categories:
${catList}

Historical categorizations from this user:
${historicalExamples || '(none yet)'}
${feedbackLines ? `\nPast AI suggestion feedback:\n${feedbackLines}` : ''}

Transactions to categorize:
${txnList}

Return ONLY a JSON array, nothing else: [{"id": <txnId>, "categoryId": <id>}, ...]
Only include transactions you are confident about. Skip uncertain ones.`;

  try {
    const resp = await fetch(`${settings.ollamaUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: settings.model,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
        options: { temperature: 0.1 },
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!resp.ok) return [];

    const result = await resp.json();
    const content: string = result.message?.content ?? '';
    const match = content.match(/\[[\s\S]*\]/);
    if (!match) return [];

    const raw = JSON.parse(match[0]) as Array<{ id: number; categoryId: number }>;
    return raw
      .filter((r) => r.id && r.categoryId && catMap.has(Number(r.categoryId)))
      .map((r) => ({ txnId: Number(r.id), categoryId: Number(r.categoryId), categoryName: catMap.get(Number(r.categoryId))! }));
  } catch {
    return [];
  }
}

// --- Structured questions ---

export type StructuredQuestionType = 'planned_comparison' | 'over_budget' | 'category_high' | 'category_low';

export interface StructuredQuestionParams {
  monthA?: string;
  monthB?: string;
  month?: string;
  categoryId?: number;
}

function fmtMonth(m: string): string {
  const [y, mo] = m.split('-');
  return new Date(Number(y), Number(mo) - 1).toLocaleString('default', { month: 'long', year: 'numeric' });
}

function getSummary(month: string, appData: AppData) {
  const catMap = new Map(appData.categories.map((c) => [c.id, c.name]));
  const spending = new Map<number, number>();
  for (const t of appData.transactions) {
    if (t.txnDate.startsWith(month) && !t.ignoreInBudget && t.amount > 0 && t.categoryId) {
      spending.set(t.categoryId, (spending.get(t.categoryId) ?? 0) + t.amount);
    }
  }
  return appData.budgets
    .filter((b) => b.month === month)
    .map((b) => ({
      categoryId: b.categoryId,
      name: catMap.get(b.categoryId) ?? '?',
      target: b.targetAmount,
      spent: +(spending.get(b.categoryId) ?? 0).toFixed(2),
    }));
}

/**
 * Build the structured answer and a minimal LLM interpretation prompt.
 * preamble = the facts, always correct, built from data
 * llmPrompt = what to ask the LLM to add (just a brief interpretation)
 */
function buildStructuredAnswer(
  type: StructuredQuestionType,
  params: StructuredQuestionParams,
  appData: AppData,
): { preamble: string; llmPrompt: string } | null {
  const catMap = new Map(appData.categories.map((c) => [c.id, c.name]));

  if (type === 'planned_comparison') {
    const { monthA, monthB } = params;
    if (!monthA || !monthB) return null;
    const labelA = fmtMonth(monthA);
    const labelB = fmtMonth(monthB);
    const sumA = getSummary(monthA, appData);
    const sumB = getSummary(monthB, appData);
    const totalA = sumA.reduce((s, b) => s + b.target, 0);
    const totalB = sumB.reduce((s, b) => s + b.target, 0);
    const diff = totalA - totalB;
    const direction = diff >= 0 ? 'higher' : 'lower';

    const mapA = new Map(sumA.map((b) => [b.categoryId, b.target]));
    const mapB = new Map(sumB.map((b) => [b.categoryId, b.target]));
    const allIds = new Set([...mapA.keys(), ...mapB.keys()]);
    const diffs: Array<{ name: string; a: number; b: number; diff: number }> = [];
    for (const id of allIds) {
      const a = mapA.get(id) ?? 0;
      const b = mapB.get(id) ?? 0;
      if (a !== b) diffs.push({ name: catMap.get(id) ?? '?', a, b, diff: a - b });
    }
    diffs.sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff));

    const diffLines = diffs.length > 0
      ? diffs.map((d) => `• ${d.name}: $${d.a.toFixed(0)} in ${labelA} vs $${d.b.toFixed(0)} in ${labelB} (${d.diff > 0 ? '+' : ''}$${d.diff.toFixed(0)})`).join('\n')
      : '• No differences — all targets are identical';

    const preamble = `**${labelA} planned: $${totalA.toFixed(0)} vs ${labelB} planned: $${totalB.toFixed(0)}** (${labelA} is $${Math.abs(diff).toFixed(0)} ${direction})\n\nCategory differences:\n${diffLines}`;

    const llmPrompt = `A personal budget has these planned spending differences between ${labelA} and ${labelB}:\n${diffLines}\nIn 1–2 sentences, briefly explain what this pattern likely means (e.g. one-time annual expense, missing recurring item, seasonal cost). Do not repeat the category names or numbers — they are already shown.`;

    return { preamble, llmPrompt };
  }

  if (type === 'over_budget') {
    const { month } = params;
    if (!month) return null;
    const label = fmtMonth(month);
    const summary = getSummary(month, appData);
    const totalTarget = summary.reduce((s, b) => s + b.target, 0);
    const totalSpent = summary.reduce((s, b) => s + b.spent, 0);
    const over = summary
      .filter((b) => b.spent > b.target)
      .sort((a, b) => (b.spent - b.target) - (a.spent - a.target));

    const overLines = over.length > 0
      ? over.map((b) => `• ${b.name}: target $${b.target.toFixed(0)}, spent $${b.spent.toFixed(0)} (over by $${(b.spent - b.target).toFixed(0)})`).join('\n')
      : '• No categories exceeded their target';

    const netStr = totalSpent > totalTarget
      ? `$${(totalSpent - totalTarget).toFixed(0)} over`
      : `$${(totalTarget - totalSpent).toFixed(0)} under`;

    const preamble = `**${label}: planned $${totalTarget.toFixed(0)}, spent $${totalSpent.toFixed(0)} — ${netStr} budget**\n\nOver-budget categories:\n${overLines}`;

    const llmPrompt = `In ${label}, these budget categories were overspent:\n${overLines}\nIn 1–2 sentences, briefly comment on what type of spending this represents (e.g. discretionary, seasonal, one-off). Do not repeat the numbers — they are already shown.`;

    return { preamble, llmPrompt };
  }

  if (type === 'category_high') {
    const { categoryId, month } = params;
    if (!categoryId || !month) return null;
    const catName = catMap.get(categoryId) ?? '?';
    const label = fmtMonth(month);
    const budget = appData.budgets.find((b) => b.month === month && b.categoryId === categoryId);
    const target = budget?.targetAmount ?? 0;
    const txns = appData.transactions
      .filter((t) => t.txnDate.startsWith(month) && t.categoryId === categoryId && !t.ignoreInBudget && t.amount > 0)
      .sort((a, b) => b.amount - a.amount);
    const totalSpent = txns.reduce((s, t) => s + t.amount, 0);

    const txnLines = txns.length > 0
      ? txns.map((t) => `• ${t.txnDate}  $${t.amount.toFixed(2)}  "${t.descriptor}"${t.comment ? `  [${t.comment}]` : ''}`).join('\n')
      : '• No transactions';

    const overStr = target > 0
      ? ` — over by $${(totalSpent - target).toFixed(0)} (${Math.round(((totalSpent - target) / target) * 100)}% above target)`
      : '';

    const preamble = `**${catName} in ${label}: target $${target.toFixed(0)}, spent $${totalSpent.toFixed(2)}${overStr}**\n\nTransactions (largest first):\n${txnLines}`;

    const llmPrompt = `These are the ${catName} transactions for ${label}:\n${txnLines}\nIn 1–2 sentences, briefly describe what drove the high spending (e.g. large one-off purchase, cluster of small purchases, seasonal pattern). Do not repeat the transaction details.`;

    return { preamble, llmPrompt };
  }

  if (type === 'category_low') {
    const { categoryId, month } = params;
    if (!categoryId || !month) return null;
    const catName = catMap.get(categoryId) ?? '?';
    const label = fmtMonth(month);
    const budget = appData.budgets.find((b) => b.month === month && b.categoryId === categoryId);
    const target = budget?.targetAmount ?? 0;
    const txns = appData.transactions
      .filter((t) => t.txnDate.startsWith(month) && t.categoryId === categoryId && !t.ignoreInBudget && t.amount > 0)
      .sort((a, b) => a.txnDate.localeCompare(b.txnDate));
    const totalSpent = txns.reduce((s, t) => s + t.amount, 0);

    const [yr, mo] = month.split('-').map(Number);
    const prevMonths: string[] = [];
    for (let i = 1; i <= 3; i++) {
      let pm = mo - i; let py = yr;
      while (pm <= 0) { pm += 12; py--; }
      prevMonths.push(`${py}-${String(pm).padStart(2, '0')}`);
    }

    const prevData = prevMonths.map((pm) => {
      const pt = appData.transactions
        .filter((t) => t.txnDate.startsWith(pm) && t.categoryId === categoryId && !t.ignoreInBudget && t.amount > 0)
        .sort((a, b) => a.txnDate.localeCompare(b.txnDate));
      const ptotal = pt.reduce((s, t) => s + t.amount, 0);
      const lines = pt.length > 0
        ? pt.map((t) => `  ${t.txnDate}  $${t.amount.toFixed(2)}  "${t.descriptor}"`).join('\n')
        : '  (none)';
      return { label: fmtMonth(pm), total: ptotal, lines };
    });

    const thisMonthLines = txns.length > 0
      ? txns.map((t) => `• ${t.txnDate}  $${t.amount.toFixed(2)}  "${t.descriptor}"`).join('\n')
      : '• No transactions';

    const prevLines = prevData
      .map((pd) => `• ${pd.label}: $${pd.total.toFixed(0)}\n${pd.lines}`)
      .join('\n');

    // Identify descriptors present in prior months but absent this month
    const thisDescriptors = new Set(txns.map((t) => t.descriptor.toLowerCase()));
    const missingDescriptors = new Set<string>();
    for (const pd of prevData) {
      const pt = appData.transactions.filter(
        (t) => t.txnDate.startsWith(prevMonths[prevData.indexOf(pd)]) && t.categoryId === categoryId && !t.ignoreInBudget && t.amount > 0,
      );
      for (const t of pt) {
        if (!thisDescriptors.has(t.descriptor.toLowerCase())) missingDescriptors.add(t.descriptor);
      }
    }
    const missingLines = missingDescriptors.size > 0
      ? [...missingDescriptors].map((d) => `• "${d}"`).join('\n')
      : '• None identified';

    const underStr = target > 0 ? ` (under by $${(target - totalSpent).toFixed(0)})` : '';

    const preamble = `**${catName} in ${label}: target $${target.toFixed(0)}, spent $${totalSpent.toFixed(2)}${underStr}**\n\nThis month's transactions:\n${thisMonthLines}\n\nPrevious 3 months:\n${prevLines}\n\nTransaction descriptors present in prior months but missing this month:\n${missingLines}`;

    const llmPrompt = `For the ${catName} budget category, spending was low in ${label}. The missing descriptors compared to prior months are:\n${missingLines}\nIn 1–2 sentences, briefly comment on what might explain the absence (e.g. skipped recurring expense, seasonal, already paid elsewhere). Do not repeat the transaction details.`;

    return { preamble, llmPrompt };
  }

  return null;
}

export async function answerStructuredQuestion(
  type: StructuredQuestionType,
  params: StructuredQuestionParams,
  settings: AISettings,
  onStatus: (s: string) => void,
): Promise<string> {
  const data = getData();
  const built = buildStructuredAnswer(type, params, data);
  if (!built) return 'Missing required parameters.';

  onStatus('Analyzing…');

  const resp = await fetch(`${settings.ollamaUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: settings.model,
      messages: [{ role: 'user', content: built.llmPrompt }],
      stream: false,
      options: { temperature: 0.3 },
    }),
  });

  if (!resp.ok) throw new Error(`Ollama error ${resp.status}: ${await resp.text()}`);
  const result = await resp.json();
  const interpretation = (result.message?.content ?? '').trim();

  return interpretation
    ? `${built.preamble}\n\n${interpretation}`
    : built.preamble;
}

// --- Parser generation ---

const PARSER_SYSTEM_PROMPT = `You are a TypeScript code generator for a budgeting app. Your task is to write a JavaScript/TypeScript function that parses bank transaction files.

The function MUST have this exact signature and name:
\`\`\`javascript
function parseTransactions(text, filename) {
  // your code here
  // return an array of transaction objects
}
\`\`\`

Each returned object must have these fields:
- source: string (use 'custom')
- sourceRef: string (use filename)
- txnDate: string (YYYY-MM-DD format)
- amount: number (positive for debits/expenses, negative for credits/income — see sign convention below)
- instrument: string (use the provided instrument name)
- descriptor: string (merchant/description)
- categoryId: null
- linkedTransactionId: null
- ignoreInBudget: boolean (true for credits/income, false for debits/expenses)
- comment: null

Amount sign convention:
- Debits (purchases, expenses): store as POSITIVE — amount = Math.abs(rawAmount)
- Credits (refunds, income, deposits): store as NEGATIVE — amount = -Math.abs(rawAmount)
- Use the transaction type column (Credit/Debit) as the authoritative source, not the raw CSV sign.
  Different banks use opposite sign conventions in their CSV files, so always normalise via Math.abs
  then apply the sign based on type: isCredit ? -Math.abs(raw) : Math.abs(raw)
- Set ignoreInBudget = true whenever isCredit, false otherwise.

Rules:
- Always return plain JavaScript (no TypeScript syntax, no imports, no type annotations)
- Handle CSV with proper quote parsing if needed
- Skip header rows and empty lines
- Skip any rows that represent pending, pre-authorized, or provisional transactions (e.g. rows with a status/type column containing "pending", "preauthorized", "pre-authorized", "pre-auth", or similar; or descriptors starting with "pending" or "preauth")
- Dates must be converted to YYYY-MM-DD. Use the provided parseDate(str) helper — it handles M/D/YYYY, YYYY-MM-DD, DD-Mon-YYYY, YYYYMMDD and other common formats. NEVER use new Date() or Date.parse().
- Return ONLY the function, nothing else
- Do NOT include markdown code fences in your response`;

/**
 * Ask the LLM to generate a parser function for a given sample file.
 */
export async function generateParser(
  sampleContent: string,
  parserName: string,
  instrument: string,
  settings: AISettings,
  onStatus: (s: string) => void,
  feedback?: { previousCode: string; issue: string },
): Promise<Omit<CustomParser, 'id' | 'createdAt'>> {
  onStatus(feedback ? 'Revising parser based on feedback…' : 'Analyzing sample file…');

  const sampleLines = sampleContent.split(/\r?\n/).slice(0, 25).join('\n');

  const userMsg = feedback
    ? `The previous parser you generated had a problem. Please fix it.

Parser name: ${parserName}
Instrument: ${instrument}

Original sample file (first 25 lines):
\`\`\`
${sampleLines}
\`\`\`

Previous parser code that had issues:
\`\`\`javascript
${feedback.previousCode}
\`\`\`

User-reported problem: ${feedback.issue}

Write a corrected parseTransactions(text, filename) function. Remember:
- Return plain JavaScript only, no TypeScript annotations
- Debits: amount = Math.abs(raw), ignoreInBudget = false
- Credits: amount = -Math.abs(raw), ignoreInBudget = true
- Use the type column (Credit/Debit) as authoritative — do not rely on raw sign
- Convert dates to YYYY-MM-DD
- instrument should be "${instrument}"`
    : `Generate a parser function for this bank export file.

Parser name: ${parserName}
Instrument: ${instrument}

Sample file content (first 25 lines):
\`\`\`
${sampleLines}
\`\`\`

Write the parseTransactions(text, filename) function. Remember:
- Return plain JavaScript only, no TypeScript annotations
- Debits: amount = Math.abs(raw), ignoreInBudget = false
- Credits: amount = -Math.abs(raw), ignoreInBudget = true
- Use the type column (Credit/Debit) as authoritative — do not rely on raw sign
- Convert dates to YYYY-MM-DD
- instrument should be "${instrument}"`;

  const resp = await fetch(`${settings.ollamaUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: settings.model,
      messages: [
        { role: 'system', content: PARSER_SYSTEM_PROMPT },
        { role: 'user', content: userMsg },
      ],
      stream: false,
      options: { temperature: 0.1 },
    }),
  });

  if (!resp.ok) throw new Error(`Ollama error ${resp.status}: ${await resp.text()}`);

  const result = await resp.json();
  let code: string = result.message?.content ?? '';

  // Strip markdown code fences if present
  code = code.replace(/^```[\w]*\n?/gm, '').replace(/^```\s*$/gm, '').trim();

  // Validate it contains parseTransactions
  if (!code.includes('parseTransactions')) {
    throw new Error('Generated code does not contain parseTransactions function');
  }

  onStatus('Parser generated!');

  return {
    name: parserName,
    instrument,
    code,
    sampleLines: sampleLines.split('\n').slice(0, 5).join('\n'),
  };
}
