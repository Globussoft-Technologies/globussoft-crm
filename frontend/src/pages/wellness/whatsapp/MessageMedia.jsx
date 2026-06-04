

// Render an inline preview for media messages. The backend (cron/
// whatsappMediaEngine.js) downloads Meta media → uploads to S3 →
// stores the S3 URL on WhatsAppMessage.mediaUrl. Until the cron
// processes the job, mediaUrl is `meta:<id>` (placeholder); we
// show "Loading media…" for those.
export default function MessageMedia({ message }) {
  const url = message.mediaUrl || '';
  const type = (message.mediaType || message.metaType || '').toLowerCase();
  if (url.startsWith('meta:')) {
    return <em style={{ opacity: 0.6, fontSize: '0.8rem' }}>Loading media…</em>;
  }
  if (!url) return <em style={{ opacity: 0.6 }}>(media)</em>;
  if (type.startsWith('image')) {
    return (
      <a href={url} target="_blank" rel="noreferrer">
        <img
          src={url}
          alt="media"
          style={{ maxWidth: '100%', maxHeight: 300, borderRadius: 8, display: 'block' }}
        />
      </a>
    );
  }
  if (type.startsWith('video')) {
    return (
      <video controls preload="metadata" style={{ maxWidth: '100%', maxHeight: 320, borderRadius: 8 }}>
        <source src={url} type={message.mediaType || undefined} />
        Your browser cannot play this video. <a href={url} target="_blank" rel="noreferrer">Download</a>
      </video>
    );
  }
  if (type.startsWith('audio') || type === 'voice') {
    return (
      <audio controls preload="metadata" style={{ maxWidth: '100%' }}>
        <source src={url} type={message.mediaType || undefined} />
        Your browser cannot play this audio. <a href={url} target="_blank" rel="noreferrer">Download</a>
      </audio>
    );
  }
  // Document / generic — download link
  const filename = url.split('/').pop() || 'attachment';
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: '0.4rem 0.6rem', borderRadius: 6,
        background: 'var(--surface-color)',
        color: 'var(--text-primary)',
        textDecoration: 'none',
        fontSize: '0.82rem',
      }}
    >
      📎 {filename}
    </a>
  );
}
