// Full-screen image viewer for WhatsApp chats — click a profile picture (DP)
// or a conversation image to see it full size, like WhatsApp Web.
//
// Decoupled via a tiny module-level registry so any shared component
// (ThreadAvatar, MessageMedia) can call openImage(src) without prop-drilling
// or context wiring; the single <ImageLightbox /> mounted near the chat root
// renders the overlay. openImage is a no-op until a lightbox is mounted.
import { useEffect, useState } from 'react';

let _setSrc = null;
// eslint-disable-next-line react-refresh/only-export-components
export function openImage(src) {
  if (_setSrc && src) _setSrc(src);
}

export function ImageLightbox() {
  const [src, setSrc] = useState(null);
  useEffect(() => {
    _setSrc = setSrc;
    return () => { if (_setSrc === setSrc) _setSrc = null; };
  }, []);
  useEffect(() => {
    if (!src) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setSrc(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [src]);
  if (!src) return null;
  return (
    <div
      data-testid="wa-image-lightbox"
      onClick={() => setSrc(null)}
      style={{
        position: 'fixed', inset: 0, zIndex: 3000,
        background: 'rgba(0,0,0,0.88)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        cursor: 'zoom-out',
      }}
    >
      <img
        src={src}
        alt=""
        referrerPolicy="no-referrer"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: '92vw', maxHeight: '92vh', borderRadius: 8, cursor: 'default', objectFit: 'contain' }}
      />
      <button
        type="button"
        onClick={() => setSrc(null)}
        aria-label="Close"
        style={{
          position: 'fixed', top: 18, right: 22, fontSize: 28, lineHeight: 1,
          background: 'transparent', border: 'none', color: '#fff', cursor: 'pointer',
        }}
      >
        ×
      </button>
    </div>
  );
}
