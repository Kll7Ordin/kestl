import { useRef } from 'react';
import { getData, addCategory, saveExperimentalBudget } from '../db';
import { parseWorkbook } from '../parsers/xlsx';
import * as XLSX from 'xlsx';
import { save } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';

interface Props {
  /** compact = just buttons, no title/description (for inline use in BudgetView / ExperimentalBudgets) */
  compact?: boolean;
  onImported?: () => void;
}

async function downloadTemplate() {
  const wb = XLSX.utils.book_new();
  const budgetSheet = XLSX.utils.aoa_to_sheet([
    ['Category', 'Monthly Target'],
    ['Groceries', 800],
    ['Gas', 200],
    ['Dining', 300],
    ['Subscriptions', 50],
    ['Personal Care', 100],
  ]);
  const rulesSheet = XLSX.utils.aoa_to_sheet([
    ['Pattern', 'Category'],
    ['netflix', 'Subscriptions'],
    ['spotify', 'Subscriptions'],
    ['loblaws', 'Groceries'],
  ]);
  XLSX.utils.book_append_sheet(wb, budgetSheet, 'Budget');
  XLSX.utils.book_append_sheet(wb, rulesSheet, 'Rules');
  const base64 = XLSX.write(wb, { type: 'base64', bookType: 'xlsx' }) as string;
  let savePath: string | null = null;
  try {
    savePath = await save({
      defaultPath: 'budget-template.xlsx',
      filters: [{ name: 'Excel Workbook', extensions: ['xlsx'] }],
    });
  } catch {
    // ignore
  }
  if (!savePath) return;
  await invoke('save_base64', { path: savePath, data: base64 });
}

function parseCsvBudget(text: string): { categoryName: string; targetAmount: number }[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length === 0) return [];
  const firstLower = lines[0].toLowerCase();
  const start = firstLower.includes('category') || firstLower.includes('target') ? 1 : 0;
  const result: { categoryName: string; targetAmount: number }[] = [];
  for (let i = start; i < lines.length; i++) {
    // Handle quoted fields
    const parts = lines[i].match(/(".*?"|[^,]+)(?=,|$)/g) ?? lines[i].split(',');
    if (parts.length < 2) continue;
    const name = parts[0].trim().replace(/^"|"$/g, '').trim();
    const rawAmt = parts[1].trim().replace(/^"|"$/g, '').replace(/[$,\s]/g, '');
    const amount = parseFloat(rawAmt);
    if (name && !isNaN(amount) && amount >= 0) {
      result.push({ categoryName: name, targetAmount: amount });
    }
  }
  return result;
}

async function handleFile(file: File, onImported?: () => void) {
  try {
    const isCsv = file.name.toLowerCase().endsWith('.csv');
    let budgetLines: { categoryName: string; targetAmount: number }[];

    if (isCsv) {
      const text = await file.text();
      budgetLines = parseCsvBudget(text);
    } else {
      const buf = await file.arrayBuffer();
      const result = parseWorkbook(buf);
      budgetLines = result.budgetLines;
    }

    if (budgetLines.length === 0) { alert('No budget lines found.'); return; }
    const { categories } = getData();
    const existingNames = new Set(categories.map((c) => c.name.toLowerCase()));
    for (const line of budgetLines) {
      if (!existingNames.has(line.categoryName.toLowerCase())) {
        await addCategory(line.categoryName);
      }
    }
    const { categories: allCats } = getData();
    const catMap = new Map(allCats.map((c) => [c.name.toLowerCase(), c.id!]));
    const items = budgetLines
      .filter((l) => catMap.has(l.categoryName.toLowerCase()))
      .map((l) => ({
        categoryId: catMap.get(l.categoryName.toLowerCase())!,
        categoryName: l.categoryName,
        groupId: null,
        groupName: null,
        targetAmount: l.targetAmount,
      }));
    await saveExperimentalBudget({
      name: file.name.replace(/\.[^.]+$/, ''),
      createdAt: new Date().toISOString(),
      items,
    });
    alert(`Imported ${items.length} budget lines as a Budget Sandbox. Go to Budget Sandbox to review and apply.`);
    onImported?.();
  } catch (err) {
    alert(`Import failed: ${String(err)}`);
  }
}

export function ImportBudgetCard({ compact = false, onImported }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);

  function onChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    handleFile(file, onImported);
    e.target.value = '';
  }

  if (compact) {
    return (
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }} onChange={onChange} />
        <button className="btn btn-ghost btn-sm" onClick={() => fileRef.current?.click()}>
          Import Budget from XLSX or CSV
        </button>
        <button className="btn btn-ghost btn-sm" onClick={downloadTemplate}>↓ Template</button>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75rem', flexWrap: 'wrap' }}>
      <p style={{ fontSize: '0.85rem', opacity: 0.8, margin: 0, flex: 1, minWidth: 180 }}>
        Upload a budget spreadsheet to create a draft in <strong>Budget Sandbox</strong>. From there you can review it and apply it to a live month manually.
      </p>
      <div style={{ display: 'flex', gap: '0.4rem', flexShrink: 0, alignItems: 'center' }}>
        <button className="btn btn-ghost btn-sm" style={{ opacity: 0.65, fontSize: '0.75rem' }} onClick={downloadTemplate}>↓ Template</button>
        <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }} onChange={onChange} />
        <button className="btn btn-ghost btn-sm" style={{ opacity: 0.65, fontSize: '0.75rem' }} onClick={() => fileRef.current?.click()}>
          Choose file…
        </button>
      </div>
    </div>
  );
}
