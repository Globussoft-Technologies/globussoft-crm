import { useContext, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { createPortal } from 'react-dom';
import { IndianRupee, Clock, MapPin, Activity, Pencil, Trash2, CalendarPlus } from 'lucide-react';
import { useScrollLock } from '../../../hooks/useScrollLock';
import { AuthContext } from '../../../App';
import { fetchApi } from '../../../utils/api';
import { useNotify } from '../../../utils/notify';
import { usePermissions } from '../../../hooks/usePermissions';
import { formatMoney } from '../../../utils/money';
import { formatDate } from '../../../utils/date';
import { allImagesOf, tierColor } from './shared';

function DetailStat({ icon, label, value }) {
  return (
    <div style={{ background: 'rgba(255,255,255,0.04)', padding: '0.65rem 0.8rem', borderRadius: 8 }}>
      <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'flex', alignItems: 'center', gap: '0.3rem', marginBottom: '0.2rem' }}>
        {icon} {label}
      </div>
      <div style={{ fontSize: '0.95rem', fontWeight: 600, color: 'var(--text-primary)' }}>{value}</div>
    </div>
  );
}

export default function ServiceDetailModal({ service, categories, onClose, onChanged, onEdit }) {
  const notify = useNotify();
  const navigate = useNavigate();
  const { user } = useContext(AuthContext) || {};
  const { hasPermission, isReady: permsReady, userType } = usePermissions();
  const canManageServices = permsReady && hasPermission('services', 'write');
  // USER / CUSTOMER roles get a customer-facing view: the internal "marketing
  // radius" metric is hidden and a "Book service" CTA is shown instead. Admin
  // / Manager keep the full management view untouched.
  const isUserOrCustomer = userType === 'CUSTOMER' || user?.role === 'USER';

  const bookService = () => {
    onClose && onClose();
    navigate(`/wellness/book-appointment?serviceId=${service.id}`);
  };
  const images = allImagesOf(service);
  const [activeIdx, setActiveIdx] = useState(0);
  const [deleting, setDeleting] = useState(false);
  const activeImage = images[Math.min(activeIdx, images.length - 1)];
  const categoryName = (() => {
    const cat = (categories || []).find((c) => c.id === service.categoryId);
    return cat?.name || service.category || '—';
  })();

  const handleDelete = async () => {
    if (deleting) return;
    if (!await notify.confirm({ message: `Deactivate "${service.name}"? It won't show in the catalog or booking page.`, destructive: true, confirmText: 'Deactivate' })) return;
    setDeleting(true);
    try {
      await fetchApi(`/api/wellness/services/${service.id}`, {
        method: 'PUT',
        body: JSON.stringify({ isActive: false }),
      });
      notify.success(`Deactivated "${service.name}"`);
      onChanged && onChanged();
      onClose && onClose();
    } catch (_err) { /* fetchApi already surfaced the message */ }
    setDeleting(false);
  };

  // Close on Escape + lock page scroll so the modal is the focus point.
  // A previous version rendered the backdrop inline and a Layout-level
  // transform/animation ancestor was making `position: fixed` resolve
  // relative to the page content instead of the viewport — i.e. the modal
  // would float somewhere near the top of the document and look invisible
  // when the user had scrolled down. Rendering through a portal into
  // document.body bypasses every ancestor containing-block, so `fixed`
  // means "the viewport" and the centered modal lands where the user
  // expects it.
  useScrollLock(true);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal((
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '1rem' }}
      onClick={onClose}
    >
      <div className="glass" style={{ maxWidth: 720, width: '100%', maxHeight: '90vh', overflow: 'auto', padding: '1.75rem', position: 'relative' }} onClick={(e) => e.stopPropagation()}>
        <button onClick={onClose} aria-label="Close" style={{ position: 'absolute', top: '0.75rem', right: '0.75rem', background: 'transparent', border: 'none', fontSize: '1.4rem', cursor: 'pointer', color: 'var(--text-secondary)', lineHeight: 1 }}>×</button>

        {/* Image gallery — main image + thumbnail strip. If no images are
            attached we render a neutral placeholder rather than empty space. */}
        {images.length > 0 ? (
          <div style={{ marginBottom: '1.25rem' }}>
            <img
              src={activeImage}
              alt={service.name}
              style={{ width: '100%', maxHeight: 320, objectFit: 'cover', borderRadius: 10, background: 'rgba(255,255,255,0.04)' }}
              onError={(e) => { e.currentTarget.style.display = 'none'; }}
            />
            {images.length > 1 && (
              <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.6rem', flexWrap: 'wrap' }}>
                {images.map((url, i) => (
                  <button
                    key={`${url}-${i}`}
                    type="button"
                    onClick={() => setActiveIdx(i)}
                    aria-label={`Show image ${i + 1}`}
                    style={{
                      padding: 0,
                      width: 60, height: 60,
                      borderRadius: 6,
                      overflow: 'hidden',
                      border: i === activeIdx ? '2px solid var(--accent-color)' : '2px solid transparent',
                      background: 'transparent',
                      cursor: 'pointer',
                    }}
                  >
                    <img src={url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div style={{ marginBottom: '1.25rem', padding: '2rem', textAlign: 'center', background: 'rgba(255,255,255,0.04)', borderRadius: 10, color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
            No images attached to this service.
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', gap: '1rem', marginBottom: '0.75rem' }}>
          <div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              {categoryName}
            </div>
            <h2 style={{ fontSize: '1.5rem', fontWeight: 700, marginTop: '0.2rem' }}>{service.name}</h2>
          </div>
          <span style={{ background: tierColor[service.ticketTier] || tierColor.medium, color: '#fff', padding: '0.25rem 0.65rem', borderRadius: 6, fontSize: '0.7rem', textTransform: 'uppercase', fontWeight: 700, whiteSpace: 'nowrap', flexShrink: 0 }}>
            {service.ticketTier}
          </span>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 160px), 1fr))', gap: '0.75rem', marginBottom: '1rem' }}>
          <DetailStat icon={<IndianRupee size={14} />} label="Base price" value={service.basePrice != null ? formatMoney(service.basePrice, { maximumFractionDigits: 0 }) : '—'} />
          <DetailStat icon={<Clock size={14} />} label="Duration" value={service.durationMin ? `${service.durationMin} min` : '—'} />
          {/* Marketing radius is an internal metric — hidden for USER/CUSTOMER. */}
          {!isUserOrCustomer && (
            <DetailStat icon={<MapPin size={14} />} label="Marketing radius" value={service.targetRadiusKm ? `${service.targetRadiusKm} km` : 'Unlimited'} />
          )}
          <DetailStat icon={<Activity size={14} />} label="Status" value={service.isActive !== false ? 'Active' : 'Inactive'} />
        </div>

        {service.description && (
          <div style={{ marginBottom: '1rem' }}>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.3rem' }}>Description</div>
            <p style={{ fontSize: '0.9rem', lineHeight: 1.5, color: 'var(--text-primary)', margin: 0 }}>{service.description}</p>
          </div>
        )}

        {isUserOrCustomer && service.isActive !== false && (
          <div style={{ marginBottom: '0.75rem' }}>
            <button
              type="button"
              onClick={bookService}
              style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', padding: '0.65rem 1.25rem', background: 'var(--primary-color, var(--accent-color))', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: '0.9rem' }}
            >
              <CalendarPlus size={16} /> Book service
            </button>
          </div>
        )}

        {canManageServices && (
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '0.75rem' }}>
            <button
              type="button"
              onClick={() => onEdit && onEdit(service)}
              disabled={!onEdit}
              style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', padding: '0.55rem 1rem', background: 'var(--primary-color, var(--accent-color))', color: '#fff', border: 'none', borderRadius: 8, cursor: onEdit ? 'pointer' : 'not-allowed', fontWeight: 600, fontSize: '0.85rem' }}
            >
              <Pencil size={14} /> Edit
            </button>
            <button
              type="button"
              onClick={handleDelete}
              disabled={deleting}
              style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', padding: '0.55rem 1rem', background: 'rgba(239,68,68,0.15)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.35)', borderRadius: 8, cursor: deleting ? 'wait' : 'pointer', fontWeight: 600, fontSize: '0.85rem' }}
            >
              <Trash2 size={14} /> {deleting ? 'Deactivating…' : 'Deactivate'}
            </button>
          </div>
        )}

        <div style={{ borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: '0.75rem', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
          Service ID: {service.id} {service.createdAt && <> · Added {formatDate(service.createdAt)}</>}
        </div>
      </div>
    </div>
  ), document.body);
}
