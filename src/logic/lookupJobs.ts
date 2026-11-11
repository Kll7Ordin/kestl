import { getAISettings, getData, saveMerchantLookup, addMerchantTypes, type Transaction } from '../db';
import { checkOllama, ollamaJson, searchWeb } from './llm';
import { runLookup, type LookupReport } from './lookup';
import { parseDescriptor, type Suggester } from './suggest';

/**
 * Background ? lookups. A job outlives the dialog: clicking ? starts it, the button pulses while it
 * runs and glows once it finishes, and opening the dialog (which acknowledges it) shows its progress.
 */
export interface LookupJob {
  status: 'running' | 'done';
  report: LookupReport | null;
  /** Finished but the user hasn't opened it yet: drives the glow. */
  unseen: boolean;
}

export function lookupJobKey(t: Pick<Transaction, 'id' | 'descriptor'>): string {
  return parseDescriptor(t.descriptor).key || `#${t.id}`;
}

let jobs: ReadonlyMap<string, LookupJob> = new Map();
const listeners = new Set<() => void>();

function setJob(key: string, job: LookupJob | null) {
  const next = new Map(jobs);
  if (job) next.set(key, job); else next.delete(key);
  jobs = next;
  listeners.forEach((l) => l());
}

export const subscribeLookupJobs = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export const getLookupJobs = () => jobs;

export function acknowledgeLookup(key: string) {
  const j = jobs.get(key);
  if (j?.unseen) setJob(key, { ...j, unseen: false });
}

export function startLookup(
  txn: Transaction,
  suggester: Suggester,
  categories: { id: number; name: string }[],
): void {
  const key = lookupJobKey(txn);
  if (jobs.get(key)?.status === 'running') return;
  setJob(key, { status: 'running', report: null, unseen: false });
  const settings = getAISettings();
  void (async () => {
    let final: LookupReport | null = null;
    try {
      final = await runLookup(
        { descriptor: txn.descriptor, amount: txn.amount, txnDate: txn.txnDate, instrument: txn.instrument },
        { suggester, categories, model: settings.model },
        {
          aiAvailable: () => checkOllama(settings.ollamaUrl),
          chat: (system, user, schema) => ollamaJson(settings, system, user, schema),
          search: searchWeb,
        },
        (r) => setJob(key, { status: 'running', report: r, unseen: false }),
      );
      const merchantKey = parseDescriptor(txn.descriptor).key;
      const trace = suggester.explain(txn.descriptor, txn.amount, { asOf: txn.txnDate });
      if (merchantKey && !trace.bankTransfer) {
        await saveMerchantLookup(merchantKey, final);
        // Fill in the merchant type only where none is known; never overwrite a saved (maybe hand-picked) one.
        const t = final.reading.merchantType;
        const existing = getData().merchantTypes?.[merchantKey];
        if (t && (existing === undefined || (existing === 'unknown' && t !== 'unknown'))) {
          await addMerchantTypes({ [merchantKey]: t });
        }
      }
    } catch (e) {
      console.error('lookup failed', e);
    } finally {
      setJob(key, { status: 'done', report: final ?? jobs.get(key)?.report ?? null, unseen: true });
    }
  })();
}
