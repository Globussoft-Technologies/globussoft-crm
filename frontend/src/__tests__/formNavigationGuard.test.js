import { afterEach, describe, test, expect, vi } from "vitest";
import { confirmActiveFormExit, installFormNavigationGuard } from "../utils/formNavigationGuard";

const cleanups = [];
afterEach(() => { while (cleanups.length) cleanups.pop()(); });

function setup(answer, signOutAnswer = answer, initiallyActive = true) {
  let pop;
  const navigator = { push: vi.fn(), replace: vi.fn(), go: vi.fn() };
  const originals = { ...navigator };
  const win = { history: { state: { idx: 2 }, go: vi.fn(), pushState: vi.fn(), replaceState: vi.fn() },
    addEventListener: vi.fn((_name, fn) => { pop = fn; }), removeEventListener: vi.fn() };
  const confirm = vi.fn().mockResolvedValue(answer);
  const confirmSignOut = vi.fn().mockResolvedValue(signOutAnswer);
  const bypassRef = { current: false };
  const activeRef = { current: initiallyActive };
  const onDiscard = vi.fn();
  const cleanup = installFormNavigationGuard({ navigator, confirm, confirmSignOut, onDiscard, bypassRef, isActive: () => activeRef.current, targetWindow: win });
  cleanups.push(cleanup);
  const emit = (idx) => { const event = { state: { idx }, stopImmediatePropagation: vi.fn() }; pop(event); return event; };
  return { navigator, originals, win, confirm, confirmSignOut, onDiscard, bypassRef, activeRef, cleanup, emit };
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
  test("sign-out waits for the unsaved form decision and bypasses the later route change", async () => {
    const s = setup(true);
    expect(await confirmActiveFormExit()).toBe(true);
    expect(s.onDiscard).toHaveBeenCalledOnce();
    expect(s.bypassRef.current).toBe(true);
    s.navigator.push("/login");
    expect(s.originals.push).toHaveBeenCalledWith("/login");
    expect(s.confirmSignOut).toHaveBeenCalledOnce();
    expect(s.confirm).not.toHaveBeenCalled();
  });
  test("keeping edits cancels sign-out without bypassing the form guard", async () => {
    const s = setup(false);
    expect(await confirmActiveFormExit()).toBe(false);
    expect(s.onDiscard).not.toHaveBeenCalled();
    expect(s.bypassRef.current).toBe(false);
  });
  test("uses the normal sign-out dialog when no unsaved form guard is active", async () => {
    expect(await confirmActiveFormExit()).toBeNull();
  });
  test("a mounted clean form switches to one form sign-out decision when it becomes dirty", async () => {
    const s = setup(true, true, false);
    expect(await confirmActiveFormExit()).toBeNull();
    s.navigator.push("/clean-destination");
    expect(s.originals.push).toHaveBeenCalledWith("/clean-destination");
    expect(s.confirmSignOut).not.toHaveBeenCalled();

    s.activeRef.current = true;
    expect(await confirmActiveFormExit()).toBe(true);
    expect(s.confirmSignOut).toHaveBeenCalledOnce();
    expect(s.confirm).not.toHaveBeenCalled();
  });
});
