import { useEffect, useRef, useState } from "react";

// Wraps a horizontally-scrollable table with a second, slim scrollbar
// pinned to the TOP of the table (in addition to the browser's native one
// at the bottom of the scroll container). Freshsales/HubSpot-style tables
// do this because on a long table the native bottom scrollbar can be a full
// page-scroll away - the user has to scroll all the way down just to find
// it before they can scroll right. This mirrors scroll position both ways
// so either bar can be dragged from wherever the user's mouse already is.
//
// `hideBottomScrollbar` keeps the sync behavior but visually hides the
// native bottom scrollbar, which is useful on dense split tables where the
// top bar is the only one we want the user to see. `hideTopBar` does the
// reverse (no top bar, native bottom scrollbar only); opt-in, default false.
//
// `scrollWidth` is OPTIONAL - when omitted, the actual rendered width of the
// wrapped content is measured automatically (via ResizeObserver, so it stays
// correct when columns are toggled on/off or data changes row count). Pass
// an explicit `scrollWidth` only if you already compute it for other reasons
// (e.g. it also drives the table's own minWidth) and want to skip the extra
// measurement.
const TopScrollSync = ({
  scrollWidth,
  children,
  disabled = false,
  forceScrollbar = false,
  stickyTop = false,
  stickyTopOffset = 0,
  hideBottomScrollbar = false,
  hideTopBar = false,
  verticalOverflow = "visible",
  stickyBottom = false,
  topBarLeadingWidth = 0,
}) => {
  const topRef = useRef(null);
  const bottomRef = useRef(null);
  const stickyBottomRef = useRef(null);
  const syncingFrom = useRef(null);
  const [measuredWidth, setMeasuredWidth] = useState(0);
  const [clientWidth, setClientWidth] = useState(0);

  useEffect(() => {
    const top = topRef.current;
    const bottom = bottomRef.current;
    const stickyBottomElement = stickyBottomRef.current;
    if (!bottom) return undefined;

    const content = bottom.firstElementChild;
    const originalContentStyle = content
      ? {
          position: content.style.position,
          left: content.style.left,
          transform: content.style.transform,
        }
      : null;

    const setHorizontalPosition = (position) => {
      if (stickyBottom) {
        if (content) {
          // Keep the table in the normal layout flow so sticky table headers
          // continue to anchor to the outer vertical table viewport. A
          // transform on the table creates a containing block that prevents
          // the scrollable header from staying aligned while rows move.
          content.style.position = "relative";
          content.style.left = `-${position}px`;
          content.style.transform = "none";
        }
        if (stickyBottomElement) {
          stickyBottomElement.scrollLeft = position;
        }
        return;
      }
      bottom.scrollLeft = position;
    };
    if (stickyBottom) {
      setHorizontalPosition(stickyBottomElement?.scrollLeft || 0);
    }

    const onTopScroll = () => {
      if (syncingFrom.current === "bottom" || syncingFrom.current === "sticky-bottom") return;
      syncingFrom.current = "top";
      setHorizontalPosition(top.scrollLeft);
      syncingFrom.current = null;
    };
    const onBottomScroll = () => {
      if (syncingFrom.current === "top" || syncingFrom.current === "sticky-bottom") return;
      syncingFrom.current = "bottom";
      if (top) top.scrollLeft = bottom.scrollLeft;
      setHorizontalPosition(bottom.scrollLeft);
      syncingFrom.current = null;
    };
    const onStickyBottomScroll = () => {
      if (syncingFrom.current === "top" || syncingFrom.current === "bottom") return;
      syncingFrom.current = "sticky-bottom";
      setHorizontalPosition(stickyBottomElement.scrollLeft);
      if (top) top.scrollLeft = stickyBottomElement.scrollLeft;
      syncingFrom.current = null;
    };

    if (top) top.addEventListener("scroll", onTopScroll);
    bottom.addEventListener("scroll", onBottomScroll);
    if (stickyBottomElement) {
      stickyBottomElement.addEventListener("scroll", onStickyBottomScroll);
    }
    return () => {
      if (top) top.removeEventListener("scroll", onTopScroll);
      bottom.removeEventListener("scroll", onBottomScroll);
      if (stickyBottomElement) {
        stickyBottomElement.removeEventListener("scroll", onStickyBottomScroll);
      }
      if (content && originalContentStyle) {
        content.style.position = originalContentStyle.position;
        content.style.left = originalContentStyle.left;
        content.style.transform = originalContentStyle.transform;
      }
    };
  }, [measuredWidth, scrollWidth, forceScrollbar, disabled, hideTopBar, stickyBottom]);

  useEffect(() => {
    if (scrollWidth !== undefined) return undefined;
    const bottom = bottomRef.current;
    if (!bottom || typeof ResizeObserver === "undefined") return undefined;
    // Usually `bottom.scrollWidth` alone is enough — the wrapped table
    // overflows this div directly, so the div's own scrollWidth captures
    // it. But tables that manage their own horizontal overflow (e.g. the
    // `.stable-table` mobile rule sets `display:block; overflow-x:auto`
    // directly on the <table>) clip their content one level deeper — the
    // overflow never reaches this wrapper, so its scrollWidth reads equal
    // to its clientWidth even though the table's own content is wider.
    // Taking the max of both catches that case without affecting the
    // normal case (where they're already equal).
    const measure = () => {
      const nextMeasuredWidth = Math.max(
        bottom.scrollWidth,
        bottom.firstElementChild ? bottom.firstElementChild.scrollWidth : 0,
      );
      setMeasuredWidth((current) =>
        current === nextMeasuredWidth ? current : nextMeasuredWidth,
      );
      setClientWidth((current) =>
        current === bottom.clientWidth ? current : bottom.clientWidth,
      );
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(bottom);
    if (bottom.firstElementChild) ro.observe(bottom.firstElementChild);
    return () => ro.disconnect();
  }, [scrollWidth]);

  const spacerWidth =
    scrollWidth !== undefined ? scrollWidth : `${measuredWidth}px`;
  const topSpacerWidth = topBarLeadingWidth
    ? `calc(${topBarLeadingWidth}px + ${spacerWidth})`
    : spacerWidth;
  const explicitScrollWidth =
    typeof scrollWidth === "number"
      ? scrollWidth
      : Number.parseFloat(scrollWidth);
  const hasHorizontalOverflow =
    scrollWidth !== undefined
      ? Number.isFinite(explicitScrollWidth) &&
        explicitScrollWidth > clientWidth + 1
      : measuredWidth > clientWidth + 1;

  if (disabled) {
    return (
      <div className="top-scroll-sync top-scroll-sync--disabled">
        {children}
      </div>
    );
  }

  return (
    <div className="top-scroll-sync">
      {!hideTopBar && (forceScrollbar || hasHorizontalOverflow) ? (
        <div
          ref={topRef}
          className="top-scroll-sync__top"
          style={{
            overflowX: forceScrollbar ? "scroll" : "auto",
            overflowY: "hidden",
            height: "16px",
            marginLeft: topBarLeadingWidth ? `-${topBarLeadingWidth}px` : undefined,
            width: topBarLeadingWidth ? `calc(100% + ${topBarLeadingWidth}px)` : undefined,
            minWidth: 0,
            maxWidth: "100%",
            position: stickyTop ? "sticky" : "static",
            top: stickyTop ? stickyTopOffset : "auto",
            zIndex: stickyTop ? 5 : "auto",
            background: stickyTop ? "var(--surface-color)" : "transparent",
          }}
        >
          <div style={{ width: topSpacerWidth, height: "1px" }} />
        </div>
      ) : null}
      <div
        ref={bottomRef}
        className={`top-scroll-sync__bottom${hideBottomScrollbar || stickyBottom ? " top-scroll-sync__bottom--hidden-scrollbar" : ""}`}
        style={{
          overflowX: stickyBottom
            ? "visible"
            : forceScrollbar
              ? "scroll"
              : "auto",
          overflowY: verticalOverflow,
          minWidth: 0,
          maxWidth: "100%",
          // The generic Leads table translates its content for horizontal
          // scrolling while the outer viewport remains vertically scrollable.
          // Clip that translated content at the scroll-pane boundary so it
          // cannot paint over the frozen Name column.
          clipPath: stickyBottom ? "inset(0)" : undefined,
          scrollbarWidth: hideBottomScrollbar ? "none" : "auto",
          msOverflowStyle: hideBottomScrollbar ? "none" : "auto",
        }}
      >
        {children}
      </div>
      {stickyBottom && (forceScrollbar || hasHorizontalOverflow) ? (
        <div
          ref={stickyBottomRef}
          className="top-scroll-sync__sticky-bottom"
          style={{
            overflowX: forceScrollbar ? "scroll" : "auto",
            overflowY: "hidden",
            height: "16px",
            minWidth: 0,
            maxWidth: "100%",
            position: "sticky",
            bottom: 0,
            zIndex: 6,
            background: "var(--surface-color)",
          }}
        >
          <div style={{ width: spacerWidth, height: "1px" }} />
        </div>
      ) : null}
    </div>
  );
};

export default TopScrollSync;
