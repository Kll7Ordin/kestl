import { useState, useEffect } from 'react';
import { open, save } from '@tauri-apps/plugin-dialog';
import { getLastFilePath, loadFromFile, createNewFile, createDemoFile, fileExists } from '../db';
import { PasswordPrompt } from './PasswordPrompt';
import kestlLogo from '../assets/kestl-logo.svg';

interface Props {
  onReady: () => void;
}

export function FileSetup({ onReady }: Props) {
  const [status, setStatus] = useState('Checking for saved file...');
  const [error, setError] = useState('');
  const [pendingPath, setPendingPath] = useState<string | null>(null); // path awaiting password

  async function openPath(path: string) {
    setStatus(`Loading ${path.split('/').pop()}...`);
    try {
      await loadFromFile(path);
      onReady();
    } catch (e) {
      const msg = String(e);
      if (msg.includes('FILE_ENCRYPTED')) {
        setPendingPath(path);
        setStatus('');
      } else {
        setError(msg);
        setStatus('');
      }
    }
  }

  useEffect(() => {
    (async () => {
      try {
        const lastPath = await getLastFilePath();
        if (lastPath && await fileExists(lastPath)) {
          await openPath(lastPath);
          return;
        }
        setStatus('');
      } catch {
        setStatus('');
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleOpen() {
    setError('');
    try {
      const selected = await open({
        filters: [{ name: 'Budget Data', extensions: ['json'] }],
        multiple: false,
        directory: false,
      });
      if (!selected) return;
      await openPath(selected as string);
    } catch (e) {
      setError(String(e));
      setStatus('');
    }
  }

  async function handleNew() {
    setError('');
    try {
      const selected = await save({
        filters: [{ name: 'Budget Data', extensions: ['json'] }],
        defaultPath: 'budget-data.json',
      });
      if (!selected) return;
      const path = typeof selected === 'string' ? selected : selected;
      setStatus(`Creating ${path.split('/').pop()}...`);
      await createNewFile(path);
      onReady();
    } catch (e) {
      setError(String(e));
      setStatus('');
    }
  }

  async function handleDemo() {
    setError('');
    try {
      const selected = await save({
        filters: [{ name: 'Budget Data', extensions: ['json'] }],
        defaultPath: 'budget-demo.json',
      });
      if (!selected) return;
      const path = typeof selected === 'string' ? selected : selected;
      setStatus('Creating budget template...');
      await createDemoFile(path);
      onReady();
    } catch (e) {
      setError(String(e));
      setStatus('');
    }
  }

  // Password prompt for encrypted file
  if (pendingPath) {
    return (
      <PasswordPrompt
        filePath={pendingPath}
        onSubmit={async (password) => {
          await loadFromFile(pendingPath, password);
          onReady();
        }}
        onCancel={() => {
          setPendingPath(null);
          setStatus('');
        }}
      />
    );
  }

  if (status && !error) {
    return (
      <div className="file-setup">
        <div className="file-setup-spinner" />
        <p style={{ opacity: 0.6, fontSize: '0.9rem' }}>{status}</p>
      </div>
    );
  }

  return (
    <div className="file-setup">
      <img src={kestlLogo} alt="kestl" className="file-setup-logo" />

      <div className="setup-actions">
        <button className="btn btn-primary" onClick={handleOpen}>
          Open existing file
        </button>
        <button className="btn btn-ghost" onClick={handleNew}>
          Create new file
        </button>
        <button className="btn btn-ghost" onClick={handleDemo}>
          Use Budget Template
        </button>
      </div>

      {error && <p className="setup-error">{error}</p>}
    </div>
  );
}
