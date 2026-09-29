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
