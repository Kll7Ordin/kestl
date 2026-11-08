import type { Transaction } from '../db';

/**
 * `ignoreInBudget` is the stored name (kept for file compatibility) but it actually means
 * "this is a credit" (money in). Credits subtract from spend in their category, or count as
 * income in income categories.
 */
export const isCredit = (t: Pick<Transaction, 'ignoreInBudget'>): boolean => t.ignoreInBudget;

/** `linkedTransactionId === -1` is a hidden marker meaning "enriched from a PayPal record". */
export const isPaypalLinked = (t: Pick<Transaction, 'linkedTransactionId'>): boolean => t.linkedTransactionId === -1;
