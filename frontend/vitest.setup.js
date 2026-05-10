import '@testing-library/jest-dom';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

// #634: vite's `define` injects __APP_VERSION__ / __APP_GIT_SHA__ at build
// time, but vitest doesn't always apply the same replacement (depends on
// transformer order). Polyfill them here so any component referencing the
// build identifier doesn't blow up under jsdom with a ReferenceError.
if (typeof globalThis.__APP_VERSION__ === 'undefined') {
  globalThis.__APP_VERSION__ = '0.0.0-test';
}
if (typeof globalThis.__APP_GIT_SHA__ === 'undefined') {
  globalThis.__APP_GIT_SHA__ = '';
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

// Stub out browser-only APIs jsdom doesn't ship with
if (!window.matchMedia) {
  window.matchMedia = () => ({
    matches: false,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

if (!global.ResizeObserver) {
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// Recharts ResponsiveContainer relies on this
if (!Element.prototype.getBoundingClientRect.toString().includes('jsdom')) {
  Element.prototype.getBoundingClientRect = function () {
    return { width: 800, height: 400, top: 0, left: 0, right: 800, bottom: 400, x: 0, y: 0, toJSON: () => ({}) };
  };
}

// Wave 12: jsdom doesn't implement scrollIntoView. Several pages call it
// inside a useEffect after toggling a panel (e.g. wellness/Patients.jsx
// `setShowAdd(true)` → form ref.scrollIntoView). Without this stub the
// effect throws, React unmounts the component, and the test reds with a
// hard-to-debug "element not found" downstream. Promoted from Wave 12
// per-test fix so future RTL authors get it for free.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function () {};
}
