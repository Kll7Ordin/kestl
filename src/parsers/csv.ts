import type { Transaction } from '../db';

function parseDate(raw: string): string {
  const trimmed = raw.trim();
  const parts = trimmed.split('/');
  if (parts.length === 3) {
    const [m, d, y] = parts;
    const year = y.length === 2 ? `20${y}` : y;
    return `${year}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  const dashed = trimmed.split('-');
  if (dashed.length === 3) {
    const [y, m, d] = dashed;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  return trimmed;
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        fields.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
  }
  fields.push(current.trim());
  return fields;
}

/**
 * Detect whether a Scotia CSV is from a chequing account or a credit card
 * by sampling the sign of debit-row amounts.
 *
 * Chequing exports: debit amounts are negative (e.g. -55.76).
 * Credit card exports: debit amounts are positive (e.g. 70.56).
 *
 * This relies on fundamental bank accounting conventions rather than
 * filenames or specific column names, so it is robust to Scotia renaming
 * their export files or adding/reordering columns.
 */
function detectAccountType(
  typeIndex: number,
  amountIndex: number,
  dataLines: string[],
): 'chequing' | 'creditcard' {
  let negativeDebits = 0;
  let positiveDebits = 0;
  for (const line of dataLines.slice(0, 20)) {
    const fields = parseCsvLine(line);
    if (fields.length <= Math.max(typeIndex, amountIndex)) continue;
    if ((fields[typeIndex] ?? '').trim().toLowerCase() !== 'debit') continue;
    const amt = parseFloat((fields[amountIndex] ?? '').replace(/[,$]/g, ''));
    if (isNaN(amt)) continue;
    if (amt < 0) negativeDebits++;
    else if (amt > 0) positiveDebits++;
  }
  // Chequing: debits are negative. Credit card: debits are positive.
  // Default to creditcard if no debit rows sampled (safe fallback).
  return negativeDebits > positiveDebits ? 'chequing' : 'creditcard';
}

export function parseBankCsv(
  text: string,
  filename: string,
): Omit<Transaction, 'id'>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];

  const results: Omit<Transaction, 'id'>[] = [];
  const headerFields = parseCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const findIndex = (...names: string[]) =>
    headerFields.findIndex((h) => names.includes(h));

  // Newer exports include a leading "Filter" column. Use header-based mapping first.
  const dateIndex = findIndex('date');
  const descIndex = findIndex('description');
  const subDescIndex = findIndex('sub-description', 'sub description');
  const amountIndex = findIndex('amount');
  const typeIndex = findIndex('type of transaction', 'type');
  const statusIndex = findIndex('status', 'transaction status');

  // Detect account type from debit sign convention and set instrument accordingly.
  // Only applies when the Type column is present; legacy files fall back to 'creditcard'.
  const accountType =
    typeIndex !== -1 && amountIndex !== -1
      ? detectAccountType(typeIndex, amountIndex, lines.slice(1))
      : 'creditcard';
  const instrument =
    accountType === 'chequing' ? 'Scotiabank Chequing CSV' : 'Scotiabank Credit Card CSV';

  for (let i = 1; i < lines.length; i++) {
    const fields = parseCsvLine(lines[i]);
    if (fields.length < 5) continue;

    let dateRaw = '';
    let desc = '';
    let subDesc = '';
    let amountRaw = '';
    let typeRaw = '';

    if (dateIndex !== -1 && descIndex !== -1 && amountIndex !== -1) {
      dateRaw = fields[dateIndex] ?? '';
      desc = fields[descIndex] ?? '';
      subDesc = subDescIndex !== -1 ? (fields[subDescIndex] ?? '') : '';
      amountRaw = fields[amountIndex] ?? '';
      typeRaw = typeIndex !== -1 ? (fields[typeIndex] ?? '').trim().toLowerCase() : '';
      // Skip pending/pre-authorized rows — they will reappear as settled in a later file.
      const statusRaw = statusIndex !== -1 ? (fields[statusIndex] ?? '').trim().toLowerCase() : '';
      if (/\bpending\b|\bpre-?auth(orized)?\b|\bprovisional\b/.test(statusRaw)) continue;
    } else {
      // Backward-compatible fallback for legacy CSV shape.
      [dateRaw, desc, subDesc, , amountRaw] = fields;
    }

    if (!dateRaw || !amountRaw) continue;

    // Also skip rows whose descriptor explicitly signals a pending transaction.
    const descLower = desc.trim().toLowerCase();
    if (/^pending\b|^pre-?auth\b/.test(descLower)) continue;

    const rawAmount = parseFloat(amountRaw.replace(/[,$]/g, ''));
    if (isNaN(rawAmount)) continue;

    const descriptor = [desc, subDesc].filter(Boolean).join(' ').trim();

    // Sign convention: expenses (debits) are stored as positive amounts;
    // income (credits) are stored as negative amounts.
    // typeRaw is the authoritative source when present; it correctly handles both
    // chequing (debits negative in CSV) and credit card (debits positive in CSV)
    // because we normalise via Math.abs before applying the convention.
    // Legacy fallback (no Type column): use the CSV sign directly — negative = credit.
    let amount: number;
    let ignoreInBudget: boolean;
    if (typeRaw === 'credit') {
      amount = -Math.abs(rawAmount);
      ignoreInBudget = true;
    } else if (typeRaw === 'debit') {
      amount = Math.abs(rawAmount);
      ignoreInBudget = false;
    } else {
      // Legacy: negative raw amount = credit (credit-card style).
      ignoreInBudget = rawAmount < 0;
      amount = ignoreInBudget ? -Math.abs(rawAmount) : Math.abs(rawAmount);
    }

    results.push({
      source: 'bank_csv',
      sourceRef: filename,
      txnDate: parseDate(dateRaw),
      amount,
      instrument,
      descriptor,
      categoryId: null,
      linkedTransactionId: null,
      ignoreInBudget,
      comment: null,
    });
  }

  return results;
}
