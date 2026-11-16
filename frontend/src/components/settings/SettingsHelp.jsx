import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Info } from "lucide-react";

export default function SettingsHelp({ label, children }) {
  const id = useId();
  const button = useRef(null);
  const tip = useRef(null);
  const leaveTimer = useRef(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });

  useLayoutEffect(() => {
    if (!open) return;
    const anchor = button.current.getBoundingClientRect();
    const bounds = tip.current.getBoundingClientRect();
    setPosition({
      left: Math.max(16, Math.min(anchor.left, window.innerWidth - bounds.width - 16)),
      top: anchor.bottom + bounds.height + 24 < window.innerHeight
        ? anchor.bottom + 8 : Math.max(16, anchor.top - bounds.height - 8),
    });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event) => {
      if (!button.current?.contains(event.target) && !tip.current?.contains(event.target)) setOpen(false);
    };
    const close = () => setOpen(false);
    const escape = (event) => { if (event.key === "Escape") close(); };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      clearTimeout(leaveTimer.current);
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [open]);

  const leave = () => {
    clearTimeout(leaveTimer.current);
    leaveTimer.current = setTimeout(() => { if (document.activeElement !== button.current) setOpen(false); }, 120);
  };

  return <>
    <button ref={button} type="button" className="gs-info" aria-label={`${label} help`} aria-expanded={open} aria-describedby={open ? id : undefined}
      onMouseEnter={() => { clearTimeout(leaveTimer.current); setOpen(true); }} onMouseLeave={leave} onFocus={() => setOpen(true)} onClick={() => setOpen(true)} onBlur={(event) => { if (!tip.current?.contains(event.relatedTarget)) setOpen(false); }}>
      <Info size={16} aria-hidden="true" />
    </button>
    {open && createPortal(<div ref={tip} id={id} role="tooltip" className="gs-tooltip" style={position} onMouseEnter={() => clearTimeout(leaveTimer.current)} onMouseLeave={leave}>{children}</div>, document.body)}
  </>;
}
