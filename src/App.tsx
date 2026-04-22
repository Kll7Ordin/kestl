import { useState, useEffect, useRef, useCallback, useSyncExternalStore } from 'react';
import { FileSetup } from './components/FileSetup';
import { BudgetView } from './components/BudgetView';
import { TransactionView } from './components/TransactionView';
import { YearView } from './components/YearView';
import { SavingsView } from './components/SavingsView';
import { ImportView } from './components/ImportView';
import { SettingsView } from './components/SettingsView';
import { ExperimentalBudgetsView } from './components/ExperimentalBudgetsView';
import { ToolsView } from './components/ToolsView';
import { MortgageTool } from './components/MortgageTool';
import { processRecurringTemplates } from './logic/recurring';
import { processSchedules } from './logic/savings';
import { startupCleanup, getAISettings, getData, undo, canUndo, subscribeUndo, type AppData } from './db';
import { checkOllama } from './logic/llm';
import { invoke } from '@tauri-apps/api/core';
import './App.css';

type Tab = 'budget' | 'transactions' | 'year' | 'savings' | 'import' | 'experimental' | 'settings' | 'tools' | 'mortgage';

const MORTGAGE_TAB_KEY = 'budget-app-show-mortgage-tab';
const EXPERIMENTAL_KEY = 'budget-app-experimental';
const TXN_AI_LOOKUP_KEY = 'budget-app-txn-ai-lookup';

export interface NavFilter {
  month?: string;
  categoryId?: number;
  groupId?: number;
  scope?: 'overall' | 'categories' | 'groups';
  offBudget?: boolean;
  uncategorized?: boolean;
}

const BASE_TABS: { key: Tab; label: string }[] = [
  { key: 'budget', label: 'Budget' },
  { key: 'transactions', label: 'Txns' },
  { key: 'year', label: 'Year' },
  { key: 'savings', label: 'Savings' },
  { key: 'import', label: 'Import' },
  { key: 'experimental', label: 'Budget Sandbox' },
];

const ZOOM_KEY = 'budget-app-zoom';
const DARK_KEY = 'budget-app-dark';
const BACKUP_ENABLED_KEY = 'budget-app-backup-enabled';
const BACKUP_COUNT_KEY = 'budget-app-backup-count';
const BACKUP_DIR_KEY = 'budget-app-backup-dir';

async function runStartupBackup(getDataFn: () => AppData) {
  try {
    const enabled = localStorage.getItem(BACKUP_ENABLED_KEY) === 'true';
    if (!enabled) return;
    const dir = localStorage.getItem(BACKUP_DIR_KEY);
    if (!dir) return;
    const maxCount = parseInt(localStorage.getItem(BACKUP_COUNT_KEY) ?? '3', 10);

    // Get unencrypted JSON of current data
    const data = getDataFn();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const json = JSON.stringify({ ...data, _backupCreatedAt: new Date().toISOString() }, null, 2);

    // List existing backup files
    type FileInfo = { path: string; modified_secs: number };
    const existing: FileInfo[] = await invoke('list_dir_files', { dir, ext: '.json' });
    const backupFiles = existing
      .filter((f) => {
        const name = f.path.split('/').pop() ?? f.path.split('\\').pop() ?? '';
        return name.startsWith('qbdgt-backup-') || name.startsWith('kestl-backup-');
      })
      .sort((a, b) => a.modified_secs - b.modified_secs);

    let savePath: string;
    const sep = dir.includes('\\') ? '\\' : '/';
    if (backupFiles.length >= maxCount && backupFiles.length > 0) {
      // Overwrite oldest
      savePath = backupFiles[0].path;
    } else {
      savePath = `${dir}${sep}kestl-backup-${timestamp}.json`;
    }

    await invoke('save_data', { path: savePath, data: json });
  } catch {
    // Backup failure is non-fatal
  }
}

function applyDarkMode(dark: boolean) {
  if (dark) {
    document.documentElement.classList.add('dark');
    document.documentElement.classList.remove('light');
  } else {
    document.documentElement.classList.remove('dark');
    document.documentElement.classList.add('light');
  }
}

