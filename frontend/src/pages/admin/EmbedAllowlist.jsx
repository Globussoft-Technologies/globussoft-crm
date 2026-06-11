/**
 * EmbedAllowlist.jsx — ADMIN-only operator UI for setting per-tenant
 * iframe-embed origin allowlists (S128).
 *
 * Consumes backend/routes/admin.js GET + PATCH /api/admin/tenants/:id/embed-allowlist
 * (shipped same slice). Completes the embed-allowlist chain:
 *   S38 (embed mount) + S39 (column) + S66 (per-tenant read) + S129 (?key=
 *   resolution) + S128 (this admin UI).
 *
 * UX shape
 * ────────
 *   - Single page; renders the CURRENT allowlist as a list of editable chips +
 *     an "Add origin" input.
 *   - Each chip shows the origin string + a remove (×) button.
 *   - Input below the chip list with an "Add" button (or Enter key); validates
 *     against the same HTTPS regex as the backend (HTTPS-only, hostname + opt
 *     port + opt path).
 *   - Save button at the bottom posts the entire list to PATCH. The page
 *     reloads the GET response afterward to confirm persistence.
 *   - Empty state: "No allowlist set — partner iframes are unrestricted
 *     (wildcard fallback)."  — matches the S66 fallback semantics.
 *
 * Validation parity with backend
 * ──────────────────────────────
 * The frontend HTTPS_ORIGIN_RE must match backend/routes/admin.js verbatim
 * so an origin accepted on the frontend isn't rejected on PATCH (or vice
 * versa). The regex pins HTTPS-only + hostname required + optional port +
 * optional path. Wildcard subdomains are NOT supported in v1.
 *
 * Mock surface for tests (per TenantSettings.test.jsx pattern)
 * ──────────────────────────────
 *   - fetchApi: '../utils/api'
 *   - useNotify: '../utils/notify'
 *   - useAuth: '../AuthContext' (for tenantId)
 */

import { useContext, useEffect, useMemo, useState } from 'react';
import { Globe, Save, Plus, X, Shield, AlertCircle } from 'lucide-react';
import { fetchApi } from '../../utils/api';
import { useNotify } from '../../utils/notify';
import { AuthContext } from '../../App';

// MUST mirror backend HTTPS_ORIGIN_RE in backend/routes/admin.js
const HTTPS_ORIGIN_RE = /^https:\/\/[^\s/]+(:\d+)?(\/.*)?$/;

function isValidOrigin(s) {
  return typeof s === 'string' && HTTPS_ORIGIN_RE.test(s.trim());
}

