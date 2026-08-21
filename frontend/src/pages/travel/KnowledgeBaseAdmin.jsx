import { useCallback, useContext, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  AlertCircle,
  ArrowLeft,
  Brain,
  CheckCircle,
  ChevronRight,
  Cloud,
  Database,
  ExternalLink,
  FileText,
  Folder,
  FolderOpen,
  LogOut,
  RefreshCw,
  Save,
  Trash2,
  User,
  XCircle,
} from 'lucide-react';
import { fetchApi } from '../../utils/api';
import { useNotify } from '../../utils/notify';
import { AuthContext } from '../../App';
import CountBadge from '../../components/CountBadge';

const SUB_BRAND_LABELS = {
  tmc: 'TMC (school trips)',
  rfu: 'RFU (Umrah)',
  travelstall: 'Travel Stall',
  visasure: 'Visa Sure',
};

const STEP = {
  CONFIG: 0,
  CONNECT: 1,
  FOLDER: 2,
  SYNC: 3,
};

export default function KnowledgeBaseAdmin() {
  const notify = useNotify();
  const { user } = useContext(AuthContext) || {};
  const isAdmin = user?.role === 'ADMIN' || user?.role === 'MANAGER';
  const [searchParams] = useSearchParams();

  const [oauth, setOauth] = useState({ configured: false, connected: false, userInfo: null, rootFolderId: '' });
  const [config, setConfig] = useState({ rootFolderId: '', qdrantEnabled: false });
  const [folderInput, setFolderInput] = useState('');
  const [status, setStatus] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [files, setFiles] = useState([]);
  const [filesTotal, setFilesTotal] = useState(0);
  const [filesLoadingMore, setFilesLoadingMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [activeJobId, setActiveJobId] = useState(null);
  const [stopping, setStopping] = useState(false);
  const [savingConfig, setSavingConfig] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [completingOAuth, setCompletingOAuth] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  const [folders, setFolders] = useState([]);
  const [pickerBreadcrumbs, setPickerBreadcrumbs] = useState([{ id: 'root', name: 'My Drive' }]);
  const [loadingFolders, setLoadingFolders] = useState(false);

  // If Google (or the backend callback) redirected back to this page with
  // ?oauth=success or ?oauth=error, load the latest connection state and toast.
  // When this page is opened inside the OAuth popup window, post the result to
  // the opener and close instead.
  useEffect(() => {
    const status = searchParams.get('oauth');
    if (!status) return;
    if (window.opener) {
      try {
        window.opener.postMessage({ type: 'travel-knowledge-oauth', status }, window.location.origin);
      } catch {
        // ignore
      }
      window.close();
      return;
    }
    const message = searchParams.get('message');
    window.history.replaceState({}, '', '/travel/trip-knowledge');
    if (status === 'success') {
      notify.success('Google Drive connected');
    } else {
      notify.error(message || 'Google Drive connection failed');
    }
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  useEffect(() => {
    const code = searchParams.get('code');
    const state = searchParams.get('state');
    const error = searchParams.get('error');
    if (!code && !error) return;
    if (completingOAuth) return;
    if (window.opener && searchParams.get('oauth')) return; // popup handled by the effect above

    setCompletingOAuth(true);
    (async () => {
      try {
        const res = await fetchApi('/api/travel/knowledge-base/oauth/exchange', {
          method: 'POST',
          body: JSON.stringify({ code, state, error }),
        });
        if (res.success) {
          window.location.replace(`${res.redirectPath || '/travel/trip-knowledge'}?oauth=success`);
        } else {
          throw new Error(res.error || 'OAuth exchange failed');
        }
      } catch (e) {
        const msg = e.message || 'Failed to complete Google Drive connection';
        window.location.replace(`/travel/trip-knowledge?oauth=error&message=${encodeURIComponent(msg)}`);
      }
    })();
  }, [searchParams, completingOAuth]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [cfg, st, jbs, fls, oauthStatus] = await Promise.all([
        fetchApi('/api/travel/knowledge-base/config', { silent: true }).catch(() => ({ rootFolderId: '' })),
        fetchApi('/api/travel/knowledge-base/status', { silent: true }).catch(() => ({ stats: [], lastJob: null })),
        fetchApi('/api/travel/knowledge-base/jobs?limit=5', { silent: true }).catch(() => ({ jobs: [] })),
        fetchApi('/api/travel/knowledge-base/files?limit=50&offset=0', { silent: true }).catch(() => ({ files: [], total: 0 })),
        fetchApi('/api/travel/knowledge-base/oauth/status', { silent: true }).catch(() => ({ configured: false, connected: false, userInfo: null, rootFolderId: '' })),
      ]);
      setConfig(cfg || { rootFolderId: '', qdrantEnabled: false });
      setFolderInput(cfg?.rootFolderId || oauthStatus?.rootFolderId || '');
      setStatus(st || { stats: [], lastJob: null });
      setJobs(jbs?.jobs || []);
      setFiles(fls?.files || []);
      setFilesTotal(fls?.total || 0);
      setOauth(oauthStatus || { configured: false, connected: false, userInfo: null, rootFolderId: '' });
    } catch (e) {
      notify.error(e.message || 'Failed to load knowledge base');
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  useEffect(() => {
    const onMessage = (event) => {
      if (event.origin !== window.location.origin) return;
      if (event.data?.type === 'travel-knowledge-oauth') {
        loadAll();
        notify.success(event.data.status === 'success' ? 'Google Drive connected' : 'Google Drive connection failed');
      }
    };
    const onFocus = () => {
      if (oauth.connected || connecting) {
        loadAll();
      }
    };
    window.addEventListener('message', onMessage);
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('message', onMessage);
      window.removeEventListener('focus', onFocus);
    };
  }, [loadAll, oauth.connected, connecting, notify]);

  const connectDrive = async () => {
    if (!isAdmin) return;
    setConnecting(true);
    try {
      const { url } = await fetchApi('/api/travel/knowledge-base/oauth/auth-url');
      if (!url || !url.startsWith('https://accounts.google.com')) {
        throw new Error('Invalid Google auth URL from server');
      }
      // Full-page redirect keeps the flow in one browser tab and avoids the
      // popup-closing problems we had with window.open().
      window.location.href = url;
    } catch (e) {
      notify.error(e.message || 'Failed to start Google Drive connection');
      setConnecting(false);
    }
  };

  const disconnectDrive = async () => {
    if (!isAdmin) return;
    if (!window.confirm('Disconnect Google Drive? The selected root folder will be kept; you can reconnect later.')) return;
    setDisconnecting(true);
    try {
      await fetchApi('/api/travel/knowledge-base/oauth/disconnect', { method: 'POST' });
      notify.success('Google Drive disconnected');
      await loadAll();
    } catch (e) {
      notify.error(e.message || 'Failed to disconnect Google Drive');
    } finally {
      setDisconnecting(false);
    }
  };

  const loadMoreFiles = async () => {
    setFilesLoadingMore(true);
    try {
      const nextOffset = files.length;
      const res = await fetchApi(`/api/travel/knowledge-base/files?limit=50&offset=${nextOffset}`, { silent: true });
      setFiles((prev) => [...prev, ...(res?.files || [])]);
      setFilesTotal(res?.total || filesTotal);
    } catch (e) {
      notify.error(e.message || 'Failed to load more files');
    } finally {
      setFilesLoadingMore(false);
    }
  };

  const loadFolders = async (parentId) => {
    if (!oauth.connected) return;
    setLoadingFolders(true);
    try {
      const res = await fetchApi(`/api/travel/knowledge-base/folders?parentId=${encodeURIComponent(parentId)}`);
      setFolders(res.folders || []);
    } catch (e) {
      notify.error(e.message || 'Failed to load folders');
    } finally {
      setLoadingFolders(false);
    }
  };

  const enterFolder = (folder) => {
    setPickerBreadcrumbs((prev) => [...prev, { id: folder.id, name: folder.name }]);
    loadFolders(folder.id);
  };

  const jumpBreadcrumb = (index) => {
    const crumb = pickerBreadcrumbs[index];
    setPickerBreadcrumbs(pickerBreadcrumbs.slice(0, index + 1));
    loadFolders(crumb.id);
  };

  const saveFolderAsRoot = async (folderId) => {
    if (!isAdmin) return;
    setSavingConfig(true);
    try {
      const res = await fetchApi('/api/travel/knowledge-base/config', {
        method: 'POST',
        body: JSON.stringify({ rootFolderId: folderId }),
      });
      setConfig(res);
      setFolderInput(res.rootFolderId);
      setOauth((prev) => ({ ...prev, rootFolderId: res.rootFolderId }));
      notify.success('Folder selected for RAG pipeline');
    } catch (e) {
      notify.error(e.message || 'Failed to save folder');
    } finally {
      setSavingConfig(false);
    }
  };

  const saveConfig = async () => {
    if (!isAdmin) return;
    setSavingConfig(true);
    try {
      const res = await fetchApi('/api/travel/knowledge-base/config', {
        method: 'POST',
        body: JSON.stringify({ rootFolderId: folderInput }),
      });
      setConfig(res);
      setFolderInput(res.rootFolderId);
      setOauth((prev) => ({ ...prev, rootFolderId: res.rootFolderId }));
      notify.success('Drive folder ID saved');
    } catch (e) {
      notify.error(e.message || 'Failed to save config');
    } finally {
      setSavingConfig(false);
    }
  };

  const runSync = async () => {
    if (!isAdmin) return;
    setSyncing(true);
    setActiveJobId(null);
    try {
      const rootFolderId = (folderInput || '').trim() || config.rootFolderId;
      if (!rootFolderId) {
        notify.error('Select a Drive folder first');
        setSyncing(false);
        return;
      }
      const res = await fetchApi('/api/travel/knowledge-base/sync/jobs', {
        method: 'POST',
        body: JSON.stringify({ rootFolderId }),
      });
      setActiveJobId(res.jobId || null);
      notify.success('Sync started');
    } catch (e) {
      notify.error(e.message || 'Sync failed to start');
      setSyncing(false);
    }
  };

  const stopSync = async () => {
    if (!activeJobId) return;
    setStopping(true);
    try {
      await fetchApi(`/api/travel/knowledge-base/sync/${activeJobId}/stop`, { method: 'POST' });
      notify.success('Sync stop requested');
    } catch (e) {
      notify.error(e.message || 'Failed to stop sync');
    } finally {
      setStopping(false);
    }
  };

  const pollJobStatus = useCallback(async () => {
    if (!activeJobId) return;
    try {
      const res = await fetchApi(`/api/travel/knowledge-base/jobs/${activeJobId}`, { silent: true });
      const job = res?.job;
      if (!job) return;
      setStatus((prev) => ({
        ...prev,
        lastJob: job,
      }));
      if (job.status !== 'running') {
        setSyncing(false);
        setActiveJobId(null);
        await loadAll();
        if (job.status === 'completed') {
          notify.success(`Sync completed: ${job.filesIndexed} indexed, ${job.filesFailed} failed`);
        } else if (job.status === 'stopped') {
          notify.info(`Sync stopped: ${job.filesIndexed} indexed, ${job.filesFailed} failed`);
        } else {
          notify.error(`Sync ${job.status}: ${job.errorMessage || 'unknown error'}`);
        }
      }
    } catch (_) {
      // ignore polling errors; next tick will retry
    }
  }, [activeJobId, loadAll, notify]);

  useEffect(() => {
    if (!activeJobId) return;
    pollJobStatus();
    const id = setInterval(pollJobStatus, 3000);
    return () => clearInterval(id);
  }, [activeJobId, pollJobStatus]);

  const deleteFile = async (id) => {
    if (!isAdmin) return;
    if (!window.confirm('Remove this file from the index?')) return;
    try {
      await fetchApi(`/api/travel/knowledge-base/files/${id}`, { method: 'DELETE' });
      notify.success('File removed from index');
      await loadAll();
    } catch (e) {
      notify.error(e.message || 'Failed to remove file');
    }
  };

  const formatDate = (d) => {
    if (!d) return '—';
    try { return new Date(d).toLocaleString(); } catch { return String(d); }
  };

  const canSync = oauth.connected && oauth.rootFolderId && config.qdrantEnabled;
  const indexedFilesCount = filesTotal || files.length;

  const activeStep = (() => {
    if (!oauth.configured) return STEP.CONFIG;
    if (!oauth.connected) return STEP.CONNECT;
    if (!oauth.rootFolderId) return STEP.FOLDER;
    return STEP.SYNC;
  })();

  const stepDot = (n, label) => {
    const done = activeStep > n;
    const current = activeStep === n;
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, opacity: current ? 1 : 0.65 }}>
        <div style={{
          width: 28, height: 28, borderRadius: 14, display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: done ? '#22c55e' : current ? 'var(--accent-color)' : 'var(--surface-hover)',
          color: '#fff', fontSize: 12, fontWeight: 700,
        }}>
          {done ? <CheckCircle size={16} /> : n}
        </div>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{label}</span>
      </div>
    );
  };

  const muted = { color: 'var(--text-secondary)' };

  if (loading) {
    return (
      <div style={{ padding: 24, maxWidth: 1200, margin: '0 auto', color: 'var(--text-primary)' }}>
        <Link to="/travel" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--text-secondary)', fontSize: 13, textDecoration: 'none', marginBottom: 16 }}>
          <ArrowLeft size={16} /> Back to Travel
        </Link>
        <div className="card" style={{ padding: 48, textAlign: 'center' }}>
          <RefreshCw size={32} style={{ marginBottom: 12, animation: 'spin 1s linear infinite' }} />
          <div>Loading Travel Knowledge…</div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: 24, maxWidth: 1200, margin: '0 auto', color: 'var(--text-primary)' }}>
      <Link to="/travel" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--text-secondary)', fontSize: 13, textDecoration: 'none', marginBottom: 16 }}>
        <ArrowLeft size={16} /> Back to Travel
      </Link>

      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 24, flexWrap: 'wrap' }}>
        <div style={{ width: 56, height: 56, borderRadius: 16, background: 'rgba(59,130,246,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Brain size={28} color="var(--accent-color)" />
        </div>
        <div>
          <h1 style={{ margin: 0, fontSize: 26, fontWeight: 700 }}>Travel Knowledge</h1>
          <p style={{ margin: '4px 0 0', color: 'var(--text-secondary)', fontSize: 14 }}>
            Connect Google Drive, pick the brochure root folder, and sync PDFs so TMC diagnostics can recommend trips with AI.
          </p>
        </div>
      </div>

      {completingOAuth && (
        <div className="card" style={{ padding: 20, marginBottom: 20, borderLeft: '4px solid var(--accent-color)', background: 'rgba(59,130,246,0.08)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <RefreshCw size={20} style={{ animation: 'spin 1s linear infinite' }} />
            <span style={{ fontSize: 14 }}>Completing Google Drive connection…</span>
          </div>
        </div>
      )}

      {!config.qdrantEnabled && (
        <div className="card" style={{ padding: 16, marginBottom: 20, borderLeft: '4px solid #eab308', background: 'rgba(234,179,8,0.08)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <AlertCircle size={18} color="#eab308" />
            <span style={{ fontSize: 13 }}>
              Qdrant is not configured. RAG recommendations will be skipped until <code>QDRANT_URL</code> is set.
            </span>
          </div>
        </div>
      )}

      {!oauth.configured && (
        <div className="card" style={{ padding: 20, marginBottom: 20, borderLeft: '4px solid #eab308', background: 'rgba(234,179,8,0.08)' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
            <AlertCircle size={22} color="#eab308" style={{ flexShrink: 0, marginTop: 2 }} />
            <div>
              <div style={{ fontWeight: 700, marginBottom: 4 }}>Google Drive OAuth is not configured</div>
              <p style={{ margin: 0, lineHeight: 1.5, fontSize: 13, ...muted }}>
                Ask the devops team to set <code>GOOGLE_DRIVE_CLIENT_ID</code>, <code>GOOGLE_DRIVE_CLIENT_SECRET</code>, and <code>GOOGLE_DRIVE_REDIRECT_URI</code> in the backend environment.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Stepper */}
      <div className="card" style={{ padding: 20, marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 24, flexWrap: 'wrap' }}>
          {stepDot(STEP.CONFIG, 'Configure OAuth')}
          <ChevronRight size={16} style={{ color: 'var(--text-secondary)' }} />
          {stepDot(STEP.CONNECT, 'Connect Drive')}
          <ChevronRight size={16} style={{ color: 'var(--text-secondary)' }} />
          {stepDot(STEP.FOLDER, 'Pick folder')}
          <ChevronRight size={16} style={{ color: 'var(--text-secondary)' }} />
          {stepDot(STEP.SYNC, 'Sync PDFs')}
        </div>
      </div>

      <div style={{ display: 'grid', gap: 20, gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 360px), 1fr))' }}>
        {/* Connect card */}
        <div className="card" style={{ padding: 24 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
            <div style={{ width: 44, height: 44, borderRadius: 12, background: 'rgba(59,130,246,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Cloud size={22} color="var(--accent-color)" />
            </div>
            <div>
              <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>1. Connect Google Drive</h2>
              <p style={{ margin: '4px 0 0', fontSize: 12, ...muted }}>Read-only access to your brochure folders.</p>
            </div>
          </div>

          {!oauth.connected ? (
            <>
              <p style={{ fontSize: 13, lineHeight: 1.5, ...muted, marginBottom: 12 }}>
                Authorise the CRM to read the Drive folder that contains the TMC, RFU, Travel Stall and Visa Sure brochure sub-folders. You only need to do this once per tenant.
              </p>
              <div style={{ padding: 12, borderRadius: 8, background: 'var(--bg-color)', fontSize: 12, ...muted, marginBottom: 16, lineHeight: 1.5 }}>
                If Google shows “This app hasn&apos;t been verified”, click <strong>Continue</strong> or ask your admin to add your email as a test user in the Google Cloud OAuth consent screen. The redirect must point to the backend callback URL.
              </div>
              {isAdmin ? (
                <button className="btn-primary" onClick={connectDrive} disabled={connecting || !oauth.configured || completingOAuth} style={{ width: '100%' }}>
                  <ExternalLink size={16} style={{ marginRight: 6 }} />
                  {connecting ? 'Opening Google…' : completingOAuth ? 'Completing…' : 'Connect Google Drive'}
                </button>
              ) : (
                <div style={{ padding: 12, borderRadius: 8, background: 'var(--bg-color)', fontSize: 13, ...muted }}>Admin only</div>
              )}
            </>
          ) : (
            <div style={{ padding: 12, borderRadius: 10, background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.25)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <CheckCircle size={20} color="#22c55e" />
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 14 }}>Connected</div>
                    {oauth.userInfo?.emailAddress && (
                      <div style={{ fontSize: 12, ...muted, display: 'flex', alignItems: 'center', gap: 4, marginTop: 2 }}>
                        <User size={12} /> {oauth.userInfo.displayName || oauth.userInfo.emailAddress}
                      </div>
                    )}
                  </div>
                </div>
                <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, color: '#22c55e' }}>Active</span>
              </div>
              {isAdmin && (
                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <button
                    className="btn-secondary"
                    onClick={disconnectDrive}
                    disabled={disconnecting}
                    style={{ padding: '6px 12px', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 6 }}
                  >
                    <LogOut size={14} />
                    {disconnecting ? 'Disconnecting…' : 'Disconnect'}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Folder picker card */}
        <div className="card" style={{ padding: 24 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
            <div style={{ width: 44, height: 44, borderRadius: 12, background: 'rgba(234,179,8,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <FolderOpen size={22} color="#eab308" />
            </div>
            <div>
              <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>2. Select brochure root folder</h2>
              <p style={{ margin: '4px 0 0', fontSize: 12, ...muted }}>All PDFs inside this folder tree will be indexed.</p>
            </div>
          </div>

          {!oauth.connected ? (
            <div style={{ padding: 16, borderRadius: 8, background: 'var(--bg-color)', fontSize: 13, ...muted }}>Connect Google Drive first to browse folders.</div>
          ) : (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 12, fontSize: 13 }}>
                {pickerBreadcrumbs.map((crumb, idx) => (
                  <span key={crumb.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    {idx > 0 && <ChevronRight size={14} style={{ color: 'var(--text-secondary)' }} />}
                    <button
                      className="btn-secondary"
                      onClick={() => jumpBreadcrumb(idx)}
                      disabled={loadingFolders}
                      style={{ padding: '4px 10px', fontSize: 12 }}
                    >
                      {idx === 0 ? <Folder size={14} style={{ marginRight: 4 }} /> : null}
                      {crumb.name}
                    </button>
                  </span>
                ))}
              </div>

              <div style={{ minHeight: 120, maxHeight: 280, overflowY: 'auto', borderRadius: 10, border: '1px solid var(--border-color)', padding: 10, marginBottom: 16, background: 'var(--bg-color)' }}>
                {loadingFolders ? (
                  <div style={{ padding: 30, textAlign: 'center', ...muted, fontSize: 13 }}>Loading folders…</div>
                ) : folders.length === 0 ? (
                  <div style={{ padding: 30, textAlign: 'center', ...muted, fontSize: 13 }}>No sub-folders here.</div>
                ) : (
                  <div style={{ display: 'grid', gap: 8 }}>
                    {folders.map((folder) => {
                      const isSelected = folder.id === config.rootFolderId;
                      return (
                        <div key={folder.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '10px 12px', borderRadius: 8, background: isSelected ? 'rgba(34,197,94,0.08)' : 'var(--surface-color)', border: `1px solid ${isSelected ? 'rgba(34,197,94,0.35)' : 'var(--border-color)'}` }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                            {isSelected ? <CheckCircle size={18} color="#22c55e" style={{ flexShrink: 0 }} /> : <Folder size={18} color="#eab308" style={{ flexShrink: 0 }} />}
                            <span style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: isSelected ? '#22c55e' : 'var(--text-primary)' }}>{folder.name}</span>
                          </div>
                          <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                            {isAdmin && (
                              <button
                                className={isSelected ? 'btn-secondary' : 'btn-primary'}
                                onClick={() => saveFolderAsRoot(folder.id)}
                                disabled={savingConfig || isSelected}
                                style={{ padding: '6px 12px', fontSize: 12 }}
                              >
                                {isSelected ? 'Selected' : 'Use for RAG'}
                              </button>
                            )}
                            <button className="btn-secondary" onClick={() => enterFolder(folder)} disabled={loadingFolders} style={{ padding: '6px 12px', fontSize: 12 }}>
                              Open <ChevronRight size={14} />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              <div style={{ marginBottom: 12 }}>
                <label style={{ display: 'block', fontSize: 12, ...muted, marginBottom: 6, fontWeight: 600 }}>Selected root folder ID</label>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  <input
                    type="text"
                    className="input-field"
                    value={folderInput}
                    onChange={(e) => setFolderInput(e.target.value)}
                    placeholder="Drive folder ID"
                    disabled={!isAdmin || savingConfig}
                    style={{ flex: 1, minWidth: 220 }}
                  />
                  {isAdmin && (
                    <button className="btn-primary" onClick={saveConfig} disabled={savingConfig}>
                      <Save size={16} style={{ marginRight: 6 }} />
                      {savingConfig ? 'Saving…' : 'Save'}
                    </button>
                  )}
                </div>
              </div>

              {oauth.rootFolderId && (
                <div style={{ fontSize: 12, color: '#22c55e', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <CheckCircle size={14} /> Root folder saved for sync.
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Sync status card */}
      <div className="card" style={{ padding: 24, marginTop: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ width: 44, height: 44, borderRadius: 12, background: 'rgba(34,197,94,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Database size={22} color="#22c55e" />
            </div>
            <div>
              <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>3. Sync to Qdrant</h2>
              <p style={{ margin: '4px 0 0', fontSize: 12, ...muted }}>Indexed PDF brochures per sub-brand.</p>
            </div>
          </div>
          {isAdmin && (
            <div style={{ display: 'flex', gap: 10 }}>
              {syncing && activeJobId ? (
                <button className="btn-danger" onClick={stopSync} disabled={stopping}>
                  <XCircle size={16} style={{ marginRight: 6 }} />
                  {stopping ? 'Stopping…' : 'Stop sync'}
                </button>
              ) : (
                <button className="btn-primary" onClick={runSync} disabled={syncing || !canSync}>
                  <RefreshCw size={16} style={{ marginRight: 6, animation: syncing ? 'spin 1s linear infinite' : undefined }} />
                  {syncing ? 'Syncing…' : 'Sync now'}
                </button>
              )}
            </div>
          )}
        </div>

        {!canSync && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 12, borderRadius: 8, background: 'rgba(234,179,8,0.08)', border: '1px solid rgba(234,179,8,0.25)', marginBottom: 16 }}>
            <AlertCircle size={16} color="#eab308" />
            <span style={{ fontSize: 13 }}>
              {!oauth.connected && 'Connect Google Drive and select a folder before syncing.'}
              {oauth.connected && !oauth.rootFolderId && 'Select a Drive folder above before syncing.'}
              {oauth.connected && oauth.rootFolderId && !config.qdrantEnabled && 'Qdrant is not configured. Sync is disabled.'}
            </span>
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
          {(status?.stats || []).length === 0 ? (
            <div style={{ padding: 16, borderRadius: 8, background: 'var(--bg-color)', border: '1px solid var(--border-color)', ...muted, fontSize: 13 }}>
              No files indexed yet. Run a sync after selecting a folder.
            </div>
          ) : (
            (status?.stats || []).map((s) => (
              <div key={s.subBrand} style={{ padding: 18, borderRadius: 10, background: 'var(--bg-color)', border: '1px solid var(--border-color)' }}>
                <div style={{ fontSize: 12, ...muted, marginBottom: 4 }}>{SUB_BRAND_LABELS[s.subBrand] || s.subBrand}</div>
                <div style={{ fontSize: 28, fontWeight: 700 }}>{s.filesActive}</div>
                <div style={{ fontSize: 12, ...muted }}>{s.chunksInQdrant} chunks in Qdrant</div>
                {s.filesFailed > 0 && <div style={{ fontSize: 12, color: '#ef4444', marginTop: 4 }}>{s.filesFailed} failed</div>}
              </div>
            ))
          )}
        </div>

        {status?.lastJob && (
          <div style={{ marginTop: 16, fontSize: 13, ...muted }}>
            Last sync: <strong style={{ color: 'var(--text-primary)' }}>{status.lastJob.status}</strong> on {formatDate(status.lastJob.startedAt)}
            {status.lastJob.completedAt && ` → completed ${formatDate(status.lastJob.completedAt)}`}
            {status.lastJob.errorMessage && <div style={{ color: '#ef4444', marginTop: 4 }}>{status.lastJob.errorMessage}</div>}
          </div>
        )}
      </div>

      {/* Folder structure help */}
      <div className="card" style={{ padding: 20, marginTop: 20 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <div style={{ width: 36, height: 36, borderRadius: 10, background: 'rgba(59,130,246,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <FileText size={18} color="var(--accent-color)" />
          </div>
          <div>
            <h3 style={{ margin: '0 0 6px', fontSize: 15, fontWeight: 700 }}>Expected Drive folder structure</h3>
            <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, ...muted }}>
              Select the <strong>Brochures</strong> folder (or any folder that contains one immediate sub-folder per sub-brand). The sync walks every sub-brand folder recursively, so nested folders and direct PDFs inside them are all indexed.
            </p>
            <pre style={{ margin: '12px 0 0', padding: 12, borderRadius: 8, background: 'var(--bg-color)', fontSize: 12, overflowX: 'auto', color: 'var(--text-primary)' }}>
{`Brochures/
  tmc/
    DAY TRIPS/
      JUNIOR -GRADE Nursery to 5/
        Campus Overnight Adventure.pdf
        Europe Tour [Italy+Switzerland+Germany].pdf
      SENIOR- GRADE 6 to 12/
        ...
    DOMESTIC/
      REST OF INDIA/
        ...
    INTERNATIONAL/
      EUROPE/
        ...
  rfu/
    ...
  travelstall/
    ...
  visasure/
    ...`}
            </pre>
          </div>
        </div>
      </div>

      {/* Jobs table */}
      {jobs.length > 0 && (
        <div className="card" style={{ padding: 24, marginTop: 20 }}>
          <h2 style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '0 0 16px', fontSize: 16, fontWeight: 700, flexWrap: 'wrap' }}>
            Recent sync jobs
            <CountBadge count={jobs.length} title={`${jobs.length.toLocaleString()} sync jobs`} />
          </h2>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ color: 'var(--text-secondary)', borderBottom: '1px solid var(--border-color)' }}>
                  <th style={{ textAlign: 'left', padding: '10px 8px', fontWeight: 700 }}>Started</th>
                  <th style={{ textAlign: 'left', padding: '10px 8px', fontWeight: 700 }}>Status</th>
                  <th style={{ textAlign: 'right', padding: '10px 8px', fontWeight: 700 }}>Discovered</th>
                  <th style={{ textAlign: 'right', padding: '10px 8px', fontWeight: 700 }}>Indexed</th>
                  <th style={{ textAlign: 'right', padding: '10px 8px', fontWeight: 700 }}>Failed</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <tr key={job.id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                    <td style={{ padding: '10px 8px' }}>{formatDate(job.startedAt)}</td>
                    <td style={{ padding: '10px 8px' }}>
                      {job.status === 'completed' ? <CheckCircle size={14} color="#22c55e" /> : <XCircle size={14} color="#ef4444" />}
                      {' '}<span>{job.status}</span>
                    </td>
                    <td style={{ padding: '10px 8px', textAlign: 'right' }}>{job.filesDiscovered}</td>
                    <td style={{ padding: '10px 8px', textAlign: 'right' }}>{job.filesIndexed}</td>
                    <td style={{ padding: '10px 8px', textAlign: 'right', color: job.filesFailed > 0 ? '#ef4444' : 'inherit' }}>{job.filesFailed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Files table */}
      {files.length > 0 && (
        <div className="card" style={{ padding: 24, marginTop: 20 }}>
          <h2 style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '0 0 16px', fontSize: 16, fontWeight: 700, flexWrap: 'wrap' }}>
            Indexed files
            <CountBadge count={indexedFilesCount} title={`${indexedFilesCount.toLocaleString()} indexed files`} />
          </h2>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ color: 'var(--text-secondary)', borderBottom: '1px solid var(--border-color)' }}>
                  <th style={{ textAlign: 'left', padding: '10px 8px', fontWeight: 700 }}>Sub-brand</th>
                  <th style={{ textAlign: 'left', padding: '10px 8px', fontWeight: 700 }}>File</th>
                  <th style={{ textAlign: 'left', padding: '10px 8px', fontWeight: 700 }}>Folder path</th>
                  <th style={{ textAlign: 'left', padding: '10px 8px', fontWeight: 700 }}>Status</th>
                  <th style={{ textAlign: 'left', padding: '10px 8px', fontWeight: 700 }}>Indexed</th>
                  {isAdmin && <th style={{ width: 60 }} />}
                </tr>
              </thead>
              <tbody>
                {files.map((file) => (
                  <tr key={file.id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                    <td style={{ padding: '10px 8px' }}>{SUB_BRAND_LABELS[file.subBrand] || file.subBrand}</td>
                    <td style={{ padding: '10px 8px' }}>
                      <a href={file.driveViewLink} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent-color)', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        <ExternalLink size={12} /> {file.fileName}
                      </a>
                    </td>
                    <td style={{ padding: '10px 8px', ...muted }}>{file.folderPath}</td>
                    <td style={{ padding: '10px 8px' }}>
                      {file.status === 'active' ? <CheckCircle size={14} color="#22c55e" /> : <XCircle size={14} color="#ef4444" />}
                      {' '}<span>{file.status}</span>
                    </td>
                    <td style={{ padding: '10px 8px', ...muted }}>{formatDate(file.indexedAt)}</td>
                    {isAdmin && (
                      <td style={{ padding: '10px 8px' }}>
                        <button className="btn-secondary" onClick={() => deleteFile(file.id)} title="Remove from index" style={{ padding: 6 }}>
                          <Trash2 size={16} color="#ef4444" />
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {files.length < filesTotal && (
            <div style={{ display: 'flex', justifyContent: 'center', marginTop: 16 }}>
              <button className="btn-secondary" onClick={loadMoreFiles} disabled={filesLoadingMore} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                <RefreshCw size={14} style={{ animation: filesLoadingMore ? 'spin 1s linear infinite' : undefined }} />
                {filesLoadingMore ? 'Loading…' : `Load more files (${files.length} of ${filesTotal})`}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
