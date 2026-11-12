import { invoke } from '@tauri-apps/api/core';
import { flushSave, getFilePath, getBackupSettings, getSaveCount } from './db';

export type BackupReason = 'startup' | 'interval' | 'manual' | 'pre-import' | 'pre-merge' | 'pre-separate' | 'pre-purge';

const INTERVAL_MS = 30 * 60 * 1000;

let lastBackupAt: number | null = null;
let lastBackupError: string | null = null;
let lastBackupSaveCount = -1;
let listeners: Array<() => void> = [];
let timer: ReturnType<typeof setInterval> | null = null;

export function dirKey(filePath: string): string {
  return `kestl-backup-dir:${filePath}`;
}

function dirname(p: string): { dir: string; sep: string } {
  const sep = p.includes('\\') ? '\\' : '/';
  const i = p.lastIndexOf(sep);
  return { dir: i > 0 ? p.slice(0, i) : '.', sep };
}

/** Default folder: <data dir>/kestl-backups. */
export function defaultBackupDir(filePath: string): string {
  const { dir, sep } = dirname(filePath);
  return `${dir}${sep}kestl-backups`;
}

/** Backup folder is per machine and per data file. */
export function getBackupDir(filePath: string): string {
  try {
    const stored = localStorage.getItem(dirKey(filePath));
    if (stored) return stored;
  } catch { /* ignore */ }
  return defaultBackupDir(filePath);
}

export function setBackupDir(filePath: string, dir: string): void {
  try { localStorage.setItem(dirKey(filePath), dir); } catch { /* ignore */ }
}

export function getBackupState() {
  return { lastBackupAt, lastBackupError };
}

export function subscribeBackup(fn: () => void): () => void {
  listeners = [...listeners, fn];
  return () => { listeners = listeners.filter((l) => l !== fn); };
}

function notify() { for (const fn of listeners) fn(); }

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

/**
 * Copy the saved data file into the backup folder (so encrypted files give encrypted backups).
 * `manual` ignores the enabled flag.
 */
export async function runBackup(reason: BackupReason): Promise<void> {
  const filePath = getFilePath();
  if (!filePath) return;
  const settings = getBackupSettings();
  if (!settings.enabled && reason !== 'manual') return;
  try {
    await flushSave();
    await invoke('backup_file', {
      src: filePath,
      dir: getBackupDir(filePath),
      stamp: stamp(),
      maxCount: settings.maxCount,
    });
    lastBackupAt = Date.now();
    lastBackupError = null;
    lastBackupSaveCount = getSaveCount();
  } catch (e) {
    lastBackupError = e instanceof Error ? e.message : String(e);
    console.warn('[backup] failed:', lastBackupError);
  }
  notify();
}

/** Back up every 30 minutes, but only if a save happened since the last backup. */
export function startBackupScheduler(): void {
  if (timer) return;
  timer = setInterval(() => {
    if (getSaveCount() !== lastBackupSaveCount) void runBackup('interval');
  }, INTERVAL_MS);
}

export function stopBackupScheduler(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