function App() {
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState<Tab>('budget');
  const [showMortgageTab, setShowMortgageTab] = useState(
    () => localStorage.getItem(MORTGAGE_TAB_KEY) === 'true',
  );
  const [experimentalEnabled, setExperimentalEnabled] = useState(
    () => localStorage.getItem(EXPERIMENTAL_KEY) === 'true',
  );
  const [txnAiLookupEnabled, setTxnAiLookupEnabled] = useState(
    () => localStorage.getItem(TXN_AI_LOOKUP_KEY) === 'true',
  );
  const [tabHistory, setTabHistory] = useState<Tab[]>([]);
  const [zoom, setZoom] = useState(() => {
    const stored = localStorage.getItem(ZOOM_KEY);
    const val = stored ? parseFloat(stored) : 1;
    return Number.isFinite(val) && val >= 0.5 && val <= 1.5 ? val : 1;
  });
  const [darkMode, setDarkMode] = useState(() => {
    return localStorage.getItem(DARK_KEY) === 'true';
  });
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [ollamaPrompt, setOllamaPrompt] = useState<{ model: string; binaryPath: string } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const undoAvailable = useSyncExternalStore(subscribeUndo, canUndo, canUndo);

  // Nav filters for cross-tab navigation
  const [transactionNavFilter, setTransactionNavFilter] = useState<NavFilter | null>(null);
  const [yearNavFilter, setYearNavFilter] = useState<NavFilter | null>(null);

  useEffect(() => {
    localStorage.setItem(ZOOM_KEY, String(zoom));
  }, [zoom]);

  useEffect(() => {
    localStorage.setItem(DARK_KEY, String(darkMode));
    applyDarkMode(darkMode);
  }, [darkMode]);

  // Apply dark mode on initial load
  useEffect(() => {
    applyDarkMode(darkMode);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (ready) {
      startupCleanup();
      processRecurringTemplates();
      processSchedules();
      runStartupBackup(getData);
    }
  }, [ready]);

  // Called by features that require Ollama (parser generator, transaction AI lookup).
  // Shows "Start Ollama" prompt if binary is found, otherwise navigates to Settings.
  async function checkAndPromptOllama() {
    const ai = getAISettings();
    if (!ai.model) {
      changeTab('settings');
      return;
    }
    const running = await checkOllama(ai.ollamaUrl);
    if (!running) {
      const binaryPath = await invoke<string | null>('find_ollama');
      if (binaryPath) {
        setOllamaPrompt({ model: ai.model, binaryPath });
      } else {
        changeTab('settings');
      }
    }
  }

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
      e.preventDefault();
      e.stopPropagation();
      setSearchOpen(true);
      setTimeout(() => searchRef.current?.focus(), 0);
    }
    if (e.key === 'Escape' && searchOpen) {
      setSearchOpen(false);
      setSearchTerm('');
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLTextAreaElement)) {
      e.preventDefault();
      undo();
    }
  }, [searchOpen]);

  // Close native date pickers when clicking outside (WebKit/Tauri doesn't do this automatically)
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const active = document.activeElement;
      if (active instanceof HTMLInputElement && active.type === 'date') {
        if (!(e.target as HTMLElement).closest('input[type="date"]')) {
          active.blur();
        }
      }
    };
    document.addEventListener('mousedown', handler, true);
    return () => document.removeEventListener('mousedown', handler, true);
  }, []);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [handleKeyDown]);

  function navigateTo(newTab: Tab, filter?: NavFilter) {
    setTabHistory((h) => [...h, tab]);
    setTab(newTab);
    if (newTab === 'transactions' && filter) setTransactionNavFilter(filter);
    if (newTab === 'year' && filter) setYearNavFilter(filter);
  }

  const [customBackHandler, setCustomBackHandler] = useState<(() => void) | null>(null);
  const [settingsParserToOpen, setSettingsParserToOpen] = useState<string | null>(null);

  function navigateBack() {
    if (customBackHandler) {
      customBackHandler();
      setCustomBackHandler(null);
      return;
    }
    const prev = tabHistory[tabHistory.length - 1];
    if (prev == null) return;
    setTabHistory((h) => h.slice(0, -1));
    setTab(prev);
  }

  function changeTab(newTab: Tab) {
    if (newTab === tab) return;
    setTabHistory((h) => [...h, tab]);
    setTab(newTab);
    setCustomBackHandler(null);
  }

  if (!ready) {
    return <FileSetup onReady={() => setReady(true)} />;
  }

  const canGoBack = tabHistory.length > 0 || customBackHandler != null;

  const TABS = [
    ...BASE_TABS,
    ...(experimentalEnabled ? [{ key: 'tools' as Tab, label: 'Tools' }] : []),
    ...(experimentalEnabled && showMortgageTab ? [{ key: 'mortgage' as Tab, label: 'Mortgage' }] : []),
  ];

  return (
    <div className="app" style={{ zoom }}>
      {ollamaPrompt && (
        <div className="modal-overlay">
          <div className="modal" style={{ maxWidth: 380 }}>
            <h3 style={{ marginTop: 0 }}>Start Ollama?</h3>
            <p>Model <strong>{ollamaPrompt.model}</strong> is configured but Ollama is not running.</p>
            <div className="modal-actions">
              <button
                className="btn btn-primary"
                onClick={() => {
                  invoke('start_ollama', { binaryPath: ollamaPrompt.binaryPath });
                  setOllamaPrompt(null);
                }}
              >
                Start Ollama
              </button>
              <button className="btn btn-ghost" onClick={() => setOllamaPrompt(null)}>
                Not now
              </button>
            </div>
          </div>
        </div>
      )}
      <nav className="tab-bar">
        {/* Left: Back */}
        <div className="tab-bar-left">
          <button
            className="ai-toggle-btn"
            onClick={navigateBack}
            title="Go back"
            disabled={!canGoBack}
            style={{ opacity: canGoBack ? 1 : 0.35 }}
          >
            ← Back
          </button>
        </div>

        {/* Center: Tabs */}
        <div className="tab-bar-center">
          {TABS.map((t) => (
            <button
              key={t.key}
              className={`tab-btn ${tab === t.key ? 'active' : ''}`}
              onClick={() => changeTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Right: Undo + Settings + AI + version */}
        <div className="tab-bar-right">
          <button
            className="ai-toggle-btn"
            onClick={() => undo()}
            disabled={!undoAvailable}
            title="Undo last action (Ctrl+Z)"
            style={{ opacity: undoAvailable ? 1 : 0.35 }}
          >
            ↩ Undo
          </button>
          <button
            className={`ai-toggle-btn ${tab === 'settings' ? 'active' : ''}`}
            onClick={() => changeTab(tab === 'settings' ? 'budget' : 'settings')}
            title="Settings"
            style={{ fontSize: '1.2rem', padding: '0.35rem 0.6rem' }}
          >
            ⚙
          </button>
          <span className="app-version">v{__APP_VERSION__}</span>
        </div>
      </nav>
      {searchOpen && (
        <div className="search-bar">
          <input
            ref={searchRef}
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search in tab..."
            autoFocus
          />
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => { setSearchOpen(false); setSearchTerm(''); }}
          >
            &times;
          </button>
        </div>
      )}
      <main className="main-content">
        {tab === 'budget' && (
          <BudgetView
            search={searchTerm}
            onNavigateToTransactions={(month, categoryId, offBudget, uncategorized) => navigateTo('transactions', { month, categoryId, offBudget, uncategorized })}
            onNavigateToYear={(categoryId, groupId) => groupId != null
              ? navigateTo('year', { groupId, scope: 'groups' })
              : navigateTo('year', { categoryId, scope: 'categories' })
            }
          />
        )}
        {tab === 'transactions' && (
          <TransactionView
            search={searchTerm}
            navFilter={transactionNavFilter}
            onNavConsumed={() => setTransactionNavFilter(null)}
            txnAiLookupEnabled={txnAiLookupEnabled}
            onNeedOllama={checkAndPromptOllama}
          />
        )}
        {tab === 'year' && (
          <div style={{ maxWidth: 1400, margin: '0 auto' }}>
            <YearView
              navFilter={yearNavFilter}
              onNavConsumed={() => setYearNavFilter(null)}
              darkMode={darkMode}
            />
          </div>
        )}
        {tab === 'savings' && <div style={{ maxWidth: 1400, margin: '0 auto' }}><SavingsView /></div>}
        {tab === 'import' && (
          <div style={{ maxWidth: 1400, margin: '0 auto' }}>
            <ImportView onOpenParserSettings={(parserId) => {
              setSettingsParserToOpen(parserId);
              changeTab('settings');
            }} />
          </div>
        )}
        {tab === 'experimental' && <div style={{ maxWidth: 1400, margin: '0 auto' }}><ExperimentalBudgetsView /></div>}
        {tab === 'tools' && (
          <div style={{ maxWidth: 1400, margin: '0 auto' }}>
            <ToolsView onOpenTool={(tool) => {
              if (tool === 'mortgage') changeTab('mortgage');
            }} />
          </div>
        )}
        {tab === 'mortgage' && (
          <div style={{ maxWidth: 1400, margin: '0 auto' }}>
            <MortgageTool onShowMortgageTabChange={(show) => {
              setShowMortgageTab(show);
              if (!show && tab === 'mortgage') changeTab('tools');
            }} />
          </div>
        )}
        {tab === 'settings' && (
          <div style={{ maxWidth: 1400, margin: '0 auto' }}>
            <SettingsView
              zoom={zoom}
              onZoomChange={setZoom}
              search={searchTerm}
              darkMode={darkMode}
              onDarkModeChange={setDarkMode}
              experimentalEnabled={experimentalEnabled}
              onExperimentalChange={(v) => {
                setExperimentalEnabled(v);
                localStorage.setItem(EXPERIMENTAL_KEY, String(v));
              }}
              showMortgageTab={showMortgageTab}
              onShowMortgageTabChange={(show) => {
                setShowMortgageTab(show);
                localStorage.setItem(MORTGAGE_TAB_KEY, String(show));
              }}
              txnAiLookupEnabled={txnAiLookupEnabled}
              onTxnAiLookupChange={(v) => {
                setTxnAiLookupEnabled(v);
                localStorage.setItem(TXN_AI_LOOKUP_KEY, String(v));
              }}
              onNeedOllama={checkAndPromptOllama}
              onRegisterBack={(handler) => setCustomBackHandler(handler ? () => handler : null)}
              parserToOpen={settingsParserToOpen}
              onParserToOpenConsumed={() => setSettingsParserToOpen(null)}
            />
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
