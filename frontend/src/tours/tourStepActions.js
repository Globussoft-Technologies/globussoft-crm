function visible(element) {
  return Boolean(element && element.getClientRects().length > 0);
}

export function waitForTourTarget(selector, {
  timeoutMs = 4000,
  requireVisible = true,
  signal,
} = {}) {
  if (!selector) return Promise.resolve(null);
  const find = () => {
    const element = document.querySelector(selector);
    return element && (!requireVisible || visible(element)) ? element : null;
  };
  const immediate = find();
  if (immediate) return Promise.resolve(immediate);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      window.clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve(value);
    };
    const observer = new MutationObserver(() => {
      const element = find();
      if (element) finish(element);
    });
    const abort = () => finish(null);
    const timer = window.setTimeout(() => finish(null), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
  });
}

async function resolveActionTarget(action, signal) {
  return waitForTourTarget(action.target, {
    timeoutMs: action.timeoutMs || 4000,
    requireVisible: action.requireVisible !== false,
    signal,
  });
}

export async function performTourActions(actions = [], { signal } = {}) {
  const restorers = [];
  for (const action of actions) {
    if (signal?.aborted) break;
    if (action.type === "event") {
      window.dispatchEvent(new CustomEvent(action.name, { detail: action.detail }));
      continue;
    }

    const target = await resolveActionTarget(action, signal);
    if (!target) {
      if (action.required) return { ok: false, restorers };
      continue;
    }

    if (action.type === "expand") {
      const wasExpanded = target.getAttribute("aria-expanded") === "true";
      if (!wasExpanded) target.click();
      if (!wasExpanded) restorers.unshift(() => {
        if (target.isConnected && target.getAttribute("aria-expanded") === "true") target.click();
      });
    } else if (action.type === "tab") {
      const current = target.closest('[role="tablist"]')?.querySelector('[role="tab"][aria-selected="true"]');
      if (target !== current) target.click();
      if (current && target !== current) restorers.unshift(() => current.isConnected && current.click());
    } else if (action.type === "click") {
      target.click();
      if (action.restoreTarget) restorers.unshift(() => document.querySelector(action.restoreTarget)?.click());
    }

    if (action.waitFor) {
      const loaded = await waitForTourTarget(action.waitFor, {
        timeoutMs: action.timeoutMs || 4000,
        requireVisible: action.requireVisible !== false,
        signal,
      });
      if (!loaded && action.required) return { ok: false, restorers };
    }
  }
  return { ok: true, restorers };
}

export function needsTourPreparation(step = {}) {
  return Boolean(
    step.navigateTo || step.actions?.length || step.waitFor || step.skipIfMissing || step.requiresRecords,
  );
}
