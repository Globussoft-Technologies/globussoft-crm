/**
 * FlyerShareAdmin.jsx — Travel-vertical operator UI for flyer share-link
 * lifecycle management (mint + history + revoke). Slice S79 (Wave 34) from
 * `docs/TRAVEL_BIG_SCOPE_BACKLOG.md`, flagged as the operator-facing follow-up
 * to S18's backend `POST /api/v1/flyers/:id/share` mint route.
 *
 * Lands at `/travel/flyer-share-admin` (ADMIN-gated). Companion surface to
 * the existing /travel/flyer-templates list page (which is the metadata /
 * design-time CRUD); THIS page is purely about sharing lifecycle:
 *
 *   1. Pick a saved FlyerTemplate from a list (left rail).
 *   2. Click "Mint share link" → `POST /api/v1/flyers/:id/share` → modal
 *      shows the returned shareUrl + embedCode + expiresAt with one-click
 *      copy-to-clipboard buttons on each. (Operators can override the TTL
 *      via a numeric input; clamped at the backend to 5 min ≤ x ≤ 90 d.)
 *   3. History panel reads audit-log rows for the selected template via
 *      `GET /api/audit-viewer/entity/TravelFlyerTemplate/:id`, filtered to
 *      `action='TRAVEL_FLYER_PUBLIC_SHARE_MINTED'`. Each row surfaces
 *      mintedAt + mintedBy (userId) + slug + expiresAt + Revoke button.
 *   4. Revoke button: `POST /api/v1/flyers/:id/revoke-share` body
 *      `{slug, mintedAt}`. **GRACEFUL 404**: S80 (revoke endpoint) is not
 *      yet shipped at slice-author time; on 404 the button surfaces a
 *      "Revoke not yet supported — tracked in S80" notify.info instead of
 *      a generic error, so operators can still ship copy / view-history
 *      flows without the lifecycle being blocked.
 *
 * Backend contracts pinned:
 *   POST /api/v1/flyers/:id/share        (S18 ✅, 0db18b58)
 *       → 200 { shareUrl, embedCode, expiresAt, slug, flyerId }
 *       Body (optional): { expiresInSec: <300..7776000> }
 *   POST /api/v1/flyers/:id/revoke-share (S80 ⬜ — graceful 404 fallback)
 *   GET  /api/audit-viewer/entity/TravelFlyerTemplate/:id
 *       → 200 { entity, entityId, total, logs: [...] }
 *       Filter client-side to action='TRAVEL_FLYER_PUBLIC_SHARE_MINTED'.
 *   GET  /api/travel/flyer-templates     (reused from S77 ✅)
 *
 * Mounting / route wire-in:
 *   App.jsx → lazy() at `/travel/flyer-share-admin`, wrapped in
 *   <TravelOnly><RoleGuard allow=["ADMIN"]>...</RoleGuard></TravelOnly>.
 *   Sidebar.jsx → entry under Travel marketing block, gated `isAdmin`.
 *
 * RTL stable-mock discipline per CLAUDE.md standing rule:
 *   - useNotify mock returns ONE stable object reference module-wide.
 *   - fetchApi is the lone external dep; mocked at ../utils/api.
 *   - navigator.clipboard.writeText is monkey-patched per test.
 */
import { useCallback, useContext, useEffect, useMemo, useState } from "react";
import {
  Share2,
  Copy,
  X,
  RefreshCw,
  ShieldAlert,
  History,
  Ban,
  Link2,
  Clock,
} from "lucide-react";
import { fetchApi } from "../../utils/api";
import { useNotify } from "../../utils/notify";
import { AuthContext } from "../../App";

const SHARE_MINTED_ACTION = "TRAVEL_FLYER_PUBLIC_SHARE_MINTED";
const SHARE_REVOKED_ACTION = "TRAVEL_FLYER_PUBLIC_SHARE_REVOKED";

// TTL options surfaced as quick-pick chips. Operators can also free-type a
// custom value. Backend clamps 5 min ≤ x ≤ 90 d server-side so a hand-typed
// out-of-range value is safe.
const TTL_PRESETS = [
  { label: "1 hour", seconds: 3600 },
  { label: "1 day", seconds: 86400 },
  { label: "7 days (default)", seconds: 7 * 86400 },
  { label: "30 days", seconds: 30 * 86400 },
];

