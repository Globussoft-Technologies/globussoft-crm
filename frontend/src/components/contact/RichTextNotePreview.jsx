import { useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { RichText, truncateRichTextHtml } from '../../utils/richText';

export default function RichTextNotePreview({ value }) {
  const [open, setOpen] = useState(false);
  const preview = useMemo(() => truncateRichTextHtml(value, 50), [value]);

  if (!preview.truncated) return <RichText value={value} />;

  return (
    <>
      <div className="cp-generic-note-preview">
        <RichText value={preview.html} />
        <button type="button" className="cp-note-extend" onClick={() => setOpen(true)}>View full note</button>
      </div>
      {open && (
        <div className="cp-overlay cp-generic-note-overlay" onClick={() => setOpen(false)} role="dialog" aria-modal="true" aria-label="Full note">
          <div className="cp-modal cp-modal-wide" onClick={(event) => event.stopPropagation()}>
            <div className="cp-modal-head">
              <h3>Full note</h3>
              <button type="button" className="cp-icon-btn" onClick={() => setOpen(false)} aria-label="Close"><X size={16} /></button>
            </div>
            <div className="cp-modal-body cp-generic-note-full"><RichText value={value} /></div>
          </div>
        </div>
      )}
    </>
  );
}
