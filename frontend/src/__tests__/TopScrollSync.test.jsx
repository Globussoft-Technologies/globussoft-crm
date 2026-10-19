import React from "react";
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import TopScrollSync from "../components/TopScrollSync";

const renderStickyScroller = (props = {}) =>
  render(
    <TopScrollSync
      forceScrollbar
      scrollWidth={1000}
      stickyBottom
      {...props}
    >
      <div data-testid="wide-content" style={{ width: 1000 }} />
    </TopScrollSync>,
  );

describe("TopScrollSync sticky bottom mode", () => {
  const setScrollDimensions = (container) => {
    const bar = container.querySelector('.top-scroll-sync__sticky-bottom');
    Object.defineProperties(bar, {
      scrollWidth: { configurable: true, value: 1000 },
      clientWidth: { configurable: true, value: 400 },
    });
    return bar;
  };

  it('scrolls translated rows with horizontal trackpad and Shift+wheel gestures', () => {
    const { container, getByTestId } = renderStickyScroller();
    const bar = setScrollDimensions(container);
    const content = getByTestId('wide-content');
    expect(fireEvent.wheel(content, { deltaX: 120, cancelable: true })).toBe(false);
    expect(bar.scrollLeft).toBe(120);
    expect(content.style.left).toBe('-120px');
    expect(container.querySelector('.top-scroll-sync__top').scrollLeft).toBe(120);
    fireEvent.wheel(content, { deltaY: 3, shiftKey: true, deltaMode: 1 });
    expect(bar.scrollLeft).toBe(168);
    fireEvent.wheel(content, { deltaX: -1, deltaMode: 2 });
    expect(bar.scrollLeft).toBe(0);
  });

  it('handles gestures over frozen columns and removes the surface listener on unmount', () => {
    const surfaceRef = React.createRef();
    const { container, getByTestId, unmount } = render(
      <div ref={surfaceRef}>
        <div data-testid="frozen-column">Frozen name</div>
        <TopScrollSync forceScrollbar stickyBottom scrollWidth={1000} wheelTargetRef={surfaceRef}>
          <div data-testid="wide-content" />
        </TopScrollSync>
      </div>,
    );
    const bar = setScrollDimensions(container);
    const surface = surfaceRef.current;
    const remove = vi.spyOn(surface, 'removeEventListener');
    fireEvent.wheel(getByTestId('frozen-column'), { deltaX: 85 });
    expect(bar.scrollLeft).toBe(85);
    expect(getByTestId('wide-content').style.left).toBe('-85px');
    Object.defineProperties(surface, {
      scrollHeight: { configurable: true, value: 1200 },
      clientHeight: { configurable: true, value: 400 },
    });
    surface.style.overflowY = 'auto';
    fireEvent.wheel(getByTestId('frozen-column'), { deltaX: -25, deltaY: 120 });
    expect(bar.scrollLeft).toBe(60);
    expect(surface.scrollTop).toBe(120);
    unmount();
    expect(remove).toHaveBeenCalledWith('wheel', expect.any(Function), true);
  });

  it('preserves vertical scrolling, zoom, native scrollbar events and boundary gestures', () => {
    const { container, getByTestId } = renderStickyScroller();
    const bar = setScrollDimensions(container);
    const content = getByTestId('wide-content');
    for (const event of [
      { deltaY: 120 }, { deltaX: 100, ctrlKey: true },
    ]) {
      expect(fireEvent.wheel(content, { ...event, cancelable: true })).toBe(true);
      expect(bar.scrollLeft).toBe(0);
    }
    expect(fireEvent.wheel(bar, { deltaX: 50, cancelable: true })).toBe(true);
    fireEvent.wheel(content, { deltaX: 2000 });
    expect(bar.scrollLeft).toBe(600);
    expect(fireEvent.wheel(content, { deltaX: 50, cancelable: true })).toBe(false);
    fireEvent.wheel(content, { deltaX: -100, deltaY: 120 });
    expect(bar.scrollLeft).toBe(500);
    expect(content.style.left).toBe('-500px');
    fireEvent.wheel(content, { deltaX: -2000 });
    expect(bar.scrollLeft).toBe(0);
    expect(fireEvent.wheel(content, { deltaX: -50, cancelable: true })).toBe(false);
  });

  it("keeps the top bar, sticky bottom bar, and translated content synchronized", () => {
    const { container, getByTestId } = renderStickyScroller();
    const top = container.querySelector(".top-scroll-sync__top");
    const stickyBottom = container.querySelector(
      ".top-scroll-sync__sticky-bottom",
    );
    const content = getByTestId("wide-content");

    stickyBottom.scrollLeft = 240;
    fireEvent.scroll(stickyBottom);

    expect(top.scrollLeft).toBe(240);
    expect(content.style.left).toBe("-240px");

    top.scrollLeft = 120;
    fireEvent.scroll(top);

    expect(stickyBottom.scrollLeft).toBe(120);
    expect(content.style.left).toBe("-120px");
  });

  it("removes listeners from the exact sticky element when the mode changes", () => {
    const { container, rerender } = renderStickyScroller();
    const stickyBottom = container.querySelector(
      ".top-scroll-sync__sticky-bottom",
    );
    const removeEventListener = vi.spyOn(stickyBottom, "removeEventListener");

    rerender(
      <TopScrollSync forceScrollbar scrollWidth={1000} stickyBottom={false}>
        <div data-testid="wide-content" style={{ width: 1000 }} />
      </TopScrollSync>,
    );

    expect(removeEventListener).toHaveBeenCalledWith(
      "scroll",
      expect.any(Function),
    );
  });
});

