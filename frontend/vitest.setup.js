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

// Node 24/25 ships an experimental Web Storage API that leaves
// `globalThis.localStorage` / `globalThis.sessionStorage` undefined unless
// `--localstorage-file` is provided. Vitest's jsdom environment sometimes
// exposes them on `window`, but when Node's accessor wins we end up with
// bare `undefined` and tests crash on localStorage.clear()/setItem().
// Provide a minimal in-memory Storage polyfill and force it onto both
// `globalThis` and `window` so every test file sees a working Web Storage API.
//
// The polyfill stores values as enumerable string properties so that
// `Object.keys(localStorage)` and `for...in` iteration work the same way
// jsdom's native Storage does (some tests assert localStorage key lists).
function createStoragePolyfill() {
  const store = {};
  const defineMethod = (name, fn) => {
    Object.defineProperty(store, name, {
      value: fn,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  };
  defineMethod('getItem', function (key) {
    const k = String(key);
    return Object.prototype.hasOwnProperty.call(this, k) ? String(this[k]) : null;
  });
  defineMethod('setItem', function (key, value) {
    this[String(key)] = String(value);
  });
  defineMethod('removeItem', function (key) {
    delete this[String(key)];
  });
  defineMethod('clear', function () {
    Object.keys(this).forEach((k) => delete this[k]);
  });
  defineMethod('key', function (index) {
    const keys = Object.keys(this);
    return keys[index] ?? null;
  });
  Object.defineProperty(store, 'length', {
    get() { return Object.keys(this).length; },
    configurable: true,
    enumerable: false,
  });
  return new Proxy(store, {
    set(target, prop, value) {
      if (typeof prop === 'symbol') return Reflect.set(target, prop, value);
      target[prop] = String(value);
      return true;
    },
    deleteProperty(target, prop) {
      if (typeof prop === 'symbol') return Reflect.deleteProperty(target, prop);
      delete target[prop];
      return true;
    },
  });
}

function makeStorage(fallbackSource) {
  if (fallbackSource && typeof fallbackSource.getItem === 'function') {
    return fallbackSource;
  }
  return createStoragePolyfill();
}

function pinStorageGlobals() {
  const ls = makeStorage(typeof window !== 'undefined' ? window.localStorage : undefined);
  const ss = makeStorage(typeof window !== 'undefined' ? window.sessionStorage : undefined);
  Object.defineProperty(globalThis, 'localStorage', {
    value: ls,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(globalThis, 'sessionStorage', {
    value: ss,
    writable: true,
    configurable: true,
  });
  if (typeof window !== 'undefined') {
    try { window.localStorage = ls; } catch {}
    try { window.sessionStorage = ss; } catch {}
  }
}

pinStorageGlobals();

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  // Some tests replace the storage globals intentionally; restore the jsdom
  // instances afterwards so subsequent tests in the same worker still see a
  // working Storage API. Then clear them to avoid cross-test data leakage.
  pinStorageGlobals();
  try {
    globalThis.localStorage?.clear();
  } catch {}
  try {
    globalThis.sessionStorage?.clear();
  } catch {}
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
