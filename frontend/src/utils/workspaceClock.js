import { useEffect, useState } from 'react';
import { fetchApi } from './api';

export function useSchedulingClock() {
  const [sample, setSample] = useState(null);
  const [tick, setTick] = useState(() => performance.now());
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    let pending = false;
    async function sync() {
      if (pending || document.hidden) return;
      pending = true;
      const sentAt = performance.now();
      try {
        const { serverTime } = await fetchApi('/api/callified/dial-jobs/control', { silent: true, cache: 'no-store' });
        const receivedAt = performance.now();
        const timestamp = Date.parse(serverTime);
        if (!Number.isFinite(timestamp)) throw new Error('Invalid server time');
        if (active) {
          setSample({ timestamp, midpoint: (sentAt + receivedAt) / 2 });
          setTick(receivedAt);
          setFailed(false);
        }
      } catch {
        if (active) setFailed(true);
      } finally {
        pending = false;
      }
    }
    sync();
    const ticker = setInterval(() => setTick(performance.now()), 250);
    const refresh = setInterval(sync, 30_000);
    document.addEventListener('visibilitychange', sync);
    return () => {
      active = false;
      clearInterval(ticker);
      clearInterval(refresh);
      document.removeEventListener('visibilitychange', sync);
    };
  }, []);

  return {
    now: sample ? sample.timestamp + tick - sample.midpoint : null,
    getNow: () => sample ? sample.timestamp + performance.now() - sample.midpoint : null,
    failed,
  };
}

export function wallTimeParts(instant, timezone) {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  return Object.fromEntries(formatter.formatToParts(instant).map(({ type, value }) => [type, Number(value)]));
}

export function scheduleInstant(date, hour, minute, period, timezone) {
  const wall = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), hour % 12 + (period === 'PM' ? 12 : 0), minute);
  return resolveWallTime(wall, timezone);
}

function resolveWallTime(wall, timezone) {
  let instant = wall;
  for (let i = 0; i < 3; i++) {
    const { year, month, day, hour, minute } = wallTimeParts(instant, timezone);
    const represented = Date.UTC(year, month - 1, day, hour, minute);
    if (represented === wall) return new Date(instant);
    instant += wall - represented;
  }
  // A missing local hour during the spring DST change has no UTC equivalent.
  return new Date(NaN);
}


export function parseWorkspaceDateTime(value, timezone = 'UTC') {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return new Date(NaN);
  const wall = Date.parse(`${value}:00Z`);
  if (!Number.isFinite(wall) || new Date(wall).toISOString().slice(0, 16) !== value) return new Date(NaN);
  return resolveWallTime(wall, timezone);
}