describe("TopScrollSync detached bottom bar", () => {
  it('bridges a native table frozen pane without hijacking its scrolling pane', () => {
    const surface = React.createRef();
    const { container, getByTestId } = render(<div ref={surface}>
      <div data-testid="frozen">Name</div>
      <TopScrollSync forceScrollbar scrollWidth={1000} wheelTargetRef={surface}>
        <div data-testid="rows" />
      </TopScrollSync>
    </div>);
    const body = container.querySelector('.top-scroll-sync__bottom');
    Object.defineProperties(body, {
      scrollWidth: { value: 1000 }, clientWidth: { value: 400 },
    });
    fireEvent.wheel(getByTestId('frozen'), { deltaX: 200 });
    expect(body.scrollLeft).toBe(200);
    fireEvent.wheel(getByTestId('frozen'), { deltaX: -80 });
    expect(body.scrollLeft).toBe(120);
    expect(container.querySelector('.top-scroll-sync__top').scrollLeft).toBe(120);
    expect(fireEvent.wheel(getByTestId('rows'), { deltaX: 50, cancelable: true })).toBe(true);
    expect(body.scrollLeft).toBe(120);
  });

  it('leaves native-scroll tables on their existing wheel behavior', () => {
    const { container, getByTestId } = renderStickyScroller({ stickyBottom: false });
    const body = container.querySelector('.top-scroll-sync__bottom');
    expect(fireEvent.wheel(getByTestId('wide-content'), { deltaX: 100, cancelable: true })).toBe(true);
    expect(body.scrollLeft).toBe(0);
  });

  it("offsets the visible bottom bar and keeps it in sync without moving content", () => {
    const { container, getByTestId } = render(
      <TopScrollSync forceScrollbar scrollWidth={1000} hideBottomScrollbar bottomBarLeadingWidth={80}>
        <div data-testid="wide-content" style={{ width: 1080 }} />
      </TopScrollSync>,
    );
    const top = container.querySelector(".top-scroll-sync__top");
    const body = container.querySelector(".top-scroll-sync__bottom");
    const lower = container.querySelector(".top-scroll-sync__detached-bottom");
    expect(lower.style.marginLeft).toBe("80px");
    expect(lower.style.width).toBe("calc(100% - 80px)");
    expect(body).toHaveClass("top-scroll-sync__bottom--hidden-scrollbar");

    lower.scrollLeft = 240;
    fireEvent.scroll(lower);
    expect(top.scrollLeft).toBe(240);
    expect(body.scrollLeft).toBe(240);

    top.scrollLeft = 120;
    fireEvent.scroll(top);
    expect(lower.scrollLeft).toBe(120);
    expect(body.scrollLeft).toBe(120);
    expect(getByTestId("wide-content").style.left).toBe("");
  });
});
