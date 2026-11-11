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
import { runStartupJobs } from './startup';
import { getAISettings, getData, subscribe, undo, canUndo, getUndoLabel, subscribeUndo, getDisplaySettings, updateDisplaySettings, flushSave, retrySave, getSaveStatus, subscribeSaveStatus, resolveConflict } from './db';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { checkOllama } from './logic/llm';
import { invoke } from '@tauri-apps/api/core';
import { BackToTop } from './components/BackToTop';
import './App.css';

type Tab = 'budget' | 'transactions' | 'year' | 'savings' | 'import' | 'experimental' | 'settings' | 'tools' | 'mortgage';


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
function applyDarkMode(dark: boolean) {
  if (dark) {
    document.documentElement.classList.add('dark');
    document.documentElement.classList.remove('light');
  } else {
    document.documentElement.classList.remove('dark');
    document.documentElement.classList.add('light');
  }
}

function SaveIndicator({ info }: { info: { status: string; error?: string } }) {
  if (info.status === 'error') {
    return (
      <button className="btn btn-ghost btn-sm" style={{ color: '#dc2626' }} title={info.error} onClick={() => { void retrySave().catch(() => {}); }}>
        Save failed: Retry
      </button>
    );
  }
  const text = info.status === 'pending' || info.status === 'saving' ? 'Saving…' : info.status === 'conflict' ? 'Conflict' : 'Saved';
  return <span style={{ fontSize: '0.75rem', opacity: 0.6, marginRight: '0.4rem' }}>{text}</span>;
}

function App() {
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState<Tab>('budget');
  useSyncExternalStore(subscribe, getData); // re-render when file-backed display settings change
  const displaySettings = getDisplaySettings();
  const showMortgageTab = displaySettings.showMortgageTab === true;
  const experimentalEnabled = displaySettings.experimentalEnabled === true;
  const txnAiLookupEnabled = displaySettings.txnAiLookupEnabled === true;
  const saveInfo = useSyncExternalStore(subscribeSaveStatus, getSaveStatus);
  const undoLabel = useSyncExternalStore(subscribeUndo, getUndoLabel, getUndoLabel);
  const [startupError, setStartupError] = useState<string | null>(null);
  const [closeError, setCloseError] = useState<string | null>(null);
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
  const [ollamaPrompt, setOllamaPrompt] = useState<{ model: string } | null>(null);
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
      runStartupJobs().catch((e) => setStartupError(e instanceof Error ? e.message : String(e)));
    }
  }, [ready]);

  // Flush pending saves before the window closes.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    getCurrentWindow().onCloseRequested(async (event) => {
      try {
        await flushSave();
      } catch (e) {
        event.preventDefault();
        setCloseError(e instanceof Error ? e.message : String(e));
      }
    }).then((fn) => { unlisten = fn; }).catch(() => { /* not running inside Tauri */ });
    return () => { unlisten?.(); };
  }, []);

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
        setOllamaPrompt({ model: ai.model });
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
    // Also close the picker once a date is picked with the mouse (no close button in the native popup).
    // Keyboard typing is left alone so multi-digit entry isn't interrupted.
    let typing = false;
    const keyHandler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement && e.target.type === 'date') typing = true;
    };
    const downHandler = (e: MouseEvent) => {
      if (e.target instanceof HTMLInputElement && e.target.type === 'date') typing = false;
    };
    const changeHandler = (e: Event) => {
      const t = e.target;
      if (t instanceof HTMLInputElement && t.type === 'date' && !typing && t.value) {
        setTimeout(() => t.blur(), 0);
      }
    };
    document.addEventListener('mousedown', handler, true);
    document.addEventListener('mousedown', downHandler, true);
    document.addEventListener('keydown', keyHandler, true);
    document.addEventListener('change', changeHandler, true);
    return () => {
      document.removeEventListener('mousedown', handler, true);
      document.removeEventListener('mousedown', downHandler, true);
      document.removeEventListener('keydown', keyHandler, true);
      document.removeEventListener('change', changeHandler, true);
    };
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
    setSearchOpen(false);
    setSearchTerm('');
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
                  invoke('start_ollama');
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
      {saveInfo.status === 'conflict' && (
        <div className="modal-overlay">
          <div className="modal" style={{ maxWidth: 460 }}>
            <h3 style={{ marginTop: 0 }}>File changed outside kestl</h3>
            <p>This file was changed outside kestl (another device, a sync app, or another window).</p>
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => { void resolveConflict('reload').catch((e) => setStartupError(String(e))); }}>
                Reload from disk (my unsaved changes here are lost)
              </button>
              <button className="btn btn-primary" onClick={() => { void resolveConflict('overwrite').catch((e) => setStartupError(String(e))); }}>
                Overwrite with my version
              </button>
            </div>
          </div>
        </div>
      )}
      {closeError && (
        <div className="modal-overlay">
          <div className="modal" style={{ maxWidth: 420 }}>
            <h3 style={{ marginTop: 0 }}>Unsaved changes</h3>
            <p>Your latest changes could not be saved: {closeError}</p>
            <div className="modal-actions">
              <button className="btn btn-primary" onClick={() => { setCloseError(null); void retrySave().then(() => getCurrentWindow().close()).catch((e) => setCloseError(e instanceof Error ? e.message : String(e))); }}>
                Retry
              </button>
              <button className="btn btn-ghost" onClick={() => { setCloseError(null); void getCurrentWindow().destroy(); }}>
                Quit anyway
              </button>
              <button className="btn btn-ghost" onClick={() => setCloseError(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
      {startupError && (
        <div style={{ background: '#fee2e2', color: '#991b1b', padding: '0.4rem 0.8rem', fontSize: '0.85rem', display: 'flex', justifyContent: 'space-between' }}>
          <span>Startup tasks failed: {startupError}</span>
          <button className="btn btn-ghost btn-sm" onClick={() => setStartupError(null)}>&times;</button>
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
            title={undoLabel ? `Undo: ${undoLabel} (Ctrl+Z)` : 'Nothing to undo'}
            style={{ opacity: undoAvailable ? 1 : 0.35 }}
          >
            ↩ Undo
          </button>
          <SaveIndicator info={saveInfo} />
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
              onExperimentalChange={(v) => { void updateDisplaySettings({ experimentalEnabled: v }); }}
              showMortgageTab={showMortgageTab}
              onShowMortgageTabChange={(show) => { void updateDisplaySettings({ showMortgageTab: show }); }}
              txnAiLookupEnabled={txnAiLookupEnabled}
              onTxnAiLookupChange={(v) => { void updateDisplaySettings({ txnAiLookupEnabled: v }); }}
              onNeedOllama={checkAndPromptOllama}
              onRegisterBack={(handler) => setCustomBackHandler(handler ? () => handler : null)}
              parserToOpen={settingsParserToOpen}
              onParserToOpenConsumed={() => setSettingsParserToOpen(null)}
            />
          </div>
        )}
      </main>
      <BackToTop />
    </div>
  );
}

export default App;
