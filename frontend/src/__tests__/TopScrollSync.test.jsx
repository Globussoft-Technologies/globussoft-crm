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
