import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';

export interface SearchableSelectOption {
  value: string | number;
  label: string;
}

interface Props {
  options: SearchableSelectOption[];
  value: string | number | '';
  onChange: (value: string | number | '') => void;
  placeholder?: string;
  className?: string;
  style?: React.CSSProperties;
  buttonStyle?: React.CSSProperties;
  compact?: boolean;
  disabled?: boolean;
}

interface DropdownPos {
  top: number;
  bottom: number;
  left: number;
  width: number;
}

function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function SearchableSelect({ options, value, onChange, placeholder = 'Select...', className = '', style, buttonStyle, compact = false, disabled }: Props) {
  const [isOpen, setIsOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const [flipUp, setFlipUp] = useState(false);
  const [pos, setPos] = useState<DropdownPos | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const selected = options.find((o) => String(o.value) === String(value));
  const filtered = filter.trim()
    ? options.filter((o) => normalize(o.label).includes(normalize(filter)))
    : options;

  useEffect(() => {
    if (!isOpen) setFilter('');
  }, [isOpen]);

  const dropdownRef = useRef<HTMLDivElement>(null);

  // Only add global listeners when the dropdown is open — avoids N instances × 2 listeners on scroll
  useEffect(() => {
    if (!isOpen) return;
    function handleClose(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node) && !dropdownRef.current?.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    function handleScroll(e: Event) {
      if (dropdownRef.current?.contains(e.target as Node)) return;
      setIsOpen(false);
    }
    document.addEventListener('mousedown', handleClose);
    document.addEventListener('scroll', handleScroll, true);
    return () => {
      document.removeEventListener('mousedown', handleClose);
      document.removeEventListener('scroll', handleScroll, true);
    };
  }, [isOpen]);

  function open() {
    if (disabled) return;
    if (!isOpen && containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      const flip = window.innerHeight - rect.bottom < 300 && rect.top > 300;
      setFlipUp(flip);
      setPos({ top: rect.bottom, bottom: rect.top, left: rect.left, width: rect.width });
    }
    setIsOpen((v) => !v);
  }

  const dropdown = isOpen && pos ? (
    <div
      ref={dropdownRef}
      style={{
        position: 'fixed',
        top: flipUp ? 'auto' : pos.top + 4,
        bottom: flipUp ? window.innerHeight - pos.bottom + 4 : 'auto',
        left: pos.left,
        zIndex: 9999,
        minWidth: pos.width,
        width: 'max-content',
        maxWidth: 320,
        background: 'var(--card-bg)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        boxShadow: '0 4px 16px rgba(0,0,0,0.18)',
        maxHeight: 280,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <input
        type="text"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        onKeyDown={(e) => e.stopPropagation()}
        placeholder="Type to filter..."
        autoFocus
        style={{
          margin: 6,
          padding: '0.45rem 0.6rem',
          borderRadius: 6,
          border: '1px solid var(--border)',
          background: 'var(--input-bg)',
          color: 'inherit',
          fontSize: '0.9rem',
          flexShrink: 0,
        }}
      />
      <div style={{ overflowY: 'auto', maxHeight: 220 }}>
        <button
          type="button"
          onClick={() => { onChange(''); setIsOpen(false); }}
          style={{
            display: 'block', width: '100%', padding: '0.45rem 0.75rem',
            border: 'none', background: value === '' ? 'var(--accent-muted)' : 'transparent',
            color: 'inherit', fontSize: '0.9rem', textAlign: 'left', cursor: 'pointer',
          }}
        >
          {placeholder}
        </button>
        {filtered.map((opt) => (
          <button
            key={String(opt.value)}
            type="button"
            onClick={() => { onChange(opt.value); setIsOpen(false); }}
            style={{
              display: 'block', width: '100%', padding: '0.45rem 0.75rem',
              border: 'none',
              background: String(value) === String(opt.value) ? 'var(--accent-muted)' : 'transparent',
              color: 'inherit', fontSize: '0.9rem', textAlign: 'left', cursor: 'pointer',
            }}
          >
            {opt.label}
          </button>
        ))}
        {filtered.length === 0 && (
          <div style={{ padding: '0.45rem 0.75rem', fontSize: '0.85rem', opacity: 0.6 }}>No matches</div>
        )}
      </div>
    </div>
  ) : null;

  return (
    <div
      ref={containerRef}
      className={className}
      style={{ position: 'relative', ...style }}
    >
      <button
        type="button"
        onClick={open}
        disabled={disabled}
        style={{
          width: compact ? 'auto' : '100%',
          textAlign: 'left',
          padding: compact ? '0.2rem 0.5rem' : '0.5rem 0.65rem',
          borderRadius: compact ? 99 : 8,
          border: '1px solid var(--border)',
          background: 'var(--input-bg)',
          color: 'inherit',
          fontSize: 'inherit',
          fontFamily: 'inherit',
          cursor: disabled ? 'not-allowed' : 'pointer',
          whiteSpace: 'nowrap',
          ...buttonStyle,
        }}
      >
        {selected ? selected.label : placeholder}
      </button>

      {createPortal(dropdown, document.body)}
    </div>
  );
}
