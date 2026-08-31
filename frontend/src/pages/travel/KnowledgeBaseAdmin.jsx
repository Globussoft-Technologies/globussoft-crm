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
  Download,
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
  const [config, setConfig] = useState({ rootFolderId: '', qdrantEnabled: false, embedEnabled: false, embedProvider: null, embedModel: null, vectorSize: null });
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

  // Bulk selection state for indexed files and sync jobs.
  const [selectedFileIds, setSelectedFileIds] = useState(new Set());
  const [selectedJobIds, setSelectedJobIds] = useState(new Set());
  const [bulkDeletingFiles, setBulkDeletingFiles] = useState(false);
  const [bulkDeletingJobs, setBulkDeletingJobs] = useState(false);

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
      setConfig(cfg || { rootFolderId: '', qdrantEnabled: false, embedEnabled: false, embedProvider: null, embedModel: null, vectorSize: null });
      setFolderInput(cfg?.rootFolderId || oauthStatus?.rootFolderId || '');
      setStatus(st || { stats: [], lastJob: null, providerChunks: {}, activeProvider: null });
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

  // If a previous sync was left running (e.g. backend restart) and the user
  // reloads the page, adopt the most recent running job so the stop button works.
  useEffect(() => {
    if (activeJobId) return;
    const running = jobs.find((j) => j.status === 'running');
    if (running) {
      setSyncing(true);
      setActiveJobId(running.id);
    }
  }, [jobs, activeJobId]);

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
    if (!window.confirm('Disconnect Google Drive? Your selected brochure folder will be kept, and you can reconnect later.')) return;
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
      setConfig((prev) => ({ ...prev, ...res }));
      setFolderInput(res.rootFolderId);
      setOauth((prev) => ({ ...prev, rootFolderId: res.rootFolderId }));
      notify.success('Brochure folder selected');
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
      setConfig((prev) => ({ ...prev, ...res }));
      setFolderInput(res.rootFolderId);
      setOauth((prev) => ({ ...prev, rootFolderId: res.rootFolderId }));
      notify.success('Brochure folder saved');
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
      notify.success('Library update started');
    } catch (e) {
      notify.error(e.message || 'Library update could not be started');
      setSyncing(false);
    }
  };

  const stopSync = async () => {
    if (!activeJobId) return;
    setStopping(true);
    try {
      await fetchApi(`/api/travel/knowledge-base/sync/${activeJobId}/stop`, { method: 'POST' });
      notify.success('Stopping the library update');
    } catch (e) {
      notify.error(e.message || 'The library update could not be stopped');
    } finally {
      setStopping(false);
    }
  };

  const stopAllSyncs = async () => {
    if (!isAdmin) return;
    setStopping(true);
    try {
      const res = await fetchApi('/api/travel/knowledge-base/sync/stop-all', { method: 'POST' });
      notify.success(`Stopped ${res.stopped || 0} library update${res.stopped === 1 ? '' : 's'}`);
      setSyncing(false);
      setActiveJobId(null);
      await loadAll();
    } catch (e) {
      notify.error(e.message || 'The library updates could not be stopped');
    } finally {
      setStopping(false);
    }
  };

  const wipeAndResync = async () => {
    if (!isAdmin) return;
    const rootFolderId = (folderInput || '').trim() || config.rootFolderId;
    if (!rootFolderId) {
      notify.error('Select a Drive folder first');
      return;
    }

    const confirmed = await notify.confirm({
      title: 'Rebuild library',
      message: 'This will delete all indexed brochure data for this tenant and start a fresh sync from the selected folder.',
      confirmText: 'Rebuild',
      destructive: true,
    });
    if (!confirmed) return;

    setSyncing(true);
    setActiveJobId(null);
    try {
      const res = await fetchApi('/api/travel/knowledge-base/sync/wipe-and-resync', {
        method: 'POST',
        body: JSON.stringify({ rootFolderId }),
      });
      setActiveJobId(res.jobId || null);
      notify.success('Library cleared; fresh update started');
    } catch (e) {
      notify.error(e.message || 'The library could not be rebuilt');
      setSyncing(false);
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
      notify.success(`Library update finished: ${job.filesIndexed} added, ${job.filesFailed} failed`);
        } else if (job.status === 'stopped') {
      notify.info(`Library update stopped: ${job.filesIndexed} added, ${job.filesFailed} failed`);
        } else {
      notify.error(`Library update ${formatJobStatus(job.status).toLowerCase()}: ${job.errorMessage || 'unknown error'}`);
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
    if (!await notify.confirm({
      title: 'Remove brochure',
      message: 'Remove this brochure from the library?',
      confirmText: 'Remove',
      destructive: true,
    })) return;
    try {
      await fetchApi(`/api/travel/knowledge-base/files/${id}`, { method: 'DELETE' });
      notify.success('Brochure removed from library');
      await loadAll();
    } catch (e) {
      notify.error(e.message || 'Failed to remove file');
    }
  };

  const bulkDeleteFiles = async () => {
    if (!isAdmin) return;
    const ids = Array.from(selectedFileIds);
    if (ids.length === 0) return;
    if (!await notify.confirm({
      title: 'Remove Selected Files',
      message: `Remove ${ids.length} selected brochure${ids.length === 1 ? '' : 's'} from the library?`,
      confirmText: 'Remove',
      destructive: true,
    })) return;
    setBulkDeletingFiles(true);
    try {
      const res = await fetchApi('/api/travel/knowledge-base/files/bulk-delete', {
        method: 'POST',
        body: JSON.stringify({ ids }),
      });
      notify.success(`${res.deleted || ids.length} brochure${res.deleted === 1 ? '' : 's'} removed from library`);
      setSelectedFileIds(new Set());
      await loadAll();
    } catch (e) {
      notify.error(e.message || 'Failed to remove selected files');
    } finally {
      setBulkDeletingFiles(false);
    }
  };

  const bulkDeleteJobs = async () => {
    if (!isAdmin) return;
    const ids = Array.from(selectedJobIds);
    if (ids.length === 0) return;
    if (!await notify.confirm({
      title: 'Delete selected update history',
      message: `Delete ${ids.length} selected history item${ids.length === 1 ? '' : 's'}? Running updates must be stopped first.`,
      confirmText: 'Delete',
      destructive: true,
    })) return;
    setBulkDeletingJobs(true);
    try {
      const res = await fetchApi('/api/travel/knowledge-base/jobs/bulk-delete', {
        method: 'POST',
        body: JSON.stringify({ ids }),
      });
      notify.success(`${res.deleted || ids.length} history item${res.deleted === 1 ? '' : 's'} deleted`);
      setSelectedJobIds(new Set());
      await loadAll();
    } catch (e) {
      notify.error(e.message || 'Failed to delete selected jobs');
    } finally {
      setBulkDeletingJobs(false);
    }
  };

  const toggleFileSelection = (id) => {
    setSelectedFileIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAllFiles = (select) => {
    setSelectedFileIds(select ? new Set(files.map((f) => f.id)) : new Set());
  };

  const toggleJobSelection = (id) => {
    setSelectedJobIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAllJobs = (select) => {
    setSelectedJobIds(select ? new Set(jobs.map((j) => j.id)) : new Set());
  };

  const formatDate = (d) => {
    if (!d) return '—';
    try { return new Date(d).toLocaleString(); } catch { return String(d); }
  };

  const formatJobStatus = (value) => ({
    running: 'Updating',
    completed: 'Ready',
    stopped: 'Stopped',
    failed: 'Needs attention',
  }[value] || value || 'Unknown');

  const canSync = oauth.connected && oauth.rootFolderId && config.qdrantEnabled && config.embedEnabled;
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
          <div>Loading brochure library…</div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: 24, maxWidth: 1200, margin: '0 auto', color: 'var(--text-primary)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 16, flexWrap: 'wrap' }}>
        <Link to="/travel" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--text-secondary)', fontSize: 13, textDecoration: 'none' }}>
          <ArrowLeft size={16} /> Back to Travel
        </Link>
        <Link
          to="/travel/diagnostics"
          title="Open Diagnostics — brochures from this library help create trip recommendations."
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--text-secondary)', fontSize: 13, textDecoration: 'none' }}
        >
          <ArrowLeft size={16} /> Go to Diagnostics
        </Link>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 24, flexWrap: 'wrap' }}>
        <div style={{ width: 56, height: 56, borderRadius: 16, background: 'rgba(59,130,246,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Brain size={28} color="var(--accent-color)" />
        </div>
        <div>
          <h1 style={{ margin: 0, fontSize: 26, fontWeight: 700 }}>Travel Brochure Library</h1>
          <p style={{ margin: '4px 0 0', color: 'var(--text-secondary)', fontSize: 14 }}>
            Keep your travel brochures in one place so the CRM can use them when preparing trip recommendations.
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
              The brochure library service is not ready yet. Please ask your system administrator to finish the one-time setup.
            </span>
            </div>
          </div>
        )}

      {!oauth.configured && (
        <div className="card" style={{ padding: 20, marginBottom: 20, borderLeft: '4px solid #eab308', background: 'rgba(234,179,8,0.08)' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
            <AlertCircle size={22} color="#eab308" style={{ flexShrink: 0, marginTop: 2 }} />
            <div>
              <div style={{ fontWeight: 700, marginBottom: 4 }}>Google Drive connection needs one-time setup</div>
              <p style={{ margin: 0, lineHeight: 1.5, fontSize: 13, ...muted }}>
                Please ask your system administrator to finish the Google Drive setup before connecting.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Stepper */}
      <div className="card" style={{ padding: 20, marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 24, flexWrap: 'wrap' }}>
          {stepDot(STEP.CONFIG, 'Prepare connection')}
          <ChevronRight size={16} style={{ color: 'var(--text-secondary)' }} />
          {stepDot(STEP.CONNECT, 'Connect Google Drive')}
          <ChevronRight size={16} style={{ color: 'var(--text-secondary)' }} />
          {stepDot(STEP.FOLDER, 'Choose brochure folder')}
          <ChevronRight size={16} style={{ color: 'var(--text-secondary)' }} />
          {stepDot(STEP.SYNC, 'Update library')}
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
              <p style={{ margin: '4px 0 0', fontSize: 12, ...muted }}>The CRM will only read your brochure folders.</p>
            </div>
          </div>

          {!oauth.connected ? (
            <>
              <p style={{ fontSize: 13, lineHeight: 1.5, ...muted, marginBottom: 12 }}>
                Give the CRM permission to read the Drive folder that contains your TMC, RFU, Travel Stall, and Visa Sure brochures. You only need to do this once for your organisation.
              </p>
              <div style={{ padding: 12, borderRadius: 8, background: 'var(--bg-color)', fontSize: 12, ...muted, marginBottom: 16, lineHeight: 1.5 }}>
                If Google shows a warning before connecting, follow the on-screen instructions or ask your system administrator for help.
              </div>
              {isAdmin ? (
                <button className="btn-primary" onClick={connectDrive} disabled={connecting || !oauth.configured || completingOAuth} style={{ width: '100%', marginBottom: 12 }}>
                  <ExternalLink size={16} style={{ marginRight: 6 }} />
                  {connecting ? 'Opening Google…' : completingOAuth ? 'Completing…' : 'Connect Google Drive'}
                </button>
              ) : (
              <div style={{ padding: 12, borderRadius: 8, background: 'var(--bg-color)', fontSize: 13, ...muted, marginBottom: 12 }}>Only an organisation administrator can connect the brochure library.</div>
              )}
              <a
                href="/templates/brochure-template.zip"
                download
                className="btn-secondary"
                style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontSize: 12, textDecoration: 'none', width: '100%' }}
              >
                <Download size={14} /> Download brochure folder template
              </a>
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
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
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
              <a
                href="/templates/brochure-template.zip"
                download
                className="btn-secondary"
                style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontSize: 12, textDecoration: 'none', width: '100%' }}
              >
                <Download size={14} /> Download brochure folder template
              </a>
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border-color)', fontSize: 12, lineHeight: 1.5, ...muted }}>
            <FolderOpen size={15} style={{ flex: '0 0 auto', marginTop: 1, color: 'var(--accent-color)' }} />
            <span><strong style={{ color: 'var(--text-primary)' }}>TMC Catalogue uses this connection.</strong> The selected brochure folder supplies the PDFs shown in TMC Catalogue, including files in <strong style={{ color: 'var(--text-primary)' }}>TMC / CRM Itineraries</strong>.</span>
          </div>
        </div>

        {/* Folder picker card */}
        <div className="card" style={{ padding: 24 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
            <div style={{ width: 44, height: 44, borderRadius: 12, background: 'rgba(234,179,8,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <FolderOpen size={22} color="#eab308" />
            </div>
            <div>
              <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>2. Choose brochure folder</h2>
              <p style={{ margin: '4px 0 0', fontSize: 12, ...muted }}>All brochures inside this folder and its subfolders will be added.</p>
            </div>
          </div>

          {!oauth.connected ? (
            <div style={{ padding: 16, borderRadius: 8, background: 'var(--bg-color)', fontSize: 13, ...muted }}>Connect Google Drive above before choosing a folder.</div>
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
                                {isSelected ? 'Selected' : 'Use this folder'}
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
                <label style={{ display: 'block', fontSize: 12, ...muted, marginBottom: 6, fontWeight: 600 }}>Selected folder</label>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  <input
                    type="text"
                    className="input-field"
                    value={folderInput}
                    onChange={(e) => setFolderInput(e.target.value)}
                    placeholder="Folder ID (optional)"
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
                  <CheckCircle size={14} /> Brochure folder saved.
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
              <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>3. Update brochure library</h2>
              <p style={{ margin: '4px 0 0', fontSize: 12, ...muted }}>Add the latest brochures for each travel brand.</p>
            </div>
          </div>
          {isAdmin && (
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              {syncing && activeJobId ? (
                <button className="btn-danger" onClick={stopSync} disabled={stopping}>
                  <XCircle size={16} style={{ marginRight: 6 }} />
                  {stopping ? 'Stopping…' : 'Stop sync'}
                </button>
              ) : (
                <>
                  <button className="btn-primary" onClick={runSync} disabled={syncing || !canSync}>
                    <RefreshCw size={16} style={{ marginRight: 6, animation: syncing ? 'spin 1s linear infinite' : undefined }} />
                  {syncing ? 'Updating…' : 'Update library'}
                  </button>
                  <button
                    className="btn-secondary"
                    onClick={wipeAndResync}
                    disabled={syncing || !canSync}
                    title="Delete the current indexed brochure data and rebuild it from the selected folder"
                    style={{ color: '#ef4444', borderColor: 'rgba(239,68,68,0.4)' }}
                  >
                    <Trash2 size={16} style={{ marginRight: 6 }} />
                    Rebuild library
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        {config.embedProvider && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 12, borderRadius: 8, background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.25)', marginBottom: 16 }}>
            <Database size={16} color="var(--accent-color)" />
            <span style={{ fontSize: 13 }}>
              Search service: <strong>Ready</strong>
              . New brochures will be added to the library automatically.
            </span>
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 12, borderRadius: 8, background: 'rgba(59,130,246,0.06)', border: '1px solid rgba(59,130,246,0.2)', marginBottom: 16 }}>
          <AlertCircle size={16} color="var(--accent-color)" />
          <span style={{ fontSize: 13 }}>
            Trip recommendations also need the organisation&apos;s AI service to be enabled. If this message remains after setup, please ask your system administrator to check the AI settings.
          </span>
        </div>

        {(() => {
          if (!status?.activeProvider || !status?.providerChunks) return null;
          const activeChunks = status.providerChunks[status.activeProvider] || 0;
          const hasOtherData = Object.entries(status.providerChunks)
            .some(([k, v]) => k !== status.activeProvider && v > 0);
          if (activeChunks > 0 || !hasOtherData) return null;
          return (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 12, borderRadius: 8, background: 'rgba(234,179,8,0.08)', border: '1px solid rgba(234,179,8,0.25)', marginBottom: 16 }}>
              <AlertCircle size={16} color="#eab308" />
              <span style={{ fontSize: 13 }}>
                The search setup has changed, but the existing brochures need to be refreshed. Click <strong>Update library</strong> to bring everything up to date.
              </span>
            </div>
          );
        })()}

        {!canSync && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 12, borderRadius: 8, background: 'rgba(234,179,8,0.08)', border: '1px solid rgba(234,179,8,0.25)', marginBottom: 16 }}>
            <AlertCircle size={16} color="#eab308" />
            <span style={{ fontSize: 13 }}>
              {!oauth.connected && 'Connect Google Drive and choose a brochure folder before updating the library.'}
              {oauth.connected && !oauth.rootFolderId && 'Choose a brochure folder above before updating the library.'}
              {oauth.connected && oauth.rootFolderId && !config.qdrantEnabled && 'The brochure library service is not ready yet. Please ask your system administrator for help.'}
              {oauth.connected && oauth.rootFolderId && config.qdrantEnabled && !config.embedEnabled && 'The search service is not ready yet. Please ask your system administrator to check the AI settings.'}
            </span>
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
          {(status?.stats || []).length === 0 ? (
            <div style={{ padding: 16, borderRadius: 8, background: 'var(--bg-color)', border: '1px solid var(--border-color)', ...muted, fontSize: 13 }}>
              No brochures have been added yet. Choose a folder and update the library.
            </div>
          ) : (
            (status?.stats || []).map((s) => (
              <div key={s.subBrand} style={{ padding: 18, borderRadius: 10, background: 'var(--bg-color)', border: '1px solid var(--border-color)' }}>
                <div style={{ fontSize: 12, ...muted, marginBottom: 4 }}>{SUB_BRAND_LABELS[s.subBrand] || s.subBrand}</div>
                <div style={{ fontSize: 28, fontWeight: 700 }}>{s.filesActive}</div>
                <div style={{ fontSize: 12, ...muted }}>searchable content pieces</div>
                {s.filesFailed > 0 && <div style={{ fontSize: 12, color: '#ef4444', marginTop: 4 }}>{s.filesFailed} failed</div>}
              </div>
            ))
          )}
        </div>

        {status?.lastJob && (
          <div style={{ marginTop: 16, fontSize: 13, ...muted }}>
            Last update: <strong style={{ color: 'var(--text-primary)' }}>{formatJobStatus(status.lastJob.status)}</strong> on {formatDate(status.lastJob.startedAt)}
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
          <div style={{ flex: 1, minWidth: 0 }}>
            <h3 style={{ margin: '0 0 6px', fontSize: 15, fontWeight: 700 }}>How to organise your brochures</h3>
            <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, ...muted }}>
              Choose the main <strong>brochure</strong> folder. Inside it, keep one folder for each travel brand. The CRM will look through the folders underneath and add every PDF it finds.
            </p>
            <p style={{ margin: '8px 0 0', fontSize: 12, ...muted }}>
              New to this? Download the template above, place your PDFs in the matching brand folders, then upload the whole <strong>brochure</strong> folder to Google Drive.
            </p>
            <pre style={{ margin: '12px 0 0', padding: 12, borderRadius: 8, background: 'var(--bg-color)', fontSize: 12, overflowX: 'auto', color: 'var(--text-primary)' }}>
{`brochure/
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
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 12 }}>
            <h2 style={{ display: 'flex', alignItems: 'center', gap: 10, margin: 0, fontSize: 16, fontWeight: 700, flexWrap: 'wrap' }}>
              Update history
              <CountBadge count={jobs.length} title={`${jobs.length.toLocaleString()} library updates`} />
            </h2>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              {isAdmin && selectedJobIds.size > 0 && (
                <button
                  className="btn-danger"
                  onClick={bulkDeleteJobs}
                  disabled={bulkDeletingJobs}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
                >
                  <Trash2 size={14} />
                  {bulkDeletingJobs ? 'Deleting…' : `Delete selected (${selectedJobIds.size})`}
                </button>
              )}
              {isAdmin && jobs.some((j) => j.status === 'running') && (
                <button className="btn-danger" onClick={stopAllSyncs} disabled={stopping} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <XCircle size={14} />
                  {stopping ? 'Stopping…' : 'Stop all updates'}
                </button>
              )}
            </div>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ color: 'var(--text-secondary)', borderBottom: '1px solid var(--border-color)' }}>
                  {isAdmin && (
                    <th style={{ width: 40, padding: '10px 8px', textAlign: 'center', verticalAlign: 'middle' }}>
                      <input
                        type="checkbox"
                        checked={selectedJobIds.size > 0 && selectedJobIds.size === jobs.length}
                        onChange={(e) => toggleAllJobs(e.target.checked)}
                        aria-label="Select all jobs"
                        style={{ cursor: 'pointer', width: 16, height: 16, margin: 0, verticalAlign: 'middle' }}
                      />
                    </th>
                  )}
                  <th style={{ textAlign: 'left', padding: '10px 8px', fontWeight: 700 }}>Started</th>
                  <th style={{ textAlign: 'left', padding: '10px 8px', fontWeight: 700 }}>Status</th>
                  <th style={{ textAlign: 'right', padding: '10px 8px', fontWeight: 700 }}>Found</th>
                  <th style={{ textAlign: 'right', padding: '10px 8px', fontWeight: 700 }}>Added</th>
                  <th style={{ textAlign: 'right', padding: '10px 8px', fontWeight: 700 }}>Failed</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <tr key={job.id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                    {isAdmin && (
                      <td style={{ width: 40, padding: '10px 8px', textAlign: 'center', verticalAlign: 'middle' }}>
                        <input
                          type="checkbox"
                          checked={selectedJobIds.has(job.id)}
                          onChange={() => toggleJobSelection(job.id)}
                          aria-label={`Select sync job ${job.id}`}
                          style={{ cursor: 'pointer', width: 16, height: 16, margin: 0, verticalAlign: 'middle' }}
                        />
                      </td>
                    )}
                    <td style={{ padding: '10px 8px' }}>{formatDate(job.startedAt)}</td>
                    <td style={{ padding: '10px 8px' }}>
                      {job.status === 'completed' ? <CheckCircle size={14} color="#22c55e" /> : <XCircle size={14} color="#ef4444" />}
                      {' '}<span>{formatJobStatus(job.status)}</span>
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
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 12 }}>
            <h2 style={{ display: 'flex', alignItems: 'center', gap: 10, margin: 0, fontSize: 16, fontWeight: 700, flexWrap: 'wrap' }}>
              Brochures in library
              <CountBadge count={indexedFilesCount} title={`${indexedFilesCount.toLocaleString()} brochures in library`} />
            </h2>
            {isAdmin && selectedFileIds.size > 0 && (
              <button
                className="btn-danger"
                onClick={bulkDeleteFiles}
                disabled={bulkDeletingFiles}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
              >
                <Trash2 size={14} />
                {bulkDeletingFiles ? 'Removing…' : `Remove selected (${selectedFileIds.size})`}
              </button>
            )}
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ color: 'var(--text-secondary)', borderBottom: '1px solid var(--border-color)' }}>
                  {isAdmin && (
                    <th style={{ width: 40, padding: '10px 8px', textAlign: 'center', verticalAlign: 'middle' }}>
                      <input
                        type="checkbox"
                        checked={selectedFileIds.size > 0 && selectedFileIds.size === files.length}
                        onChange={(e) => toggleAllFiles(e.target.checked)}
                        aria-label="Select all files"
                        style={{ cursor: 'pointer', width: 16, height: 16, margin: 0, verticalAlign: 'middle' }}
                      />
                    </th>
                  )}
                  <th style={{ textAlign: 'left', padding: '10px 8px', fontWeight: 700 }}>Travel brand</th>
                  <th style={{ textAlign: 'left', padding: '10px 8px', fontWeight: 700 }}>Brochure</th>
                  <th style={{ textAlign: 'left', padding: '10px 8px', fontWeight: 700 }}>Location</th>
                  <th style={{ textAlign: 'left', padding: '10px 8px', fontWeight: 700 }}>Status</th>
                  <th style={{ textAlign: 'left', padding: '10px 8px', fontWeight: 700 }}>Added</th>
                  {isAdmin && <th style={{ width: 60 }} />}
                </tr>
              </thead>
              <tbody>
                {files.map((file) => (
                  <tr key={file.id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                    {isAdmin && (
                      <td style={{ width: 40, padding: '10px 8px', textAlign: 'center', verticalAlign: 'middle' }}>
                        <input
                          type="checkbox"
                          checked={selectedFileIds.has(file.id)}
                          onChange={() => toggleFileSelection(file.id)}
                          aria-label={`Select file ${file.fileName}`}
                          style={{ cursor: 'pointer', width: 16, height: 16, margin: 0, verticalAlign: 'middle' }}
                        />
                      </td>
                    )}
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
