import { useRef, useState } from 'react';
import { Upload, X } from 'lucide-react';
import { useNotify } from '../../../utils/notify';
import { uploadImageFile } from './shared';

// Shared upload control — preview + replace + remove. Used by the Create
// form AND the inline edit form on each service card.
export default function ImageUploadField({ imageUrl, onChange }) {
  const notify = useNotify();
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef(null);

  const pick = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploading(true);
    try {
      const url = await uploadImageFile(file);
      onChange(url);
      notify.success('Image uploaded');
    } catch (err) {
      notify.error(err.message || 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
      <input ref={inputRef} type="file" accept="image/*" onChange={pick} style={{ display: 'none' }} />
      {imageUrl ? (
        <>
          <img src={imageUrl} alt="" style={{ width: 56, height: 56, borderRadius: 6, objectFit: 'cover', border: '1px solid rgba(255,255,255,0.1)' }} />
          <button type="button" onClick={() => inputRef.current?.click()} disabled={uploading} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', padding: '0.4rem 0.7rem', background: 'transparent', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 6, color: 'var(--text-primary)', cursor: 'pointer', fontSize: '0.8rem' }}>
            <Upload size={13} /> {uploading ? 'Uploading…' : 'Replace'}
          </button>
          <button type="button" onClick={() => onChange('')} title="Remove image" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', padding: '0.4rem 0.7rem', background: 'transparent', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 6, color: 'var(--danger-color, #ef4444)', cursor: 'pointer', fontSize: '0.8rem' }}>
            <X size={13} /> Remove
          </button>
        </>
      ) : (
        <button type="button" onClick={() => inputRef.current?.click()} disabled={uploading} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', padding: '0.5rem 0.8rem', background: 'transparent', border: '1px dashed rgba(255,255,255,0.2)', borderRadius: 6, color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '0.85rem' }}>
          <Upload size={14} /> {uploading ? 'Uploading…' : 'Upload image'}
        </button>
      )}
    </div>
  );
}
