import { startupCleanup, flushSave, withoutUndo, isMigrationDone, REMOVE_RENAMED_DUPLICATES } from './db';
import { processRecurringTemplates } from './logic/recurring';
import { processSchedules } from './logic/savings';
import { runBackup, startBackupScheduler } from './backup';

/** Run after a file is loaded (app start or file switch). Strictly sequential so saves never overlap. */
export async function runStartupJobs(): Promise<void> {
  // The file on disk is still untouched here: back it up before the one-time duplicate removal.
  if (!isMigrationDone(REMOVE_RENAMED_DUPLICATES)) await runBackup('pre-purge');
  await withoutUndo(async () => {
    await startupCleanup();
    await processRecurringTemplates();
    await processSchedules();
  });
  await flushSave();
  await runBackup('startup');
  startBackupScheduler();
}
