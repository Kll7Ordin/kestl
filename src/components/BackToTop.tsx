import { useEffect, useRef, useState } from 'react';

const SHOW_AFTER = 400;

/** Is this element a whole-screen scroller (not a dropdown, list box or modal)? */
function isPageScroller(el: Element): boolean {
  if (el.closest('.modal, .modal-overlay')) return false;
  return el.clientHeight >= window.innerHeight * 0.6;
}

/**
 * Floating "back to top" button. Follows whichever page-sized area was scrolled last: the window
 * itself, or a full-screen settings sub-screen that scrolls on its own.
 */
export function BackToTop() {
  const [visible, setVisible] = useState(false);
  const target = useRef<Element | null>(null); // null = the window

  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const el = target.current;
      if (el && !el.isConnected) target.current = null;
      const top = target.current ? target.current.scrollTop : window.scrollY;
      setVisible(top > SHOW_AFTER);
    };
    const onScroll = (e: Event) => {
      const el = e.target;
      if (el === document || el === document.documentElement || el === document.body) target.current = null;
      else if (el instanceof Element && isPageScroller(el)) target.current = el;
      else return;
      if (!frame) frame = requestAnimationFrame(update);
    };
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    // A closed sub-screen takes its scroller with it; recheck now and then.
    const timer = window.setInterval(() => { if (target.current && !target.current.isConnected) update(); }, 1000);
    return () => {
      document.removeEventListener('scroll', onScroll, { capture: true });
      window.clearInterval(timer);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  if (!visible) return null;
  return (
    <button
      className="back-to-top"
      title="Back to top"
      aria-label="Back to top"
      onClick={() => {
        const el = target.current;
        if (el) el.scrollTo({ top: 0, behavior: 'smooth' });
        else window.scrollTo({ top: 0, behavior: 'smooth' });
      }}
    >
      ↑
    </button>
  );
}
