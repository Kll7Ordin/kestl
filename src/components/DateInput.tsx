import { useState, useEffect, useRef } from 'react';

const CAL_MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const CAL_DAYS = ['Su','Mo','Tu','We','Th','Fr','Sa'];

export function DateInput({ value, onChange, style, autoFocus }: {
  value: string;
  onChange: (v: string) => void;
  style?: React.CSSProperties;
  autoFocus?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const [viewYear, setViewYear] = useState(() => {
    const d = value ? new Date(value + 'T00:00:00') : new Date();
    return isNaN(d.getTime()) ? new Date().getFullYear() : d.getFullYear();
  });
  const [viewMonth, setViewMonth] = useState(() => {
    const d = value ? new Date(value + 'T00:00:00') : new Date();
    return isNaN(d.getTime()) ? new Date().getMonth() : d.getMonth();
  });
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDraft(value);
    if (value) {
      const d = new Date(value + 'T00:00:00');
      if (!isNaN(d.getTime())) { setViewYear(d.getFullYear()); setViewMonth(d.getMonth()); }
    }
  }, [value]);

  function parseAndCommit(raw: string) {
    const trimmed = raw.trim();
    if (!trimmed) { onChange(''); return; }
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      const d = new Date(trimmed + 'T00:00:00');
      if (!isNaN(d.getTime())) { onChange(trimmed); return; }
    }
    const d = new Date(trimmed);
    if (!isNaN(d.getTime())) { onChange(d.toISOString().split('T')[0]); }
    else setDraft(value);
  }

  function selectDay(year: number, month: number, day: number) {
    const s = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    onChange(s);
    setOpen(false);
  }

  function prevMonth() { if (viewMonth === 0) { setViewMonth(11); setViewYear(y => y - 1); } else setViewMonth(m => m - 1); }
  function nextMonth() { if (viewMonth === 11) { setViewMonth(0); setViewYear(y => y + 1); } else setViewMonth(m => m + 1); }
  function prevYear() { setViewYear(y => y - 1); }
  function nextYear() { setViewYear(y => y + 1); }

  const firstDow = new Date(viewYear, viewMonth, 1).getDay();
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const today = new Date().toISOString().split('T')[0];

  return (
    <div ref={containerRef} style={{ position: 'relative', display: 'flex', ...style, flex: undefined }}>
      <input
        ref={inputRef}
        type="text"
        value={draft}
        placeholder="YYYY-MM-DD"
        autoFocus={autoFocus}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={() => setOpen(true)}
        onBlur={(e) => {
          if (!containerRef.current?.contains(e.relatedTarget as Node)) {
            parseAndCommit(e.target.value);
            setOpen(false);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { parseAndCommit(draft); setOpen(false); inputRef.current?.blur(); }
          if (e.key === 'Escape') { setDraft(value); setOpen(false); inputRef.current?.blur(); }
        }}
        style={{ flex: 1 }}
      />
      {open && (
        <div
          onMouseDown={(e) => e.preventDefault()}
          style={{
            position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 2000,
            background: 'var(--bg-2)', border: '1px solid var(--border)',
            borderRadius: 8, padding: '0.6rem',
            boxShadow: '0 6px 24px rgba(0,0,0,0.35)', minWidth: 248,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.45rem' }}>
            <div style={{ display: 'flex', gap: 2 }}>
              <button type="button" className="btn btn-ghost btn-sm" onClick={prevYear} title="Previous year" style={{ fontSize: '0.75rem', padding: '0.2rem 0.4rem' }}>«</button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={prevMonth}>‹</button>
            </div>
            <span style={{ fontWeight: 600, fontSize: '0.88rem' }}>{CAL_MONTHS[viewMonth]} {viewYear}</span>
            <div style={{ display: 'flex', gap: 2 }}>
              <button type="button" className="btn btn-ghost btn-sm" onClick={nextMonth}>›</button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={nextYear} title="Next year" style={{ fontSize: '0.75rem', padding: '0.2rem 0.4rem' }}>»</button>
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2, marginBottom: 3 }}>
            {CAL_DAYS.map(d => <div key={d} style={{ textAlign: 'center', fontSize: '0.68rem', opacity: 0.45 }}>{d}</div>)}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2 }}>
            {Array.from({ length: firstDow }).map((_, i) => <div key={`e${i}`} />)}
            {Array.from({ length: daysInMonth }).map((_, i) => {
              const day = i + 1;
              const ds = `${viewYear}-${String(viewMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
              const sel = ds === value, isToday = ds === today;
              return (
                <button key={day} type="button" onClick={() => selectDay(viewYear, viewMonth, day)} style={{
                  padding: '5px 2px', textAlign: 'center', fontSize: '0.82rem', borderRadius: 4, cursor: 'pointer',
                  border: isToday && !sel ? '1px solid var(--teal)' : '1px solid transparent',
                  background: sel ? 'var(--teal)' : 'transparent',
                  color: sel ? '#fff' : 'inherit', fontWeight: isToday ? 600 : 400,
                }}>{day}</button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
