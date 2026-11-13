import React, { useState, useEffect, useCallback, useRef } from 'react';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';
import { formatDate } from '../utils/date';
import { AuthContext } from '../appContexts';
import { Ticket, Plus, Trash2, AlertTriangle, X, MessageCircle } from 'lucide-react';
import './Tickets.css';

const PRIORITY_CONFIG = {
  Urgent:  { color: '#ef4444', bg: 'rgba(239,68,68,0.08)' },
  High:    { color: '#f97316', bg: 'rgba(249,115,22,0.08)' },
  Medium:  { color: '#3b82f6', bg: 'rgba(59,130,246,0.08)' },
  Low:     { color: '#64748b', bg: 'rgba(100,116,139,0.08)' },
};

const STATUS_CONFIG = {
  Open:     { color: '#3b82f6', bg: 'rgba(59,130,246,0.1)' },
  Pending:  { color: '#f59e0b', bg: 'rgba(245,158,11,0.1)' },
  Resolved: { color: '#10b981', bg: 'rgba(16,185,129,0.1)' },
  Closed:   { color: '#6b7280', bg: 'rgba(107,114,128,0.1)' },
};

function Badge({ label, config }) {
  const cfg = config[label] || { color: '#6b7280', bg: 'rgba(107,114,128,0.08)' };
  return (
    <span style={{
      padding: '0.2rem 0.6rem', borderRadius: '999px', fontSize: '0.7rem',
      fontWeight: 'bold', backgroundColor: cfg.bg, color: cfg.color,
      border: `1px solid ${cfg.color}33`, whiteSpace: 'nowrap',
    }}>
      {label}
    </span>
  );
}

const EMPTY_FORM = { subject: '', description: '', priority: 'Medium', assigneeId: '' };
const PAGE_SIZE_PRESETS = [10, 20, 30, 50];
const DEFAULT_PAGE_SIZE = 10;

