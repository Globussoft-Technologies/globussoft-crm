import { useEffect, useRef, useState } from 'react';
import { Info, Mail, Plus, Save, Search, X } from 'lucide-react';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';

const ENDPOINT = '/api/notifications/email-cc-recipients';
const EMAIL_PATTERN = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]{2,}$/;

export default function NotificationEmailCcSettings({ isAdmin, onClose }) {
  const notify = useNotify();
  const [staff, setStaff] = useState([]);
  const [staffSearch, setStaffSearch] = useState('');
  const [staffSearchFocused, setStaffSearchFocused] = useState(false);
  const [staffPickerOpen, setStaffPickerOpen] = useState(false);
  const staffSearchInput = useRef(null);
  const savedSettings = useRef(null);
  const [staffUserIds, setStaffUserIds] = useState([]);
  const [externalEmails, setExternalEmails] = useState([]);
  const [externalEmailDraft, setExternalEmailDraft] = useState('');
  const [receiverEmail, setReceiverEmail] = useState('');
  const [defaultReceiverEmail, setDefaultReceiverEmail] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    if (!isAdmin) return;
    let active = true;
    fetchApi(ENDPOINT)
      .then((data) => {
        if (!active) return;
        const settings = {
          staffUserIds: Array.isArray(data?.recipients?.staffUserIds) ? data.recipients.staffUserIds : [],
          externalEmails: Array.isArray(data?.recipients?.externalEmails) ? data.recipients.externalEmails : [],
          receiverEmail: data?.receiverEmail || data?.defaultReceiverEmail || '',
        };
        savedSettings.current = settings;
        setStaff(Array.isArray(data?.staff) ? data.staff : []);
        setStaffUserIds(settings.staffUserIds);
        setExternalEmails(settings.externalEmails);
        setDefaultReceiverEmail(data?.defaultReceiverEmail || '');
        setReceiverEmail(settings.receiverEmail);
      })
      .catch((error) => {
        if (!active) return;
        setLoadError(error?.message || 'Failed to load email CC recipients.');
        notify.error('Failed to load email CC recipients');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [isAdmin, notify]);

  useEffect(() => {
    if (staffPickerOpen) staffSearchInput.current?.focus();
  }, [staffPickerOpen]);

  if (!isAdmin) return null;

  const toggleStaffRecipient = (userId) => {
    setStaffUserIds((current) => current.includes(userId)
      ? current.filter((id) => id !== userId)
      : [...current, userId]);
  };

  const addExternalEmail = () => {
    const email = externalEmailDraft.trim().toLowerCase();
    if (!EMAIL_PATTERN.test(email)) {
      notify.error('Enter a valid email address');
      return;
    }
    if (!externalEmails.includes(email)) {
      setExternalEmails((current) => [...current, email]);
    }
    setExternalEmailDraft('');
  };

  const cancel = () => {
    if (!savedSettings.current) return;
    setStaffUserIds(savedSettings.current.staffUserIds);
    setExternalEmails(savedSettings.current.externalEmails);
    setReceiverEmail(savedSettings.current.receiverEmail);
    setExternalEmailDraft('');
    setStaffPickerOpen(false);
    setStaffSearch('');
    onClose?.();
  };

  const save = async () => {
    setSaving(true);
    try {
      const result = await fetchApi(ENDPOINT, {
        method: 'PUT',
        body: JSON.stringify({
          staffUserIds,
          externalEmails,
          receiverEmail: receiverEmail.trim() || null,
        }),
      });
      const settings = {
        staffUserIds: result?.recipients?.staffUserIds || staffUserIds,
        externalEmails: result?.recipients?.externalEmails || externalEmails,
        receiverEmail: result?.receiverEmail || result?.defaultReceiverEmail || receiverEmail,
      };
      savedSettings.current = settings;
      setStaffUserIds(settings.staffUserIds);
      setExternalEmails(settings.externalEmails);
      setDefaultReceiverEmail(result?.defaultReceiverEmail || defaultReceiverEmail);
      setReceiverEmail(settings.receiverEmail);
      setExternalEmailDraft('');
      notify.success('Email settings saved');
    } catch (error) {
      notify.error(error?.message || 'Failed to save email CC recipients');
    } finally {
      setSaving(false);
    }
  };

  const searchTerm = staffSearch.trim().toLowerCase();
  const filteredStaff = staff.filter((member) =>
    `${member.name || ''} ${member.email || ''}`.toLowerCase().includes(searchTerm)
  );
  const selectedStaff = staff.filter((member) => staffUserIds.includes(member.id));

  return (
    <section
      aria-labelledby="notification-email-settings-heading"
      style={{ marginTop: '1.25rem', padding: '1.1rem', border: '1px solid var(--border-color)', borderRadius: 12, background: 'var(--surface-color)' }}
    >
      <header style={{ display: 'flex', alignItems: 'center', gap: '0.8rem', padding: '0 0 1rem' }}>
        <Mail size={20} color="var(--primary-color, var(--accent-color))" aria-hidden="true" />
        <div>
          <h3 id="notification-email-settings-heading" style={{ fontSize: '1rem', fontWeight: 650, margin: 0, color: 'var(--text-primary)' }}>
            Email notification settings
          </h3>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', margin: '0.2rem 0 0' }}>
            Manage who receives copies of CRM notification emails.
          </p>
        </div>
      </header>
      <hr style={{ border: 0, borderTop: '1px solid var(--border-color)', margin: 0 }} />
      {loading ? (
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.82rem', margin: '1rem 0 0' }}>Loading recipients…</p>
      ) : (
        <>
          {loadError ? <p role="alert" style={{ color: 'var(--danger-color)', fontSize: '0.82rem', margin: '0.75rem 0' }}>{loadError}</p> : null}
          <div style={{ padding: '1rem 0 1.15rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.75rem', marginBottom: '0.35rem' }}>
              <h4 style={{ fontSize: '0.92rem', fontWeight: 650, margin: 0, color: 'var(--text-primary)' }}>CC recipients</h4>
              <button
                type="button"
                aria-expanded={staffPickerOpen}
                aria-controls="notification-email-cc-staff-picker"
                onClick={() => setStaffPickerOpen((open) => !open)}
                disabled={saving || Boolean(loadError)}
                style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', padding: '0.42rem 0.7rem', border: '1px solid var(--border-color)', borderRadius: 999, background: 'transparent', color: 'var(--text-primary)', fontSize: '0.78rem', fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }}
              >
                <Plus size={14} aria-hidden="true" /> Add person
              </button>
            </div>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.78rem', margin: '0 0 0.75rem' }}>
              Select team members or add external email addresses.
            </p>
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.45rem', padding: '0.55rem', border: '1px solid var(--border-color)', borderRadius: 9, background: 'var(--input-bg, transparent)' }}>
              {selectedStaff.map((member) => (
                <span key={`staff-${member.id}`} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', maxWidth: '100%', padding: '0.28rem 0.45rem', border: '1px solid var(--border-color)', borderRadius: 999, color: 'var(--text-primary)', fontSize: '0.75rem' }}>
                  <Mail size={12} aria-hidden="true" />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{member.name || member.email}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${member.name || member.email}`}
                    onClick={() => toggleStaffRecipient(member.id)}
                    disabled={saving || Boolean(loadError)}
                    style={{ display: 'grid', placeItems: 'center', width: 18, height: 18, padding: 0, border: 0, background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer' }}
                  >
                    <X size={12} aria-hidden="true" />
                  </button>
                </span>
              ))}
              {externalEmails.map((email) => (
                <span key={`email-${email}`} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', maxWidth: '100%', padding: '0.28rem 0.45rem', border: '1px solid var(--border-color)', borderRadius: 999, color: 'var(--text-primary)', fontSize: '0.75rem' }}>
                  <Mail size={12} aria-hidden="true" />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{email}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${email}`}
                    onClick={() => setExternalEmails((current) => current.filter((value) => value !== email))}
                    disabled={saving || Boolean(loadError)}
                    style={{ display: 'grid', placeItems: 'center', width: 18, height: 18, padding: 0, border: 0, background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer' }}
                  >
                    <X size={12} aria-hidden="true" />
                  </button>
                </span>
              ))}
              <div style={{ display: 'flex', flex: '1 1 270px', minWidth: 0, gap: '0.45rem' }}>
                <input
                  type="text"
                  aria-label="Add an email address"
                  name="ccRecipientEmail"
                  inputMode="email"
                  autoComplete="off"
                  className="input-field"
                  value={externalEmailDraft}
                  onChange={(event) => setExternalEmailDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      addExternalEmail();
                    }
                  }}
                  placeholder="Enter email address"
                  disabled={saving || Boolean(loadError)}
                  style={{ flex: 1, minWidth: 0, border: 0, background: 'transparent', padding: '0.35rem 0.5rem' }}
                />
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={addExternalEmail}
                  disabled={saving || Boolean(loadError) || !externalEmailDraft.trim()}
                  style={{ borderRadius: 999, padding: '0.38rem 0.8rem' }}
                >
                  Add
                </button>
              </div>
            </div>
            {selectedStaff.length === 0 && externalEmails.length === 0 && (
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.72rem', margin: '0.4rem 0 0' }}>
                No CC recipients added yet. Enter an address and click Add to add it here.
              </p>
            )}
            {staffPickerOpen && (
              <div id="notification-email-cc-staff-picker" style={{ marginTop: '0.55rem', border: `1px solid ${staffSearchFocused ? 'var(--accent-color)' : 'var(--border-color)'}`, boxShadow: staffSearchFocused ? '0 0 0 2px var(--accent-color)' : 'none', borderRadius: 8, overflow: 'hidden', background: 'var(--surface-color)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.55rem', padding: '0.45rem 0.6rem', borderBottom: '1px solid var(--border-color)' }}>
                  <Search size={16} color="var(--text-secondary)" aria-hidden="true" />
                  <input
                    ref={staffSearchInput}
                    type="text"
                    aria-label="Search staff by name or email"
                    placeholder="Search staff by name or email..."
                    value={staffSearch}
                    onChange={(event) => setStaffSearch(event.target.value)}
                    onFocus={() => setStaffSearchFocused(true)}
                    onBlur={() => setStaffSearchFocused(false)}
                    disabled={saving || Boolean(loadError)}
                    style={{ flex: 1, minWidth: 0, border: 0, outline: 0, background: 'transparent', color: 'var(--text-primary)', fontSize: '0.84rem' }}
                  />
                  <button
                    type="button"
                    aria-label="Close staff picker"
                    onClick={() => {
                      setStaffPickerOpen(false);
                      setStaffSearch('');
                    }}
                    disabled={saving}
                    style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, padding: 0, border: '1px solid var(--border-color)', borderRadius: 6, background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', lineHeight: 0 }}
                  >
                    <X size={15} aria-hidden="true" />
                  </button>
                </div>
                <div style={{ maxHeight: 220, overflowY: 'auto', padding: '0.25rem 0.55rem' }}>
                  {staff.length === 0 ? (
                    <p style={{ color: 'var(--text-secondary)', fontSize: '0.82rem', margin: '0.5rem 0' }}>No active staff with email addresses.</p>
                  ) : filteredStaff.length === 0 ? (
                    <p style={{ color: 'var(--text-secondary)', fontSize: '0.82rem', margin: '0.5rem 0' }}>No staff match your search.</p>
                  ) : filteredStaff.map((member) => (
                    <label key={member.id} style={{ display: 'flex', alignItems: 'center', gap: '0.55rem', minWidth: 0, padding: '0.5rem 0.2rem', fontSize: '0.82rem', color: 'var(--text-primary)', cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        aria-label={`${member.name || member.email} (${member.email})`}
                        checked={staffUserIds.includes(member.id)}
                        onChange={() => toggleStaffRecipient(member.id)}
                        disabled={saving || Boolean(loadError)}
                      />
                      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        <strong style={{ marginRight: '0.35rem' }}>{member.name || member.email}</strong>
                        <span style={{ color: 'var(--text-secondary)' }}>{member.email}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            )}
            <p style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', color: 'var(--text-secondary)', fontSize: '0.75rem', margin: '0.65rem 0 0' }}>
              <Info size={14} aria-hidden="true" /> CC recipients are visible to other email recipients.
            </p>
          </div>
          <hr style={{ border: 0, borderTop: '1px solid var(--border-color)', margin: 0 }} />
          <div style={{ padding: '1rem 0 1.1rem' }}>
            <h4 style={{ fontSize: '0.92rem', fontWeight: 650, margin: '0 0 0.45rem', color: 'var(--text-primary)' }}>
              Default notification receiver
            </h4>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.78rem', margin: '0 0 0.75rem' }}>
              This address receives a copy of all enabled notification emails.
            </p>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.55rem', minWidth: 0 }}>
              <Mail size={16} color="var(--text-secondary)" aria-hidden="true" />
              <input
                id="notification-email-receiver"
                type="email"
                aria-label="Default notification receiver email"
                name="notificationReceiverEmail"
                autoComplete="off"
                className="input-field"
                value={receiverEmail}
                onChange={(event) => setReceiverEmail(event.target.value)}
                placeholder={defaultReceiverEmail || 'Your account email'}
                disabled={saving || Boolean(loadError)}
                style={{ flex: 1, minWidth: 0, borderRadius: 999 }}
              />
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setReceiverEmail(defaultReceiverEmail)}
                disabled={saving || Boolean(loadError) || !defaultReceiverEmail}
                style={{ borderRadius: 999, whiteSpace: 'nowrap' }}
              >
                Use account email
              </button>
            </div>
          </div>
          <hr style={{ border: 0, borderTop: '1px solid var(--border-color)', margin: 0 }} />
          <footer style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.55rem', paddingTop: '0.9rem' }}>
            <button
              type="button"
              className="btn-secondary"
              onClick={cancel}
              disabled={saving || loading || Boolean(loadError)}
              style={{ borderRadius: 999 }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={save}
              disabled={saving || loading || Boolean(loadError)}
              style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', borderRadius: 9 }}
            >
              <Save size={14} aria-hidden="true" /> {saving ? 'Saving…' : 'Save email settings'}
            </button>
          </footer>
        </>
      )}
    </section>
  );
}
