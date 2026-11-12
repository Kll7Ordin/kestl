import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
}

/**
 * Month stepping for a budget screen: ←/→ keys and side arrows. When the month changes,
 * the budget row at the top of the screen stays where it was, so the same line can be
 * compared month to month.
 *
 * `rows` must change identity once the new month's rows are rendered.
 */
export function useMonthStepper(
  month: string,
  setMonth: (m: string) => void,
  containerRef: RefObject<HTMLElement | null>,
  rows: unknown,
) {
  const pending = useRef<{ anchors: { id: string; top: number }[]; rows: unknown } | null>(null);

  function step(delta: number) {
    const container = containerRef.current;
    if (container) {
      const anchors: { id: string; top: number }[] = [];
      for (const el of container.querySelectorAll<HTMLElement>('tr[data-catid]')) {
        const r = el.getBoundingClientRect();
        if (r.bottom <= 0) continue;
        anchors.push({ id: el.dataset.catid!, top: r.top });
        if (anchors.length >= 12) break;
      }
      pending.current = anchors.length > 0 ? { anchors, rows } : null;
    }
    setMonth(shiftMonth(month, delta));
  }

  useLayoutEffect(() => {
    const p = pending.current;
    const container = containerRef.current;
    if (!p || p.rows === rows || !container) return;
    pending.current = null;
    for (const a of p.anchors) {
      const el = container.querySelector<HTMLElement>(`tr[data-catid="${a.id}"]`);
      if (!el) continue;
      const want = el.getBoundingClientRect().top - a.top;
      if (Math.abs(want) < 1) return;
      // Page zoom can make scroll units differ from rect units — measure the first move and correct.
      const before = el.getBoundingClientRect().top;
      window.scrollBy(0, want);
      const moved = before - el.getBoundingClientRect().top;
      const left = want - moved;
      if (moved !== 0 && Math.abs(left) >= 1) window.scrollBy(0, left * (want / moved));
      return;
    }
  }, [rows, containerRef]);

  // ←/→ keys, unless typing or using a modifier
  const stepRef = useRef(step);
  useEffect(() => { stepRef.current = step; });
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (isTypingTarget(e.target) || isTypingTarget(document.activeElement)) return;
      e.preventDefault();
      stepRef.current(e.key === 'ArrowLeft' ? -1 : 1);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return step;
}