export default function Tickets() {
  const notify = useNotify();
  const { tenant } = React.useContext(AuthContext);
  const [isGenericVertical, setIsGenericVertical] = useState(() => (
    typeof document !== 'undefined' && document.body?.dataset.vertical === 'generic'
  ));
  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const updateVertical = () => setIsGenericVertical(document.body?.dataset.vertical === 'generic');
    updateVertical();
    const observer = new MutationObserver(updateVertical);
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-vertical'] });
    return () => observer.disconnect();
  }, []);
  const [tickets, setTickets] = useState([]);
  const [users, setUsers] = useState([]);
  const [form, setForm] = useState(EMPTY_FORM);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [pageSizeMode, setPageSizeMode] = useState(String(DEFAULT_PAGE_SIZE));
  const [customPageSize, setCustomPageSize] = useState(String(DEFAULT_PAGE_SIZE));
  const [totalTickets, setTotalTickets] = useState(0);
  const [openCount, setOpenCount] = useState(0);
  const [urgentCount, setUrgentCount] = useState(0);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [isTicketDetailOpen, setIsTicketDetailOpen] = useState(false);
  const [ticketDetail, setTicketDetail] = useState(null);
  const [ticketDetailLoading, setTicketDetailLoading] = useState(false);
  const [ticketDetailSaving, setTicketDetailSaving] = useState(false);
  const [detailResolutionNotes, setDetailResolutionNotes] = useState('');
  const [resolutionEmailTemplate, setResolutionEmailTemplate] = useState('');
  const [isResolutionTemplateGenerated, setIsResolutionTemplateGenerated] = useState(false);
  const [isConversationModalOpen, setIsConversationModalOpen] = useState(false);
  const [resolutionPromptTicket, setResolutionPromptTicket] = useState(null);
  const [resolutionPromptNotes, setResolutionPromptNotes] = useState('');
  const [resolutionPromptSaving, setResolutionPromptSaving] = useState(false);
  const ticketsTableScrollRef = useRef(null);
  const isResolvedGenericTicketWithoutQuestions = Boolean(
    ticketDetail?.sourceConversationId
    && String(ticketDetail.status || '').toLowerCase() === 'resolved'
    && !(ticketDetail.conversation?.unresolvedQuestions?.length)
  );

  const loadData = useCallback(async (targetPage = 1, targetPageSize = pageSize) => {
    try {
      setLoading(true);
      const [t, u] = await Promise.all([
        fetchApi(`/api/tickets?page=${targetPage}&limit=${targetPageSize}`),
        fetchApi('/api/auth/users').catch(() => []),
      ]);
      const ticketList = Array.isArray(t) ? t : Array.isArray(t?.tickets) ? t.tickets : [];
      setTickets(ticketList);
      setTotalTickets(Array.isArray(t) ? ticketList.length : Number(t?.total) || ticketList.length);
      setOpenCount(Array.isArray(t) ? ticketList.filter((ticket) => ticket.status === 'Open').length : Number(t?.openCount) || 0);
      setUrgentCount(Array.isArray(t) ? ticketList.filter((ticket) => ticket.priority === 'Urgent' && ticket.status !== 'Closed').length : Number(t?.urgentCount) || 0);
      if (!Array.isArray(t) && Number.isFinite(Number(t?.page)) && Number(t.page) !== targetPage) {
        setPage(Number(t.page));
      }
      setUsers(Array.isArray(u) ? u : []);
    } catch (err) {
      console.error('Failed to load tickets:', err);
    } finally {
      setLoading(false);
    }
  }, [pageSize]);

  useEffect(() => { loadData(page, pageSize); }, [page, pageSize, loadData]);

  useEffect(() => {
    if (!isCreateModalOpen) return undefined;
    const previousOverflow = document.body.style.overflow;
    const mainContent = document.querySelector('.app-main > main');
    const previousMainOverflow = mainContent?.style.overflow;
    document.body.style.overflow = 'hidden';
    if (mainContent) mainContent.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
      if (mainContent) mainContent.style.overflow = previousMainOverflow;
    };
  }, [isCreateModalOpen]);

  const createTicket = async (e) => {
    e.preventDefault();
    try {
      const payload = {
        subject: form.subject,
        description: form.description || null,
        priority: form.priority,
      };
      if (form.assigneeId) {
        payload.assigneeId = parseInt(form.assigneeId, 10);
      }
      await fetchApi('/api/tickets', { method: 'POST', body: JSON.stringify(payload) });
      setForm(EMPTY_FORM);
      setIsCreateModalOpen(false);
      if (page === 1) {
        await loadData(1);
      } else {
        setPage(1);
      }
    } catch (err) {
      notify.error('Failed to create ticket.');
    }
  };

  const updateStatus = async (id, status) => {
    try {
      const current = tickets.find((ticket) => ticket.id === id);
      const payload = { status };
      if (status === 'Resolved' && current?.sourceConversationId) {
        setResolutionPromptTicket(current);
        setResolutionPromptNotes(current.resolutionNotes || '');
        return;
      }
      await fetchApi(`/api/tickets/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
      loadData(page);
    } catch (err) {
      console.error('Failed to update ticket status:', err);
    }
  };

  const submitResolutionPrompt = async (event) => {
    event.preventDefault();
    if (!resolutionPromptTicket || !resolutionPromptNotes.trim()) {
      notify.error('Enter the answer before resolving this ticket.');
      return;
    }
    setResolutionPromptSaving(true);
    try {
      await fetchApi(`/api/tickets/${resolutionPromptTicket.id}`, {
        method: 'PUT',
        body: JSON.stringify({ status: 'Resolved', resolutionNotes: resolutionPromptNotes.trim() }),
      });
      setResolutionPromptTicket(null);
      setResolutionPromptNotes('');
      await loadData(page);
    } catch (err) {
      console.error('Failed to resolve ticket:', err);
      notify.error(err?.message || 'Failed to resolve ticket.');
    } finally {
      setResolutionPromptSaving(false);
    }
  };

  const updateAssignee = async (id, assigneeId) => {
    try {
      await fetchApi(`/api/tickets/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ assigneeId: assigneeId ? parseInt(assigneeId, 10) : null }),
      });
      loadData(page);
    } catch (err) {
      console.error('Failed to update ticket assignee:', err);
    }
  };

  const openTicketDetails = async (ticket) => {
    setIsTicketDetailOpen(true);
    setTicketDetail(null);
    setTicketDetailLoading(true);
    try {
      const details = await fetchApi(`/api/tickets/${ticket.id}`);
      setTicketDetail(details);
      setDetailResolutionNotes(details.resolutionNotes || '');
      setResolutionEmailTemplate('');
      setIsResolutionTemplateGenerated(false);
    } catch (err) {
      console.error('Failed to load ticket details:', err);
      setIsTicketDetailOpen(false);
      notify.error('Failed to load ticket details.');
    } finally {
      setTicketDetailLoading(false);
    }
  };

  const generateResolutionEmail = () => {
    if (!ticketDetail) return;
    if (ticketDetail.sourceConversationId && !detailResolutionNotes.trim()) {
      notify.error('Enter the answer before resolving this ticket.');
      return;
    }
    const greetingName = ticketDetail.requesterName || 'there';
    setResolutionEmailTemplate([
      `Hi ${greetingName},`,
      '',
      detailResolutionNotes.trim(),
      '',
      'Regards,',
      'Globus CRM Support',
    ].join('\n'));
    setIsResolutionTemplateGenerated(true);
  };

  const sendResolutionEmail = async () => {
    if (!ticketDetail || !resolutionEmailTemplate.trim()) return;
    setTicketDetailSaving(true);
    try {
      const payload = { status: 'Resolved' };
      if (ticketDetail.sourceConversationId) payload.resolutionNotes = detailResolutionNotes.trim();
      if (ticketDetail.sourceConversationId) payload.resolutionEmailTemplate = resolutionEmailTemplate.trim();
      await fetchApi(`/api/tickets/${ticketDetail.id}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
        silent: true,
      });
      await loadData(page);
      setIsConversationModalOpen(false);
      setIsTicketDetailOpen(false);
    } catch (err) {
      console.error('Failed to update ticket:', err);
      notify.error(err?.message || 'The ticket could not be resolved or the email could not be sent.');
      await loadData(page);
      await openTicketDetails({ id: ticketDetail.id });
    } finally {
      setTicketDetailSaving(false);
    }
  };

  const saveTicketAsPending = async () => {
    if (!ticketDetail || !detailResolutionNotes.trim()) {
      notify.error('Enter an answer before saving the ticket.');
      return;
    }
    setTicketDetailSaving(true);
    try {
      await fetchApi(`/api/tickets/${ticketDetail.id}`, {
        method: 'PUT',
        body: JSON.stringify({ status: 'Pending', resolutionNotes: detailResolutionNotes.trim() }),
        silent: true,
      });
      await loadData(page);
      setIsConversationModalOpen(false);
      setIsTicketDetailOpen(false);
    } catch (err) {
      console.error('Failed to save ticket:', err);
      notify.error(err?.message || 'The ticket could not be saved.');
    } finally {
      setTicketDetailSaving(false);
    }
  };

  const deleteTicket = async (id) => {
    if (!await notify.confirm({
      title: 'Delete ticket',
      message: 'Delete this ticket?',
      confirmText: 'Delete',
      destructive: true,
    })) return;
    try {
      await fetchApi(`/api/tickets/${id}`, { method: 'DELETE' });
      loadData(page);
    } catch (err) {
      console.error('Failed to delete ticket:', err);
    }
  };

  const updateField = (field, value) => {
    setForm({ ...form, [field]: value });
  };
  const handlePageSizeModeChange = (value) => {
    setPageSizeMode(value);
    if (value === 'custom') {
      setCustomPageSize(String(pageSize));
      return;
    }
    const nextPageSize = parseInt(value, 10);
    if (!Number.isFinite(nextPageSize) || nextPageSize <= 0) return;
    setPageSize(nextPageSize);
    setPage(1);
  };
  const applyCustomPageSize = () => {
    const parsed = parseInt(customPageSize, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return;
    const nextPageSize = Math.min(100, parsed);
    setPageSize(nextPageSize);
    setPageSizeMode('custom');
    setCustomPageSize(String(nextPageSize));
    setPage(1);
  };
  const totalPages = Math.max(1, Math.ceil(totalTickets / pageSize));
  const showPagination = totalTickets > pageSize;
  const startItem = totalTickets === 0 ? 0 : ((page - 1) * pageSize) + 1;
  const endItem = Math.min(page * pageSize, totalTickets);
  // Tickets is a Generic CRM surface unless a vertical-specific tenant is
  // explicitly active. This avoids the first mobile render briefly falling
  // back to the fluid ten-column layout before the tenant/body metadata is
  // hydrated.
  const genericTicketLayout = tenant?.vertical !== 'wellness'
    && tenant?.vertical !== 'travel';
  const genericTicketColumnWidths = [
    'auto', 'auto', 'auto', 'auto', 'auto',
    'auto', 'auto', 'auto', 'auto', 'auto',
  ];

  useEffect(() => {
    if (genericTicketLayout && ticketsTableScrollRef.current) {
      ticketsTableScrollRef.current.scrollLeft = 0;
    }
  }, [genericTicketLayout, tickets]);

  return (
    <div className="tickets-page" style={{ padding: '2rem', minHeight: '100%', animation: 'fadeIn 0.5s ease-out' }}>
      <header className="tickets-page-header" style={{ marginBottom: '2rem' }}>
        <div>
          <h1 style={{ fontSize: '2rem', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <Ticket size={26} color="var(--accent-color)" /> Support Tickets
          </h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
            Track and resolve customer support requests.
          </p>
        </div>
        <button
          type="button"
          className="btn-primary tickets-create-button"
          onClick={() => setIsCreateModalOpen(true)}
        >
          <Plus size={17} /> Create Ticket
        </button>
      </header>

      {/* Stats bar */}
      {totalTickets > 0 && (
        <div className="tickets-summary-cards" role="group" aria-label="Ticket summary">
          <div className="tickets-summary-card">
            <span className="tickets-summary-card__label">TOTAL TICKETS</span>
            <strong>{totalTickets}</strong>
            <span className="tickets-summary-card__hint">All support tickets</span>
          </div>
          <div className="tickets-summary-card tickets-summary-card--open">
            <span className="tickets-summary-card__label">OPEN TICKETS</span>
            <strong>{openCount}</strong>
            <span className="tickets-summary-card__hint">Awaiting resolution</span>
          </div>
          <div className="tickets-summary-card tickets-summary-card--urgent">
            <span className="tickets-summary-card__label">URGENT TICKETS</span>
            <strong>{urgentCount}</strong>
            <span className="tickets-summary-card__hint">Needs immediate attention</span>
          </div>
        </div>
      )}

      {isCreateModalOpen && (
        <div className="tickets-modal-backdrop" role="presentation" onMouseDown={(e) => {
          if (e.target === e.currentTarget) setIsCreateModalOpen(false);
        }}>
          <div className="card tickets-create-modal" role="dialog" aria-modal="true" aria-labelledby="create-ticket-title">
            <div className="tickets-modal-header">
              <h2 id="create-ticket-title">
                <Plus size={20} color="var(--accent-color)" /> Create Ticket
              </h2>
              <button
                type="button"
                className="tickets-modal-close"
                aria-label="Close create ticket dialog"
                onClick={() => setIsCreateModalOpen(false)}
              >
                <X size={20} />
              </button>
            </div>
          <form onSubmit={createTicket} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            <div>
              <label style={{ display: 'block', fontSize: '0.875rem', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>Subject</label>
              <input
                type="text" required className="input-field" placeholder="e.g. Login page not loading"
                value={form.subject} onChange={e => updateField('subject', e.target.value)}
              />
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.875rem', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>Description</label>
              <textarea
                className="input-field" rows="4" placeholder="Describe the issue..."
                value={form.description} onChange={e => updateField('description', e.target.value)}
              />
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.875rem', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>Priority</label>
              <select
                className="input-field" value={form.priority}
                onChange={e => updateField('priority', e.target.value)}
                style={{ background: 'var(--input-bg)' }}
              >
                <option value="Low">Low</option>
                <option value="Medium">Medium</option>
                <option value="High">High</option>
                <option value="Urgent">Urgent</option>
              </select>
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.875rem', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>Assignee</label>
              <select
                className="input-field" value={form.assigneeId}
                onChange={e => updateField('assigneeId', e.target.value)}
                style={{ background: 'var(--input-bg)' }}
              >
                <option value="">-- Unassigned --</option>
                {users.map(u => (
                  <option key={u.id} value={u.id}>{u.name || u.email} ({u.email})</option>
                ))}
              </select>
            </div>

            <button type="submit" className="btn-primary" style={{ padding: '1rem' }}>
              Submit Ticket
            </button>
          </form>
          </div>
        </div>
      )}

      {resolutionPromptTicket && (
        <div
          className="tickets-modal-backdrop"
          role="presentation"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !resolutionPromptSaving) setResolutionPromptTicket(null);
          }}
        >
          <div className="card tickets-create-modal" role="dialog" aria-modal="true" aria-labelledby="ticket-resolution-prompt-title">
            <div className="tickets-modal-header">
              <h2 id="ticket-resolution-prompt-title">
                <MessageCircle size={20} color="var(--accent-color)" /> Answer visitor
              </h2>
              <button
                type="button"
                className="tickets-modal-close"
                aria-label="Close answer dialog"
                onClick={() => setResolutionPromptTicket(null)}
                disabled={resolutionPromptSaving}
              >
                <X size={20} />
              </button>
            </div>
            <form onSubmit={submitResolutionPrompt} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <p style={{ margin: 0, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                Enter the answer to send to the visitor before resolving “{resolutionPromptTicket.subject}”.
              </p>
              <label htmlFor="ticket-resolution-prompt-notes" style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', fontWeight: 600 }}>
                Answer
              </label>
              <textarea
                id="ticket-resolution-prompt-notes"
                rows="6"
                autoFocus
                required
                value={resolutionPromptNotes}
                onChange={(e) => setResolutionPromptNotes(e.target.value)}
                placeholder="Write the answer for the visitor..."
                className="input-field"
                style={{ resize: 'vertical', minHeight: 130 }}
              />
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem' }}>
                <button type="button" className="btn-secondary" onClick={() => setResolutionPromptTicket(null)} disabled={resolutionPromptSaving}>
                  Cancel
                </button>
                <button type="submit" className="btn-primary" disabled={resolutionPromptSaving || !resolutionPromptNotes.trim()}>
                  {resolutionPromptSaving ? 'Resolving...' : 'Resolve ticket'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {isTicketDetailOpen && (
        <div className="tickets-modal-backdrop tickets-detail-backdrop" role="presentation" onMouseDown={(e) => {
          if (e.target === e.currentTarget) setIsTicketDetailOpen(false);
        }}>
          <div className="card tickets-detail-modal" role="dialog" aria-modal="true" aria-labelledby="ticket-detail-title">
            <div className="tickets-modal-header">
              <h2 id="ticket-detail-title">
                <Ticket size={20} color="var(--accent-color)" /> Ticket details
              </h2>
              <button
                type="button"
                className="tickets-modal-close"
                aria-label="Close ticket details"
                onClick={() => { setIsConversationModalOpen(false); setIsTicketDetailOpen(false); }}
              >
                <X size={20} />
              </button>
            </div>

            {ticketDetailLoading ? (
              <p className="tickets-detail-empty">Loading ticket details...</p>
            ) : ticketDetail ? (
              <div className="tickets-detail-content">
                <div className="tickets-detail-summary">
                  <h3>Ticket #{ticketDetail.id}</h3>
                  <div className="tickets-detail-row"><span>Subject</span><strong>{ticketDetail.subject}</strong></div>
                  <div className="tickets-detail-row"><span>Lead name</span><strong>{ticketDetail.requesterName || '—'}</strong></div>
                  <div className="tickets-detail-row"><span>Lead email</span><strong>{ticketDetail.requesterEmail || '—'}</strong></div>
                  <div className="tickets-detail-row"><span>Status</span><div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}><Badge label={ticketDetail.status} config={STATUS_CONFIG} />{ticketDetail.sourceConversationId && String(ticketDetail.status || '').toLowerCase() === 'resolved' && ticketDetail.requesterEmail && <small style={{ color: '#059669', fontWeight: 600 }}>Resolution email sent</small>}</div></div>
                  <div className="tickets-detail-row"><span>Priority</span><Badge label={ticketDetail.priority} config={PRIORITY_CONFIG} /></div>
                  <div className="tickets-detail-row"><span>Assignee</span><strong>{ticketDetail.assignee?.name || ticketDetail.assignee?.email || 'Unassigned'}</strong></div>
                  <div className="tickets-detail-row"><span>Created</span><strong>{formatDate(ticketDetail.createdAt)}</strong></div>
                  <div className="tickets-detail-row"><span>Last updated</span><strong>{formatDate(ticketDetail.updatedAt)}</strong></div>
                </div>

                <section className="tickets-detail-section">
                  <div className="tickets-detail-section-heading">
                    <h3>Unresolved questions</h3>
                    {ticketDetail.conversation?.messages?.length > 0 && (
                      <button type="button" className="tickets-view-conversation-button" onClick={() => setIsConversationModalOpen(true)}>
                        <MessageCircle size={14} /> View full conversation
                      </button>
                    )}
                  </div>
                  {ticketDetail.conversation?.unresolvedQuestions?.length ? (
                    <ul className="tickets-unresolved-list">
                      {ticketDetail.conversation.unresolvedQuestions.map((question, index) => (
                        <li key={`${question}-${index}`}>{question}</li>
                      ))}
                    </ul>
                  ) : (
                    <p className="tickets-detail-empty">No unresolved questions recorded.</p>
                  )}
                </section>

                {!isResolvedGenericTicketWithoutQuestions && <section className="tickets-detail-resolution">
                  {ticketDetail.sourceConversationId && (
                    <>
                      <label htmlFor="ticket-resolution-notes">Answer for unresolved questions</label>
                      <textarea
                        id="ticket-resolution-notes"
                        rows="4"
                        value={detailResolutionNotes}
                        onChange={e => setDetailResolutionNotes(e.target.value)}
                        placeholder="Write the answer that should be sent to the lead when the ticket is resolved..."
                      />
                      {isResolutionTemplateGenerated && (
                        <>
                          <label htmlFor="ticket-resolution-email-template">Email template</label>
                          <textarea
                            id="ticket-resolution-email-template"
                            rows="7"
                            value={resolutionEmailTemplate}
                            onChange={e => setResolutionEmailTemplate(e.target.value)}
                          />
                        </>
                      )}
                    </>
                  )}
                  <div className="tickets-detail-action-row">
                    <button type="button" className="tickets-detail-save-button" onClick={saveTicketAsPending} disabled={ticketDetailSaving}>
                      Save
                    </button>
                    <button
                      type="button"
                      className="btn-primary"
                      onClick={ticketDetail.sourceConversationId
                        ? (isResolutionTemplateGenerated ? sendResolutionEmail : generateResolutionEmail)
                        : sendResolutionEmail}
                      disabled={ticketDetailSaving}
                    >
                      {ticketDetailSaving ? 'Processing...' : (ticketDetail.sourceConversationId && isResolutionTemplateGenerated ? 'Send email' : 'Resolve')}
                    </button>
                  </div>
                </section>}
              </div>
            ) : null}
          </div>
        </div>
      )}

      {isConversationModalOpen && ticketDetail?.conversation?.messages?.length > 0 && (
        <div className="tickets-conversation-modal-backdrop" role="presentation" onMouseDown={(e) => {
          if (e.target === e.currentTarget) setIsConversationModalOpen(false);
        }}>
          <section className="tickets-conversation-modal" role="dialog" aria-modal="true" aria-labelledby="full-conversation-title">
            <header className="tickets-conversation-modal-header">
              <div>
                <strong id="full-conversation-title">Globus CRM assistant</strong>
                <span>Full conversation for Ticket #{ticketDetail.id}</span>
              </div>
              <button type="button" aria-label="Close full conversation" onClick={() => setIsConversationModalOpen(false)}>
                <X size={18} />
              </button>
            </header>
            <div className="tickets-conversation-modal-messages">
              {ticketDetail.conversation.messages.map((item, index) => (
                <div className={`tickets-chat-message tickets-chat-message--${item.role === 'user' ? 'lead' : 'assistant'}`} key={`${item.at || 'message'}-${index}`}>
                  <strong>{item.role === 'user' ? 'Lead' : 'Globus CRM assistant'}</strong>
                  <p>{item.content}</p>
                  {item.at && <time>{formatDate(item.at)}</time>}
                </div>
              ))}
            </div>
          </section>
        </div>
      )}

      <div className="tickets-grid" style={{ display: 'block', marginTop: '1.5rem' }}>

        {/* Tickets Table */}
        <div className="card tickets-list-card" style={{ padding: '2rem', overflow: 'hidden' }}>
          <h3 style={{ fontSize: '1.15rem', fontWeight: '600', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Ticket size={20} color="var(--accent-color)" /> All Tickets
          </h3>

          {loading ? (
            <p style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '2rem' }}>Loading...</p>
          ) : tickets.length === 0 ? (
            <p style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '2rem' }}>
              No tickets found. Create one to get started.
            </p>
          ) : (
            <div
              className={`tickets-table-scroll${genericTicketLayout ? ' tickets-table-scroll--generic' : ''}`}
              ref={ticketsTableScrollRef}
              style={{
                overflowX: genericTicketLayout ? 'scroll' : 'auto',
                minWidth: 0,
                width: '100%',
              }}
            >
              {/* #633: stable-table — pins tableLayout=fixed so row hover never jumps column widths. */}
              <table className={`stable-table tickets-table${genericTicketLayout ? ' tickets-table--generic' : ''}`} style={{
                borderCollapse: 'collapse',
                fontSize: '0.875rem',
                ...(genericTicketLayout ? { width: 'max-content', minWidth: '100%', maxWidth: 'none', tableLayout: 'auto' } : {}),
              }}>
                <colgroup>
                  {/* Keep the fixed table widths within 100% so the card does
                      not create an avoidable horizontal overflow. */}
                  {[4, 21, 12, 16, 9, 7, 11, 7, 7, 6].map((percentage, index) => (
                    <col
                      key={`ticket-column-${index}`}
                      style={{ width: genericTicketLayout ? genericTicketColumnWidths[index] : `${percentage}%` }}
                    />
                  ))}
                </colgroup>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
                    {['ID', 'Subject', 'Lead Name', 'Lead Email', 'Status', 'Priority', 'Assignee', 'Created', 'Last Updated', 'Actions'].map(h => (
                      <th key={h} style={{
                        padding: '0.75rem 0.5rem', textAlign: 'left', color: 'var(--text-secondary)',
                        fontSize: '0.75rem', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.05em',
                      }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {tickets.map(ticket => (
                    <tr key={ticket.id} onClick={() => openTicketDetails(ticket)} style={{ borderBottom: '1px solid var(--border-color)', transition: '0.15s', cursor: 'pointer' }}
                      onMouseEnter={e => {
                        if (!isGenericVertical) e.currentTarget.style.background = 'var(--subtle-bg-2)';
                      }}
                      onMouseLeave={e => {
                        if (!isGenericVertical) e.currentTarget.style.background = 'transparent';
                      }}
                    >
                      <td style={{ padding: '0.75rem 0.5rem', color: 'var(--text-secondary)' }}>#{ticket.id}</td>
                      <td title={ticket.subject} style={{ padding: '0.75rem 0.5rem', fontWeight: '500' }}>{ticket.subject}</td>
                      <td style={{ padding: '0.75rem 0.5rem' }}>{ticket.requesterName || ''}</td>
                      <td style={{ padding: '0.75rem 0.5rem' }}>{ticket.requesterEmail || ''}</td>
                      <td style={{ padding: '0.75rem 0.5rem' }}>
                        <select
                          value={ticket.status}
                          onClick={e => e.stopPropagation()}
                          onChange={e => updateStatus(ticket.id, e.target.value)}
                          style={{
                            background: STATUS_CONFIG[ticket.status]?.bg || 'transparent',
                            color: STATUS_CONFIG[ticket.status]?.color || 'inherit',
                            border: `1px solid ${STATUS_CONFIG[ticket.status]?.color || 'var(--border-color)'}33`,
                            borderRadius: '999px', padding: '0.2rem 0.5rem', fontSize: '0.75rem',
                            fontWeight: 'bold', cursor: 'pointer', outline: 'none',
                          }}
                        >
                          <option value="Open">Open</option>
                          <option value="Pending">Pending</option>
                          <option value="Resolved">Resolved</option>
                          <option value="Closed">Closed</option>
                        </select>
                      </td>
                      <td style={{ padding: '0.75rem 0.5rem' }}>
                        <Badge label={ticket.priority} config={PRIORITY_CONFIG} />
                      </td>
                      <td style={{ padding: '0.75rem 0.5rem', color: 'var(--text-secondary)' }}>
                        <select
                          aria-label={`Assignee for ticket ${ticket.id}`}
                          value={ticket.assigneeId || ''}
                          onClick={e => e.stopPropagation()}
                          onChange={e => updateAssignee(ticket.id, e.target.value)}
                          style={{
                            maxWidth: '100%', background: 'transparent', color: 'inherit',
                            border: '1px solid var(--border-color)', borderRadius: '6px',
                            padding: '0.25rem 0.35rem', fontSize: '0.75rem', cursor: 'pointer',
                          }}
                        >
                          <option value="">Unassigned</option>
                          {users.map(user => (
                            <option key={user.id} value={user.id}>{user.name || user.email}</option>
                          ))}
                        </select>
                      </td>
                      <td style={{ padding: '0.75rem 0.5rem', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                        {formatDate(ticket.createdAt)}
                      </td>
                      <td style={{ padding: '0.75rem 0.5rem', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                        {formatDate(ticket.updatedAt)}
                      </td>
                      <td style={{ padding: '0.75rem 0.5rem' }}>
                        <button
                          onClick={e => { e.stopPropagation(); deleteTicket(ticket.id); }}
                          title="Delete ticket"
                          style={{
                            background: 'rgba(239,68,68,0.1)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.2)',
                            borderRadius: '6px', padding: '0.35rem 0.5rem', cursor: 'pointer', display: 'flex',
                            alignItems: 'center', gap: '0.3rem', fontSize: '0.75rem',
                          }}
                        >
                          <Trash2 size={13} /> Delete
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      {!loading && totalTickets > 0 && (
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: '1rem',
              marginTop: '1.5rem',
              flexWrap: 'wrap',
            }}>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', margin: 0 }}>
                Showing {startItem}-{endItem} of {totalTickets} tickets
              </p>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <label style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                  color: 'var(--text-secondary)',
                  fontSize: '0.875rem',
                }}>
                  <span>Rows per page</span>
                  <select
                    aria-label="Rows per page"
                    value={pageSizeMode === 'custom' ? 'custom' : String(pageSize)}
                    onChange={(e) => handlePageSizeModeChange(e.target.value)}
                    style={{
                      padding: '0.55rem 0.75rem',
                      borderRadius: '8px',
                      border: '1px solid var(--border-color)',
                      background: 'var(--input-bg)',
                      color: 'var(--text-primary)',
                    }}
                  >
                    {PAGE_SIZE_PRESETS.map((size) => (
                      <option key={size} value={size}>{size}</option>
                    ))}
                    <option value="custom">Custom</option>
                  </select>
                </label>
                {pageSizeMode === 'custom' && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <input
                      type="number"
                      min="1"
                      max="100"
                      aria-label="Custom rows per page"
                      value={customPageSize}
                      onChange={(e) => setCustomPageSize(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          applyCustomPageSize();
                        }
                      }}
                      placeholder="Type number"
                      style={{
                        width: '120px',
                        padding: '0.55rem 0.75rem',
                        borderRadius: '8px',
                        border: '1px solid var(--border-color)',
                        background: 'var(--input-bg)',
                        color: 'var(--text-primary)',
                      }}
                    />
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={applyCustomPageSize}
                      style={{ padding: '0.65rem 1rem' }}
                    >
                      Apply
                    </button>
                  </div>
                )}
                {showPagination && (
                  <>
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={() => setPage((prev) => Math.max(1, prev - 1))}
                      disabled={page <= 1}
                      style={{ padding: '0.65rem 1rem', opacity: page <= 1 ? 0.6 : 1 }}
                    >
                      Previous
                    </button>
                    <span style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
                      Page {page} of {totalPages}
                    </span>
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={() => setPage((prev) => Math.min(totalPages, prev + 1))}
                      disabled={page >= totalPages}
                      style={{ padding: '0.65rem 1rem', opacity: page >= totalPages ? 0.6 : 1 }}
                    >
                      Next
                    </button>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      <style>{`
        @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
        /* #478: collapse the 1fr 2fr two-column layout to a single stack on mobile.
           Without this, the Create Ticket form columns shrink to ~30px wide and the
           Description textarea renders text vertically (one letter per line). The
           minmax(0, ...) on the desktop grid is also load-bearing — it prevents the
           form-field min-content from forcing the column wider than 1fr would allow,
           which is what was triggering the textarea-collapse at sub-1024px widths. */
        @media (max-width: 768px) {
          .tickets-page { padding: 1rem !important; }
          .tickets-grid { grid-template-columns: 1fr !important; gap: 1.25rem !important; }
          .tickets-page .card { padding: 1.25rem !important; }
        }
      `}</style>
    </div>
  );
}
