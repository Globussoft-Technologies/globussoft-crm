import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { RichText, sanitizeRichTextHtml } from '../../utils/richText';

export default function RichTextNotePreview({ value }) {
  const [open, setOpen] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const previewRef = useRef(null);
  const safeHtml = useMemo(() => sanitizeRichTextHtml(value), [value]);
  const hasImage = /<img\b/i.test(safeHtml);

  useLayoutEffect(() => {
    const preview = previewRef.current;
    if (!preview) return undefined;
    const measure = () => setOverflowing(
      hasImage
        || preview.scrollHeight > preview.clientHeight + 1
        || preview.scrollWidth > preview.clientWidth + 1,
    );
    measure();
    const observer = typeof ResizeObserver === 'function'
      ? new ResizeObserver(measure)
      : null;
    observer?.observe(preview);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [hasImage, safeHtml]);

  return (
    <>
      <div className="cp-generic-note-preview">
        <div
          ref={previewRef}
          className={`cp-generic-note-content${hasImage ? ' cp-generic-note-content--image' : ''}`}
        >
          <RichText value={value} />
        </div>
        {overflowing && <button type="button" className="cp-note-extend" onClick={() => setOpen(true)}>View details</button>}
      </div>
      {open && (
        <div className="cp-overlay cp-generic-note-overlay" onClick={() => setOpen(false)} role="dialog" aria-modal="true" aria-label="Full note">
          <div className="cp-modal cp-modal-wide" onClick={(event) => event.stopPropagation()}>
            <div className="cp-modal-head">
              <h3>Note details</h3>
              <button type="button" className="cp-icon-btn" onClick={() => setOpen(false)} aria-label="Close"><X size={16} /></button>
            </div>
            <div className="cp-modal-body cp-generic-note-full"><RichText value={value} /></div>
          </div>
        </div>
      )}
    </>
  );
}
