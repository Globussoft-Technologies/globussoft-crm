/**
 * Wave 7 Agent A — Service Categories admin page (PRD Gap §10 #1).
 *
 * Hierarchical taxonomy CRUD for the new ServiceCategory model. Manager+
 * gated via App.jsx's RoleGuard wrapper. Pattern mirrors Locations.jsx —
 * inline form + list + edit-in-place + soft-toggle isActive.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Stethoscope, Plus, Pencil, Trash2, Upload, X, Search, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';

const ICON_BTN_STYLE = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 30,
  height: 30,
  background: 'transparent',
  border: '1px solid var(--border-soft, rgba(255,255,255,0.15))',
  borderRadius: 6,
  color: 'var(--text-primary)',
  cursor: 'pointer',
  transition: 'background 0.15s, border-color 0.15s',
};
const DANGER_ICON_BTN_STYLE = { ...ICON_BTN_STYLE, color: 'var(--danger-color, #ef4444)' };
const TH_STYLE = { padding: '0.6rem 0.75rem', fontWeight: 600, color: 'var(--text-secondary)', fontSize: '0.85rem' };
const TD_STYLE = { padding: '0.6rem 0.75rem', verticalAlign: 'middle' };
import { fetchApi, getAuthToken } from '../../utils/api';
import { useNotify } from '../../utils/notify';
import { usePermissions } from '../../hooks/usePermissions';
import PageHeader from '../../components/PageHeader';

const EMPTY_FORM = { name: '', parentId: '', displayOrder: 0, isActive: true, imageUrl: '' };

// Helper — POST a file to /api/wellness/upload/service-category-image and
// return the URL. Mirrors the multipart pattern used by ProductCategories
// (`file` field, `{ url }` response, same uploadImage helper on the server).
async function uploadImageFile(file) {
  const token = getAuthToken();
  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch('/api/wellness/upload/service-category-image', {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: fd,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Upload failed (${res.status})`);
  }
  const data = await res.json();
  return data.url;
}

export default function ServiceCategories() {
  const notify = useNotify();
  // Backend gates POST/PUT/DELETE on adminGate (verifyWellnessRole or
  // services.write RBAC). Fail closed until perms resolve so buttons
  // don't flash visible during the initial fetch.
  const { hasPermission, isReady: permsReady } = usePermissions();
  const canManageServices = permsReady && hasPermission('services', 'write');
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef(null);

  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [isCustomPageSize, setIsCustomPageSize] = useState(false);
  const [customPageSize, setCustomPageSize] = useState('');

  const filtered = useMemo(() => {
    const trimmed = q.trim().toLowerCase();
    if (!trimmed) return categories;
    return categories.filter((c) => {
      const parent = categories.find((p) => p.id === c.parentId);
      return (
        (c.name || '').toLowerCase().includes(trimmed) ||
        (parent?.name || '').toLowerCase().includes(trimmed)
      );
    });
  }, [categories, q]);

  useEffect(() => { setPage(1); }, [q, pageSize]);

  const total = filtered.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, pageCount);
  const pageStart = (safePage - 1) * pageSize;
  const pageRows = filtered.slice(pageStart, pageStart + pageSize);

  const onPickImage = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-picking the same file later
    if (!file) return;
    setUploading(true);
    try {
      const url = await uploadImageFile(file);
      setForm((f) => ({ ...f, imageUrl: url }));
      notify.success('Image uploaded');
    } catch (err) {
      notify.error(err.message || 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  const load = () => {
    setLoading(true);
    fetchApi('/api/wellness/service-categories')
      .then((rows) => setCategories(Array.isArray(rows) ? rows : []))
      .catch(() => setCategories([]))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const resetForm = () => {
    setForm(EMPTY_FORM);
    setEditingId(null);
    setShowAdd(false);
  };

  const startEdit = (cat) => {
    setEditingId(cat.id);
    setForm({
      name: cat.name || '',
      parentId: cat.parentId || '',
      displayOrder: cat.displayOrder || 0,
      isActive: cat.isActive !== false,
      imageUrl: cat.imageUrl || '',
    });
    setShowAdd(true);
  };

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const payload = {
        name: form.name,
        parentId: form.parentId ? parseInt(form.parentId) : null,
        displayOrder: form.displayOrder ? parseInt(form.displayOrder) : 0,
        isActive: form.isActive,
        imageUrl: form.imageUrl || null,
      };
      if (editingId) {
        await fetchApi(`/api/wellness/service-categories/${editingId}`, { method: 'PUT', body: JSON.stringify(payload) });
        notify.success(`Updated "${form.name}"`);
      } else {
        await fetchApi('/api/wellness/service-categories', { method: 'POST', body: JSON.stringify(payload) });
        notify.success(`Created "${form.name}"`);
      }
      resetForm();
      load();
    } catch (_err) { /* fetchApi toasts the server message */ }
    setSaving(false);
  };

  const remove = async (cat) => {
    const ok = await notify.confirm({
      title: 'Delete service category',
      message: `Delete "${cat.name}"? Services in this category will keep working but lose the link.`,
      confirmText: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    try {
      await fetchApi(`/api/wellness/service-categories/${cat.id}`, { method: 'DELETE' });
      notify.success(`Deleted "${cat.name}"`);
      load();
    } catch (_err) { /* fetchApi toasts */ }
  };

  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.5s ease-out' }}>
      <PageHeader
        icon={Stethoscope}
        title="Service categories"
        description={`${q.trim() ? `${filtered.length} of ${categories.length}` : categories.length} categor${(q.trim() ? filtered.length : categories.length) === 1 ? 'y' : 'ies'} — hierarchical taxonomy for the service catalogue.`}
        inlineBadge={permsReady && !canManageServices ? (
          <span
            title="You can view categories but can't make changes."
            style={{ fontSize: '0.7rem', padding: '0.2rem 0.55rem', borderRadius: 999, background: 'var(--subtle-bg)', color: 'var(--text-secondary)', border: '1px solid var(--border-color)', fontWeight: 500 }}
          >
            View only
          </span>
        ) : null}
      >
        {canManageServices && (
          <button onClick={() => (showAdd ? resetForm() : setShowAdd(true))} style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', padding: '0.5rem 1rem', background: 'var(--primary-color, var(--accent-color))', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' }}>
            <Plus size={16} /> {showAdd ? 'Cancel' : 'New category'}
          </button>
        )}
      </PageHeader>

      {showAdd && canManageServices && (
        <form onSubmit={submit} style={{ background: 'var(--bg-elev)', padding: '1rem', borderRadius: 8, marginBottom: '1.5rem', display: 'grid', gap: '0.75rem', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))' }}>
          <input required placeholder="Name (e.g. Hair Restoration)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <select value={form.parentId || ''} onChange={(e) => setForm({ ...form, parentId: e.target.value })}>
            <option value="">— No parent (root)</option>
            {categories.filter((c) => c.id !== editingId).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <input type="number" placeholder="Display order" value={form.displayOrder} onChange={(e) => setForm({ ...form, displayOrder: e.target.value })} />
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <input type="checkbox" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} />
            Active
          </label>
          <div style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.5rem 0' }}>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={onPickImage}
              style={{ display: 'none' }}
            />
            {form.imageUrl ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <img src={form.imageUrl} alt="" style={{ width: 56, height: 56, borderRadius: 6, objectFit: 'cover', border: '1px solid var(--border-soft, rgba(255,255,255,0.1))' }} />
                <button type="button" onClick={() => fileInputRef.current?.click()} disabled={uploading} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', padding: '0.4rem 0.7rem', background: 'transparent', border: '1px solid var(--border-soft, rgba(255,255,255,0.15))', borderRadius: 6, color: 'var(--text-primary)', cursor: 'pointer', fontSize: '0.8rem' }}>
                  <Upload size={13} /> {uploading ? 'Uploading…' : 'Replace'}
                </button>
                <button type="button" onClick={() => setForm({ ...form, imageUrl: '' })} title="Remove image" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', padding: '0.4rem 0.7rem', background: 'transparent', border: '1px solid var(--border-soft, rgba(255,255,255,0.15))', borderRadius: 6, color: 'var(--danger-color, #ef4444)', cursor: 'pointer', fontSize: '0.8rem' }}>
                  <X size={13} /> Remove
                </button>
              </div>
            ) : (
              <button type="button" onClick={() => fileInputRef.current?.click()} disabled={uploading} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', padding: '0.5rem 0.8rem', background: 'transparent', border: '1px dashed var(--border-soft, rgba(255,255,255,0.2))', borderRadius: 6, color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '0.85rem' }}>
                <Upload size={14} /> {uploading ? 'Uploading…' : 'Upload image'}
              </button>
            )}
          </div>
          <button type="submit" disabled={saving || uploading} style={{ gridColumn: '1 / -1', padding: '0.6rem', background: 'var(--primary-color, var(--accent-color))', color: '#fff', border: 'none', borderRadius: 6 }}>
            {saving ? 'Saving…' : editingId ? 'Save changes' : 'Create category'}
          </button>
        </form>
      )}

      <div style={{ display: 'flex', gap: '0.6rem', marginBottom: '1rem', alignItems: 'stretch', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 260, position: 'relative', display: 'flex' }}>
          <Search
            size={16}
            color="var(--text-secondary)"
            style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', flexShrink: 0 }}
            aria-hidden
          />
          <input
            placeholder="Search by name or parent…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            style={{
              width: '100%',
              padding: q ? '0.65rem 2.5rem 0.65rem 2.4rem' : '0.65rem 0.85rem 0.65rem 2.4rem',
              borderRadius: 10,
              fontSize: '0.92rem',
              fontFamily: 'inherit',
              background: 'var(--surface-color, #fff)',
              border: '1px solid var(--border-color, rgba(0,0,0,0.12))',
              color: 'var(--text-primary)',
              outline: 'none',
              boxSizing: 'border-box',
            }}
          />
          {q && (
            <button
              type="button"
              onClick={() => setQ('')}
              title="Clear search"
              aria-label="Clear search"
              style={{
                position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
                background: 'var(--subtle-bg, rgba(0,0,0,0.06))', border: 'none', borderRadius: 999,
                color: 'var(--text-secondary)', cursor: 'pointer', padding: '0.2rem',
                display: 'inline-flex', alignItems: 'center', lineHeight: 1,
              }}
            >
              <X size={12} />
            </button>
          )}
        </div>
      </div>

      {loading ? (
        <p>Loading categories…</p>
      ) : categories.length === 0 ? (
        <p style={{ color: 'var(--text-secondary)' }}>No categories yet — create one to start grouping services.</p>
      ) : filtered.length === 0 ? (
        <p style={{ color: 'var(--text-secondary)' }}>No categories match “{q}”.</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border-soft)' }}>
              <th style={TH_STYLE}>Image</th>
              <th style={TH_STYLE}>Name</th>
              <th style={TH_STYLE}>Parent</th>
              <th style={TH_STYLE}>Order</th>
              <th style={TH_STYLE}>Services</th>
              <th style={TH_STYLE}>Status</th>
              {canManageServices && <th style={{ ...TH_STYLE, textAlign: 'right' }}>Actions</th>}
            </tr>
          </thead>
          <tbody>
            {pageRows.map((c) => {
              const parent = categories.find((p) => p.id === c.parentId);
              return (
                <tr key={c.id} style={{ borderTop: '1px solid var(--border-soft)' }}>
                  <td style={TD_STYLE}>
                    {c.imageUrl
                      ? <img src={c.imageUrl} alt="" style={{ width: 40, height: 40, borderRadius: 4, objectFit: 'cover' }} />
                      : <div style={{ width: 40, height: 40, borderRadius: 4, background: 'rgba(255,255,255,0.05)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)', fontSize: '0.7rem' }}>—</div>}
                  </td>
                  <td style={TD_STYLE}>{c.name}</td>
                  <td style={TD_STYLE}>{parent ? parent.name : '—'}</td>
                  <td style={TD_STYLE}>{c.displayOrder}</td>
                  <td style={TD_STYLE}>{c._count ? c._count.services : 0}</td>
                  <td style={TD_STYLE}>
                    <span style={{
                      display: 'inline-block',
                      padding: '0.2rem 0.6rem',
                      borderRadius: 999,
                      fontSize: '0.78rem',
                      fontWeight: 500,
                      background: c.isActive ? 'rgba(34, 197, 94, 0.12)' : 'rgba(148, 163, 184, 0.15)',
                      color: c.isActive ? '#22c55e' : 'var(--text-secondary)',
                    }}>
                      {c.isActive ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  {canManageServices && (
                    <td style={{ ...TD_STYLE, textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <div style={{ display: 'inline-flex', gap: '0.4rem' }}>
                        <button onClick={() => startEdit(c)} title="Edit" aria-label={`Edit ${c.name}`} style={ICON_BTN_STYLE}>
                          <Pencil size={14} />
                        </button>
                        <button onClick={() => remove(c)} title="Delete" aria-label={`Delete ${c.name}`} style={DANGER_ICON_BTN_STYLE}>
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {!loading && filtered.length > 0 && (
        <Pager
          total={total}
          page={safePage}
          pageSize={pageSize}
          onPageChange={setPage}
          onPageSizeChange={setPageSize}
          isCustomPageSize={isCustomPageSize}
          setIsCustomPageSize={setIsCustomPageSize}
          customPageSize={customPageSize}
          setCustomPageSize={setCustomPageSize}
        />
      )}
    </div>
  );
}

const DROPDOWN_MENU_STYLE = {
  position: 'absolute',
  minWidth: 110,
  background: 'var(--bg-color, #fff)',
  border: '1px solid var(--border-color, rgba(0,0,0,0.18))',
  borderRadius: 8,
  boxShadow: 'var(--shadow-lg, 0 12px 32px rgba(0,0,0,0.25))',
  padding: '0.25rem',
  zIndex: 100,
  display: 'flex',
  flexDirection: 'column',
};
const DROPDOWN_ITEM_STYLE = {
  textAlign: 'left',
  padding: '0.5rem 0.75rem',
  background: 'transparent',
  color: 'var(--text-primary, inherit)',
  border: 'none',
  borderRadius: 6,
  cursor: 'pointer',
  fontSize: '0.85rem',
};

function Pager({ total, page, pageSize, onPageChange, onPageSizeChange, isCustomPageSize, setIsCustomPageSize, customPageSize, setCustomPageSize }) {
  const pageCount = Math.max(1, Math.ceil((total || 0) / pageSize));
  const safePage = Math.min(page, pageCount);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);
  const [hovered, setHovered] = useState(null);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const onDocClick = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [menuOpen]);

  const pages = useMemo(() => {
    const out = new Set([1, pageCount, safePage]);
    for (let i = Math.max(2, safePage - 2); i <= Math.min(pageCount - 1, safePage + 2); i++) out.add(i);
    const sorted = Array.from(out).sort((a, b) => a - b);
    const withGaps = [];
    sorted.forEach((p, i) => {
      if (i > 0 && p - sorted[i - 1] > 1) withGaps.push('…');
      withGaps.push(p);
    });
    return withGaps;
  }, [pageCount, safePage]);

  if (total === 0) return null;
  const start = (safePage - 1) * pageSize + 1;
  const end = Math.min(start + pageSize - 1, total);

  const pillBtn = (active, disabled) => ({
    minWidth: 32, height: 32, padding: '0 0.5rem',
    background: active ? 'var(--primary-color, var(--accent-color))' : 'transparent',
    color: active ? '#fff' : 'var(--text-primary)',
    border: '1px solid var(--border-color, rgba(255,255,255,0.18))',
    borderRadius: 6, cursor: disabled ? 'not-allowed' : 'pointer',
    fontSize: '0.85rem', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    opacity: disabled ? 0.4 : 1,
  });

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', alignItems: 'center', justifyContent: 'space-between', padding: '0.85rem 1rem', borderTop: '1px solid var(--border-color, rgba(255,255,255,0.08))', fontSize: '0.85rem' }}>
      <div style={{ color: 'var(--text-secondary)' }}>
        Showing <strong style={{ color: 'var(--text-primary)' }}>{start}–{end}</strong> of <strong style={{ color: 'var(--text-primary)' }}>{total}</strong> categories
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }}>
        <label style={{ color: 'var(--text-secondary)', display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
          Per page:
          {isCustomPageSize ? (
            <>
              <input
                type="number"
                min="1"
                max="200"
                value={customPageSize}
                onChange={(e) => {
                  const raw = parseInt(e.target.value, 10);
                  const val = Number.isFinite(raw) ? Math.min(Math.max(raw, 1), 200) : '';
                  setCustomPageSize(val);
                  if (val) onPageSizeChange(val);
                }}
                placeholder="1-200"
                autoFocus
                title="Enter a number between 1 and 200"
                style={{ width: 80, padding: '0.3rem 0.5rem', borderRadius: 6, border: '1px solid var(--border-color, rgba(255,255,255,0.18))', background: 'var(--surface-color, rgba(255,255,255,0.04))', color: 'var(--text-primary)' }}
              />
              <button
                type="button"
                onClick={() => { setIsCustomPageSize(false); setCustomPageSize(''); }}
                style={{ padding: '0.3rem 0.55rem', borderRadius: 6, border: '1px solid var(--border-color, rgba(255,255,255,0.18))', background: 'var(--surface-color, rgba(255,255,255,0.04))', color: 'var(--text-primary)', cursor: 'pointer', fontSize: '0.85rem' }}
              >
                Back
              </button>
            </>
          ) : (
            <div ref={menuRef} style={{ position: 'relative' }}>
              <button
                type="button"
                onClick={() => setMenuOpen((v) => !v)}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: '0.4rem',
                  padding: '0.3rem 0.55rem', borderRadius: 6,
                  border: '1px solid var(--border-color, rgba(255,255,255,0.18))',
                  background: 'var(--surface-color, rgba(255,255,255,0.04))',
                  color: 'var(--text-primary)', fontSize: '0.85rem',
                  cursor: 'pointer', minWidth: 70,
                }}
              >
                <span>{[10, 20, 50].includes(pageSize) ? pageSize : 'Custom'}</span>
                <ChevronDown size={12} style={{ opacity: 0.7 }} />
              </button>
              {menuOpen && (
                <div
                  role="menu"
                  style={{ ...DROPDOWN_MENU_STYLE, top: 'auto', bottom: 'calc(100% + 4px)', right: 'auto', left: 0 }}
                >
                  {[10, 20, 50].map((n) => {
                    const active = pageSize === n;
                    const isHovered = hovered === String(n);
                    return (
                      <button
                        key={n}
                        type="button"
                        role="menuitem"
                        onClick={() => { onPageSizeChange(n); setMenuOpen(false); }}
                        onMouseEnter={() => setHovered(String(n))}
                        onMouseLeave={() => setHovered(null)}
                        style={{
                          ...DROPDOWN_ITEM_STYLE,
                          background: active
                            ? 'var(--primary-color, var(--accent-color))'
                            : isHovered
                              ? 'var(--surface-color, rgba(255,255,255,0.06))'
                              : 'transparent',
                          color: active ? '#fff' : 'var(--text-primary, inherit)',
                        }}
                      >
                        {n}
                      </button>
                    );
                  })}
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => { setIsCustomPageSize(true); setCustomPageSize(''); setMenuOpen(false); }}
                    onMouseEnter={() => setHovered('custom')}
                    onMouseLeave={() => setHovered(null)}
                    style={{
                      ...DROPDOWN_ITEM_STYLE,
                      background: hovered === 'custom'
                        ? 'var(--surface-color, rgba(255,255,255,0.06))'
                        : 'transparent',
                    }}
                  >
                    Custom
                  </button>
                </div>
              )}
            </div>
          )}
        </label>
        <button
          type="button"
          onClick={() => onPageChange(safePage - 1)}
          disabled={safePage <= 1}
          aria-label="Previous page"
          style={pillBtn(false, safePage <= 1)}
        >
          <ChevronLeft size={14} />
        </button>
        {pages.map((p, i) => (
          p === '…'
            ? <span key={`gap-${i}`} style={{ color: 'var(--text-secondary)', padding: '0 0.2rem' }}>…</span>
            : <button
                key={p}
                type="button"
                onClick={() => onPageChange(p)}
                aria-current={p === safePage ? 'page' : undefined}
                style={pillBtn(p === safePage, false)}
              >
                {p}
              </button>
        ))}
        <button
          type="button"
          onClick={() => onPageChange(safePage + 1)}
          disabled={safePage >= pageCount}
          aria-label="Next page"
          style={pillBtn(false, safePage >= pageCount)}
        >
          <ChevronRight size={14} />
        </button>
      </div>
    </div>
  );
}
