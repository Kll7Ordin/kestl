import { useEffect, useRef, useState } from 'react';
import { monthLabel } from '../logic/dateUtils';
import { shiftMonth } from './useMonthStepper';

/**
 * ‹ › buttons in the empty space either side of the budget, shown once you scroll down.
 * Render inside the budget's container; that container must be `position: relative`.
 */
export function MonthSideArrows({ month, onStep }: { month: string; onStep: (delta: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [outside, setOutside] = useState(true);

  useEffect(() => {
    function update() {
      setVisible(window.scrollY > 200);
      const parent = ref.current?.parentElement;
      if (parent) setOutside(parent.getBoundingClientRect().left >= 56);
    }
    update();
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => { window.removeEventListener('scroll', update); window.removeEventListener('resize', update); };
  }, []);

  const offset = outside ? -50 : 2;
  const column = (side: 'left' | 'right', delta: number) => (
    <div style={{ position: 'absolute', top: 0, bottom: 0, [side]: offset, width: 40, pointerEvents: 'none', zIndex: 20 }}>
      <button
        type="button"
        className="btn btn-ghost"
        onClick={() => onStep(delta)}
        title={`${monthLabel(shiftMonth(month, delta))} (${delta < 0 ? '←' : '→'} key)`}
        style={{
          position: 'sticky', top: 'calc(50vh - 24px)', width: 40, height: 48, padding: 0,
          fontSize: '1.5rem', lineHeight: 1, borderRadius: 'var(--radius-lg)',
          background: outside ? 'transparent' : 'var(--bg-2)', border: outside ? 'none' : '1px solid var(--border)',
          color: 'var(--text-3)', pointerEvents: visible ? 'auto' : 'none',
          opacity: visible ? 0.7 : 0, transition: 'opacity 150ms',
        }}
      >
        {delta < 0 ? '‹' : '›'}
      </button>
    </div>
  );

  return (
    <div ref={ref} style={{ display: 'contents' }}>
      {column('left', -1)}
      {column('right', 1)}
    </div>
  );
}
