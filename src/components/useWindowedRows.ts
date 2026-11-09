import { useEffect, useRef, useState, type RefObject } from 'react';

const BLOCK = 10; // snap the range to blocks so small scrolls don't re-render

/**
 * Table row windowing: returns the slice of rows near the viewport plus spacer heights for the
 * rows above and below it. Rows are treated as roughly equal height; the height is measured from
 * the rows actually rendered. Listens to scroll on any scroller (capture), so it works whichever
 * ancestor scrolls.
 *
 * Rendering only ~60 rows instead of hundreds keeps both scrolling (less to paint on WebKitGTK)
 * and re-renders after an edit cheap.
 */
export function useWindowedRows(
  count: number,
  tbodyRef: RefObject<HTMLTableSectionElement | null>,
  { estimate = 40, overscan = 20 }: { estimate?: number; overscan?: number } = {},
) {
  const rowHRef = useRef(estimate);
  const [layout, setLayout] = useState({ start: 0, end: Math.min(count, 60), rowH: estimate });

  useEffect(() => {
    let raf = 0;
    const update = () => {
      raf = 0;
      const el = tbodyRef.current;
      if (!el) return;

      // Measure the real average row height from what's rendered; ignore small wobble so spacer
      // heights (and the scroll position) stay stable.
      let total = 0, n = 0;
      for (const row of Array.from(el.rows)) {
        if (row.dataset.spacer) continue;
        total += row.offsetHeight;
        n++;
      }
      if (n >= 5 && Math.abs(total / n - rowHRef.current) > 3) rowHRef.current = total / n;
      const rowH = rowHRef.current;

      const top = el.getBoundingClientRect().top; // < 0 once the table has scrolled past the top
      const first = Math.max(0, Math.floor(-top / rowH) - overscan);
      const last = first + Math.ceil(window.innerHeight / rowH) + overscan * 2;
      const start = Math.min(Math.floor(first / BLOCK) * BLOCK, Math.max(0, count - 1));
      const end = Math.min(count, Math.ceil(last / BLOCK) * BLOCK);
      setLayout((l) => (l.start === start && l.end === end && l.rowH === rowH ? l : { start, end, rowH }));
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(update); };
    schedule();
    window.addEventListener('scroll', schedule, { capture: true, passive: true });
    window.addEventListener('resize', schedule, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('scroll', schedule, { capture: true });
      window.removeEventListener('resize', schedule);
    };
  }, [count, overscan, tbodyRef]);

  const start = Math.min(layout.start, count);
  const end = Math.min(Math.max(layout.end, start), count);
  return { start, end, padTop: start * layout.rowH, padBottom: (count - end) * layout.rowH };
}
