import { useState, useRef, useEffect } from 'react';

interface Props {
  filePath: string;
  onSubmit: (password: string) => Promise<void>;
  onCancel: () => void;
}

export function PasswordPrompt({ filePath, onSubmit, onCancel }: Props) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  async function handleSubmit(e?: React.FormEvent) {
    e?.preventDefault();
    if (!password.trim()) return;
    setLoading(true);
    setError('');
    try {
      await onSubmit(password);
    } catch (err) {
      setError(String(err).replace('Error: ', ''));
      setLoading(false);
      setPassword('');
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }

  const filename = filePath.split('/').pop() ?? filePath;

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--bg)',
        padding: '1rem',
      }}
    >
      <div
        style={{
          background: 'var(--card-bg)',
          borderRadius: 12,
          padding: '2rem',
          width: '100%',
          maxWidth: 380,
          boxShadow: '0 8px 40px rgba(0,0,0,0.3)',
        }}
      >
        <div style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
          <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>🔒</div>
          <h2 style={{ margin: 0, fontWeight: 700, fontSize: '1.2rem' }}>
            Encrypted File
          </h2>
          <p style={{ margin: '0.5rem 0 0', fontSize: '0.85rem', opacity: 0.6 }}>
            <code>{filename}</code> is encrypted. Enter your password to open it.
          </p>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="field" style={{ marginBottom: '1rem' }}>
            <label>Password</label>
            <input
              ref={inputRef}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter password…"
              disabled={loading}
              autoComplete="current-password"
            />
          </div>

          {error && (
            <div
              style={{
                background: 'rgba(239,68,68,0.12)',
                border: '1px solid rgba(239,68,68,0.3)',
                borderRadius: 6,
                padding: '0.6rem 0.75rem',
                fontSize: '0.85rem',
                color: '#ef4444',
                marginBottom: '0.75rem',
              }}
            >
              {error}
            </div>
          )}

          <button
            type="submit"
            className="btn btn-primary"
            style={{ width: '100%', marginBottom: '0.5rem' }}
            disabled={loading || !password.trim()}
          >
            {loading ? 'Decrypting…' : 'Open'}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            style={{ width: '100%' }}
            onClick={onCancel}
            disabled={loading}
          >
            Open different file
          </button>
        </form>
      </div>
    </div>
  );
}
