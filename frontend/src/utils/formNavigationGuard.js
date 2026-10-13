// Guard React Router's navigator, not the browser's push/replace methods.
// POPs are reversed by their router index while confirmation is pending;
// replaying the original delta preserves both backward and forward entries.
export function installFormNavigationGuard({ navigator, confirm, onDiscard, bypassRef, targetWindow = window }) {
  const originals = { push: navigator.push, replace: navigator.replace, go: navigator.go };
  let pending = false;
  let disposed = false;
  let index = targetWindow.history.state?.idx;
  let restoring = false;
  let replaying = false;
  let afterRestore = null;
  const ask = async (action) => {
    if (pending) return;
    pending = true;
    try {
      if (await confirm() && !disposed) {
        onDiscard?.();
        action();
      }
    } finally { pending = false; }
  };
  for (const method of ["push", "replace", "go"]) {
    navigator[method] = (...args) => {
      if (bypassRef.current) return originals[method].apply(navigator, args);
      return ask(() => {
        if (method === "go") replaying = true;
        originals[method].apply(navigator, args);
        index = targetWindow.history.state?.idx;
      });
    };
  }
  const onPop = (event) => {
    const nextIndex = event.state?.idx;
    if (restoring) {
      event.stopImmediatePropagation();
      restoring = false;
      const action = afterRestore;
      afterRestore = null;
      action?.();
      return;
    }
    if (replaying || bypassRef.current) {
      replaying = false;
      index = nextIndex;
      return;
    }
    // Entries created outside React Router cannot be safely reversed.
    // Let native navigation proceed; never fabricate a replacement entry.
    if (!Number.isInteger(index) || !Number.isInteger(nextIndex) || index === nextIndex) return;
    event.stopImmediatePropagation();
    const delta = nextIndex - index;
    restoring = true;
    afterRestore = () => ask(() => {
      replaying = true;
      targetWindow.history.go(delta);
    });
    targetWindow.history.go(-delta);
  };
  targetWindow.addEventListener("popstate", onPop, true);
  const onClick = (event) => {
    if (bypassRef.current || event.defaultPrevented || event.button !== 0
      || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target.closest?.("a");
    if (!link || link.target === "_blank" || link.hasAttribute("download")) return;
    // Router Links must retain their own replace/state options. Their
    // navigation is intercepted by the navigator wrappers above instead.
    if (link.hasAttribute("data-discover")) return;
    const url = new URL(link.href, targetWindow.location.href);
    if (url.origin !== targetWindow.location.origin) return;
    event.preventDefault();
    event.stopPropagation();
    ask(() => originals.push.call(navigator, {
      pathname: url.pathname, search: url.search, hash: url.hash,
    }));
  };
  targetWindow.document?.addEventListener("click", onClick, true);
  return () => {
    disposed = true;
    for (const method of Object.keys(originals)) navigator[method] = originals[method];
    targetWindow.removeEventListener("popstate", onPop, true);
    targetWindow.document?.removeEventListener("click", onClick, true);
  };
}
