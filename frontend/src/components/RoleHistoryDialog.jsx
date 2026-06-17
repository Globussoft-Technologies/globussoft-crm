import { useCallback, useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';

/**
 * RoleHistoryDialog — role-permission version-history popup.
 *
 * Layout strategy: bulletproof absolute-positioning.
 *
 * Earlier iterations used the shared <Modal> primitive with flex
 * column + flex-shrink: 0 on header/footer. On roles with many
 * version snapshots (Admin role: 8+ versions) the header and footer
 * vanished off-screen — almost certainly because the shared Modal's
 * body lacked `min-height: 0` on its flex child, letting the body
 * grow past the dialog's max-height cap. Even rewriting with
 * min-height: 0 + flex-shrink: 0 didn't visually surface the close
 * buttons in the user's browser.
 *
 * This version sidesteps any flex-sizing ambiguity:
 *   • Dialog container: position: relative, fixed height (60vh).
 *   • Header: position: absolute at top:0; ZERO ambiguity, can NEVER
 *     be pushed off-screen by body content.
 *   • Footer: position: absolute at bottom:0; same guarantee.
 *   • Body: position: absolute, top: <header height>, bottom:
 *     <footer height>, overflow-y: auto. The body fills the space
 *     between header and footer exactly. No flex math.
 *   • Close buttons styled to be visually unmissable — solid
 *     primary-color backgrounds, generous padding, high contrast.
 *
 * Same APIs and same testids preserved.
 */
const DIALOG_HEIGHT_VH = 60;
const HEADER_HEIGHT_PX = 56;
const FOOTER_HEIGHT_PX = 64;

export default function RoleHistoryDialog({ role, canManage, open, onClose, onRestored }) {
  const [versions, setVersions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [restoringId, setRestoringId] = useState(null);
  const notify = useNotify();

  const load = useCallback(async () => {
    if (!role || !role.id) return;
    setLoading(true);
    setError('');
    try {
      const res = await fetchApi(`/api/roles/${role.id}/permissions/versions`);
      setVersions(Array.isArray(res?.versions) ? res.versions : []);
    } catch (err) {
      setError(err.message || 'Could not load history');
    } finally {
      setLoading(false);
    }
  }, [role]);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  // ESC closes the popup.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        if (typeof onClose === 'function') onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Body scroll lock while the popup is open.
  useEffect(() => {
    if (!open) return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  const onRestore = async (version) => {
    const ok = await notify.confirm({
      title: 'Restore role permissions',
      message:
        `Restore "${role.name}" to v${version.versionNumber} (${version.permissionCount} permissions)? ` +
        `A new version row will be appended; history is not overwritten.`,
      confirmText: 'Restore',
    });
    if (!ok) return;
    setRestoringId(version.id);
    try {
      await fetchApi(`/api/roles/${role.id}/permissions/restore`, {
        method: 'POST',
        body: JSON.stringify({ versionId: version.id }),
      });
      const sourceDate = version?.changedAt
        ? new Date(version.changedAt).toLocaleString()
        : null;
      notify.success?.(
        sourceDate
          ? `Restored "${role.name}" to the version from ${sourceDate}.`
          : `Restored "${role.name}" to a previous version.`,
      );
      if (onRestored) onRestored();
    } catch (err) {
      const body = err?.body || err?.payload || err;
      if (body && body.code === 'LOCKOUT_PREVENTED') {
        notify.error?.(
          `Cannot restore — the resulting state would lock everyone out of RBAC. ${body.error || ''}`,
        );
      } else {
        notify.error?.(err.message || 'Restore failed');
      }
    } finally {
      setRestoringId(null);
    }
  };

  if (!role || !open) return null;

  return (
    <div
      role="presentation"
      onClick={onClose}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 9999,
        background: 'rgba(0, 0, 0, 0.7)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '1rem',
      }}
    >
      {/* FLOATING CLOSE BUTTON — pinned to the top-right corner of
          the VIEWPORT (not the dialog). z-index above the dialog +
          its overlay, so it's the topmost element on screen and can
          never be cropped, scrolled past, or hidden by other UI
          (the Callified telephony widget, Activate Windows
          watermark, etc.). Styled to match the dialog chrome —
          dark elevated surface with a subtle border and refined
          drop shadow — instead of a loud accent color, so it reads
          as a polished icon button consistent with the rest of the
          app's iconography. */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        aria-label="Close dialog"
        data-testid="role-history-floating-close"
        style={{
          position: 'fixed',
          top: '1.25rem',
          right: '1.25rem',
          zIndex: 10001,
          background: 'var(--bg-color, #14171c)',
          color: 'var(--text-primary)',
          border: '1px solid var(--border-color, rgba(255,255,255,0.18))',
          borderRadius: 10,
          width: 38,
          height: 38,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          boxShadow: '0 6px 20px rgba(0, 0, 0, 0.4)',
          padding: 0,
          transition: 'background 0.15s ease, border-color 0.15s ease, transform 0.1s ease',
        }}
        onMouseEnter={(e) => {
          // Subtle hover lift — fades the border to the accent
          // color so it feels interactive without being noisy.
          e.currentTarget.style.borderColor =
            'var(--primary-color, var(--accent-color, rgba(255,255,255,0.4)))';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.borderColor =
            'var(--border-color, rgba(255,255,255,0.18))';
        }}
        title="Close (Esc)"
      >
        <X size={18} strokeWidth={2} />
      </button>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="role-history-title"
        onClick={(e) => e.stopPropagation()}
        data-testid="role-history-dialog"
        style={{
          // Explicit opaque background — never inherits the theme's
          // semi-transparent --surface-color.
          background: 'var(--bg-color, #14171c)',
          color: 'var(--text-primary)',
          border: '1px solid var(--border-color, rgba(255,255,255,0.12))',
          borderRadius: 12,
          boxShadow: '0 30px 80px rgba(0, 0, 0, 0.7)',
          width: '100%',
          maxWidth: 720,
          // Fixed height — predictable layout for absolute-positioned
          // children. 60vh leaves comfortable margin even on short
          // laptop viewports (~600-700px).
          height: `${DIALOG_HEIGHT_VH}vh`,
          maxHeight: `${DIALOG_HEIGHT_VH}vh`,
          // Critical: position: relative makes this the containing
          // block for the absolutely-positioned header, body, footer.
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        {/* HEADER — absolutely positioned at the top. CANNOT be
            pushed off-screen by any body content, regardless of
            version count. Solid background, prominent close button. */}
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: `${HEADER_HEIGHT_PX}px`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0 1.1rem',
            borderBottom: '1px solid var(--border-color)',
            background: 'var(--bg-color, #14171c)',
            zIndex: 2,
            gap: '0.75rem',
          }}
        >
          <h3
            id="role-history-title"
            style={{
              margin: 0,
              fontSize: '1.05rem',
              fontWeight: 700,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              color: 'var(--text-primary)',
            }}
          >
            Role history: {role.name}
          </h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
            data-testid="role-history-header-close"
            style={{
              // Unmissable Close button — bordered + bold so it stands
              // out against the dialog chrome regardless of theme.
              background: 'var(--subtle-bg-3, rgba(255,255,255,0.08))',
              border: '1px solid var(--border-color)',
              color: 'var(--text-primary)',
              cursor: 'pointer',
              padding: '0.4rem 0.7rem',
              borderRadius: 6,
              display: 'flex',
              alignItems: 'center',
              gap: '0.35rem',
              fontSize: '0.85rem',
              fontWeight: 600,
              flexShrink: 0,
            }}
          >
            <X size={16} /> Close
          </button>
        </div>

        {/* BODY — absolutely positioned to fill the space between
            header and footer. overflow-y: auto so the version list
            scrolls inside this fixed region. The header and footer
            are physically outside this scroll, so neither can ever
            be obscured by body content. */}
        <div
          style={{
            position: 'absolute',
            top: `${HEADER_HEIGHT_PX}px`,
            bottom: `${FOOTER_HEIGHT_PX}px`,
            left: 0,
            right: 0,
            overflowY: 'auto',
            padding: '1rem 1.1rem',
            boxSizing: 'border-box',
          }}
        >
          <p
            style={{
              fontSize: '0.85rem',
              color: 'var(--text-secondary)',
              marginTop: 0,
              marginBottom: '0.85rem',
            }}
          >
            Every permission save appends a snapshot here. Restore creates a
            new version pointing at the source — history is never overwritten.
          </p>
          {loading && (
            <div style={{ padding: '1rem 0', color: 'var(--text-secondary)' }}>
              Loading history…
            </div>
          )}
          {error && !loading && (
            <div
              role="alert"
              style={{
                padding: '0.65rem 0.8rem',
                borderRadius: 8,
                background: 'rgba(239, 68, 68, 0.08)',
                border: '1px solid rgba(239, 68, 68, 0.4)',
                color: 'var(--text-primary)',
                fontSize: '0.85rem',
                marginBottom: '0.75rem',
              }}
            >
              {error}
            </div>
          )}
          {!loading && !error && versions.length === 0 && (
            <div style={{ padding: '1rem 0', color: 'var(--text-secondary)' }}>
              No history yet. The next permission save on this role becomes v1.
            </div>
          )}
          {!loading && versions.length > 0 && (
            <ul
              data-testid="permissions-history-list"
              style={{
                listStyle: 'none',
                padding: 0,
                margin: 0,
              }}
            >
              {versions.map((v) => (
                <li
                  key={v.id}
                  data-testid={`history-version-${v.versionNumber}`}
                  style={{
                    padding: '0.6rem 0.8rem',
                    marginBottom: '0.4rem',
                    borderRadius: 6,
                    border: '1px solid var(--border-color)',
                    background: v.isCurrent
                      ? 'var(--subtle-bg-3)'
                      : 'var(--subtle-bg-1)',
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: '0.7rem',
                  }}
                >
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: '0.9rem', fontWeight: 700 }}>
                      Version {v.versionNumber}
                      {v.isCurrent && (
                        <span
                          style={{
                            marginLeft: '0.4rem',
                            fontSize: '0.7rem',
                            color: 'var(--text-secondary)',
                          }}
                        >
                          (Current)
                        </span>
                      )}
                      <span
                        style={{
                          marginLeft: '0.5rem',
                          fontSize: '0.7rem',
                          color: 'var(--text-secondary)',
                        }}
                      >
                        {v.changeType}
                        {v.restoredFromVersionId
                          ? ' · restored from #' + v.restoredFromVersionId
                          : ''}
                      </span>
                    </div>
                    <div
                      style={{
                        fontSize: '0.78rem',
                        color: 'var(--text-secondary)',
                        marginTop: '0.15rem',
                      }}
                    >
                      {new Date(v.changedAt).toLocaleString()} ·{' '}
                      {v.changedBy
                        ? v.changedBy.name || v.changedBy.email
                        : 'system'}{' '}
                      · {v.permissionCount} permission
                      {v.permissionCount === 1 ? '' : 's'}
                    </div>
                    {v.note && (
                      <div
                        style={{
                          fontSize: '0.78rem',
                          color: 'var(--text-secondary)',
                          marginTop: '0.2rem',
                          fontStyle: 'italic',
                        }}
                      >
                        “{v.note}”
                      </div>
                    )}
                  </div>
                  {canManage && !v.isCurrent && (
                    <button
                      type="button"
                      className="btn-secondary"
                      style={{ fontSize: '0.78rem', padding: '0.3rem 0.6rem' }}
                      onClick={() => onRestore(v)}
                      disabled={restoringId === v.id}
                      data-testid={`restore-version-${v.versionNumber}`}
                    >
                      {restoringId === v.id ? 'Restoring…' : 'Restore'}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* FOOTER — absolutely positioned at the bottom. CANNOT be
            pushed off-screen. Visible Close button with prominent
            background. */}
        <div
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            height: `${FOOTER_HEIGHT_PX}px`,
            display: 'flex',
            justifyContent: 'flex-end',
            alignItems: 'center',
            padding: '0 1.1rem',
            borderTop: '1px solid var(--border-color)',
            background: 'var(--bg-color, #14171c)',
            zIndex: 2,
            gap: '0.5rem',
          }}
        >
          <button
            type="button"
            onClick={onClose}
            data-testid="role-history-close"
            style={{
              background: 'var(--primary-color, var(--accent-color, #3b82f6))',
              color: '#fff',
              border: 'none',
              borderRadius: 6,
              fontSize: '0.9rem',
              padding: '0.55rem 1.6rem',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