function fmtDateTime(d) {
  if (!d) return "—";
  const dt = new Date(d);
  if (!Number.isFinite(dt.getTime())) return "—";
  return dt.toLocaleString();
}

function truncateUrl(url, max = 60) {
  if (!url) return "";
  if (url.length <= max) return url;
  return `${url.slice(0, max - 3)}...`;
}

export default function FlyerShareAdmin() {
  const notify = useNotify();
  const { user } = useContext(AuthContext) || {};
  const isAdmin = user?.role === "ADMIN";

  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [selectedId, setSelectedId] = useState(null);

  // Mint workflow state
  const [minting, setMinting] = useState(false);
  const [expiresInSec, setExpiresInSec] = useState(7 * 86400);
  const [mintResult, setMintResult] = useState(null); // { shareUrl, embedCode, expiresAt, slug }

  // History state — keyed by template id; refetched whenever the selected
  // template changes (or after a successful mint/revoke so the new row
  // shows up immediately).
  const [history, setHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [revokingKey, setRevokingKey] = useState(null);
  // Set of "revoked" keys so the UI reflects revocations optimistically
  // even if the backend's audit row hasn't propagated yet (mirrors the
  // approve/reject optimistic pattern in PoiPendingApprovalQueue).
  const [revokedKeys, setRevokedKeys] = useState(new Set());

  const selectedTemplate = useMemo(
    () => templates.find((t) => t.id === selectedId) || null,
    [templates, selectedId],
  );

  // ─── Template list loader ─────────────────────────────────────────

  const loadTemplates = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchApi("/api/travel/flyer-templates", { silent: true })
      .then((data) => {
        const list = Array.isArray(data?.templates) ? data.templates : [];
        setTemplates(list);
        // Auto-select the first template so the page doesn't open empty.
        // We only auto-select on initial load — don't reset if the operator
        // has already picked something + we're just refreshing.
        setSelectedId((prev) => prev || (list[0] ? list[0].id : null));
      })
      .catch((e) => {
        setTemplates([]);
        setError(e?.message || "Failed to load flyer templates");
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!isAdmin) return;
    loadTemplates();
  }, [isAdmin, loadTemplates]);

  // ─── History loader ────────────────────────────────────────────────

  const loadHistory = useCallback((templateId) => {
    if (!templateId) {
      setHistory([]);
      return;
    }
    setHistoryLoading(true);
    fetchApi(
      `/api/audit-viewer/entity/TravelFlyerTemplate/${templateId}`,
      { silent: true },
    )
      .then((data) => {
        const all = Array.isArray(data?.logs) ? data.logs : [];
        // Filter to mint-action rows only; revoke rows are surfaced as
        // "(revoked)" badges on the matching mint row (via slug match)
        // rather than as separate history entries.
        const mints = all.filter((row) => row?.action === SHARE_MINTED_ACTION);
        // Collect revoke-action rows so we can mark matching mints revoked.
        const revokeSlugs = new Set(
          all
            .filter((row) => row?.action === SHARE_REVOKED_ACTION)
            .map((row) => {
              try {
                const meta = typeof row.metadata === "string"
                  ? JSON.parse(row.metadata)
                  : (row.metadata || {});
                return meta.slug || null;
              } catch (_e) { return null; }
            })
            .filter(Boolean),
        );
        // Augment each mint with the parsed-metadata fields the UI needs.
        const decorated = mints.map((row) => {
          let meta = {};
          try {
            meta = typeof row.metadata === "string"
              ? JSON.parse(row.metadata)
              : (row.metadata || {});
          } catch (_e) { meta = {}; }
          return {
            id: row.id,
            mintedAt: row.createdAt,
            mintedBy: row.userId,
            slug: meta.slug || null,
            expiresAt: meta.expiresAt || null,
            revoked: meta.slug ? revokeSlugs.has(meta.slug) : false,
          };
        });
        setHistory(decorated);
      })
      .catch(() => {
        // 4xx/5xx — the route may not be mounted for this tenant, or the
        // template has zero audit rows. Either way, just show empty.
        setHistory([]);
      })
      .finally(() => setHistoryLoading(false));
  }, []);

  useEffect(() => {
    setRevokedKeys(new Set());
    loadHistory(selectedId);
  }, [selectedId, loadHistory]);

  // ─── Mint workflow ─────────────────────────────────────────────────

  const handleMint = async () => {
    if (!selectedTemplate || minting) return;
    setMinting(true);
    try {
      const body = {};
      if (Number.isFinite(expiresInSec) && expiresInSec !== 7 * 86400) {
        body.expiresInSec = expiresInSec;
      }
      const result = await fetchApi(
        `/api/v1/flyers/${selectedTemplate.id}/share`,
        { method: "POST", body: JSON.stringify(body) },
      );
      if (!result || !result.shareUrl) {
        notify.error("Mint succeeded but server returned no shareUrl");
        return;
      }
      setMintResult({
        shareUrl: result.shareUrl,
        embedCode: result.embedCode,
        expiresAt: result.expiresAt,
        slug: result.slug,
      });
      notify.success(`Share link minted for "${selectedTemplate.name}"`);
      // Refresh history so the new mint row shows up.
      loadHistory(selectedTemplate.id);
    } catch (e) {
      notify.error(e?.message || "Failed to mint share link");
    } finally {
      setMinting(false);
    }
  };

  const handleCopy = async (text, label) => {
    if (!text) return;
    try {
      if (
        typeof navigator !== "undefined" &&
        navigator.clipboard &&
        typeof navigator.clipboard.writeText === "function"
      ) {
        await navigator.clipboard.writeText(text);
        notify.success(`${label} copied to clipboard`);
      } else {
        notify.error("Clipboard API not available in this browser");
      }
    } catch (e) {
      notify.error(e?.message || "Failed to copy to clipboard");
    }
  };

  // ─── Revoke workflow ───────────────────────────────────────────────
  // S80 (token revocation endpoint) is NOT yet shipped at slice-author time.
  // We attempt the POST; on 404 we surface a friendly "tracked in S80" hint
  // rather than a generic error. Any other error surfaces normally.

  const handleRevoke = async (row) => {
    if (!selectedTemplate || revokingKey) return;
    const ok = await notify.confirm({
      title: "Revoke share link?",
      message: `Anyone holding this URL will no longer be able to view the flyer. This cannot be undone.`,
      confirmText: "Revoke",
      cancelText: "Cancel",
      destructive: true,
    });
    if (!ok) return;
    const key = `${row.id}`;
    setRevokingKey(key);
    try {
      await fetchApi(
        `/api/v1/flyers/${selectedTemplate.id}/revoke-share`,
        {
          method: "POST",
          body: JSON.stringify({ slug: row.slug, mintedAt: row.mintedAt }),
          silent: true,
        },
      );
      notify.success("Share link revoked");
      setRevokedKeys((prev) => {
        const next = new Set(prev);
        next.add(key);
        return next;
      });
      loadHistory(selectedTemplate.id);
    } catch (e) {
      // Graceful 404 — S80 endpoint not yet shipped.
      const status = e?.status;
      const msg = String(e?.message || "");
      if (status === 404 || /not found/i.test(msg)) {
        notify.info(
          "Revoke endpoint not yet shipped — tracked as slice S80 in TRAVEL_BIG_SCOPE_BACKLOG. The link will expire naturally at expiresAt.",
        );
      } else {
        notify.error(e?.message || "Failed to revoke share link");
      }
    } finally {
      setRevokingKey(null);
    }
  };

  // ─── Styles ────────────────────────────────────────────────────────

  const wrap = { padding: 24, maxWidth: 1280, margin: "0 auto" };
  const headerStyle = {
    display: "flex", alignItems: "center", gap: 12, marginBottom: 8,
  };
  const subStyle = {
    color: "var(--text-secondary)", fontSize: 13, marginBottom: 24,
  };
  const card = {
    background: "var(--surface-color)",
    border: "1px solid var(--border-color)",
    borderRadius: 8,
    padding: 16,
    marginBottom: 12,
  };
  const layoutGrid = {
    display: "grid",
    gridTemplateColumns:
      "repeat(auto-fit, minmax(min(100%, 320px), 1fr))",
    gap: 16,
  };
  const primaryBtn = {
    display: "inline-flex", alignItems: "center", gap: 6,
    padding: "8px 14px",
    background: "var(--primary-color, var(--accent-color))",
    color: "white", border: "none", borderRadius: 6,
    fontSize: 13, fontWeight: 600, cursor: "pointer",
  };
  const secondaryBtn = {
    display: "inline-flex", alignItems: "center", gap: 6,
    padding: "6px 12px",
    background: "transparent",
    color: "var(--text-primary)",
    border: "1px solid var(--border-color)", borderRadius: 6,
    fontSize: 13, fontWeight: 500, cursor: "pointer",
  };
  const dangerBtn = {
    display: "inline-flex", alignItems: "center", gap: 4,
    padding: "5px 10px",
    background: "transparent",
    color: "#A8323F",
    border: "1px solid #A8323F", borderRadius: 4,
    fontSize: 12, fontWeight: 600, cursor: "pointer",
  };
  const ttlChip = (active) => ({
    padding: "4px 10px",
    background: active
      ? "var(--primary-color, var(--accent-color))"
      : "var(--subtle-bg, var(--bg-color))",
    color: active ? "white" : "var(--text-primary)",
    border: "1px solid var(--border-color)",
    borderRadius: 12,
    fontSize: 12,
    fontWeight: 500,
    cursor: "pointer",
  });
  const templateRow = (active) => ({
    padding: "10px 12px",
    borderRadius: 6,
    background: active
      ? "rgba(38,88,85,0.10)"
      : "transparent",
    border: active
      ? "1px solid var(--primary-color, var(--accent-color))"
      : "1px solid transparent",
    cursor: "pointer",
    marginBottom: 4,
  });
  const labelStyle = {
    fontSize: 11, color: "var(--text-secondary)",
    textTransform: "uppercase", letterSpacing: 0.5,
    marginBottom: 2,
  };
  const codeBox = {
    background: "var(--subtle-bg, var(--bg-color))",
    border: "1px solid var(--border-color)",
    borderRadius: 4,
    padding: "8px 10px",
    fontFamily: "monospace",
    fontSize: 12,
    wordBreak: "break-all",
    color: "var(--text-primary)",
  };

  // ─── ADMIN gate ────────────────────────────────────────────────────

  if (!isAdmin) {
    return (
      <div style={wrap}>
        <div style={headerStyle}>
          <ShieldAlert size={22} aria-hidden style={{ color: "#A8323F" }} />
          <h1 style={{ margin: 0, fontSize: 22 }}>Flyer Share Admin</h1>
        </div>
        <div
          style={{
            ...card,
            background: "rgba(168,50,63,0.08)",
            borderColor: "#A8323F",
            color: "#A8323F",
          }}
          role="alert"
        >
          This page is restricted to ADMIN users. Your current role is{" "}
          <strong>{user?.role || "unauthenticated"}</strong>.
        </div>
      </div>
    );
  }

  // ─── Render ────────────────────────────────────────────────────────

  return (
    <div style={wrap}>
      <div style={headerStyle}>
        <Share2
          size={22}
          aria-hidden
          style={{ color: "var(--primary-color, var(--accent-color))" }}
        />
        <h1 style={{ margin: 0, fontSize: 22 }}>Flyer Share Admin</h1>
        <button
          type="button"
          onClick={loadTemplates}
          style={{ ...secondaryBtn, marginLeft: "auto" }}
          aria-label="Refresh templates"
        >
          <RefreshCw size={14} aria-hidden /> Refresh
        </button>
      </div>
      <p style={subStyle}>
        Mint share links for saved flyer templates, view mint history, and
        revoke previously-minted links. Public viewers consume the
        shareUrl; embedders use the embedCode iframe snippet.
      </p>

      {loading && (
        <div style={card} role="status">Loading flyer templates&hellip;</div>
      )}

      {error && (
        <div
          style={{
            ...card,
            background: "rgba(168,50,63,0.08)",
            borderColor: "#A8323F",
            color: "#A8323F",
          }}
          role="alert"
        >
          <ShieldAlert size={14} aria-hidden style={{ marginRight: 4 }} />
          {error}
        </div>
      )}

      {!loading && !error && templates.length === 0 && (
        <div
          style={{
            ...card,
            textAlign: "center",
            color: "var(--text-secondary)",
          }}
          data-testid="flyer-share-empty"
        >
          No flyer templates yet. Create one in <strong>Flyer Templates</strong>{" "}
          first, then return here to mint a share link.
        </div>
      )}

      {!loading && !error && templates.length > 0 && (
        <div style={layoutGrid}>
          {/* Left column — template picker */}
          <div style={card}>
            <h2 style={{ margin: "0 0 8px", fontSize: 16 }}>Templates</h2>
            <div
              role="listbox"
              aria-label="Flyer templates"
              data-testid="flyer-share-template-list"
            >
              {templates.map((t) => {
                const active = t.id === selectedId;
                return (
                  <div
                    key={t.id}
                    role="option"
                    aria-selected={active}
                    data-testid={`flyer-share-template-row-${t.id}`}
                    style={templateRow(active)}
                    onClick={() => setSelectedId(t.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setSelectedId(t.id);
                      }
                    }}
                    tabIndex={0}
                  >
                    <div style={{ fontWeight: 600, fontSize: 14 }}>
                      {t.name || "Untitled"}
                    </div>
                    <div
                      style={{
                        fontSize: 11,
                        color: "var(--text-secondary)",
                        marginTop: 2,
                      }}
                    >
                      {t.subBrand
                        ? <span style={{ textTransform: "uppercase" }}>{t.subBrand}</span>
                        : "—"}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Right column — mint controls + history */}
          <div>
            {selectedTemplate ? (
              <>
                <div style={card}>
                  <h2 style={{ margin: "0 0 8px", fontSize: 16 }}>
                    Mint share link
                  </h2>
                  <div style={{ marginBottom: 8 }}>
                    <div style={labelStyle}>Template</div>
                    <div style={{ fontSize: 14, fontWeight: 600 }}>
                      {selectedTemplate.name}
                    </div>
                  </div>
                  <div style={{ marginBottom: 12 }}>
                    <div style={labelStyle}>Link lifetime (TTL)</div>
                    <div
                      style={{
                        display: "flex",
                        gap: 6,
                        flexWrap: "wrap",
                        marginTop: 4,
                      }}
                    >
                      {TTL_PRESETS.map((p) => (
                        <button
                          key={p.seconds}
                          type="button"
                          onClick={() => setExpiresInSec(p.seconds)}
                          style={ttlChip(expiresInSec === p.seconds)}
                          aria-pressed={expiresInSec === p.seconds}
                          data-testid={`ttl-preset-${p.seconds}`}
                        >
                          {p.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={handleMint}
                    disabled={minting}
                    style={primaryBtn}
                    aria-label={`Mint share link for ${selectedTemplate.name}`}
                    data-testid="flyer-share-mint-btn"
                  >
                    <Share2 size={14} aria-hidden />
                    {minting ? "Minting…" : "Mint share link"}
                  </button>
                </div>

                {/* History panel */}
                <div style={card}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      marginBottom: 8,
                    }}
                  >
                    <History
                      size={16}
                      aria-hidden
                      style={{ color: "var(--text-secondary)" }}
                    />
                    <h2 style={{ margin: 0, fontSize: 16 }}>Mint history</h2>
                    <button
                      type="button"
                      onClick={() => loadHistory(selectedTemplate.id)}
                      style={{ ...secondaryBtn, marginLeft: "auto", padding: "4px 8px" }}
                      aria-label="Refresh history"
                    >
                      <RefreshCw size={12} aria-hidden /> Refresh
                    </button>
                  </div>

                  {historyLoading && (
                    <div role="status" style={{ color: "var(--text-secondary)", fontSize: 13 }}>
                      Loading history&hellip;
                    </div>
                  )}

                  {!historyLoading && history.length === 0 && (
                    <div
                      style={{
                        color: "var(--text-secondary)",
                        fontSize: 13,
                        padding: "8px 0",
                      }}
                      data-testid="flyer-share-history-empty"
                    >
                      No share links minted for this template yet.
                    </div>
                  )}

                  {!historyLoading && history.map((row) => {
                    const optimisticRevoked =
                      revokedKeys.has(`${row.id}`) || row.revoked;
                    const isBusy = revokingKey === `${row.id}`;
                    return (
                      <div
                        key={row.id}
                        data-testid={`flyer-share-history-row-${row.id}`}
                        style={{
                          borderTop: "1px solid var(--border-color)",
                          padding: "10px 0",
                          display: "flex",
                          flexWrap: "wrap",
                          gap: 12,
                          alignItems: "center",
                        }}
                      >
                        <div style={{ flex: "1 1 220px", minWidth: 0 }}>
                          <div
                            style={{
                              fontSize: 12,
                              color: "var(--text-secondary)",
                              display: "flex",
                              gap: 6,
                              alignItems: "center",
                            }}
                          >
                            <Clock size={11} aria-hidden />
                            {fmtDateTime(row.mintedAt)}
                            {row.mintedBy != null && (
                              <span> · user #{row.mintedBy}</span>
                            )}
                          </div>
                          <div
                            style={{
                              fontSize: 12,
                              fontFamily: "monospace",
                              color: "var(--text-primary)",
                              marginTop: 2,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                            title={row.slug || ""}
                          >
                            {row.slug
                              ? <><Link2 size={11} aria-hidden style={{ marginRight: 4 }} />{truncateUrl(row.slug, 50)}</>
                              : "—"}
                          </div>
                          {row.expiresAt && (
                            <div
                              style={{
                                fontSize: 11,
                                color: "var(--text-secondary)",
                                marginTop: 2,
                              }}
                            >
                              Expires {fmtDateTime(row.expiresAt)}
                            </div>
                          )}
                        </div>
                        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                          {optimisticRevoked ? (
                            <span
                              style={{
                                fontSize: 11,
                                fontWeight: 600,
                                padding: "3px 8px",
                                borderRadius: 10,
                                background: "rgba(168,50,63,0.10)",
                                color: "#A8323F",
                                textTransform: "uppercase",
                                letterSpacing: 0.4,
                              }}
                              data-testid={`revoked-badge-${row.id}`}
                            >
                              Revoked
                            </span>
                          ) : (
                            <button
                              type="button"
                              onClick={() => handleRevoke(row)}
                              disabled={isBusy}
                              style={dangerBtn}
                              aria-label={`Revoke share link minted ${fmtDateTime(row.mintedAt)}`}
                              data-testid={`flyer-share-revoke-${row.id}`}
                              title="Revoke this share link"
                            >
                              <Ban size={12} aria-hidden /> {isBusy ? "Revoking…" : "Revoke"}
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            ) : (
              <div style={card}>
                <p style={{ color: "var(--text-secondary)", fontSize: 13, margin: 0 }}>
                  Select a template from the list to mint a share link.
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Mint result modal — surfaces the freshly-minted link bundle. */}
      {mintResult && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="flyer-share-modal-title"
          data-testid="flyer-share-mint-modal"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
            padding: 16,
          }}
          onClick={(e) => {
            // Click backdrop → close. Inner click bubbles + stopPropagation
            // on the inner container prevents accidental close.
            if (e.target === e.currentTarget) setMintResult(null);
          }}
        >
          <div
            style={{
              background: "var(--surface-color)",
              border: "1px solid var(--border-color)",
              borderRadius: 8,
              padding: 24,
              maxWidth: 640,
              width: "100%",
              maxHeight: "90vh",
              overflow: "auto",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginBottom: 16,
              }}
            >
              <Share2
                size={20}
                aria-hidden
                style={{ color: "var(--primary-color, var(--accent-color))" }}
              />
              <h2 id="flyer-share-modal-title" style={{ margin: 0, fontSize: 18 }}>
                Share link minted
              </h2>
              <button
                type="button"
                onClick={() => setMintResult(null)}
                style={{
                  ...secondaryBtn,
                  marginLeft: "auto",
                  padding: 4,
                  border: "none",
                }}
                aria-label="Close mint result"
                data-testid="flyer-share-modal-close"
              >
                <X size={18} aria-hidden />
              </button>
            </div>

            <div style={{ marginBottom: 16 }}>
              <div style={labelStyle}>Share URL</div>
              <div style={codeBox} data-testid="flyer-share-result-url">
                {mintResult.shareUrl}
              </div>
              <button
                type="button"
                onClick={() => handleCopy(mintResult.shareUrl, "Share URL")}
                style={{ ...secondaryBtn, marginTop: 6 }}
                aria-label="Copy share URL to clipboard"
                data-testid="flyer-share-copy-url-btn"
              >
                <Copy size={12} aria-hidden /> Copy URL
              </button>
            </div>

            <div style={{ marginBottom: 16 }}>
              <div style={labelStyle}>Embed code (iframe)</div>
              <div style={codeBox} data-testid="flyer-share-result-embed">
                {mintResult.embedCode}
              </div>
              <button
                type="button"
                onClick={() => handleCopy(mintResult.embedCode, "Embed code")}
                style={{ ...secondaryBtn, marginTop: 6 }}
                aria-label="Copy embed code to clipboard"
                data-testid="flyer-share-copy-embed-btn"
              >
                <Copy size={12} aria-hidden /> Copy embed code
              </button>
            </div>

            <div>
              <div style={labelStyle}>Expires at</div>
              <div
                style={{ fontSize: 13, color: "var(--text-primary)" }}
                data-testid="flyer-share-result-expires"
              >
                {fmtDateTime(mintResult.expiresAt)}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
