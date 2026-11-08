import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

import {
  __setDataForTests, __setFilePathForTests, getData, updateTransaction, addCategory, deleteTransactions,
  undo, getUndoLabel, canUndo, flushSave, getSaveStatus, withUndo, loadFromFile,
} from './db';
import { richFixture } from './test/fixtures';

describe('save pipeline', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(1234);
    __setDataForTests(richFixture());
    __setFilePathForTests('/tmp/test.budget');
  });
  afterEach(() => vi.useRealTimers());

  it('debounces several mutations into one save', async () => {
    const t = getData().transactions[0].id;
    await updateTransaction(t, { comment: 'a' });
    await updateTransaction(t, { comment: 'b' });
    await addCategory('X');
    expect(invokeMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    const saves = invokeMock.mock.calls.filter((c) => c[0] === 'save_data');
    expect(saves).toHaveLength(1);
    expect(getSaveStatus().status).toBe('idle');
  });

  it('passes the last known mtime and stops on CONFLICT', async () => {
    const t = getData().transactions[0].id;
    await updateTransaction(t, { comment: 'a' });
    await flushSave();
    expect(invokeMock.mock.calls[0][1].expectedMtime).toBeNull();
    invokeMock.mockRejectedValueOnce('CONFLICT');
    await updateTransaction(t, { comment: 'b' });
    await expect(flushSave()).rejects.toThrow('CONFLICT');
    expect(getSaveStatus().status).toBe('conflict');
    invokeMock.mockClear();
    await updateTransaction(t, { comment: 'c' });
    await vi.advanceTimersByTimeAsync(2000);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('retries after a transient error', async () => {
    invokeMock.mockRejectedValueOnce('disk full');
    await updateTransaction(getData().transactions[0].id, { comment: 'a' });
    await vi.advanceTimersByTimeAsync(500);
    expect(getSaveStatus().status).toBe('error');
    await vi.advanceTimersByTimeAsync(2100);
    expect(getSaveStatus().status).toBe('idle');
  });

  it('refreshes array references on every mutation', async () => {
    const before = getData().transactions;
    await updateTransaction(before[0].id, { comment: 'x' });
    expect(getData().transactions).not.toBe(before);
  });
});

describe('undo', () => {
  beforeEach(() => { __setDataForTests(richFixture()); });

  it('undoes only the last action, labelled', async () => {
    const ids = getData().transactions.map((t) => t.id);
    await deleteTransactions([ids[0]]);
    await updateTransaction(ids[1], { comment: 'hi' });
    expect(getUndoLabel()).toBe('Update transaction');
    await undo();
    expect(getData().transactions.find((t) => t.id === ids[1])?.comment).toBeNull();
    expect(getData().transactions.find((t) => t.id === ids[0])).toBeUndefined();
    await undo();
    expect(getData().transactions.find((t) => t.id === ids[0])).toBeDefined();
    expect(canUndo()).toBe(false);
  });

  it('withUndo pushes a single snapshot for nested mutators', async () => {
    const ids = getData().transactions.map((t) => t.id);
    await withUndo('Batch', async () => {
      await updateTransaction(ids[0], { comment: '1' });
      await updateTransaction(ids[1], { comment: '2' });
    });
    await undo();
    expect(canUndo()).toBe(false);
    expect(getData().transactions.find((t) => t.id === ids[0])?.comment).toBeNull();
  });

  it('clears the undo stack when a different file is loaded', async () => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'load_data') return JSON.stringify(richFixture());
      if (cmd === 'file_mtime') return 5;
      return undefined;
    });
    await deleteTransactions([getData().transactions[0].id]);
    expect(canUndo()).toBe(true);
    await loadFromFile('/tmp/other.budget');
    expect(canUndo()).toBe(false);
  });
});
