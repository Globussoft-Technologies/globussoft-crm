import { describe, test, expect, vi } from "vitest";
import { installFormNavigationGuard } from "../utils/formNavigationGuard";

function setup(answer) {
  let pop;
  const navigator = { push: vi.fn(), replace: vi.fn(), go: vi.fn() };
  const originals = { ...navigator };
  const win = { history: { state: { idx: 2 }, go: vi.fn(), pushState: vi.fn(), replaceState: vi.fn() },
    addEventListener: vi.fn((_name, fn) => { pop = fn; }), removeEventListener: vi.fn() };
  const confirm = vi.fn().mockResolvedValue(answer);
  const cleanup = installFormNavigationGuard({ navigator, confirm, bypassRef: { current: false }, targetWindow: win });
  const emit = (idx) => { const event = { state: { idx }, stopImmediatePropagation: vi.fn() }; pop(event); return event; };
  return { navigator, originals, win, confirm, cleanup, emit };
}

describe("form navigation guard", () => {
  test.each(["push", "replace", "go"])("blocks %s when edits are kept and restores navigator on cleanup", async (method) => {
    const s = setup(false);
    await s.navigator[method]("/next", { draft: true });
    expect(s.originals[method]).not.toHaveBeenCalled();
    s.cleanup();
    expect(s.navigator[method]).toBe(s.originals[method]);
  });
  test("preserves destination arguments on confirmed navigation", async () => {
    const s = setup(true);
    await s.navigator.push("/next", { draft: true });
    expect(s.originals.push).toHaveBeenCalledWith("/next", { draft: true });
  });
  test.each([-1, 1])("restores and replays a POP delta %s without overwriting history", async (delta) => {
    const s = setup(true);
    expect(s.emit(2 + delta).stopImmediatePropagation).toHaveBeenCalled();
    expect(s.win.history.go).toHaveBeenCalledWith(-delta);
    expect(s.confirm).not.toHaveBeenCalled();
    s.emit(2);
    await Promise.resolve();
    expect(s.win.history.go).toHaveBeenLastCalledWith(delta);
    expect(s.emit(2 + delta).stopImmediatePropagation).not.toHaveBeenCalled();
    expect(s.win.history.pushState).not.toHaveBeenCalled();
    expect(s.win.history.replaceState).not.toHaveBeenCalled();
  });
  test("cancelled Back keeps the current entry and forward history", async () => {
    const s = setup(false);
    s.emit(1); s.emit(2); await Promise.resolve();
    expect(s.win.history.go).toHaveBeenCalledTimes(1);
    expect(s.win.history.pushState).not.toHaveBeenCalled();
  });
});
