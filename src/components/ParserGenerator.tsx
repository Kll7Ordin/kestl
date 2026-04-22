import { useState, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  getAISettings,
  saveCustomParser,
  executeCustomParser,
  type CustomParser,
  type Transaction,
} from '../db';
import { generateParser, checkOllama } from '../logic/llm';
import { formatAmount } from '../utils/format';

type Step = 'create' | 'preview' | 'confirm' | 'wrong';

interface Props {
  onParsersChange?: () => void;
  onImportFile?: (txns: Omit<Transaction, 'id'>[], source: string) => Promise<void>;
}

export function ParserGenerator({ onParsersChange, onImportFile }: Props) {
  const [step, setStep] = useState<Step>('create');

  // Create step
  const [parserName, setParserName] = useState('');
  const [sampleContent, setSampleContent] = useState('');
  const [sampleFilename, setSampleFilename] = useState('');
  const [generating, setGenerating] = useState(false);
  const [genStatus, setGenStatus] = useState<string | null>(null);
  const [generatedCode, setGeneratedCode] = useState('');

  // Preview step
  const [realContent, setRealContent] = useState('');
  const [realFilename, setRealFilename] = useState('');
  const [previewTxns, setPreviewTxns] = useState<Omit<Transaction, 'id'>[]>([]);
  const [previewError, setPreviewError] = useState('');

  // Wrong step
  const [wrongChoice, setWrongChoice] = useState<'exit' | 'retry' | null>(null);
  const [feedbackText, setFeedbackText] = useState('');

  const sampleFileRef = useRef<HTMLInputElement>(null);
  const realFileRef = useRef<HTMLInputElement>(null);

  // Ollama-not-running modal
  const [ollamaModal, setOllamaModal] = useState(false);
  const [ollamaModalStatus, setOllamaModalStatus] = useState<string | null>(null);
  const [ollamaStarting, setOllamaStarting] = useState(false);
  const [ollamaInstalling, setOllamaInstalling] = useState(false);

  async function handleStartOllama() {
    setOllamaStarting(true);
    setOllamaModalStatus(null);
    try {
      const binaryPath = await invoke<string | null>('find_ollama');
      if (!binaryPath) {
        setOllamaModalStatus('Ollama binary not found. Try installing it first.');
        setOllamaStarting(false);
        return;
      }
      await invoke('start_ollama', { binaryPath });
      setOllamaModalStatus('Ollama started. Checking connection…');
      await new Promise((r) => setTimeout(r, 2000));
      const settings = getAISettings();
      const ok = await checkOllama(settings.ollamaUrl);
      if (ok) {
        setOllamaModal(false);
        setOllamaModalStatus(null);
        handleGenerate();
      } else {
        setOllamaModalStatus('Ollama started but not yet responding. Try generating again in a moment.');
      }
    } catch (e) {
      setOllamaModalStatus(`Error: ${String(e)}`);
    } finally {
      setOllamaStarting(false);
    }
  }

  async function handleInstallOllama() {
    setOllamaInstalling(true);
    setOllamaModalStatus('Starting download…');
    const unlisten = await listen<{ status: string; percent: number }>('ollama_progress', (e) => {
      setOllamaModalStatus(e.payload.status);
    });
    try {
      const binaryPath = await invoke<string>('install_ollama');
      setOllamaModalStatus(`Installed at ${binaryPath}. Click Start Ollama to launch it.`);
    } catch (e) {
      setOllamaModalStatus(`Error: ${String(e)}`);
    } finally {
      unlisten();
      setOllamaInstalling(false);
    }
  }

  function reset() {
    setStep('create');
    setParserName(''); setSampleContent(''); setSampleFilename('');
    setGenerating(false); setGenStatus(null); setGeneratedCode('');
    setRealContent(''); setRealFilename(''); setPreviewTxns([]); setPreviewError('');
    setWrongChoice(null); setFeedbackText('');
    if (realFileRef.current) realFileRef.current.value = '';
    if (sampleFileRef.current) sampleFileRef.current.value = '';
  }

  function close() { reset(); onParsersChange?.(); }

  async function handleSampleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setSampleFilename(file.name);
    const text = await file.text();
    setSampleContent(text);
    if (!parserName) setParserName(file.name.replace(/\.[^.]+$/, '').replace(/[_-]/g, ' '));
  }

  async function handleGenerate(feedback?: { previousCode: string; issue: string }) {
    if (!sampleContent.trim() || !parserName.trim()) return;
    const settings = getAISettings();
    setGenerating(true);
    setGenStatus(null);
    setGeneratedCode('');
    try {
      const ollamaRunning = await checkOllama(settings.ollamaUrl);
      if (!ollamaRunning) {
        setOllamaModal(true);
        setOllamaModalStatus(null);
        setGenerating(false);
        return;
      }
      const result = await generateParser(
        sampleContent, parserName, parserName.trim(), settings, setGenStatus, feedback,
      );
      setGeneratedCode(result.code);
      setStep('preview');
      setRealContent(''); setRealFilename(''); setPreviewTxns([]); setPreviewError('');
    } catch (e) {
      setGenStatus(`Error: ${String(e)}`);
    } finally {
      setGenerating(false);
    }
  }

  async function handleRealFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setRealFilename(file.name);
    const text = await file.text();
    setRealContent(text);
    setPreviewError('');
    try {
      const txns = executeCustomParser(generatedCode, text, file.name);
      if (txns.length === 0) {
        // Test against original sample to distinguish "broken parser" vs "file mismatch"
        let sampleCount = -1;
        try {
          sampleCount = executeCustomParser(generatedCode, sampleContent, sampleFilename).length;
        } catch { /* ignore */ }

        if (sampleCount === 0) {
          // Parser can't even parse its own training data — auto-regenerate silently
          setPreviewError('Parser returned 0 results even on the original sample. Regenerating automatically…');
          setPreviewTxns([]);
          await handleGenerate();
          return;
        }

        // Parser works on sample but not on this file
        let hint = '';
        if (sampleCount > 0) {
          hint = ` The parser correctly parsed ${sampleCount} row${sampleCount !== 1 ? 's' : ''} from the original sample — this file may have a different structure, or all transactions are being filtered as pending/provisional.`;
        } else {
          // Fallback: try first 2 lines for a thrown error
          const lines = text.split(/\r?\n/).filter((l) => l.trim());
          if (lines.length >= 2) {
            try {
              executeCustomParser(generatedCode, lines.slice(0, 2).join('\n'), file.name);
            } catch (diagErr) {
              hint = ` Hint: ${String(diagErr)}`;
            }
          }
        }
        setPreviewError(`Parser returned 0 transactions — all rows were skipped or filtered out.${hint}`);
        setPreviewTxns([]);
        return;
      }
      const instrument = parserName.trim();
      const withInstrument = txns.map((t) => ({ ...t, instrument }));
      setPreviewTxns(withInstrument);
      setStep('confirm');
    } catch (e) {
      setPreviewError(`Parse error: ${String(e)}`);
      setPreviewTxns([]);
    }
  }

  async function handleSaveParser(): Promise<CustomParser> {
    const parser: CustomParser = {
      id: `custom_${Date.now()}`,
      name: parserName.trim(),
      instrument: parserName.trim(),
      code: generatedCode,
      sampleLines: sampleContent.split('\n').slice(0, 5).join('\n'),
      createdAt: new Date().toISOString(),
    };
    await saveCustomParser(parser);
    onParsersChange?.();
    return parser;
  }

  async function handleImport() {
    const parser = await handleSaveParser();
    if (onImportFile && previewTxns.length > 0) {
      await onImportFile(previewTxns, `custom_${parser.id}`);
    }
    close();
  }

  async function handleSaveOnly() {
    await handleSaveParser();
    close();
  }

  async function handleRetry() {
    if (!feedbackText.trim()) return;
    setWrongChoice(null);
    setStep('create');
    // Include real file header if we have it and it differs from sample
    const realHeader = realContent ? realContent.split(/\r?\n/).slice(0, 5).join('\n') : '';
    const issue = realHeader && realHeader !== sampleContent.split(/\r?\n/).slice(0, 5).join('\n')
      ? `${feedbackText.trim()}\n\nActual file being parsed (first 5 lines):\n${realHeader}`
      : feedbackText.trim();
    await handleGenerate({ previousCode: generatedCode, issue });
    setFeedbackText('');
  }

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '0.75rem', marginTop: '0.5rem' }}>

      {/* ── Step 1: Create ── */}
      {step === 'create' && (
        <>
          <div className="section-title" style={{ marginBottom: '0.5rem' }}>Create New Parser</div>

          <div className="row" style={{ gap: '0.5rem', marginBottom: '0.5rem', alignItems: 'flex-end' }}>
            <div className="field" style={{ flex: 1 }}>
              <label>Parser name</label>
              <input value={parserName} onChange={(e) => setParserName(e.target.value)} placeholder="e.g. TD Bank CSV" />
            </div>
          </div>

          <div className="field" style={{ marginBottom: '0.5rem' }}>
            <label>Sample file (a few lines is enough — used to teach the AI the format)</label>
            <div className="row" style={{ gap: '0.5rem', alignItems: 'center' }}>
              <input ref={sampleFileRef} type="file" accept=".csv,.tsv,.txt" onChange={handleSampleUpload} style={{ display: 'none' }} />
              <button className="btn btn-ghost btn-sm" onClick={() => sampleFileRef.current?.click()}>
                {sampleFilename ? `📄 ${sampleFilename}` : 'Upload sample file'}
              </button>
              {sampleContent && <span style={{ fontSize: '0.8rem', opacity: 0.6 }}>{sampleContent.split('\n').length} lines loaded</span>}
            </div>
          </div>

          {!sampleContent && (
            <div className="field" style={{ marginBottom: '0.5rem' }}>
              <label>Or paste sample content</label>
              <textarea value={sampleContent} onChange={(e) => setSampleContent(e.target.value)}
                placeholder="Paste a few lines from your file here..." rows={4}
                style={{ resize: 'vertical', fontFamily: 'monospace', fontSize: '0.8rem' }} />
            </div>
          )}

          {sampleContent && (
            <div style={{ background: 'var(--input-bg)', borderRadius: 4, padding: '0.4rem 0.6rem', fontFamily: 'monospace', fontSize: '0.78rem', marginBottom: '0.5rem', maxHeight: 100, overflowY: 'auto', whiteSpace: 'pre' }}>
              {sampleContent.split('\n').slice(0, 6).join('\n')}
            </div>
          )}

          <div className="row" style={{ gap: '0.5rem' }}>
            <button className="btn btn-primary btn-sm" onClick={() => handleGenerate()} disabled={generating || !sampleContent.trim() || !parserName.trim()}>
              {generating ? 'Generating…' : 'Generate Parser'}
            </button>
            <button className="btn btn-ghost btn-sm" onClick={close}>Cancel</button>
          </div>

          {genStatus && <div style={{ fontSize: '0.85rem', opacity: 0.8, marginTop: '0.5rem' }}>{genStatus}</div>}
        </>
      )}

      {/* ── Step 2: Upload real CSV for preview ── */}
      {step === 'preview' && (
        <>
          <div className="section-title" style={{ marginBottom: '0.5rem' }}>Preview Transactions</div>
          <p style={{ fontSize: '0.85rem', opacity: 0.8, marginBottom: '0.75rem' }}>
            Parser generated. Now upload a real CSV from your bank — the app will show you exactly how it will be imported so you can confirm everything looks right.
          </p>

          <div className="field" style={{ marginBottom: '0.5rem' }}>
            <input ref={realFileRef} type="file" accept=".csv,.tsv,.txt" onChange={handleRealFileUpload} style={{ display: 'none' }} />
            <button className="btn btn-primary btn-sm" onClick={() => realFileRef.current?.click()}>
              {realFilename ? `📄 ${realFilename}` : 'Upload real CSV to preview'}
            </button>
          </div>

          {previewError && (
            <div style={{ marginBottom: '0.5rem' }}>
              <div style={{ color: 'var(--red)', fontSize: '0.85rem', marginBottom: '0.4rem' }}>{previewError}</div>
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                <button className="btn btn-primary btn-sm" onClick={() => handleGenerate()}
                  disabled={generating}>
                  {generating ? 'Regenerating…' : 'Regenerate parser'}
                </button>
                <button className="btn btn-ghost btn-sm" style={{ color: 'var(--red)', borderColor: 'var(--red)' }}
                  onClick={() => { setStep('wrong'); setWrongChoice('retry'); setFeedbackText(''); }}>
                  Fix with feedback
                </button>
              </div>
            </div>
          )}

          {generatedCode && (
            <details style={{ marginTop: '0.5rem', fontSize: '0.8rem' }}>
              <summary style={{ cursor: 'pointer', opacity: 0.5 }}>View generated code</summary>
              <pre style={{ marginTop: '0.4rem', padding: '0.5rem', background: 'var(--input-bg)', borderRadius: 4, overflowX: 'auto', whiteSpace: 'pre', fontSize: '0.75rem' }}>{generatedCode}</pre>
            </details>
          )}

          <button className="btn btn-ghost btn-sm" style={{ marginTop: '0.5rem' }} onClick={close}>Cancel</button>
        </>
      )}

      {/* ── Step 3: Confirm transactions ── */}
      {step === 'confirm' && (
        <>
          <div className="section-title" style={{ marginBottom: '0.25rem' }}>Review Transactions</div>
          <p style={{ fontSize: '0.85rem', opacity: 0.75, marginBottom: '0.75rem' }}>
            {previewTxns.length} transactions parsed from <strong>{realFilename}</strong>. Review them below and confirm they look correct before saving the parser.
          </p>

          <div style={{ maxHeight: 320, overflowY: 'auto', marginBottom: '0.75rem', border: '1px solid var(--border)', borderRadius: 6 }}>
            <table className="data-table" style={{ margin: 0 }}>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Description</th>
                  <th className="num">Amount</th>
                  <th>Type</th>
                </tr>
              </thead>
              <tbody>
                {previewTxns.map((t, i) => (
                  <tr key={i}>
                    <td style={{ whiteSpace: 'nowrap', fontSize: '0.82rem' }}>{t.txnDate}</td>
                    <td style={{ fontSize: '0.82rem' }}>{t.descriptor}</td>
                    <td className="num" style={{ fontSize: '0.82rem' }}>${formatAmount(t.amount)}</td>
                    <td style={{ fontSize: '0.82rem', color: t.ignoreInBudget ? '#16a34a' : 'var(--text-1)' }}>
                      {t.ignoreInBudget ? 'credit' : 'debit'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <button className="btn btn-primary btn-sm" onClick={handleImport}>
              Correct — Import
            </button>
            <button className="btn btn-ghost btn-sm" onClick={handleSaveOnly}>
              Correct — Don't Import Yet
            </button>
            <button className="btn btn-ghost btn-sm" style={{ color: 'var(--red)', borderColor: 'var(--red)' }}
              onClick={() => { setStep('wrong'); setWrongChoice(null); setFeedbackText(''); }}>
              Something is Wrong
            </button>
          </div>
        </>
      )}

      {/* ── Step 4: Something is Wrong ── */}
      {step === 'wrong' && (
        <>
          <div className="section-title" style={{ marginBottom: '0.5rem' }}>Something is Wrong</div>

          {wrongChoice === null && (
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              <button className="btn btn-ghost btn-sm" onClick={close}>Exit parser creation</button>
              <button className="btn btn-primary btn-sm" onClick={() => setWrongChoice('retry')}>Try Again</button>
            </div>
          )}

          {wrongChoice === 'retry' && (
            <>
              <p style={{ fontSize: '0.85rem', opacity: 0.8, marginBottom: '0.5rem' }}>
                Describe what was wrong — the AI will use this to fix the parser.
              </p>
              <div className="field" style={{ marginBottom: '0.5rem' }}>
                <label>What went wrong?</label>
                <textarea
                  value={feedbackText}
                  onChange={(e) => setFeedbackText(e.target.value)}
                  placeholder="e.g. Dates are wrong, amounts are negative, credits and debits are swapped..."
                  rows={3}
                  style={{ resize: 'vertical', width: '100%', fontSize: '0.85rem' }}
                  autoFocus
                />
              </div>
              <div className="row" style={{ gap: '0.5rem' }}>
                <button className="btn btn-primary btn-sm" onClick={handleRetry}
                  disabled={generating || !feedbackText.trim()}>
                  {generating ? 'Regenerating…' : 'Regenerate Parser'}
                </button>
                <button className="btn btn-ghost btn-sm" onClick={close}>Cancel</button>
              </div>
              {genStatus && <div style={{ fontSize: '0.85rem', opacity: 0.8, marginTop: '0.5rem' }}>{genStatus}</div>}
            </>
          )}
        </>
      )}

      {/* ── Ollama not running modal ── */}
      {ollamaModal && (
        <div className="modal-overlay" onClick={() => setOllamaModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Ollama is not running</h3>
            <p style={{ fontSize: '0.9rem', opacity: 0.8, marginBottom: '1rem' }}>
              The parser generator requires a local Ollama instance. Start Ollama to continue, or install it if you haven't already.
            </p>
            <div className="modal-actions" style={{ flexWrap: 'wrap' }}>
              <button className="btn btn-primary" onClick={handleStartOllama}
                disabled={ollamaStarting || ollamaInstalling}>
                {ollamaStarting ? 'Starting…' : 'Start Ollama'}
              </button>
              <button className="btn btn-ghost" onClick={handleInstallOllama}
                disabled={ollamaInstalling || ollamaStarting}>
                {ollamaInstalling ? 'Installing…' : 'Install Ollama'}
              </button>
              <button className="btn btn-ghost" onClick={() => setOllamaModal(false)}>Cancel</button>
            </div>
            {ollamaModalStatus && (
              <div style={{ fontSize: '0.85rem', marginTop: '0.75rem', opacity: 0.8 }}>{ollamaModalStatus}</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
