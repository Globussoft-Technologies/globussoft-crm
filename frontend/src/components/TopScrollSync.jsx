import { useEffect, useRef, useState } from 'react';

// Wraps a horizontally-scrollable table with a second, slim scrollbar
// pinned to the TOP of the table (in addition to the browser's native one
// at the bottom of the scroll container). Freshsales/HubSpot-style tables
// do this because on a long table the native bottom scrollbar can be a full
// page-scroll away — the user has to scroll all the way down just to find
// it before they can scroll right. This mirrors scroll position both ways
// so either bar can be dragged from wherever the user's mouse already is.
//
// `scrollWidth` is OPTIONAL — when omitted, the actual rendered width of the
// wrapped content is measured automatically (via ResizeObserver, so it stays
// correct when columns are toggled on/off or data changes row count). Pass
// an explicit `scrollWidth` only if you already compute it for other reasons
// (e.g. it also drives the table's own minWidth) and want to skip the extra
// measurement.
const TopScrollSync = ({ scrollWidth, children }) => {
  const topRef = useRef(null);
  const bottomRef = useRef(null);
  const syncingFrom = useRef(null);
  const [measuredWidth, setMeasuredWidth] = useState(0);

  useEffect(() => {
    const top = topRef.current;
    const bottom = bottomRef.current;
    if (!top || !bottom) return undefined;

    const onTopScroll = () => {
      if (syncingFrom.current === 'bottom') return;
      syncingFrom.current = 'top';
      bottom.scrollLeft = top.scrollLeft;
      syncingFrom.current = null;
    };
    const onBottomScroll = () => {
      if (syncingFrom.current === 'top') return;
      syncingFrom.current = 'bottom';
      top.scrollLeft = bottom.scrollLeft;
      syncingFrom.current = null;
    };

    top.addEventListener('scroll', onTopScroll);
    bottom.addEventListener('scroll', onBottomScroll);
    return () => {
      top.removeEventListener('scroll', onTopScroll);
      bottom.removeEventListener('scroll', onBottomScroll);
    };
  }, []);

  useEffect(() => {
    if (scrollWidth !== undefined) return undefined;
    const bottom = bottomRef.current;
    if (!bottom || typeof ResizeObserver === 'undefined') return undefined;
    // Usually `bottom.scrollWidth` alone is enough — the wrapped table
    // overflows this div directly, so the div's own scrollWidth captures
    // it. But tables that manage their own horizontal overflow (e.g. the
    // `.stable-table` mobile rule sets `display:block; overflow-x:auto`
    // directly on the <table>) clip their content one level deeper — the
    // overflow never reaches this wrapper, so its scrollWidth reads equal
    // to its clientWidth even though the table's own content is wider.
    // Taking the max of both catches that case without affecting the
    // normal case (where they're already equal).
    const measure = () => setMeasuredWidth(Math.max(
      bottom.scrollWidth,
      bottom.firstElementChild ? bottom.firstElementChild.scrollWidth : 0,
    ));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(bottom);
    if (bottom.firstElementChild) ro.observe(bottom.firstElementChild);
    return () => ro.disconnect();
  });

  const spacerWidth = scrollWidth !== undefined ? scrollWidth : `${measuredWidth}px`;

  return (
    <div>
      <div ref={topRef} style={{ overflowX: 'auto', overflowY: 'hidden', height: '14px' }}>
        <div style={{ width: spacerWidth, height: '1px' }} />
      </div>
      <div ref={bottomRef} style={{ overflowX: 'auto' }}>
        {children}
      </div>
    </div>
  );
};

export default TopScrollSync;
