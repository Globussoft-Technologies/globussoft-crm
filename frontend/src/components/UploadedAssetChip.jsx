import { formatUploadFilename } from '../utils/uploadDisplay';

const btnStyle = {
  padding: '0.4rem 0.75rem',
  borderRadius: 6,
  border: '1px solid var(--border-color)',
  background: 'var(--bg-color)',
  color: 'var(--text-primary)',
  cursor: 'pointer',
  fontSize: '0.8rem',
  whiteSpace: 'nowrap',
};

const chipStyle = {
  flex: 1,
  minWidth: 0,
  display: 'flex',
  alignItems: 'center',
  gap: '0.4rem',
  padding: '0.4rem 0.6rem',
  border: '1px solid var(--border-color)',
  borderRadius: 6,
  background: 'var(--bg-color)',
  fontSize: '0.8rem',
  color: 'var(--text-primary)',
  overflow: 'hidden',
};

/**
 * UploadedAssetChip — shows a clean filename chip for an uploaded asset.
 *
 *   kind="document" → 📄 filename
 *   kind="image"    → thumbnail + filename
 *   kind="video"    → ▶️ filename
 *
 * Includes Replace (re-upload) and Remove buttons. The caller owns the
 * file input; onReplace should trigger its click().
 */
function UploadedAssetChip({
  url,
  kind = 'document',
  uploading = false,
  onReplace,
  onRemove,
}) {
  const displayName = formatUploadFilename(url);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
      <span title={displayName} style={chipStyle}>
        {kind === 'image' ? (
          <img
            src={url}
            alt=""
            style={{
              width: 28,
              height: 28,
              objectFit: 'cover',
              borderRadius: 4,
              flexShrink: 0,
            }}
          />
        ) : (
          <span aria-hidden="true" style={{ flexShrink: 0 }}>
            {kind === 'video' ? '▶️' : '📄'}
          </span>
        )}
        <span
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {displayName}
        </span>
      </span>
      <button
        type="button"
        onClick={onReplace}
        disabled={uploading}
        style={btnStyle}
      >
        {uploading ? '…' : 'Replace'}
      </button>
      <button
        type="button"
        onClick={onRemove}
        disabled={uploading}
        style={{ ...btnStyle, color: 'var(--text-secondary)' }}
      >
        Remove
      </button>
    </div>
  );
}

export default UploadedAssetChip;
