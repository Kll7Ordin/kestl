import { startupCleanup, flushSave, withoutUndo } from './db';
import { processRecurringTemplates } from './logic/recurring';
import { processSchedules } from './logic/savings';
import { runBackup, startBackupScheduler } from './backup';

/** Run after a file is loaded (app start or file switch). Strictly sequential so saves never overlap. */
export async function runStartupJobs(): Promise<void> {
  await withoutUndo(async () => {
    await startupCleanup();
    await processRecurringTemplates();
    await processSchedules();
  });
  await flushSave();
  await runBackup('startup');
  startBackupScheduler();
}
