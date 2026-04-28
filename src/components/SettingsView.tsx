import { useState, useEffect, useSyncExternalStore, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { PasswordPrompt } from './PasswordPrompt';
import { open, save } from '@tauri-apps/plugin-dialog';
import {
  getData,
  subscribe,
  getFilePath,
  loadFromFile,
  addCategory,
  deleteCategory,
  addCategoryRule,
  updateCategoryRule,
  deleteCategoryRule,
  type CategoryRule,
  addRecurringTemplate,
  deleteRecurringTemplate,
  updateRecurringTemplate,
  purgeTransactionsByMonth,
  purgeTransactionsByInstrument,
  updateCategoryColor,
  updateCategoryIsIncome,
  updateCategoryBucket,
  getAISettings,
  updateAISettings,
  isCurrentFileEncrypted,
  enableEncryption,
  changeEncryptionPassword,
  disableEncryption,
  deleteCustomParser,
  saveCustomParser,
  getColorThresholds,
  setColorThresholds,
  DEFAULT_COLOR_THRESHOLDS,
  getDisplaySettings,
  updateDisplaySettings,
  type ColorThresholds,
  type RecurringTemplate,
  type Transaction,
  getMortgageConfig,
  deleteMortgage,
  reorderCategoryRules,
} from '../db';
import { recategorizeAll, bulkApplySplitRule, bulkCategorizeByDescriptor, runRuleOnHistory } from '../logic/categorize';
import { createReadableArchive } from '../utils/export';
import { encryptData } from '../utils/crypto';
import { confirmPaypalMatch, discardPaypalTransactions, type PaypalMatchCandidate } from '../logic/matching';
import { checkOllama, listModels, pullModel, RECOMMENDED_MODELS } from '../logic/llm';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { ParserGenerator } from './ParserGenerator';
import { ImportBudgetCard } from './ImportBudgetCard';
import { SearchableSelect } from './SearchableSelect';
import { DateInput } from './DateInput';
import { formatAmount } from '../utils/format';

interface Props {
  zoom?: number;
  onZoomChange?: (zoom: number) => void;
  search?: string;
  darkMode?: boolean;
  onDarkModeChange?: (dark: boolean) => void;
  experimentalEnabled?: boolean;
  onExperimentalChange?: (enabled: boolean) => void;
  showMortgageTab?: boolean;
  onShowMortgageTabChange?: (show: boolean) => void;
  txnAiLookupEnabled?: boolean;
  onTxnAiLookupChange?: (v: boolean) => void;
  onNeedOllama?: () => void;
  onRegisterBack?: (handler: (() => void) | null) => void;
  parserToOpen?: string | null;
  onParserToOpenConsumed?: () => void;
}

export function SettingsView({ zoom = 1, onZoomChange, search = '', darkMode = false, onDarkModeChange, experimentalEnabled = false, onExperimentalChange, showMortgageTab = false, onShowMortgageTabChange, txnAiLookupEnabled = false, onTxnAiLookupChange, onNeedOllama, onRegisterBack, parserToOpen, onParserToOpenConsumed }: Props) {
  const data = useSyncExternalStore(subscribe, getData);
  const categories = data.categories;
  const sq = search.trim().toLowerCase();
  const catMap = useMemo(() => new Map(categories.map((c) => [c.id, c.name])), [categories]);
  const categoryOptions = useMemo(() => categories.map((c) => ({ value: c.id, label: c.name })), [categories]);
  const rules = useMemo(() => {
    const orderMap = new Map(data.categoryRules.map((r, i) => [r.id, i + 1]));
    return data.categoryRules
      .map((r) => ({ ...r, catName: catMap.get(r.categoryId) ?? '?', orderNum: orderMap.get(r.id) ?? 0 }))
      .filter((r) => !sq || r.pattern.includes(sq) || r.catName.toLowerCase().includes(sq));
  }, [data.categoryRules, catMap, sq]);
  const templates = useMemo(() => data.recurringTemplates
    .filter((t) => !sq || t.descriptor.toLowerCase().includes(sq) || (t.categoryId && (catMap.get(t.categoryId) ?? '').toLowerCase().includes(sq))),
  [data.recurringTemplates, catMap, sq]);
  const instruments = useMemo(() => [...new Set([
    'Card', 'Chequing', 'Amazon', 'PayPal',
    ...data.transactions.map((t) => t.instrument),
  ])].filter(Boolean).sort(), [data.transactions]);

  const [pendingEncryptedPath, setPendingEncryptedPath] = useState<string | null>(null);
  const [colorThresholds, setColorThresholdsState] = useState<ColorThresholds>(() => getColorThresholds());
  const [ytdMode, setYtdModeState] = useState<'ytd' | 'rolling12'>(() => getDisplaySettings().ytdMode);
  const [showCategoriesScreen, setShowCategoriesScreen] = useState(false);
  const [showRulesScreen, setShowRulesScreen] = useState(false);
  const [showParserCreate, setShowParserCreate] = useState(false);
  const [selectedParser, setSelectedParser] = useState<{ id: string; name: string; instrument: string; code: string; sampleLines: string; createdAt: string } | null>(null);
  const [editingParserName, setEditingParserName] = useState('');
  const [selectedBuiltin, setSelectedBuiltin] = useState<{ name: string; instrument: string; columns: string } | null>(null);

  // Register a custom back handler when sub-screens are open so the tab bar back button closes them
  useEffect(() => {
    if (showCategoriesScreen) {
      onRegisterBack?.(() => setShowCategoriesScreen(false));
    } else if (showRulesScreen) {
      onRegisterBack?.(() => setShowRulesScreen(false));
    } else if (selectedParser != null) {
      onRegisterBack?.(() => setSelectedParser(null));
    } else if (selectedBuiltin != null) {
      onRegisterBack?.(() => setSelectedBuiltin(null));
    } else {
      onRegisterBack?.(null);
    }
  }, [showCategoriesScreen, showRulesScreen, selectedParser, selectedBuiltin, onRegisterBack]);

  // Auto-select a parser when navigating from ImportView
  useEffect(() => {
    if (!parserToOpen) return;
    const p = (data.customParsers ?? []).find((cp: { id: string }) => cp.id === parserToOpen);
    if (p) {
      setSelectedParser(p);
      setEditingParserName(p.name);
    }
    onParserToOpenConsumed?.();
  }, [parserToOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  const [newCat, setNewCat] = useState('');
  const [newPattern, setNewPattern] = useState('');
  const [newMatchType, setNewMatchType] = useState<'exact' | 'contains'>('exact');
  const [newRuleCat, setNewRuleCat] = useState<number | ''>('');
  const [newRuleAmount, setNewRuleAmount] = useState('');
  const [newRuleAmountRequired, setNewRuleAmountRequired] = useState(false);
  const [newRuleIsSplit, setNewRuleIsSplit] = useState(false);
  const [newRuleSplitType, setNewRuleSplitType] = useState<'%' | '$'>('%');
  const [newRuleSplits, setNewRuleSplits] = useState<Array<{ categoryId: number | ''; amount: string }>>([
    { categoryId: '', amount: '' },
    { categoryId: '', amount: '' },
  ]);

  const [editingRule, setEditingRule] = useState<CategoryRule | null>(null);
  const [runRuleDialogId, setRunRuleDialogId] = useState<number | null>(null);
  const [runRuleStartDate, setRunRuleStartDate] = useState('');
  const [runRuleEndDate, setRunRuleEndDate] = useState('');
  const [runRuleIncludeCategorized, setRunRuleIncludeCategorized] = useState(false);
  const [runRuleResult, setRunRuleResult] = useState<number | null>(null);
  const [dragOverRuleId, setDragOverRuleId] = useState<number | null>(null);
  const [editPattern, setEditPattern] = useState('');
  const [editMatchType, setEditMatchType] = useState<'exact' | 'contains'>('exact');
  const [editCatId, setEditCatId] = useState<number | ''>('');
  const [editAmountMatch, setEditAmountMatch] = useState('');
  const [editSplitType, setEditSplitType] = useState<'%' | '$'>('%');
  const [editSplits, setEditSplits] = useState<Array<{ categoryId: number | ''; amount: string }>>([]);

  const [tmplDescriptor, setTmplDescriptor] = useState('');
  const [tmplAmount, setTmplAmount] = useState('');
  const [tmplCategory, setTmplCategory] = useState<number | ''>('');
  const [tmplDay, setTmplDay] = useState('1');

  const [editTmplId, setEditTmplId] = useState<number | null>(null);
  const [editTmplDescriptor, setEditTmplDescriptor] = useState('');
  const [editTmplAmount, setEditTmplAmount] = useState('');
  const [editTmplCategory, setEditTmplCategory] = useState<number | ''>('');
  const [editTmplDay, setEditTmplDay] = useState('1');

  const [purgeMode, setPurgeMode] = useState<'month' | 'instrument'>('month');
  const [purgeYear, setPurgeYear] = useState('');
  const [purgeMonthNum, setPurgeMonthNum] = useState('');
  const [purgeInstrument, setPurgeInstrument] = useState('');
  const [purgeConfirm, setPurgeConfirm] = useState<{ mode: 'month' | 'instrument'; month: string; label: string; count: number; instrument: string } | null>(null);
  const [paypalFuzzy, setPaypalFuzzy] = useState<PaypalMatchCandidate[]>([]);
  const [paypalUnmatched, setPaypalUnmatched] = useState<Transaction[]>([]);

  // --- AI settings state ---
  const [aiStatus, setAiStatus] = useState<'idle' | 'checking' | 'connected' | 'disconnected'>('idle');
  const [aiModels, setAiModels] = useState<string[]>([]);
  const savedAI = getAISettings();
  const [aiUrl, setAiUrl] = useState(savedAI.ollamaUrl);
  const [aiModel, setAiModel] = useState(savedAI.model);
  const [pullStatus, setPullStatus] = useState<string | null>(null);
  const [pullPct, setPullPct] = useState<number | null>(null);
  const [pulling, setPulling] = useState(false);
  const [confirmDeleteMortgage, setConfirmDeleteMortgage] = useState(false);

  useEffect(() => {
    // Auto-check Ollama on mount
    checkAiConnection(savedAI.ollamaUrl, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function checkAiConnection(url: string, save: boolean) {
    setAiStatus('checking');
    const ok = await checkOllama(url);
    setAiStatus(ok ? 'connected' : 'disconnected');
    if (ok) {
      const models = await listModels(url);
      setAiModels(models);
    }
    if (save) {
      await updateAISettings({ ollamaUrl: url, model: aiModel });
    }
  }


  // --- Ollama install state ---
  const [installing, setInstalling] = useState(false);
  const [installStatus, setInstallStatus] = useState<string | null>(null);
  const [installPct, setInstallPct] = useState<number | null>(null);

  async function handleInstallOllama() {
    setInstalling(true);
    setInstallStatus('Starting download…');
    setInstallPct(0);
    const unlisten = await listen<{ status: string; percent: number }>('ollama_progress', (e) => {
      setInstallStatus(e.payload.status);
      setInstallPct(e.payload.percent);
    });
    try {
      const binaryPath = await invoke<string>('install_ollama');
      setInstallStatus(`Installed at ${binaryPath}. Click Start to launch it.`);
    } catch (e) {
      setInstallStatus(`Error: ${String(e)}`);
    } finally {
      unlisten();
      setInstalling(false);
    }
  }

  async function handleStartOllama() {
    try {
      const binaryPath = await invoke<string | null>('find_ollama');
      if (!binaryPath) { setInstallStatus('Ollama binary not found. Try downloading first.'); return; }
      await invoke('start_ollama', { binaryPath });
      setInstallStatus('Ollama started. Checking connection…');
      await new Promise((r) => setTimeout(r, 2000));
      await checkAiConnection(aiUrl, false);
    } catch (e) {
      setInstallStatus(`Error: ${String(e)}`);
    }
  }

  // --- Encryption state ---
  const encEnabled = isCurrentFileEncrypted();
  const [encAction, setEncAction] = useState<'enable' | 'change' | 'disable' | null>(null);
  const [encPwd1, setEncPwd1] = useState('');
  const [encPwd2, setEncPwd2] = useState('');
  const [encOldPwd, setEncOldPwd] = useState('');
  const [encMsg, setEncMsg] = useState<{ text: string; ok: boolean } | null>(null);

  async function handleEnableEncryption() {
    if (encPwd1 !== encPwd2) { setEncMsg({ text: 'Passwords do not match', ok: false }); return; }
    if (encPwd1.length < 6) { setEncMsg({ text: 'Password must be at least 6 characters', ok: false }); return; }
    try {
      await enableEncryption(encPwd1);
      setEncMsg({ text: 'Encryption enabled. File is now encrypted.', ok: true });
      setEncAction(null); setEncPwd1(''); setEncPwd2('');
    } catch (e) { setEncMsg({ text: String(e), ok: false }); }
  }

  async function handleChangePassword() {
    if (encPwd1 !== encPwd2) { setEncMsg({ text: 'New passwords do not match', ok: false }); return; }
    if (encPwd1.length < 6) { setEncMsg({ text: 'Password must be at least 6 characters', ok: false }); return; }
    try {
      await changeEncryptionPassword(encOldPwd, encPwd1);
      setEncMsg({ text: 'Password changed successfully.', ok: true });
      setEncAction(null); setEncPwd1(''); setEncPwd2(''); setEncOldPwd('');
    } catch (e) { setEncMsg({ text: String(e), ok: false }); }
  }

  async function handleDisableEncryption() {
    try {
      await disableEncryption();
      setEncMsg({ text: 'Encryption disabled. File is now stored as plain JSON.', ok: true });
      setEncAction(null);
    } catch (e) { setEncMsg({ text: String(e), ok: false }); }
  }

  async function handlePullModel() {
    setPulling(true);
    setPullStatus('Starting…');
    setPullPct(0);
    const ok = await pullModel(aiUrl, aiModel, (status, pct) => {
      setPullStatus(status);
      if (pct !== undefined) setPullPct(pct);
    });
    setPulling(false);
    if (ok) {
      setPullStatus('Download complete!');
      setPullPct(100);
      await checkAiConnection(aiUrl, false);
      // Auto-save the model as active
      await updateAISettings({ ollamaUrl: aiUrl, model: aiModel });
      setTimeout(() => { setPullStatus(null); setPullPct(null); }, 4000);
    } else {
      setPullStatus('Download failed — make sure Ollama is running first.');
    }
  }

  async function handleAddCategory() {
    if (!newCat.trim()) return;
    await addCategory(newCat.trim());
    setNewCat('');
  }

  async function handleDeleteCategory(id: number) {
    await deleteCategory(id);
  }

  async function handleAddRule(forceSplit?: boolean) {
    if (!newPattern) return;
    const isSplit = forceSplit ?? newRuleIsSplit;
    const amountVal = newRuleAmountRequired && newRuleAmount.trim() ? parseFloat(newRuleAmount) : null;
    if (isSplit) {
      const validSplits = newRuleSplits.filter((s) => s.categoryId !== '' && s.amount.trim() !== '');
      if (validSplits.length < 2) return;
      const primaryCatId = validSplits[0].categoryId as number;
      await addCategoryRule({
        matchType: newMatchType,
        pattern: newPattern.toLowerCase(),
        categoryId: primaryCatId,
        amountMatch: amountVal,
        splits: validSplits.map((s) => ({
          categoryId: s.categoryId as number,
          ...(newRuleSplitType === '%' ? { percent: parseFloat(s.amount) } : { amount: parseFloat(s.amount) }),
        })),
      });
      setNewRuleSplits([
        { categoryId: '', amount: '' },
        { categoryId: '', amount: '' },
      ]);
      setNewRuleIsSplit(false);
    } else {
      if (!newRuleCat) return;
      await addCategoryRule({
        matchType: newMatchType,
        pattern: newPattern.toLowerCase(),
        categoryId: newRuleCat as number,
        amountMatch: amountVal,
      });
    }
    setNewPattern('');
    setNewRuleAmount('');
    setNewRuleAmountRequired(false);
  }

  async function handleDeleteRule(id: number) {
    await deleteCategoryRule(id);
  }

  function openEditRule(r: CategoryRule) {
    setEditingRule(r);
    setEditPattern(r.pattern);
    setEditMatchType(r.matchType);
    setEditCatId(r.categoryId);
    setEditAmountMatch(r.amountMatch != null ? String(r.amountMatch) : '');
    if (r.splits && r.splits.length >= 2) {
      const usePercent = r.splits[0].percent != null;
      setEditSplitType(usePercent ? '%' : '$');
      setEditSplits(r.splits.map((s) => ({
        categoryId: s.categoryId,
        amount: usePercent ? String(s.percent ?? '') : String(s.amount ?? ''),
      })));
    } else {
      setEditSplitType('%');
      setEditSplits([]);
    }
  }

  async function handleSaveRule() {
    if (!editingRule || !editPattern.trim()) return;
    const amountVal = editAmountMatch.trim() ? parseFloat(editAmountMatch) : null;
    const isSplit = editSplits.length >= 2;
    if (isSplit) {
      const validSplits = editSplits.filter((s) => s.categoryId !== '' && s.amount.trim() !== '');
      if (validSplits.length < 2) return;
      const splitItems = validSplits.map((s) => ({
        categoryId: s.categoryId as number,
        ...(editSplitType === '%' ? { percent: parseFloat(s.amount) } : { amount: parseFloat(s.amount) }),
      }));
      await updateCategoryRule(editingRule.id, {
        pattern: editPattern.toLowerCase(),
        matchType: editMatchType,
        categoryId: splitItems[0].categoryId,
        amountMatch: amountVal,
        splits: splitItems,
      });
      await bulkApplySplitRule(editPattern, editMatchType, amountVal, splitItems);
    } else {
      if (!editCatId) return;
      await updateCategoryRule(editingRule.id, {
        pattern: editPattern.toLowerCase(),
        matchType: editMatchType,
        categoryId: editCatId as number,
        amountMatch: amountVal,
        splits: undefined,
      });
      await bulkCategorizeByDescriptor(editPattern, editCatId as number, editMatchType, amountVal);
    }
    setEditingRule(null);
  }

  async function runRecategorize() {
    const count = await recategorizeAll();
    alert(`Re-categorized ${count} transactions.`);
  }

  async function handleRunRule() {
    if (runRuleDialogId === null) return;
    const count = await runRuleOnHistory({
      ruleId: runRuleDialogId,
      startDate: runRuleStartDate || undefined,
      endDate: runRuleEndDate || undefined,
      includeAlreadyCategorized: runRuleIncludeCategorized,
    });
    setRunRuleResult(count);
  }

  function openRunRuleDialog(ruleId: number) {
    setRunRuleDialogId(ruleId);
    setRunRuleStartDate('');
    setRunRuleEndDate('');
    setRunRuleIncludeCategorized(false);
    setRunRuleResult(null);
  }

  function closeRunRuleDialog() {
    setRunRuleDialogId(null);
    setRunRuleResult(null);
  }

  async function handleRulesDragEnd(draggedId: number, targetId: number) {
    if (draggedId === targetId) return;
    const ids = data.categoryRules.map((r) => r.id);
    const fromIdx = ids.indexOf(draggedId);
    const toIdx = ids.indexOf(targetId);
    if (fromIdx === -1 || toIdx === -1) return;
    const newIds = [...ids];
    newIds.splice(fromIdx, 1);
    newIds.splice(toIdx, 0, draggedId);
    await reorderCategoryRules(newIds);
    setDragOverRuleId(null);
  }

  async function handleAddTemplate() {
    if (!tmplDescriptor.trim() || !tmplAmount) return;
    await addRecurringTemplate({
      descriptor: tmplDescriptor.trim(),
      amount: parseFloat(tmplAmount),
      instrument: 'recurring',
      categoryId: tmplCategory ? (tmplCategory as number) : null,
      dayOfMonth: parseInt(tmplDay),
      active: true,
    });
    setTmplDescriptor('');
    setTmplAmount('');
    setTmplCategory('');
    setTmplDay('1');
  }

  async function handleDeleteTemplate(id: number) {
    await deleteRecurringTemplate(id);
  }

  async function handleToggleTemplate(t: RecurringTemplate) {
    await updateRecurringTemplate(t.id, { active: !t.active });
  }

  function startEditTemplate(t: RecurringTemplate) {
    setEditTmplId(t.id);
    setEditTmplDescriptor(t.descriptor);
    setEditTmplAmount(String(t.amount));
    setEditTmplCategory(t.categoryId ?? '');
    setEditTmplDay(String(t.dayOfMonth));
  }

  async function saveEditTemplate() {
    if (!editTmplId || !editTmplDescriptor.trim() || !editTmplAmount) return;
    await updateRecurringTemplate(editTmplId, {
      descriptor: editTmplDescriptor.trim(),
      amount: parseFloat(editTmplAmount),
      instrument: 'recurring',
      categoryId: editTmplCategory ? (editTmplCategory as number) : null,
      dayOfMonth: parseInt(editTmplDay),
    });
    setEditTmplId(null);
  }

  // Backup settings (stored in localStorage; defaults: on, 2 backups, same dir as data file)
  const filePath = getFilePath();
  const defaultBackupDir = filePath ? filePath.replace(/[\\/][^\\/]+$/, '') : '';
  const [backupEnabled, setBackupEnabled] = useState(() => {
    const stored = localStorage.getItem('budget-app-backup-enabled');
    return stored === null ? true : stored === 'true'; // default ON
  });
  const [backupCount, setBackupCount] = useState(() => parseInt(localStorage.getItem('budget-app-backup-count') ?? '2', 10));
  const [backupDir, setBackupDir] = useState(() => localStorage.getItem('budget-app-backup-dir') || defaultBackupDir);
  const backupSaveRef = useRef(false);

  function saveBackupSettings(enabled: boolean, count: number, dir: string) {
    localStorage.setItem('budget-app-backup-enabled', String(enabled));
    localStorage.setItem('budget-app-backup-count', String(count));
    localStorage.setItem('budget-app-backup-dir', dir);
  }

  const [exportStatus, setExportStatus] = useState<string | null>(null);
  const [jsonExportStatus, setJsonExportStatus] = useState<string | null>(null);
  const [showEncryptArchiveModal, setShowEncryptArchiveModal] = useState(false);
  const [archivePassword, setArchivePassword] = useState('');
  const [archivePasswordConfirm, setArchivePasswordConfirm] = useState('');

  async function handleExport() {
    setExportStatus('Building archive…');
    try {
      const savedPath = await createReadableArchive(data);
      // Show just the filename portion so the message isn't too long
      const fileName = savedPath.split('/').pop() ?? savedPath;
      setExportStatus(`Saved: ${fileName}`);
    } catch (e) {
      setExportStatus(`Error: ${String(e)}`);
    }
    setTimeout(() => setExportStatus(null), 8000);
  }

  async function handleExportUnencryptedJson() {
    setJsonExportStatus('Saving…');
    try {
      const json = JSON.stringify(getData(), null, 2);
      let savePath: string | null = null;
      try {
        savePath = await save({
          defaultPath: 'budget-data.json',
          filters: [{ name: 'JSON File', extensions: ['json'] }],
        });
      } catch (_e) {}
      if (!savePath) {
        const home = await invoke<string>('get_home_dir');
        const date = new Date().toISOString().slice(0, 10);
        savePath = `${home}/budget-data-${date}.json`;
      }
      await invoke('save_data', { path: savePath, data: json });
      setJsonExportStatus(`Saved: ${savePath.split('/').pop()}`);
    } catch (e) {
      setJsonExportStatus(`Error: ${String(e)}`);
    }
    setTimeout(() => setJsonExportStatus(null), 8000);
  }

  async function doEncryptedExport() {
    if (!archivePassword || archivePassword !== archivePasswordConfirm) return;
    setShowEncryptArchiveModal(false);
    setJsonExportStatus('Encrypting…');
    try {
      const json = JSON.stringify(getData(), null, 2);
      const encrypted = await encryptData(json, archivePassword);
      let savePath: string | null = null;
      try {
        savePath = await save({
          defaultPath: 'budget-data-encrypted.json',
          filters: [{ name: 'JSON File', extensions: ['json'] }],
        });
      } catch (_e) {}
      if (!savePath) {
        const home = await invoke<string>('get_home_dir');
        const date = new Date().toISOString().slice(0, 10);
        savePath = `${home}/budget-data-encrypted-${date}.json`;
      }
      await invoke('save_data', { path: savePath, data: encrypted });
      setJsonExportStatus(`Encrypted archive saved: ${savePath.split('/').pop()}`);
    } catch (e) {
      setJsonExportStatus(`Error: ${String(e)}`);
    }
    setArchivePassword('');
    setArchivePasswordConfirm('');
    setTimeout(() => setJsonExportStatus(null), 8000);
  }

  const sections = [
    { id: 'settings-display', label: 'Display' },
    { id: 'settings-color-thresholds', label: 'Color Thresholds' },
    { id: 'settings-backup', label: 'Backup' },
    { id: 'settings-purge', label: 'Purge' },
    { id: 'settings-categories', label: 'Categories' },
    { id: 'settings-rules', label: 'Rules' },
    { id: 'settings-recurring', label: 'Recurring' },
    { id: 'settings-encryption', label: 'Encryption' },
    { id: 'settings-ai', label: 'AI' },
    { id: 'settings-parsers', label: 'Parsers' },
    { id: 'settings-export', label: 'Export' },
    { id: 'settings-experimental', label: 'Experimental' },
    ...(experimentalEnabled ? [{ id: 'settings-tools', label: 'Tools' }] : []),
  ];

  if (pendingEncryptedPath) {
    return (
      <div style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'var(--bg)' }}>
        <PasswordPrompt
          filePath={pendingEncryptedPath}
          onSubmit={async (password) => {
            await loadFromFile(pendingEncryptedPath, password);
            setPendingEncryptedPath(null);
          }}
          onCancel={() => setPendingEncryptedPath(null)}
        />
      </div>
    );
  }

  return (
    <div>
      <h1 className="view-title">Settings</h1>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', marginBottom: '1rem' }}>
        {sections.map((s) => (
          <button
            key={s.id}
            className="btn btn-ghost btn-sm"
            onClick={() => document.getElementById(s.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
          >
            {s.label}
          </button>
        ))}
      </div>

      <div id="settings-display" className="card" style={{ marginBottom: '1rem' }}>
        <div className="section-title">Display</div>
        <div className="field">
          <label>Zoom</label>
          <select
            value={zoom}
            onChange={(e) => onZoomChange?.(parseFloat(e.target.value))}
            style={{ padding: '0.6rem 0.75rem', maxWidth: 200 }}
          >
            {[0.67, 0.76, 0.86, 1, 1.1, 1.2].map((z) => (
              <option key={z} value={z}>{Math.round(z * 100)}%</option>
            ))}
          </select>
        </div>
        <div className="field" style={{ marginTop: '0.5rem' }}>
          <label>Appearance</label>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button
              className={`btn btn-sm ${!darkMode ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => onDarkModeChange?.(false)}
            >
              ☀ Light
            </button>
            <button
              className={`btn btn-sm ${darkMode ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => onDarkModeChange?.(true)}
            >
              ☾ Dark
            </button>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: '1rem' }}>
        <div className="section-title">Budget Period</div>
        <div className="field">
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button
              className={`btn btn-sm ${ytdMode === 'ytd' ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => { setYtdModeState('ytd'); updateDisplaySettings({ ytdMode: 'ytd' }); }}
            >
              Year-to-date
            </button>
            <button
              className={`btn btn-sm ${ytdMode === 'rolling12' ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => { setYtdModeState('rolling12'); updateDisplaySettings({ ytdMode: 'rolling12' }); }}
            >
              Rolling 12 months
            </button>
          </div>
          <p style={{ fontSize: '0.8rem', color: 'var(--text-2)', marginTop: '0.3rem', marginBottom: 0 }}>
            {ytdMode === 'rolling12'
              ? 'Averages and period totals cover the 12 months prior to the current month.'
              : 'Averages and period totals cover January through the previous month of the selected year.'}
          </p>
        </div>
      </div>

      {/* Color Thresholds */}
      <div id="settings-color-thresholds" className="card" style={{ marginBottom: '1rem' }}>
        <div className="section-title">Color Thresholds</div>
        <p style={{ fontSize: '0.85rem', color: 'var(--text-2)', marginBottom: '0.75rem' }}>
          Budget numbers turn orange or red when spending exceeds <strong>both</strong> the % and $ thresholds.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem 1.5rem', maxWidth: 420 }}>
          <div className="field">
            <label>Orange — % over budget</label>
            <input type="number" min="0" step="1"
              value={colorThresholds.orangePct}
              onChange={(e) => {
                const t = { ...colorThresholds, orangePct: parseFloat(e.target.value) || 0 };
                setColorThresholdsState(t);
                setColorThresholds(t);
              }}
              style={{ maxWidth: 90 }}
            />
          </div>
          <div className="field">
            <label>Orange — $ over budget</label>
            <input type="number" min="0" step="1"
              value={colorThresholds.orangeAbs}
              onChange={(e) => {
                const t = { ...colorThresholds, orangeAbs: parseFloat(e.target.value) || 0 };
                setColorThresholdsState(t);
                setColorThresholds(t);
              }}
              style={{ maxWidth: 90 }}
            />
          </div>
          <div className="field">
            <label>Red — % over budget</label>
            <input type="number" min="0" step="1"
              value={colorThresholds.redPct}
              onChange={(e) => {
                const t = { ...colorThresholds, redPct: parseFloat(e.target.value) || 0 };
                setColorThresholdsState(t);
                setColorThresholds(t);
              }}
              style={{ maxWidth: 90 }}
            />
          </div>
          <div className="field">
            <label>Red — $ over budget</label>
            <input type="number" min="0" step="1"
              value={colorThresholds.redAbs}
              onChange={(e) => {
                const t = { ...colorThresholds, redAbs: parseFloat(e.target.value) || 0 };
                setColorThresholdsState(t);
                setColorThresholds(t);
              }}
              style={{ maxWidth: 90 }}
            />
          </div>
        </div>
        <button
          className="btn btn-ghost btn-sm"
          style={{ marginTop: '0.5rem' }}
          onClick={() => {
            setColorThresholdsState({ ...DEFAULT_COLOR_THRESHOLDS });
            setColorThresholds({ ...DEFAULT_COLOR_THRESHOLDS });
          }}
        >
          Reset to defaults
        </button>
      </div>

      {/* Backup */}
      <div id="settings-backup" className="card" style={{ marginBottom: '1rem' }}>
        <div className="section-title">Automatic Backup</div>
        <p style={{ fontSize: '0.85rem', color: 'var(--text-2)', marginBottom: '0.75rem' }}>
          Creates unencrypted JSON backups on startup. Oldest backup is overwritten when the limit is reached.
        </p>
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', marginBottom: '0.75rem' }}>
          <input
            type="checkbox"
            checked={backupEnabled}
            onChange={(e) => { setBackupEnabled(e.target.checked); saveBackupSettings(e.target.checked, backupCount, backupDir); }}
            style={{ width: 16, height: 16 }}
          />
          <span style={{ fontSize: '0.875rem' }}>Enable automatic backups</span>
        </label>
        {backupEnabled && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <div className="field">
              <label>Number of backups to keep (1–5)</label>
              <input
                type="number" min="1" max="5"
                value={backupCount}
                onChange={(e) => { const v = Math.max(1, Math.min(5, parseInt(e.target.value) || 1)); setBackupCount(v); saveBackupSettings(backupEnabled, v, backupDir); }}
                style={{ maxWidth: 80 }}
              />
            </div>
            <div className="field">
              <label>Backup directory</label>
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                <input
                  value={backupDir}
                  onChange={(e) => { setBackupDir(e.target.value); if (!backupSaveRef.current) { backupSaveRef.current = true; setTimeout(() => { backupSaveRef.current = false; saveBackupSettings(backupEnabled, backupCount, e.target.value); }, 500); } }}
                  placeholder="/home/user/backups"
                  style={{ flex: 1, fontSize: '0.82rem' }}
                />
                <button className="btn btn-ghost btn-sm" onClick={async () => {
                  const { open: openDir } = await import('@tauri-apps/plugin-dialog');
                  const dir = await openDir({ directory: true, multiple: false });
                  if (dir && typeof dir === 'string') { setBackupDir(dir); saveBackupSettings(backupEnabled, backupCount, dir); }
                }}>Browse</button>
              </div>
            </div>
            {backupDir && <p style={{ fontSize: '0.8rem', color: 'var(--text-3)' }}>Backups saved as <code>kestl-backup-*.json</code> in {backupDir}</p>}
          </div>
        )}
      </div>

      {filePath && (
        <div className="card" style={{ marginBottom: '1rem', fontSize: '0.9rem' }}>
          Data file: <code style={{ wordBreak: 'break-all' }}>{filePath}</code>
          <button
            className="btn btn-ghost btn-sm"
            style={{ marginTop: '0.5rem', display: 'block' }}
            onClick={async () => {
              try {
                const selected = await open({
                  filters: [{ name: 'Budget Data', extensions: ['json'] }],
                  multiple: false,
                  directory: false,
                });
                if (!selected) return;
                const path = selected;
                try {
                  await loadFromFile(path);
                } catch (e) {
                  if (String(e).includes('FILE_ENCRYPTED')) {
                    setPendingEncryptedPath(path);
                  } else {
                    alert(String(e));
                  }
                }
              } catch (e) {
                alert(String(e));
              }
            }}
          >
            Open different file
          </button>
        </div>
      )}

      <div id="settings-purge" className="card" style={{ marginBottom: '1rem' }}>
        <div className="section-title">Purge transactions</div>
        <p style={{ fontSize: '0.85rem', opacity: 0.9, marginBottom: '0.75rem' }}>
          Permanently delete transactions. Category rules are kept.
        </p>

        {/* Mode toggle */}
        <div style={{ display: 'flex', gap: '0.4rem', marginBottom: '0.75rem' }}>
          <button className={`btn btn-sm ${purgeMode === 'month' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setPurgeMode('month')}>By month</button>
          <button className={`btn btn-sm ${purgeMode === 'instrument' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setPurgeMode('instrument')}>All months for instrument</button>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'flex-end' }}>
          {purgeMode === 'month' && (
            <>
              <div className="field" style={{ flex: '0 1 auto', minWidth: 100, marginBottom: 0 }}>
                <label>Month</label>
                <select value={purgeMonthNum} onChange={(e) => setPurgeMonthNum(e.target.value)}>
                  <option value="">Select...</option>
                  {['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'].map((m, i) => (
                    <option key={m} value={m}>{new Date(2000, i, 1).toLocaleDateString('en-US', { month: 'long' })}</option>
                  ))}
                </select>
              </div>
              <div className="field" style={{ flex: '0 1 auto', minWidth: 90, marginBottom: 0 }}>
                <label>Year</label>
                <select value={purgeYear} onChange={(e) => setPurgeYear(e.target.value)}>
                  <option value="">Select...</option>
                  {(() => {
                    const yrs = new Set(data.transactions.map((t) => t.txnDate.slice(0, 4)));
                    const arr = [...yrs].sort((a, b) => Number(b) - Number(a));
                    return arr.length ? arr : [new Date().getFullYear().toString()];
                  })().map((y) => <option key={y} value={y}>{y}</option>)}
                </select>
              </div>
            </>
          )}
          <div className="field" style={{ flex: '0 1 auto', minWidth: 140, marginBottom: 0 }}>
            <label>Instrument{purgeMode === 'month' ? ' (optional)' : ''}</label>
            <select value={purgeInstrument} onChange={(e) => setPurgeInstrument(e.target.value)}>
              {purgeMode === 'month' && <option value="">All instruments</option>}
              {purgeMode === 'instrument' && <option value="">Select instrument…</option>}
              {instruments.map((instr) => (
                <option key={instr} value={instr}>{instr}</option>
              ))}
            </select>
          </div>
          <button
            className="btn btn-danger"
            disabled={purgeMode === 'month' ? (!purgeYear || !purgeMonthNum) : !purgeInstrument}
            onClick={() => {
              if (purgeMode === 'month') {
                const purgeMonth = `${purgeYear}-${purgeMonthNum}`;
                const monthLabel = new Date(parseInt(purgeYear), parseInt(purgeMonthNum) - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
                const inMonth = data.transactions.filter((t) => t.txnDate.slice(0, 7) === purgeMonth);
                const count = purgeInstrument === 'PayPal'
                  ? inMonth.filter((t) => t.linkedTransactionId === -1 || t.instrument === 'PayPal').length
                  : inMonth.filter((t) => !purgeInstrument || t.instrument === purgeInstrument).length;
                setPurgeConfirm({ mode: 'month', month: purgeMonth, label: monthLabel, count, instrument: purgeInstrument });
              } else {
                const count = data.transactions.filter((t) => t.instrument === purgeInstrument).length;
                setPurgeConfirm({ mode: 'instrument', month: '', label: '', count, instrument: purgeInstrument });
              }
            }}
          >
            Purge transactions
          </button>
        </div>
      </div>

      {purgeConfirm && (
        <div className="modal-overlay" onClick={() => setPurgeConfirm(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Confirm Purge</h3>
            {purgeConfirm.mode === 'instrument' ? (
              <p>
                Are you sure you want to permanently delete all <strong>{purgeConfirm.count}</strong> <strong>{purgeConfirm.instrument}</strong> transaction(s) across all months?
              </p>
            ) : purgeConfirm.instrument === 'PayPal' ? (
              <>
                <p>
                  This will affect <strong>{purgeConfirm.count}</strong> PayPal transaction(s) from <strong>{purgeConfirm.label}</strong>:
                </p>
                <ul style={{ fontSize: '0.85rem', margin: '0.5rem 0' }}>
                  <li>PayPal-linked bank transactions will be <strong>reverted</strong> to their original state (descriptor restored, link removed).</li>
                  <li>Standalone PayPal transactions will be <strong>deleted</strong>.</li>
                </ul>
              </>
            ) : (
              <p>
                Are you sure you want to permanently delete <strong>{purgeConfirm.count}</strong>
                {purgeConfirm.instrument ? <> <strong>{purgeConfirm.instrument}</strong></> : ''} transaction(s) from <strong>{purgeConfirm.label}</strong>?
              </p>
            )}
            <p style={{ fontSize: '0.85rem', opacity: 0.8 }}>
              Category rules will NOT be affected.
            </p>
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => setPurgeConfirm(null)}>Cancel</button>
              <button
                className="btn btn-danger"
                onClick={async () => {
                  const { mode, month, label, instrument } = purgeConfirm;
                  setPurgeConfirm(null);
                  let deleted: number;
                  if (mode === 'instrument') {
                    deleted = await purgeTransactionsByInstrument(instrument);
                  } else {
                    deleted = await purgeTransactionsByMonth(month, instrument || undefined);
                  }
                  setPurgeYear('');
                  setPurgeMonthNum('');
                  setPurgeInstrument('');
                  const verb = instrument === 'PayPal' && mode === 'month' ? 'Reverted/deleted' : 'Deleted';
                  const scope = mode === 'instrument' ? `all months (${instrument})` : `${label}${instrument ? ` (${instrument})` : ''}`;
                  alert(`${verb} ${deleted} transaction(s) from ${scope}.`);
                }}
              >
                Purge {purgeConfirm.count} transaction(s)
              </button>
            </div>
          </div>
        </div>
      )}


      {paypalFuzzy.length > 0 && (
        <div className="modal-overlay" onClick={() => setPaypalFuzzy([])}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Confirm PayPal Matches</h3>
            <p style={{ fontSize: '0.85rem', marginBottom: '0.75rem' }}>
              These PayPal transactions have close but not exact amounts. Confirm each match or skip.
            </p>
            {paypalFuzzy.map((m) => {
              const diff = Math.abs(m.paypalTxn.amount - m.cardTxn.amount);
              return (
                <div key={m.paypalTxn.id} style={{ marginBottom: '1rem', paddingBottom: '0.75rem', borderBottom: '1px solid var(--border-color)' }}>
                  <div className="card" style={{ marginBottom: '0.5rem', borderLeft: '3px solid #8b5cf6' }}>
                    <div style={{ fontWeight: 600 }}>{m.paypalTxn.descriptor}</div>
                    <div style={{ fontSize: '0.85rem' }}>
                      ${formatAmount(m.paypalTxn.amount)} on {m.paypalTxn.txnDate}
                    </div>
                  </div>
                  <div className="card" style={{ marginBottom: '0.5rem', borderLeft: '3px solid #3b82f6' }}>
                    <div style={{ fontWeight: 600 }}>{m.cardTxn.descriptor}</div>
                    <div style={{ fontSize: '0.85rem' }}>
                      ${formatAmount(m.cardTxn.amount)} on {m.cardTxn.txnDate}
                    </div>
                  </div>
                  <div style={{ fontSize: '0.8rem', opacity: 0.7, marginBottom: '0.5rem' }}>
                    Difference: ${formatAmount(diff)} ({(diff / Math.max(m.paypalTxn.amount, 0.01) * 100).toFixed(1)}%)
                  </div>
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <button className="btn btn-primary btn-sm" style={{ flex: 1 }} onClick={async () => {
                      await confirmPaypalMatch(m.paypalTxn.id!, m.cardTxn.id);
                      setPaypalFuzzy((prev) => prev.filter((x) => x.paypalTxn.id !== m.paypalTxn.id));
                    }}>Link these</button>
                    <button className="btn btn-ghost btn-sm" style={{ flex: 1 }} onClick={() =>
                      setPaypalFuzzy((prev) => prev.filter((x) => x.paypalTxn.id !== m.paypalTxn.id))
                    }>Skip</button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {paypalUnmatched.length > 0 && (
        <div className="modal-overlay" onClick={() => {}}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 600 }}>
            <h3>Unmatched PayPal Transactions</h3>
            <p style={{ fontSize: '0.85rem', marginBottom: '0.75rem' }}>
              These PayPal transactions could not be matched to any existing bank debit.
              You can keep them as standalone transactions or discard them.
            </p>
            <div style={{ maxHeight: 400, overflowY: 'auto' }}>
              {paypalUnmatched.map((t) => (
                <div key={t.id} style={{ marginBottom: '0.75rem', paddingBottom: '0.75rem', borderBottom: '1px solid var(--border-color)' }}>
                  <div className="card" style={{ marginBottom: '0.5rem', borderLeft: '3px solid #f59e0b' }}>
                    <div style={{ fontWeight: 600 }}>{t.descriptor}</div>
                    <div style={{ fontSize: '0.85rem' }}>
                      ${formatAmount(t.amount)} on {t.txnDate}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <button className="btn btn-ghost btn-sm" style={{ flex: 1 }} onClick={async () => {
                      await discardPaypalTransactions([t.id]);
                      setPaypalUnmatched((prev) => prev.filter((x) => x.id !== t.id));
                    }}>Discard</button>
                    <button className="btn btn-primary btn-sm" style={{ flex: 1 }} onClick={() =>
                      setPaypalUnmatched((prev) => prev.filter((x) => x.id !== t.id))
                    }>Keep</button>
                  </div>
                </div>
              ))}
            </div>
            <div className="modal-actions" style={{ marginTop: '0.75rem' }}>
              <button className="btn btn-danger" onClick={async () => {
                await discardPaypalTransactions(paypalUnmatched.map((t) => t.id));
                setPaypalUnmatched([]);
              }}>Discard all {paypalUnmatched.length}</button>
              <button className="btn btn-primary" onClick={() => setPaypalUnmatched([])}>
                Keep all {paypalUnmatched.length}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Categories — button to open full screen */}
      <div id="settings-categories" className="card" style={{ marginBottom: '0.5rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: '0.95rem' }}>Categories</div>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-3)', marginTop: 2 }}>
              {categories.length} categories
            </div>
          </div>
          <button className="btn btn-primary" onClick={() => setShowCategoriesScreen(true)}>
            Manage →
          </button>
        </div>
      </div>

      {/* Rules — button to open full screen */}
      <div id="settings-rules" className="card" style={{ marginBottom: '1rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: '0.95rem' }}>Category Rules</div>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-3)', marginTop: 2 }}>
              {data.categoryRules.length} rules
            </div>
          </div>
          <button className="btn btn-primary" onClick={() => setShowRulesScreen(true)}>
            Manage →
          </button>
        </div>
      </div>

      {/* Categories full-screen overlay (below tab bar) */}
      {showCategoriesScreen && (
        <div style={{ position: 'fixed', top: 52, left: 0, right: 0, bottom: 0, zIndex: 200, background: 'var(--bg)', overflowY: 'auto', padding: '1.5rem clamp(0.75rem, 6vw, 8rem)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1.5rem' }}>
            <button className="btn btn-ghost" onClick={() => setShowCategoriesScreen(false)}>← Back</button>
            <h1 style={{ margin: 0, fontSize: '1.45rem', fontWeight: 700 }}>Categories</h1>
          </div>
          <div className="card">
            {categories.map((c) => (
              <div key={c.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.3rem 0', borderBottom: '1px solid var(--border)', gap: '0.5rem', flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flex: 1, minWidth: 120 }}>
                  <input
                    type="color"
                    value={c.color ?? '#888888'}
                    onChange={(e) => updateCategoryColor(c.id, e.target.value)}
                    title="Category color"
                    style={{ width: 28, height: 28, border: 'none', borderRadius: 6, cursor: 'pointer', padding: 0, background: 'none' }}
                  />
                  <span style={{ fontWeight: 500 }}>{c.name}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                  {data.savingsBuckets.length > 0 && (
                    <select
                      title="Link to savings bucket — transactions categorized here fill this bucket"
                      value={c.savingsBucketId ?? ''}
                      onChange={(e) => updateCategoryBucket(c.id, e.target.value ? Number(e.target.value) : null)}
                      style={{ fontSize: '0.75rem', padding: '0.1rem 0.3rem', maxWidth: 130 }}
                    >
                      <option value="">No bucket</option>
                      {data.savingsBuckets.map((b) => (
                        <option key={b.id} value={b.id}>{b.name}</option>
                      ))}
                    </select>
                  )}
                  <button
                    className={`btn btn-sm ${c.isIncome ? 'btn-primary' : 'btn-ghost'}`}
                    title={c.isIncome ? 'Marked as income — click to unmark' : 'Mark as income category'}
                    onClick={() => updateCategoryIsIncome(c.id, !c.isIncome)}
                    style={{ fontSize: '0.75rem', padding: '0.15rem 0.5rem' }}
                  >
                    Income
                  </button>
                  <button className="btn btn-danger btn-sm" onClick={() => handleDeleteCategory(c.id)}>
                    &times;
                  </button>
                </div>
              </div>
            ))}
            {categories.length === 0 && <p className="empty">No categories</p>}
            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem', alignItems: 'center' }}>
              <input
                style={{ flex: 1 }}
                value={newCat}
                onChange={(e) => setNewCat(e.target.value)}
                placeholder="New category"
                onKeyDown={(e) => e.key === 'Enter' && handleAddCategory()}
              />
              <button className="btn btn-primary" style={{ flexShrink: 0 }} onClick={handleAddCategory}>Add</button>
            </div>
          </div>
        </div>
      )}

      {/* Rules full-screen overlay (below tab bar) */}
      {showRulesScreen && (
        <div style={{ position: 'fixed', top: 52, left: 0, right: 0, bottom: 0, zIndex: 200, background: 'var(--bg)', overflowY: 'auto', padding: '1.5rem clamp(0.75rem, 6vw, 8rem)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1.5rem' }}>
            <button className="btn btn-ghost" onClick={() => setShowRulesScreen(false)}>← Back</button>
            <h1 style={{ margin: 0, fontSize: '1.45rem', fontWeight: 700 }}>Category Rules</h1>
          </div>
          {/* Run rule dialog */}
          {runRuleDialogId !== null && (() => {
            const rule = data.categoryRules.find((r) => r.id === runRuleDialogId);
            if (!rule) return null;
            return createPortal(
              <div style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <div className="card" style={{ minWidth: 320, maxWidth: 480, padding: '1.5rem', background: 'var(--bg-2)' }}>
                  <div style={{ fontWeight: 700, fontSize: '1rem', marginBottom: '0.25rem' }}>Run rule on historical transactions</div>
                  <div style={{ fontSize: '0.8rem', opacity: 0.65, marginBottom: '1rem' }}>
                    Pattern: <strong>{rule.pattern}</strong> · {rule.matchType}
                  </div>
                  <div className="field" style={{ marginBottom: '0.5rem' }}>
                    <label>Date range</label>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', fontSize: '0.85rem' }}>
                        <input type="checkbox" checked={!!runRuleStartDate} onChange={(e) => setRunRuleStartDate(e.target.checked ? new Date().toISOString().split('T')[0] : '')} />
                        From:
                        {runRuleStartDate ? (
                          <DateInput value={runRuleStartDate} onChange={setRunRuleStartDate} style={{ flex: 1 }} />
                        ) : (
                          <span style={{ opacity: 0.4 }}>all time</span>
                        )}
                      </label>
                      <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', fontSize: '0.85rem' }}>
                        <input type="checkbox" checked={!!runRuleEndDate} onChange={(e) => setRunRuleEndDate(e.target.checked ? new Date().toISOString().split('T')[0] : '')} />
                        To:
                        {runRuleEndDate ? (
                          <DateInput value={runRuleEndDate} onChange={setRunRuleEndDate} style={{ flex: 1 }} />
                        ) : (
                          <span style={{ opacity: 0.4 }}>all time</span>
                        )}
                      </label>
                    </div>
                  </div>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem', cursor: 'pointer' }}>
                    <input type="checkbox" checked={runRuleIncludeCategorized} onChange={(e) => setRunRuleIncludeCategorized(e.target.checked)} />
                    <span style={{ fontSize: '0.85rem' }}>Also recategorize already-categorized transactions</span>
                  </label>
                  {runRuleResult !== null && (
                    <div style={{ fontSize: '0.82rem', padding: '0.4rem 0.6rem', borderRadius: 5, background: 'rgba(52,211,153,0.08)', borderLeft: '3px solid var(--green)', marginBottom: '0.75rem' }}>
                      Applied to {runRuleResult} transaction{runRuleResult !== 1 ? 's' : ''}.
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <button className="btn btn-primary" onClick={handleRunRule}>Run now</button>
                    <button className="btn btn-ghost" onClick={closeRunRuleDialog}>Close</button>
                  </div>
                </div>
              </div>,
              document.body
            );
          })()}

          <div className="card">
            <div style={{ fontSize: '0.72rem', opacity: 0.55, marginBottom: '0.5rem' }}>
              Rules run in order — last matching rule wins. Drag rows to reorder.
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table className="data-table">
                <thead>
                  <tr><th style={{ width: 32 }}>#</th><th style={{ width: 20 }}></th><th>Pattern</th><th>Match</th><th>Amount</th><th>Category</th><th></th></tr>
                </thead>
                <tbody>
                  {rules.map((r) => {
                      return (
                        <tr
                          key={r.id}
                          draggable
                          onDragStart={(e) => { e.dataTransfer.setData('ruleId', String(r.id)); e.dataTransfer.effectAllowed = 'move'; }}
                          onDragOver={(e) => { e.preventDefault(); setDragOverRuleId(r.id); }}
                          onDragLeave={() => setDragOverRuleId(null)}
                          onDrop={(e) => { e.preventDefault(); const draggedId = Number(e.dataTransfer.getData('ruleId')); handleRulesDragEnd(draggedId, r.id); }}
                          style={{ opacity: dragOverRuleId === r.id ? 0.5 : 1, background: dragOverRuleId === r.id ? 'var(--accent-muted)' : undefined }}
                        >
                          <td style={{ fontSize: '0.72rem', opacity: 0.45, width: 32 }}>{r.orderNum}</td>
                          <td style={{ cursor: 'grab', opacity: 0.4, userSelect: 'none', width: 20 }}>⠿</td>
                          <td style={{ wordBreak: 'break-word', maxWidth: 260 }}>{r.pattern}</td>
                          <td><span className="chip">{r.matchType}</span></td>
                          <td>{r.amountMatch != null ? `$${formatAmount(r.amountMatch)}` : '—'}</td>
                          <td>
                            {r.splits && r.splits.length >= 2
                              ? <span style={{ fontSize: '0.8rem', color: 'var(--accent)' }}>Split: {r.splits.map((s) => `${catMap.get(s.categoryId) ?? '?'} ${s.percent != null ? s.percent + '%' : '$' + (s.amount ?? 0)}`).join(' + ')}</span>
                              : r.catName}
                          </td>
                          <td style={{ display: 'flex', gap: '0.3rem' }}>
                            <button className="btn btn-ghost btn-sm" onClick={() => openRunRuleDialog(r.id)} title="Run this rule on historical transactions">Run</button>
                            <button className="btn btn-ghost btn-sm" onClick={() => openEditRule(r)}>Edit</button>
                            <button className="btn btn-danger btn-sm" onClick={() => handleDeleteRule(r.id)}>&times;</button>
                          </td>
                        </tr>
                      );
                    })}

                  {data.categoryRules.length === 0 && <tr><td colSpan={7} className="empty">No rules</td></tr>}
                </tbody>
              </table>
            </div>
            {/* Simple rule */}
            <div style={{ borderTop: '1px solid var(--border)', marginTop: '0.75rem', paddingTop: '0.75rem' }}>
              <div style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.5rem' }}>Add simple rule</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'flex-end' }}>
                <div className="field" style={{ flex: '2 1 160px', marginBottom: 0 }}>
                  <label>Pattern</label>
                  <input value={newPattern} onChange={(e) => setNewPattern(e.target.value)} placeholder="keyword" />
                </div>
                <div className="field" style={{ flex: '1 1 100px', marginBottom: 0 }}>
                  <label>Match</label>
                  <SearchableSelect
                    options={[{ value: 'contains', label: 'Contains' }, { value: 'exact', label: 'Exact' }]}
                    value={newMatchType}
                    onChange={(v) => setNewMatchType(v as 'exact' | 'contains')}
                    placeholder="Match"
                  />
                </div>
                <div className="field" style={{ flex: '2 1 160px', marginBottom: 0 }}>
                  <label>Category</label>
                  <SearchableSelect
                    options={categoryOptions}
                    value={newRuleCat}
                    onChange={(v) => setNewRuleCat(v === '' ? '' : Number(v))}
                    placeholder="Select..."
                  />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexShrink: 0 }}>
                  <input type="checkbox" id="rule-amount-cb2" checked={!!newRuleAmountRequired} onChange={(e) => { setNewRuleAmountRequired(e.target.checked); if (!e.target.checked) setNewRuleAmount(''); }} />
                  <label htmlFor="rule-amount-cb2" style={{ fontSize: '0.8rem', whiteSpace: 'nowrap' }}>Amt</label>
                  {newRuleAmountRequired && (
                    <input type="number" step="0.01" value={newRuleAmount} onChange={(e) => setNewRuleAmount(e.target.value)} placeholder="0" style={{ width: '80px' }} />
                  )}
                </div>
                <button className="btn btn-primary" style={{ flexShrink: 0, alignSelf: 'flex-end' }} onClick={() => handleAddRule(false)}>Add Rule</button>
              </div>
            </div>

            {/* Split rule */}
            <div style={{ borderTop: '1px solid var(--border)', marginTop: '1rem', paddingTop: '0.75rem' }}>
              <div style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.5rem' }}>Add split rule — splits transaction into multiple categories</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'flex-end', marginBottom: '0.5rem' }}>
                <div className="field" style={{ flex: '2 1 160px', marginBottom: 0 }}>
                  <label>Pattern</label>
                  <input value={newPattern} onChange={(e) => setNewPattern(e.target.value)} placeholder="keyword" />
                </div>
                <div className="field" style={{ flex: '1 1 100px', marginBottom: 0 }}>
                  <label>Match</label>
                  <SearchableSelect
                    options={[{ value: 'contains', label: 'Contains' }, { value: 'exact', label: 'Exact' }]}
                    value={newMatchType}
                    onChange={(v) => setNewMatchType(v as 'exact' | 'contains')}
                    placeholder="Match"
                  />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', flexShrink: 0 }}>
                  <button className={`btn btn-sm ${newRuleSplitType === '%' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setNewRuleSplitType('%')}>%</button>
                  <button className={`btn btn-sm ${newRuleSplitType === '$' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setNewRuleSplitType('$')}>$</button>
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', background: 'var(--bg-3)', padding: '0.65rem', borderRadius: 'var(--radius)' }}>
                {newRuleSplits.map((s, i) => (
                  <div key={i} style={{ display: 'flex', gap: '0.4rem', alignItems: 'center', flexWrap: 'wrap' }}>
                    <div style={{ flex: '2 1 140px' }}>
                      <SearchableSelect
                        options={categoryOptions}
                        value={s.categoryId}
                        onChange={(v) => setNewRuleSplits((prev) => prev.map((x, j) => j === i ? { ...x, categoryId: v === '' ? '' : Number(v) } : x))}
                        placeholder="Category"
                      />
                    </div>
                    <input type="number" step="0.01" placeholder={newRuleSplitType === '%' ? '50' : '0.00'} value={s.amount} onChange={(e) => setNewRuleSplits((prev) => prev.map((x, j) => j === i ? { ...x, amount: e.target.value } : x))} style={{ width: 80, fontSize: '0.82rem' }} />
                    {newRuleSplits.length > 2 && (
                      <button className="btn btn-ghost btn-sm" onClick={() => setNewRuleSplits((prev) => prev.filter((_, j) => j !== i))}>×</button>
                    )}
                  </div>
                ))}
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginTop: '0.25rem' }}>
                  <button className="btn btn-ghost btn-sm" onClick={() => setNewRuleSplits((prev) => [...prev, { categoryId: '', amount: '' }])}>+ Add row</button>
                  {newRuleSplitType === '%' && (
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-3)' }}>
                      Total: {newRuleSplits.reduce((sum, s) => sum + (parseFloat(s.amount) || 0), 0)}%
                    </span>
                  )}
                </div>
              </div>
              <button className="btn btn-primary" style={{ marginTop: '0.5rem' }} onClick={() => handleAddRule(true)}>Add Split Rule</button>
            </div>

            <button className="btn btn-ghost btn-sm" onClick={runRecategorize} style={{ marginTop: '1rem' }}>
              Re-categorize uncategorized
            </button>
          </div>
        </div>
      )}

      {/* Recurring Templates */}
      <div id="settings-recurring" className="section-title">Recurring Templates</div>
      <p style={{ fontSize: '0.85rem', opacity: 0.8, marginBottom: '0.5rem' }}>
        Templates for expected recurring transactions (e.g. Netflix, mortgage). Each month, if no matching transaction exists, one is auto-created. <strong>Category rules</strong> instead assign categories to imported transactions by matching descriptors.
      </p>
      <div className="card">
        <table className="data-table">
          <thead>
            <tr>
              <th>Descriptor</th>
              <th className="num">Amount</th>
              <th>Category</th>
              <th>Day</th>
              <th>Active</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {templates.map((t) => {
              const cat = categories.find((c) => c.id === t.categoryId);
              if (editTmplId === t.id) {
                return (
                  <tr key={t.id} style={{ background: 'var(--accent-muted)' }}>
                    <td><input value={editTmplDescriptor} onChange={(e) => setEditTmplDescriptor(e.target.value)} style={{ width: '100%', fontSize: '0.85rem' }} /></td>
                    <td><input type="number" value={editTmplAmount} onChange={(e) => setEditTmplAmount(e.target.value)} style={{ width: 72, fontSize: '0.85rem' }} /></td>
                    <td>
                      <SearchableSelect
                        options={categoryOptions}
                        value={editTmplCategory}
                        onChange={(v) => setEditTmplCategory(v === '' ? '' : Number(v))}
                        placeholder="None"
                      />
                    </td>
                    <td><input type="number" min="1" max="31" value={editTmplDay} onChange={(e) => setEditTmplDay(e.target.value)} style={{ width: 48, fontSize: '0.85rem' }} /></td>
                    <td colSpan={2} style={{ whiteSpace: 'nowrap' }}>
                      <button className="btn btn-primary btn-sm" onClick={saveEditTemplate}>Save</button>
                      <button className="btn btn-ghost btn-sm" onClick={() => setEditTmplId(null)} style={{ marginLeft: 4 }}>Cancel</button>
                    </td>
                  </tr>
                );
              }
              return (
                <tr key={t.id}>
                  <td>{t.descriptor}</td>
                  <td className="num">${formatAmount(t.amount)}</td>
                  <td>{cat?.name ?? '—'}</td>
                  <td>{t.dayOfMonth}</td>
                  <td>
                    <button
                      className={`btn btn-sm ${t.active ? 'btn-success' : 'btn-ghost'}`}
                      onClick={() => handleToggleTemplate(t)}
                    >
                      {t.active ? 'Active' : 'Paused'}
                    </button>
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn btn-ghost btn-sm" onClick={() => startEditTemplate(t)} title="Edit">✎</button>
                    <button className="btn btn-danger btn-sm" onClick={() => handleDeleteTemplate(t.id)} style={{ marginLeft: 2 }}>&times;</button>
                  </td>
                </tr>
              );
            })}
            {templates.length === 0 && <tr><td colSpan={6} className="empty">No recurring templates</td></tr>}
          </tbody>
        </table>

        <div className="row" style={{ marginTop: '0.5rem' }}>
          <div className="field">
            <label>Descriptor</label>
            <input value={tmplDescriptor} onChange={(e) => setTmplDescriptor(e.target.value)} placeholder="Netflix, etc." />
          </div>
          <div className="field">
            <label>Amount</label>
            <input type="number" value={tmplAmount} onChange={(e) => setTmplAmount(e.target.value)} placeholder="0" />
          </div>
        </div>
        <div className="row">
          <div className="field">
            <label>Category</label>
            <SearchableSelect
              options={categoryOptions}
              value={tmplCategory}
              onChange={(v) => setTmplCategory(v === '' ? '' : Number(v))}
              placeholder="None"
            />
          </div>
          <div className="field">
            <label>Day of month</label>
            <input type="number" min="1" max="31" value={tmplDay} onChange={(e) => setTmplDay(e.target.value)} />
          </div>
          <button className="btn btn-primary" onClick={handleAddTemplate} style={{ alignSelf: 'center', flex: '0 0 auto' }}>Add Template</button>
        </div>
      </div>

      {/* ── File Encryption ── */}
      <div id="settings-encryption" className="card" style={{ marginBottom: '1rem' }}>
        <div className="section-title">File Encryption</div>
        <p style={{ fontSize: '0.85rem', opacity: 0.8, marginBottom: '0.75rem' }}>
          Encrypt your data file with a password. The file is decrypted in-memory only — nothing unencrypted is ever written to disk.
          Safe to store on cloud drives or shared folders.
        </p>

        <div className="row" style={{ alignItems: 'center', gap: '0.75rem', marginBottom: '0.75rem' }}>
          <span>
            <span className={`ai-status-dot ${encEnabled ? 'connected' : 'disconnected'}`} />
            {encEnabled ? 'Encryption enabled' : 'Not encrypted'}
          </span>
          {encEnabled && encAction === null && (
            <>
              <button className="btn btn-ghost btn-sm" onClick={() => { setEncAction('change'); setEncMsg(null); }}>
                Change password
              </button>
              <button className="btn btn-danger btn-sm" onClick={() => { setEncAction('disable'); setEncMsg(null); }}>
                Disable encryption
              </button>
            </>
          )}
          {!encEnabled && encAction === null && (
            <button className="btn btn-primary btn-sm" onClick={() => { setEncAction('enable'); setEncMsg(null); }}>
              Enable encryption
            </button>
          )}
        </div>

        {encMsg && (
          <div style={{
            padding: '0.5rem 0.75rem', borderRadius: 6, fontSize: '0.85rem', marginBottom: '0.5rem',
            background: encMsg.ok ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
            border: `1px solid ${encMsg.ok ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'}`,
            color: encMsg.ok ? '#22c55e' : '#ef4444',
          }}>
            {encMsg.text}
          </div>
        )}

        {encAction === 'enable' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <div className="field">
              <label>New password</label>
              <input type="password" value={encPwd1} onChange={(e) => setEncPwd1(e.target.value)} placeholder="At least 6 characters" />
            </div>
            <div className="field">
              <label>Confirm password</label>
              <input type="password" value={encPwd2} onChange={(e) => setEncPwd2(e.target.value)} placeholder="Repeat password" />
            </div>
            <div className="row" style={{ gap: '0.5rem' }}>
              <button className="btn btn-primary btn-sm" onClick={handleEnableEncryption}>Enable</button>
              <button className="btn btn-ghost btn-sm" onClick={() => { setEncAction(null); setEncPwd1(''); setEncPwd2(''); }}>Cancel</button>
            </div>
          </div>
        )}

        {encAction === 'change' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <div className="field">
              <label>Current password</label>
              <input type="password" value={encOldPwd} onChange={(e) => setEncOldPwd(e.target.value)} />
            </div>
            <div className="field">
              <label>New password</label>
              <input type="password" value={encPwd1} onChange={(e) => setEncPwd1(e.target.value)} />
            </div>
            <div className="field">
              <label>Confirm new password</label>
              <input type="password" value={encPwd2} onChange={(e) => setEncPwd2(e.target.value)} />
            </div>
            <div className="row" style={{ gap: '0.5rem' }}>
              <button className="btn btn-primary btn-sm" onClick={handleChangePassword}>Change</button>
              <button className="btn btn-ghost btn-sm" onClick={() => { setEncAction(null); setEncPwd1(''); setEncPwd2(''); setEncOldPwd(''); }}>Cancel</button>
            </div>
          </div>
        )}

        {encAction === 'disable' && (
          <div>
            <p style={{ fontSize: '0.85rem', marginBottom: '0.5rem' }}>
              This will save the file as plain unencrypted JSON. Are you sure?
            </p>
            <div className="row" style={{ gap: '0.5rem' }}>
              <button className="btn btn-danger btn-sm" onClick={handleDisableEncryption}>Yes, disable encryption</button>
              <button className="btn btn-ghost btn-sm" onClick={() => setEncAction(null)}>Cancel</button>
            </div>
          </div>
        )}
      </div>

      {/* ── AI Assistant Setup ── */}
      <div id="settings-ai" className="card" style={{ marginBottom: '1rem' }}>
        <div className="section-title">AI Assistant</div>
        <p style={{ fontSize: '0.85rem', opacity: 0.75, marginBottom: '1rem' }}>
          Runs a local AI model on your computer — no data leaves your machine.
          Enables transaction lookup, budget Q&amp;A, and smart categorization.
        </p>

        {/* Step 1: Ollama */}
        <div style={{ marginBottom: '1rem' }}>
          <div style={{ fontSize: '0.75rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--text-3)', marginBottom: '0.5rem' }}>
            Step 1 — AI Engine
          </div>
          <div className="row" style={{ alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
            <span className={`ai-status-dot ${aiStatus === 'connected' ? 'connected' : aiStatus === 'disconnected' ? 'disconnected' : 'checking'}`} />
            <span style={{ fontSize: '0.875rem' }}>
              {aiStatus === 'idle' && 'Not checked yet'}
              {aiStatus === 'checking' && 'Checking…'}
              {aiStatus === 'connected' && 'Ollama is running'}
              {aiStatus === 'disconnected' && 'Ollama is not running'}
            </span>
            <button className="btn btn-ghost btn-sm" onClick={() => checkAiConnection(aiUrl, false)}>Recheck</button>
          </div>

          {aiStatus === 'disconnected' && (
            <div style={{ background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 8, padding: '0.75rem', fontSize: '0.85rem' }}>
              <div style={{ marginBottom: '0.6rem', opacity: 0.85 }}>
                Ollama is the engine that runs AI models locally.
                {installing ? ' Downloading…' : ' Click below to install it automatically, or start it if already installed.'}
              </div>
              <div className="row" style={{ gap: '0.5rem' }}>
                <button className="btn btn-primary btn-sm" onClick={handleInstallOllama} disabled={installing}>
                  {installing ? 'Downloading…' : 'Download & Install Ollama'}
                </button>
                <button className="btn btn-ghost btn-sm" onClick={handleStartOllama} disabled={installing}>
                  Start Ollama
                </button>
              </div>
              {(installStatus || installing) && (
                <div style={{ marginTop: '0.6rem' }}>
                  <div style={{ fontSize: '0.8rem', opacity: 0.9, marginBottom: '0.3rem' }}>{installStatus || 'Connecting…'}</div>
                  <div style={{ background: 'var(--border)', borderRadius: 4, height: 6 }}>
                    <div style={{ background: 'var(--accent)', borderRadius: 4, height: '100%', width: `${installPct ?? 0}%`, transition: 'width 0.3s' }} />
                  </div>
                </div>
              )}
            </div>
          )}

          {/* URL (advanced, collapsed by default) */}
          <details style={{ marginTop: '0.5rem', fontSize: '0.8rem' }}>
            <summary style={{ cursor: 'pointer', opacity: 0.6 }}>Custom Ollama URL</summary>
            <div className="field" style={{ marginTop: '0.4rem' }}>
              <input value={aiUrl} onChange={(e) => setAiUrl(e.target.value)} placeholder="http://localhost:11434" />
            </div>
          </details>
        </div>

        {/* Step 2: Model */}
        <div style={{ marginBottom: '0.75rem' }}>
          <div style={{ fontSize: '0.75rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--text-3)', marginBottom: '0.5rem' }}>
            Step 2 — AI Model
          </div>

          {(() => {
            // Fuzzy match: model is "installed" if any installed model name starts with the selected name prefix
            const modelInstalled = aiModels.some((m) => m === aiModel || m.startsWith(aiModel.split(':')[0]));
            return (
              <>
                <div className="field" style={{ marginBottom: '0.5rem' }}>
                  <label>Select model</label>
                  <select
                    value={aiModel}
                    onChange={async (e) => {
                      setAiModel(e.target.value);
                      await updateAISettings({ ollamaUrl: aiUrl, model: e.target.value });
                    }}
                    style={{ padding: '0.5rem 0.75rem', width: '100%' }}
                  >
                    {aiModels.length > 0 && (
                      <optgroup label="✓ Installed on this machine">
                        {aiModels.map((m) => <option key={m} value={m}>{m}</option>)}
                      </optgroup>
                    )}
                    <optgroup label="Recommended — not yet downloaded">
                      {RECOMMENDED_MODELS.filter((m) => !aiModels.some((im) => im.startsWith(m.name.split(':')[0]))).map((m) => (
                        <option key={m.name} value={m.name}>{m.label}</option>
                      ))}
                    </optgroup>
                  </select>
                </div>

                {!modelInstalled && !pulling && !pullStatus && (
                  <div style={{ background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 8, padding: '0.75rem', fontSize: '0.85rem', marginBottom: '0.5rem' }}>
                    <div style={{ marginBottom: '0.5rem', opacity: 0.85 }}>
                      <strong>{aiModel}</strong> is not downloaded yet. Click below to download it (~4–8 GB).
                    </div>
                    <button className="btn btn-primary btn-sm" onClick={handlePullModel} disabled={aiStatus !== 'connected'}>
                      Download {aiModel}
                    </button>
                    {aiStatus !== 'connected' && (
                      <span style={{ fontSize: '0.78rem', opacity: 0.6, marginLeft: '0.5rem' }}>Start Ollama first (Step 1)</span>
                    )}
                  </div>
                )}

                {(pulling || pullStatus) && (
                  <div style={{ marginBottom: '0.5rem' }}>
                    <div style={{ fontSize: '0.82rem', marginBottom: '0.3rem', opacity: 0.9 }}>{pullStatus || 'Connecting…'}</div>
                    <div style={{ background: 'var(--border)', borderRadius: 4, height: 6 }}>
                      <div style={{
                        background: pulling && (pullPct ?? 0) === 0 ? 'var(--accent)' : '#3b82f6',
                        borderRadius: 4,
                        height: '100%',
                        width: pulling && (pullPct ?? 0) === 0 ? '100%' : `${pullPct ?? 0}%`,
                        transition: pulling && (pullPct ?? 0) === 0 ? 'none' : 'width 0.3s',
                        opacity: pulling && (pullPct ?? 0) === 0 ? 0.4 : 1,
                        animation: pulling && (pullPct ?? 0) === 0 ? 'pulse 1.5s ease-in-out infinite' : 'none',
                      }} />
                    </div>
                  </div>
                )}

                {modelInstalled && aiStatus === 'connected' && (
                  <div style={{ fontSize: '0.82rem', color: 'var(--green)', marginBottom: '0.25rem' }}>
                    ✓ Ready — use the <strong>AI</strong> button (top right) to chat, or <strong>?</strong> on any transaction.
                  </div>
                )}
              </>
            );
          })()}
        </div>
      </div>

      {/* ── Import Budget ── */}
      <div className="card" style={{ marginBottom: '1rem' }}>
        <div className="section-title">Import Budget</div>
        <ImportBudgetCard />
      </div>

      {/* ── Bank CSV Formats ── */}
      <div id="settings-parsers" className="card" style={{ marginBottom: '1rem' }}>
        <div className="section-title">Bank CSV Formats</div>
        <p style={{ fontSize: '0.85rem', opacity: 0.8, marginBottom: '0.75rem' }}>
          The Bank CSV button in Import will try each format below in order until one produces results.
          Click any parser to view details or rename it.
        </p>

        {/* Built-in parsers */}
        {[
          { name: 'Scotia Chequing CSV', instrument: 'Chequing', columns: 'Date, Description, Sub-description, Type of Transaction, Amount' },
          { name: 'Scotia Credit Card CSV', instrument: 'Card', columns: 'Date, Description, Sub-description, Amount (negative = credit)' },
        ].map((b) => (
          <div
            key={b.name}
            className="parser-row"
            style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.4rem 0.3rem', borderBottom: '1px solid var(--border)', fontSize: '0.875rem', cursor: 'pointer', borderRadius: 4 }}
            onClick={() => setSelectedBuiltin(b)}
          >
            <span style={{ flex: 1, fontWeight: 500 }}>{b.name}</span>
            <span style={{ fontSize: '0.75rem', opacity: 0.4 }}>built-in</span>
            <span style={{ opacity: 0.35, fontSize: '1rem' }}>›</span>
          </div>
        ))}

        {/* Custom parsers */}
        {(data.customParsers ?? []).map((p: { id: string; name: string; instrument: string; code: string; sampleLines: string; createdAt: string }) => (
          <div
            key={p.id}
            className="parser-row"
            style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.4rem 0.3rem', borderBottom: '1px solid var(--border)', fontSize: '0.875rem', cursor: 'pointer', borderRadius: 4 }}
            onClick={() => { setSelectedParser(p); setEditingParserName(p.name); }}
          >
            <span style={{ flex: 1, fontWeight: 500 }}>{p.name}</span>
            <button
              className="btn btn-danger btn-sm"
              onClick={async (e) => { e.stopPropagation(); await deleteCustomParser(p.id); }}
            >Delete</button>
          </div>
        ))}

        <div style={{ marginTop: '0.75rem' }}>
          {showParserCreate ? (
            <ParserGenerator onParsersChange={() => setShowParserCreate(false)} />
          ) : (
            <button className="btn btn-primary btn-sm" onClick={() => { onNeedOllama?.(); setShowParserCreate(true); }}>
              + Create Parser from Sample File
            </button>
          )}
        </div>
      </div>

      {/* ── Export ── */}
      <div id="settings-export" className="card" style={{ marginBottom: '1rem' }}>
        <div className="section-title">Export</div>

        <div style={{ marginBottom: '1.25rem' }}>
          <p style={{ fontSize: '0.85rem', opacity: 0.8, marginBottom: '0.75rem' }}>
            Creates an Excel file with two tabs per month (budget + transactions), a year summary tab, and a savings tab.
          </p>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <button className="btn btn-primary" onClick={handleExport} disabled={!!exportStatus}>
              {exportStatus ?? 'Create Readable Archive'}
            </button>
            {exportStatus && <span style={{ fontSize: '0.85rem', opacity: 0.7 }}>{exportStatus}</span>}
          </div>
        </div>

        <div style={{ marginBottom: '1.25rem' }}>
          <p style={{ fontSize: '0.85rem', opacity: 0.8, marginBottom: '0.75rem' }}>
            Save a copy of your data as a JSON file. Use the unencrypted version for backups you can read directly, or create an encrypted copy with a separate password.
          </p>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
            <button className="btn btn-ghost" onClick={handleExportUnencryptedJson} disabled={!!jsonExportStatus}>
              Create Unencrypted JSON Archive
            </button>
            <button className="btn btn-ghost" onClick={() => { setShowEncryptArchiveModal(true); setArchivePassword(''); setArchivePasswordConfirm(''); }} disabled={!!jsonExportStatus}>
              Create Encrypted JSON Archive
            </button>
            {jsonExportStatus && <span style={{ fontSize: '0.85rem', opacity: 0.7 }}>{jsonExportStatus}</span>}
          </div>
        </div>

      </div>

      {/* ── Experimental Features ── */}
      <div id="settings-experimental" className="card" style={{ marginBottom: '1rem' }}>
        <div className="section-title">Experimental Features</div>
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', cursor: 'pointer', fontSize: '0.9rem', marginBottom: '0.75rem' }}>
          <input
            type="checkbox"
            checked={experimentalEnabled}
            onChange={(e) => onExperimentalChange?.(e.target.checked)}
          />
          <div>
            <div style={{ fontWeight: 600 }}>Mortgage Tool</div>
            <div style={{ fontSize: '0.78rem', opacity: 0.6, marginTop: 2 }}>Adds a Tools menu with the Mortgage Tool</div>
          </div>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', cursor: 'pointer', fontSize: '0.9rem' }}>
          <input
            type="checkbox"
            checked={txnAiLookupEnabled}
            onChange={(e) => onTxnAiLookupChange?.(e.target.checked)}
          />
          <div>
            <div style={{ fontWeight: 600 }}>Transaction AI Lookup</div>
            <div style={{ fontSize: '0.78rem', opacity: 0.6, marginTop: 2 }}>Shows a ? button on each transaction to identify it using AI (requires Ollama)</div>
          </div>
        </label>
      </div>

      {/* ── Tools (only when experimental enabled) ── */}
      {experimentalEnabled && (
        <div id="settings-tools" className="card" style={{ marginBottom: '1rem' }}>
          <div className="section-title">Tools</div>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', cursor: 'pointer', fontSize: '0.9rem' }}>
            <input
              type="checkbox"
              checked={showMortgageTab}
              onChange={(e) => onShowMortgageTabChange?.(e.target.checked)}
            />
            <div>
              <div style={{ fontWeight: 600 }}>Show Mortgage as app tab</div>
              <div style={{ fontSize: '0.78rem', opacity: 0.6, marginTop: 2 }}>Adds a Mortgage tab to the top navigation bar</div>
            </div>
          </label>
          {getMortgageConfig() && (
            <div style={{ marginTop: '1rem', paddingTop: '0.75rem', borderTop: '1px solid var(--border)' }}>
              <div style={{ fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.4rem' }}>Mortgage Data</div>
              {confirmDeleteMortgage ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '0.85rem', color: 'var(--text-2)' }}>
                    Are you sure you want to delete all mortgage data?
                  </span>
                  <button
                    className="btn btn-danger btn-sm"
                    onClick={async () => {
                      await deleteMortgage();
                      setConfirmDeleteMortgage(false);
                    }}
                  >Yes, delete</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => setConfirmDeleteMortgage(false)}>Cancel</button>
                </div>
              ) : (
                <button
                  className="btn btn-ghost btn-sm"
                  style={{ color: '#dc2626', borderColor: '#dc262640' }}
                  onClick={() => setConfirmDeleteMortgage(true)}
                >
                  Delete mortgage &amp; all data…
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {showEncryptArchiveModal && (
        <div className="modal-overlay">
          <div className="modal" style={{ maxWidth: 360 }}>
            <h3 style={{ marginTop: 0 }}>Encrypt Archive</h3>
            <p style={{ fontSize: '0.85rem', opacity: 0.8 }}>Set a password for this archive. This does not affect your current file.</p>
            <div className="field" style={{ marginBottom: '0.75rem' }}>
              <label>Password</label>
              <input type="password" value={archivePassword} onChange={(e) => setArchivePassword(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && doEncryptedExport()} autoFocus />
            </div>
            <div className="field" style={{ marginBottom: '1rem' }}>
              <label>Confirm password</label>
              <input type="password" value={archivePasswordConfirm} onChange={(e) => setArchivePasswordConfirm(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && doEncryptedExport()} />
            </div>
            {archivePassword && archivePasswordConfirm && archivePassword !== archivePasswordConfirm && (
              <p style={{ color: 'var(--red)', fontSize: '0.82rem', marginBottom: '0.5rem' }}>Passwords do not match.</p>
            )}
            <div className="modal-actions">
              <button className="btn btn-primary" onClick={doEncryptedExport}
                disabled={!archivePassword || archivePassword !== archivePasswordConfirm}>
                Save Encrypted Archive
              </button>
              <button className="btn btn-ghost" onClick={() => setShowEncryptArchiveModal(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
      {editingRule !== null && createPortal(
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' }}>
          <div className="card" style={{ width: '100%', maxWidth: 480 }}>
            <div style={{ fontWeight: 700, fontSize: '1rem', marginBottom: '1rem' }}>Edit Rule</div>

            <div className="field">
              <label>Pattern</label>
              <input value={editPattern} onChange={(e) => setEditPattern(e.target.value)} />
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.75rem' }}>
              <button className={`btn btn-sm ${editMatchType === 'exact' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setEditMatchType('exact')}>Exact</button>
              <button className={`btn btn-sm ${editMatchType === 'contains' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setEditMatchType('contains')}>Contains</button>
            </div>
            <div className="field">
              <label>Amount condition (optional)</label>
              <input type="number" step="0.01" value={editAmountMatch} onChange={(e) => setEditAmountMatch(e.target.value)} placeholder="any" />
            </div>

            {editSplits.length >= 2 ? (
              <>
                <div style={{ fontSize: '0.8rem', fontWeight: 600, marginBottom: '0.5rem' }}>Split by:
                  <button className={`btn btn-sm ${editSplitType === '%' ? 'btn-primary' : 'btn-ghost'}`} style={{ marginLeft: '0.5rem' }} onClick={() => setEditSplitType('%')}>%</button>
                  <button className={`btn btn-sm ${editSplitType === '$' ? 'btn-primary' : 'btn-ghost'}`} style={{ marginLeft: '0.25rem' }} onClick={() => setEditSplitType('$')}>$</button>
                </div>
                {editSplits.map((s, i) => (
                  <div key={i} style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.4rem', alignItems: 'center' }}>
                    <div style={{ flex: 1 }}>
                      <SearchableSelect
                        options={categoryOptions}
                        value={s.categoryId}
                        onChange={(v) => setEditSplits((prev) => prev.map((x, j) => j === i ? { ...x, categoryId: v === '' ? '' : Number(v) } : x))}
                        placeholder="Category"
                      />
                    </div>
                    <input type="number" step="0.01" placeholder={editSplitType === '%' ? '50' : '0.00'} value={s.amount}
                      onChange={(e) => setEditSplits((prev) => prev.map((x, j) => j === i ? { ...x, amount: e.target.value } : x))}
                      style={{ width: 80 }} />
                    {editSplits.length > 2 && <button className="btn btn-ghost btn-sm" style={{ color: 'var(--red)' }} onClick={() => setEditSplits((prev) => prev.filter((_, j) => j !== i))}>×</button>}
                  </div>
                ))}
                <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', marginBottom: '0.75rem' }}>
                  <button className="btn btn-ghost btn-sm" onClick={() => setEditSplits((prev) => [...prev, { categoryId: '', amount: '' }])}>+ Add row</button>
                  {(() => {
                    const total = editSplits.reduce((sum, s) => sum + (parseFloat(s.amount) || 0), 0);
                    const ok = editSplitType === '%' ? Math.abs(total - 100) < 0.01 : true;
                    return <span style={{ fontSize: '0.75rem', color: ok ? 'var(--green)' : 'var(--red)' }}>
                      {editSplitType === '%' ? `Total: ${total.toFixed(1)}%` : `Total: $${total.toFixed(2)}`}
                    </span>;
                  })()}
                </div>
              </>
            ) : (
              <div className="field">
                <label>Category</label>
                <SearchableSelect
                  options={categoryOptions}
                  value={editCatId}
                  onChange={(v) => setEditCatId(v === '' ? '' : Number(v))}
                  placeholder="Select category"
                />
              </div>
            )}

            <div style={{ display: 'flex', gap: '0.75rem', marginTop: '0.5rem' }}>
              <button className="btn btn-primary" onClick={handleSaveRule}>Save & Apply</button>
              <button className="btn btn-ghost" onClick={() => setEditingRule(null)}>Cancel</button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {/* Built-in parser detail overlay */}
      {selectedBuiltin != null && (
        <div style={{ position: 'fixed', top: 52, left: 0, right: 0, bottom: 0, zIndex: 200, background: 'var(--bg)', overflowY: 'auto', padding: '1.5rem clamp(0.75rem, 6vw, 8rem)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1.5rem' }}>
            <button className="btn btn-ghost" onClick={() => setSelectedBuiltin(null)}>← Back</button>
            <h1 style={{ margin: 0, fontSize: '1.45rem', fontWeight: 700 }}>{selectedBuiltin.name}</h1>
          </div>
          <div className="card" style={{ marginBottom: '1rem' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
              <tbody>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: '0.4rem 0.5rem', opacity: 0.6, width: 140 }}>Type</td>
                  <td style={{ padding: '0.4rem 0.5rem' }}>Built-in (cannot be renamed or deleted)</td>
                </tr>
                <tr>
                  <td style={{ padding: '0.4rem 0.5rem', opacity: 0.6 }}>Columns</td>
                  <td style={{ padding: '0.4rem 0.5rem', fontFamily: 'monospace', fontSize: '0.85rem' }}>{selectedBuiltin.columns}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Custom parser detail overlay */}
      {selectedParser != null && (
        <div style={{ position: 'fixed', top: 52, left: 0, right: 0, bottom: 0, zIndex: 200, background: 'var(--bg)', overflowY: 'auto', padding: '1.5rem clamp(0.75rem, 6vw, 8rem)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1.5rem' }}>
            <button className="btn btn-ghost" onClick={() => setSelectedParser(null)}>← Back</button>
            <h1 style={{ margin: 0, fontSize: '1.45rem', fontWeight: 700 }}>{selectedParser.name}</h1>
          </div>
          <div className="card" style={{ marginBottom: '1rem' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
              <tbody>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: '0.4rem 0.5rem', opacity: 0.6, width: 140 }}>Name</td>
                  <td style={{ padding: '0.4rem 0.5rem' }}>
                    <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
                      <input
                        value={editingParserName}
                        onChange={(e) => setEditingParserName(e.target.value)}
                        style={{ flex: 1, fontWeight: 500 }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && editingParserName.trim() && editingParserName.trim() !== selectedParser.name) {
                            const updated = { ...selectedParser, name: editingParserName.trim() };
                            saveCustomParser(updated);
                            setSelectedParser(updated);
                          }
                        }}
                      />
                      <button
                        className="btn btn-primary btn-sm"
                        disabled={!editingParserName.trim() || editingParserName.trim() === selectedParser.name}
                        onClick={async () => {
                          const updated = { ...selectedParser, name: editingParserName.trim() };
                          await saveCustomParser(updated);
                          setSelectedParser(updated);
                        }}
                      >Save</button>
                    </div>
                  </td>
                </tr>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: '0.4rem 0.5rem', opacity: 0.6 }}>Created</td>
                  <td style={{ padding: '0.4rem 0.5rem' }}>{selectedParser.createdAt ? new Date(selectedParser.createdAt).toLocaleString() : '—'}</td>
                </tr>
              </tbody>
            </table>
          </div>
          {selectedParser.sampleLines && (
            <div className="card" style={{ marginBottom: '1rem' }}>
              <div style={{ fontWeight: 600, marginBottom: '0.5rem', fontSize: '0.875rem' }}>Sample lines</div>
              <pre style={{ fontSize: '0.78rem', overflowX: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: 0, opacity: 0.85 }}>{selectedParser.sampleLines}</pre>
            </div>
          )}
          <div className="card" style={{ marginBottom: '1rem' }}>
            <div style={{ fontWeight: 600, marginBottom: '0.5rem', fontSize: '0.875rem' }}>Parser code (JavaScript)</div>
            <pre style={{ fontSize: '0.78rem', overflowX: 'auto', whiteSpace: 'pre', margin: 0, opacity: 0.85 }}>{selectedParser.code}</pre>
          </div>
          <button
            className="btn btn-danger"
            onClick={async () => { await deleteCustomParser(selectedParser.id); setSelectedParser(null); }}
          >
            Delete this parser
          </button>
        </div>
      )}
    </div>
  );
}