export default function EmbedAllowlist() {
  const notify = useNotify();
  const { user } = useContext(AuthContext) || {};
  const tenantId = user?.tenantId;
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [origins, setOrigins] = useState([]);
  const [inputValue, setInputValue] = useState('');
  const [inputError, setInputError] = useState('');
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [lastSavedJson, setLastSavedJson] = useState('[]');

  const load = async () => {
    if (!tenantId) {
      setLoadError('No active tenant — please log in.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError('');
    try {
      const data = await fetchApi(`/api/admin/tenants/${tenantId}/embed-allowlist`);
      const next = Array.isArray(data?.origins) ? data.origins : [];
      setOrigins(next);
      setLastSavedJson(JSON.stringify(next));
      setDirty(false);
    } catch (e) {
      setLoadError(e.message || 'Failed to load embed allowlist');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  const handleAdd = () => {
    const trimmed = inputValue.trim();
    if (!trimmed) {
      setInputError('Origin cannot be empty');
      return;
    }
    if (!isValidOrigin(trimmed)) {
      setInputError('Origin must be a valid HTTPS URL (e.g. https://partner.com)');
      return;
    }
    if (origins.includes(trimmed)) {
      setInputError('This origin is already in the allowlist');
      return;
    }
    if (origins.length >= 100) {
      setInputError('Allowlist is at the 100-entry cap — remove an entry first');
      return;
    }
    const next = [...origins, trimmed];
    setOrigins(next);
    setInputValue('');
    setInputError('');
    setDirty(JSON.stringify(next) !== lastSavedJson);
  };

  const handleRemove = (origin) => {
    const next = origins.filter((o) => o !== origin);
    setOrigins(next);
    setDirty(JSON.stringify(next) !== lastSavedJson);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAdd();
    }
  };

  const handleSave = async () => {
    if (!tenantId) return;
    setSaving(true);
    try {
      const data = await fetchApi(`/api/admin/tenants/${tenantId}/embed-allowlist`, {
        method: 'PATCH',
        body: JSON.stringify({ origins }),
      });
      const next = Array.isArray(data?.origins) ? data.origins : [];
      setOrigins(next);
      setLastSavedJson(JSON.stringify(next));
      setDirty(false);
      const msg = next.length === 0
        ? 'Allowlist cleared — partner iframes are now unrestricted (wildcard fallback)'
        : `Allowlist updated (${next.length} origin${next.length === 1 ? '' : 's'})`;
      notify.success(msg);
    } catch (e) {
      // fetchApi auto-toasts the server message; log for the console too.
      console.error('[embed-allowlist] save failed', e);
    } finally {
      setSaving(false);
    }
  };

  const inputIsValid = useMemo(
    () => inputValue.trim() === '' || isValidOrigin(inputValue.trim()),
    [inputValue],
  );

  return (
    <div
      style={{
        padding: '2rem',
        height: '100%',
        overflowY: 'auto',
        animation: 'fadeIn 0.5s ease-out',
      }}
      data-testid="embed-allowlist-page"
    >
      <header style={{ marginBottom: '1.5rem' }}>
        <h1
          style={{
            fontSize: '2rem',
            fontWeight: 'bold',
            display: 'flex',
            alignItems: 'center',
            gap: '0.75rem',
            margin: 0,
          }}
        >
          <Shield size={28} color="var(--primary-color, var(--accent-color))" /> Embed Allowlist
        </h1>
        <p
          style={{
            color: 'var(--text-secondary)',
            marginTop: '0.4rem',
            maxWidth: '760px',
          }}
        >
          Which partner websites are allowed to iframe-embed your CRM widgets.
          Each entry must be a full HTTPS origin (e.g. <code>https://partner.com</code>).
          An empty allowlist means <strong>no restrictions</strong> (any site
          can embed — the wildcard fallback). Add at least one origin to enforce
          per-tenant CSP <code>frame-ancestors</code> control.
        </p>
      </header>

      {loadError && (
        <div
          className="card"
          style={{
            padding: '0.9rem 1.1rem',
            marginBottom: '1.25rem',
            borderLeft: '4px solid #ef4444',
            color: '#ef4444',
            fontSize: '0.9rem',
            display: 'flex',
            alignItems: 'center',
            gap: '0.6rem',
          }}
          data-testid="embed-allowlist-load-error"
        >
          <AlertCircle size={18} />
          <div style={{ flex: 1 }}>{loadError}</div>
          <button
            onClick={load}
            className="btn-primary"
            style={{ padding: '0.35rem 0.85rem', fontSize: '0.82rem' }}
          >
            Retry
          </button>
        </div>
      )}

      {loading ? (
        <div
          className="card"
          style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-secondary)' }}
          data-testid="embed-allowlist-loading"
        >
          Loading embed allowlist…
        </div>
      ) : (
        <div
          className="card"
          style={{
            padding: '1.5rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '1.25rem',
            maxWidth: '820px',
          }}
        >
          {/* Chip list — current allowed origins */}
          <div>
            <div
              style={{
                fontSize: '0.85rem',
                fontWeight: 600,
                color: 'var(--text-primary)',
                marginBottom: '0.5rem',
              }}
            >
              Allowed origins ({origins.length})
            </div>
            {origins.length === 0 ? (
              <div
                style={{
                  padding: '1rem',
                  border: '1px dashed var(--border-color, rgba(255,255,255,0.18))',
                  borderRadius: '8px',
                  color: 'var(--text-secondary)',
                  fontSize: '0.88rem',
                  fontStyle: 'italic',
                }}
                data-testid="embed-allowlist-empty"
              >
                No allowlist set — partner iframes are unrestricted (wildcard fallback).
              </div>
            ) : (
              <div
                style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}
                data-testid="embed-allowlist-chips"
              >
                {origins.map((o) => (
                  <span
                    key={o}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '0.4rem',
                      padding: '0.35rem 0.6rem 0.35rem 0.8rem',
                      borderRadius: '999px',
                      background: 'rgba(34, 197, 94, 0.12)',
                      border: '1px solid rgba(34, 197, 94, 0.5)',
                      color: 'var(--text-primary)',
                      fontSize: '0.82rem',
                      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                    }}
                    data-testid={`embed-allowlist-chip-${o}`}
                  >
                    <Globe size={12} />
                    <span>{o}</span>
                    <button
                      type="button"
                      onClick={() => handleRemove(o)}
                      aria-label={`Remove ${o}`}
                      data-testid={`embed-allowlist-remove-${o}`}
                      style={{
                        background: 'transparent',
                        border: 'none',
                        color: 'var(--text-secondary)',
                        cursor: 'pointer',
                        padding: '0.1rem',
                        display: 'inline-flex',
                        alignItems: 'center',
                      }}
                    >
                      <X size={13} />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Add new origin */}
          <div>
            <label
              htmlFor="embed-allowlist-input"
              style={{
                fontSize: '0.82rem',
                fontWeight: 600,
                color: 'var(--text-primary)',
                display: 'block',
                marginBottom: '0.35rem',
              }}
            >
              Add origin
            </label>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <input
                id="embed-allowlist-input"
                type="text"
                value={inputValue}
                onChange={(e) => {
                  setInputValue(e.target.value);
                  if (inputError) setInputError('');
                }}
                onKeyDown={handleKeyDown}
                placeholder="https://partner.com"
                data-testid="embed-allowlist-input"
                style={{
                  flex: 1,
                  padding: '0.55rem 0.75rem',
                  borderRadius: '8px',
                  border: inputError
                    ? '1px solid #ef4444'
                    : '1px solid var(--border-color, rgba(255,255,255,0.12))',
                  background: 'var(--surface-color, rgba(255,255,255,0.04))',
                  color: 'var(--text-primary)',
                  fontSize: '0.9rem',
                  outline: 'none',
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                }}
              />
              <button
                type="button"
                onClick={handleAdd}
                disabled={!inputValue.trim() || !inputIsValid}
                className="btn-primary"
                data-testid="embed-allowlist-add"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '0.35rem',
                  opacity: !inputValue.trim() || !inputIsValid ? 0.6 : 1,
                  cursor: !inputValue.trim() || !inputIsValid ? 'not-allowed' : 'pointer',
                }}
              >
                <Plus size={14} /> Add
              </button>
            </div>
            {inputError && (
              <div
                style={{
                  marginTop: '0.35rem',
                  fontSize: '0.78rem',
                  color: '#ef4444',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.3rem',
                }}
                data-testid="embed-allowlist-input-error"
              >
                <AlertCircle size={12} /> {inputError}
              </div>
            )}
            <div
              style={{
                marginTop: '0.35rem',
                fontSize: '0.74rem',
                color: 'var(--text-secondary)',
              }}
            >
              HTTPS only. Up to 100 origins. Wildcard subdomains
              (<code>https://*.partner.com</code>) are not supported — list
              every concrete origin.
            </div>
          </div>

          {/* Save button */}
          <div
            style={{
              display: 'flex',
              justifyContent: 'flex-end',
              gap: '0.5rem',
              borderTop: '1px solid var(--border-color, rgba(255,255,255,0.06))',
              paddingTop: '1.1rem',
            }}
          >
            <button
              type="button"
              onClick={handleSave}
              disabled={!dirty || saving}
              className="btn-primary"
              data-testid="embed-allowlist-save"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.4rem',
                opacity: !dirty || saving ? 0.6 : 1,
                cursor: !dirty || saving ? 'not-allowed' : 'pointer',
              }}
            >
              <Save size={14} />
              {saving ? 'Saving…' : 'Save allowlist'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
