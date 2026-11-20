import { useEffect, useRef } from 'react';

// A fast pointer can cross several small checkboxes between two move events.
function crossesBox(start, end, box) {
  if (!box.width || !box.height) return false;
  let enter = 0, leave = 1;
  for (const [from, to, min, max] of [
    [start.x, end.x, box.left, box.right],
    [start.y, end.y, box.top, box.bottom],
  ]) {
    if (from === to) {
      if (from < min || from > max) return false;
      continue;
    }
    const first = (min - from) / (to - from);
    const last = (max - from) / (to - from);
    enter = Math.max(enter, Math.min(first, last));
    leave = Math.min(leave, Math.max(first, last));
  }
  return enter <= leave;
}

export function useLeadCheckboxDrag(setSelected, enabled = true) {
  const cleanup = useRef(null);
  const suppressClick = useRef(false);
  useEffect(() => () => cleanup.current?.(), []);
  useEffect(() => {
    if (!enabled) return;
    function escape(event) {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
      if (!cleanup.current && document.querySelector('[aria-modal="true"], [role="listbox"], [role="menu"]')) return;
      if (cleanup.current) {
        suppressClick.current = true;
        cleanup.current();
      }
      setSelected(current => current.length ? [] : current);
    }
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [enabled, setSelected]);

  function begin(event) {
    if (event.button !== 0 || event.isPrimary === false) return;
    cleanup.current?.();
    suppressClick.current = false;
    const first = event.currentTarget;
    const scope = first.closest('table') || first.closest('.leads-page-root--generic');
    if (!scope) return;
    const pointerId = event.pointerId;
    const selecting = !first.checked;
    const visited = new Set();
    let scroller = first.parentElement;
    while (scroller && !(scroller.scrollHeight > scroller.clientHeight &&
      /^(auto|scroll|overlay)$/.test(getComputedStyle(scroller).overflowY))) {
      scroller = scroller.parentElement;
    }
    scroller ||= document.scrollingElement;
    const header = scope.querySelector('thead');
    const origin = scroller?.scrollTop || 0;
    const boxes = Array.from(scope.querySelectorAll('[data-drag-lead]:not(:disabled)'), checkbox => ({
      id:Number(checkbox.dataset.dragLead), rect:checkbox.getBoundingClientRect(),
    }));
    const firstId = Number(first.dataset.dragLead);
    visited.add(firstId);
    let pending = [];
    let paintFrame = 0;
    let lastTime = 0;
    let remainder = 0;
    let pointer = {x:event.clientX, y:event.clientY};
    let previous = pointer;
    let frame = 0;
    function bounds() {
      const rect = scroller.getBoundingClientRect();
      const page = scroller === document.scrollingElement;
      const top = page ? 0 : Math.max(0,rect.top + scroller.clientTop);
      return {
        top: Math.max(top, header?.getBoundingClientRect().bottom || 0),
        bottom: page ? window.innerHeight : Math.min(window.innerHeight, rect.top + scroller.clientTop + scroller.clientHeight),
      };
    }
    function clamp(point, edges) {
      return {x:point.x,y:Math.max(edges.top,Math.min(edges.bottom-1,point.y))};
    }
    function paint(start, next) {
      const offset = (scroller?.scrollTop || 0) - origin;
      const from = {x:start.x, y:start.y + offset}, to = {x:next.x, y:next.y + offset};
      const top = Math.min(from.y, to.y);
      const bottom = Math.max(from.y, to.y);
      for (const {id,rect} of boxes) {
        if (rect.bottom < top || rect.top > bottom) continue;
        if (!visited.has(id) && crossesBox(from, to, rect)) {
          visited.add(id);
          if (!suppressClick.current) pending.push(firstId);
          suppressClick.current = true;
          pending.push(id);
        }
      }
      if (pending.length && !paintFrame) paintFrame = requestAnimationFrame(flush);
    }
    function flush() {
      paintFrame = 0;
      if (!pending.length) return;
      const added = pending;
      pending = [];
      setSelected(current => {
        const updated = new Set(current);
        for (const id of added) {
          if (selecting) updated.add(id); else updated.delete(id);
        }
        return updated.size === current.length ? current : [...updated];
      });
    }
    function scrollFrame(time) {
      frame = 0;
      if (!scroller || !scope.isConnected) return;
      const edges = bounds();
      const band = Math.min(56,(edges.bottom-edges.top)/3);
      if (band <= 0) return;
      const down = pointer.y - (edges.bottom-band);
      const up = edges.top + band - pointer.y;
      const strength = down > 0 ? Math.min(1,down/band) : -Math.max(0,Math.min(1,up/band));
      if (!strength) { lastTime = 0; remainder = 0; return; }
      const elapsed = lastTime ? Math.min(32,time-lastTime) : 16;
      lastTime = time;
      const before = scroller.scrollTop;
      const distance = remainder + Math.sign(strength) * strength ** 2 * 0.85 * elapsed;
      const step = Math.trunc(distance);
      remainder = distance-step;
      if (!step) { frame = requestAnimationFrame(scrollFrame); return; }
      scroller.scrollTop += step;
      const delta = scroller.scrollTop-before;
      if (!delta) { lastTime=0; remainder=0; return; }
      const end = clamp(pointer,edges);
      paint({x:previous.x,y:previous.y-delta},end);
      previous = end;
      frame = requestAnimationFrame(scrollFrame);
    }
    function move(e) {
      if (e.pointerId !== pointerId) return;
      pointer = {x:e.clientX,y:e.clientY};
      const next = scroller ? clamp(pointer,bounds()) : pointer;
      paint(previous,next);
      previous = next;
      if (scroller && !frame && e.type === 'pointermove') frame = requestAnimationFrame(scrollFrame);
    }
    function finish(e) {
      if (e.pointerId !== pointerId) return;
      if (e.type === 'pointerup') {
        move(e);
        cancelAnimationFrame(paintFrame);
        flush();
      }
      stop();
    }
    function stop() {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(paintFrame);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      window.removeEventListener('blur', stop);
      scope.classList.remove('dragging-lead-checkboxes');
      cleanup.current = null;
    }
    scope.classList.add('dragging-lead-checkboxes');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    window.addEventListener('blur', stop);
    cleanup.current = stop;
  }

  return id => ({
    'data-drag-lead': id,
    onPointerDown: begin,
    onClickCapture: event => {
      if (!suppressClick.current || !event.detail) return;
      suppressClick.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
  });
}
