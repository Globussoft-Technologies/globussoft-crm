import { useEffect, useRef, useState } from 'react';
import { fetchApi } from '../../utils/api';

/**
 * Generic "fetch JSON once on mount" hook for widgets. Returns
 * { data, loading, error, refresh }. fetchApi already handles auth
 * + 401 redirect; we just wrap it for state + cleanup.
 *
 * Pass `silent: true` so a failing widget doesn't pop a global toast
 * — the widget itself surfaces the error inline.
 */
export function useWidgetData(path, deps = []) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const mounted = useRef(true);
  const tick = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!path) {
      setLoading(false);
      return;
    }
    const myTick = ++tick.current;
    setLoading(true);
    setError(null);
    fetchApi(path, { silent: true })
      .then((res) => {
        if (!mounted.current || myTick !== tick.current) return;
        setData(res);
        setLoading(false);
      })
      .catch((err) => {
        if (!mounted.current || myTick !== tick.current) return;
        setError(err?.message || 'Failed to load');
        setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  const refresh = () => {
    tick.current++;
    if (!path) return;
    setLoading(true);
    fetchApi(path, { silent: true })
      .then((res) => {
        if (!mounted.current) return;
        setData(res);
        setLoading(false);
      })
      .catch((err) => {
        if (!mounted.current) return;
        setError(err?.message || 'Failed to load');
        setLoading(false);
      });
  };

  return { data, loading, error, refresh };
}

/**
 * Helper: compute "today" as a YYYY-MM-DD string in the local timezone.
 * Widgets that filter to today's data use this so the query string is
 * deterministic per page-render.
 */
export function todayLocalISODate() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Helper: build start-of-day / end-of-day ISO timestamps for "today" in
 * the viewer's local timezone (encoded with the local offset so the
 * backend's `new Date(from)` parses correctly regardless of server TZ).
 * Returns `{ dateStr, from, to }`. Mirrors the wellness Calendar page's
 * pattern (frontend/src/pages/wellness/Calendar.jsx) which was IST-
 * hardcoded — this one is portable.
 */
export function todayLocalDayWindow() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  // getTimezoneOffset returns minutes WEST of UTC, so flip the sign to
  // get the conventional ±HH:MM offset (positive = east of UTC).
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const absOff = Math.abs(off);
  const offHH = String(Math.floor(absOff / 60)).padStart(2, '0');
  const offMM = String(absOff % 60).padStart(2, '0');
  const tz = `${sign}${offHH}:${offMM}`;
  const dateStr = `${yyyy}-${mm}-${dd}`;
  return {
    dateStr,
    from: `${dateStr}T00:00:00${tz}`,
    to: `${dateStr}T23:59:59${tz}`,
  };
}
