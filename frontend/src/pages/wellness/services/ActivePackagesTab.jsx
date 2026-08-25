import { useState } from 'react';
import { Package, Eye, EyeOff, Archive, RotateCcw, AlertTriangle } from 'lucide-react';
import { fetchApi } from '../../../utils/api';
import { useNotify } from '../../../utils/notify';

/**
 * Saved service packages.
 *
 * A sibling of Active Treatments — that tab lists clinical treatment plans,
 * this one lists the commercial bundles the clinic sells. They are deliberately
 * separate surfaces: treatment plans are per-patient PHI, packages are catalog
 * config.
 *
 * `isActive` = offered at all. `isPublic` = listed on the customer catalog.
 * Both are toggled here, because "built but not yet published" is the normal
 * state of a package while pricing is still being agreed.
 *
 * Read-only for customers (`readOnly`), which is how the same component backs
 * the customer-facing Packages tab without a second implementation.
 */
export default function ActivePackagesTab({ packages, loading, onChanged, readOnly = false }) {
  const notify = useNotify();
  const [busyId, setBusyId] = useState(null);

  const patch = async (pkg, body, successMessage) => {
    setBusyId(pkg.id);
    try {
      await fetchApi(`/api/wellness/packages/${pkg.id}`, {
        method: 'PUT',
        body: JSON.stringify(body),
      });
      notify.success(successMessage);
      onChanged?.();
    } catch (err) {
      notify.error(err?.message || 'Could not update the package');
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (pkg) => {
    // Retire, not delete — anything already quoted against this package must
    // keep resolving. A hard delete is a separate, deliberate action.
    if (!window.confirm(`Retire "${pkg.name}"? It stops being offered but stays on record.`)) return;
    setBusyId(pkg.id);
    try {
      await fetchApi(`/api/wellness/packages/${pkg.id}`, { method: 'DELETE' });
      notify.success(`"${pkg.name}" retired`);
      onChanged?.();
    } catch (err) {
      notify.error(err?.message || 'Could not retire the package');
    } finally {
      setBusyId(null);
    }
  };

  if (loading) {
    return <div style={{ color: 'var(--text-secondary)', padding: '2rem', textAlign: 'center' }}>Loading packages…</div>;
  }

  if (!packages.length) {
    return (
      <div className="glass" style={{ padding: '2.5rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
        <Package size={28} style={{ color: 'var(--accent-color)', marginBottom: '0.6rem' }} />
        <div style={{ fontWeight: 600, color: 'var(--text-primary)', marginBottom: '0.3rem' }}>
          {readOnly ? 'No packages available yet' : 'No packages saved yet'}
        </div>
        <div style={{ fontSize: '0.85rem' }}>
          {readOnly
            ? 'Your clinic has not published any packages. Check back soon.'
            : 'Build one on the Packages tab and save it to see it here.'}
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid="active-packages-list"
      style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 300px), 1fr))', gap: '1rem' }}
    >
      {packages.map((pkg) => {
        const busy = busyId === pkg.id;
        return (
          <div
            key={pkg.id}
            className="glass"
            data-testid={`package-card-${pkg.id}`}
            style={{
              padding: '1.1rem',
              borderRadius: 12,
              display: 'flex',
              flexDirection: 'column',
              gap: '0.5rem',
              opacity: pkg.isActive ? 1 : 0.6,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', alignItems: 'flex-start' }}>
              <div style={{ fontWeight: 600, minWidth: 0 }}>{pkg.name}</div>
              <div style={{ display: 'flex', gap: '0.25rem', flexShrink: 0 }}>
                {!pkg.isActive && <Badge tone="muted">Retired</Badge>}
                {pkg.isActive && pkg.isPublic && <Badge tone="success">Live</Badge>}
                {pkg.isActive && !pkg.isPublic && <Badge tone="warn">Draft</Badge>}
              </div>
            </div>

            {pkg.description && (
              <div style={{ fontSize: '0.82rem', color: 'var(--text-secondary)' }}>{pkg.description}</div>
            )}

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem' }}>
              {pkg.services.map((s) => (
                <span
                  key={s.id}
                  style={{
                    fontSize: '0.7rem',
                    padding: '0.15rem 0.45rem',
                    borderRadius: 999,
                    background: 'var(--subtle-bg-3)',
                    border: '1px solid var(--border-color)',
                  }}
                >
                  {s.name}
                </span>
              ))}
            </div>

            {/* The stored price is a snapshot. If a bundled service has since
                been deleted, say so rather than quietly showing a total that
                no longer adds up from the catalog. */}
            {pkg.missingServiceIds?.length > 0 && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.35rem',
                  fontSize: '0.72rem',
                  color: '#f59e0b',
                }}
              >
                <AlertTriangle size={12} />
                {pkg.missingServiceIds.length} bundled service(s) no longer in the catalog
              </div>
            )}

            <div style={{ display: 'flex', gap: '0.75rem', fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
              <span>{pkg.sessions} sessions</span>
              {pkg.discountPercent > 0 && <span>{pkg.discountPercent}% off</span>}
            </div>

            <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem', marginTop: '0.15rem' }}>
              <span style={{ fontSize: '1.3rem', fontWeight: 700, color: 'var(--accent-color)' }}>
                ₹{Math.round(pkg.price).toLocaleString('en-IN')}
              </span>
              {pkg.grossPrice > pkg.price && (
                <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', textDecoration: 'line-through' }}>
                  ₹{Math.round(pkg.grossPrice).toLocaleString('en-IN')}
                </span>
              )}
            </div>

            {!readOnly && (
              <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.5rem', flexWrap: 'wrap' }}>
                {pkg.isActive && (
                  <ActionBtn
                    disabled={busy}
                    onClick={() => patch(pkg, { isPublic: !pkg.isPublic }, pkg.isPublic ? `"${pkg.name}" hidden from customers` : `"${pkg.name}" published`)}
                    testId={`package-publish-${pkg.id}`}
                    icon={pkg.isPublic ? <EyeOff size={13} /> : <Eye size={13} />}
                  >
                    {pkg.isPublic ? 'Unpublish' : 'Publish'}
                  </ActionBtn>
                )}
                {pkg.isActive ? (
                  <ActionBtn
                    disabled={busy}
                    onClick={() => remove(pkg)}
                    testId={`package-retire-${pkg.id}`}
                    icon={<Archive size={13} />}
                  >
                    Retire
                  </ActionBtn>
                ) : (
                  <ActionBtn
                    disabled={busy}
                    onClick={() => patch(pkg, { isActive: true }, `"${pkg.name}" restored`)}
                    testId={`package-restore-${pkg.id}`}
                    icon={<RotateCcw size={13} />}
                  >
                    Restore
                  </ActionBtn>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Badge({ tone, children }) {
  const palette = {
    success: { fg: '#10b981', bg: 'rgba(16,185,129,0.12)' },
    warn: { fg: '#f59e0b', bg: 'rgba(245,158,11,0.12)' },
    muted: { fg: 'var(--text-secondary)', bg: 'var(--subtle-bg-3)' },
  }[tone];
  return (
    <span
      style={{
        fontSize: '0.65rem',
        fontWeight: 600,
        padding: '0.15rem 0.45rem',
        borderRadius: 999,
        color: palette.fg,
        background: palette.bg,
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  );
}

function ActionBtn({ children, icon, onClick, disabled, testId }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      className="btn-secondary"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.3rem',
        padding: '0.3rem 0.6rem',
        fontSize: '0.75rem',
      }}
    >
      {icon} {children}
    </button>
  );
}

