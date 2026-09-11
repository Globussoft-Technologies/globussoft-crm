import { createPortal } from 'react-dom';
import { useEffect, useState } from 'react';
import {
  CheckSquare,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Mail,
  MessageSquare,
  MoreHorizontal,
  Phone,
  Plus,
  Search,
  StickyNote,
  Tag,
  TrendingUp,
  Video,
  X,
} from 'lucide-react';
import { SOCIAL_NETWORKS } from './contactProfileConfig';
import { InlineField } from './ProfileWidgets';
import { fetchApi } from '../../utils/api';
import './ContactDetailsDrawer.css';

const GROUPS = [{ key: 'basic', label: 'Basic information', openByDefault: true }];

const ACTIONS = [
  { key: 'email', label: 'Email', Icon: Mail },
  { key: 'call', label: 'Call', Icon: Phone },
  { key: 'sms', label: 'SMS', Icon: MessageSquare },
  { key: 'note', label: 'Note', Icon: StickyNote },
  { key: 'task', label: 'Task', Icon: CheckSquare },
  { key: 'meeting', label: 'Meeting', Icon: Video },
  { key: 'activities', label: 'Sales activities', Icon: TrendingUp },
  { key: 'deal', label: 'Add deal', Icon: Plus, primary: true },
];

export function ContactDetailsGroup({ label, open, onToggle, children, showHeader = true }) {
  return (
    <section className={`cd-group${open ? ' is-open' : ''}`}>
      {showHeader && <button type="button" className="cd-group-head" onClick={onToggle} aria-expanded={open}>
        <span className="cd-group-toggle" aria-hidden="true">{open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</span>
        <span>{label}</span>
      </button>}
      {open && <div className="cd-group-body">{children}</div>}
    </section>
  );
}

export default function ContactDetailsDrawer({ contact, onClose, onAction, onFieldSave, onOwnerChange, staff = [], inline = false }) {
  const [openGroups, setOpenGroups] = useState(() => (
    Object.fromEntries(GROUPS.map((group) => [group.key, Boolean(group.openByDefault)]))
  ));
  const [showEmpty, setShowEmpty] = useState(true);
  const [query, setQuery] = useState('');
  const [customDefinitions, setCustomDefinitions] = useState([]);
  const [tagDraft, setTagDraft] = useState('');
  const tags = Array.isArray(contact?.tags) ? contact.tags : [];
  const name = contact?.name || 'Unnamed contact';
  const initials = name.charAt(0).toUpperCase();
  const nameParts = name.split(' ').filter(Boolean);
  useEffect(() => {
    let active = true;
    fetchApi('/api/lead-custom-fields', { silent: true }).then((data) => {
      const fields = Array.isArray(data) ? data : data?.fields || data?.data || [];
      if (active) setCustomDefinitions(fields);
    }).catch(() => {});
    return () => { active = false; };
  }, []);

  const customFields = contact?.customFields || {};
  const customKey = (keys) => keys.find((key) => Object.prototype.hasOwnProperty.call(customFields, key));
  const basicFields = [
    { label: 'Email', key: 'email', value: contact?.email },
    { label: 'First name', key: 'firstName', value: contact?.firstName || nameParts[0] },
    { label: 'Last name', key: 'lastName', value: contact?.lastName || nameParts.slice(1).join(' ') },
    { label: 'Account', key: 'company', value: contact?.company },
    { label: 'Job title', key: 'title', value: contact?.title },
    { label: 'Sales owner', key: 'assignedToId', value: contact?.assignedTo?.name || contact?.assignedTo?.email, owner: true },
    { label: 'Keyword', key: customKey(['keyword']) || 'keyword', value: contact?.keyword ?? customFields.keyword, custom: true, readOnly: true },
    { label: 'Note', key: customKey(['note']) || 'note', value: contact?.note ?? customFields.note, custom: true },
    { label: 'Medium', key: 'source', value: contact?.medium || contact?.source },
    { label: 'Description', key: customKey(['description']) || 'description', value: contact?.description ?? customFields.description, custom: true },
    { label: 'Website URL', key: 'website', value: contact?.website },
    { label: 'Monthly Budget', key: customKey(['monthly_budget', 'monthlyBudget']) || 'monthly_budget', value: contact?.monthlyBudget ?? customFields.monthly_budget ?? customFields.monthlyBudget, custom: true, type: 'number' },
    { label: 'Telegram / WhatsApp / Teams', key: customKey(['telegram', 'whatsapp', 'teams', 'messenger']) || 'messenger', value: contact?.telegram || contact?.whatsapp || contact?.teams || contact?.messenger || customFields.telegram || customFields.whatsapp || customFields.teams || customFields.messenger, custom: true },
    { label: 'Advertising Platform', key: customKey(['advertising_platform', 'advertisingPlatform', 'ad_platform']) || 'advertising_platform', value: contact?.advertisingPlatform || contact?.adPlatform || customFields.advertising_platform || customFields.advertisingPlatform || customFields.ad_platform, custom: true },
  ];
  const dynamicFields = customDefinitions
    .filter((definition) => !basicFields.some((field) => field.key === definition.fieldKey))
    .map((definition) => {
      let options = definition.options;
      if (typeof options === 'string') {
        try { options = JSON.parse(options); } catch (_error) { options = []; }
      }
      return {
        label: definition.label,
        key: definition.fieldKey,
        value: customFields[definition.fieldKey],
        custom: true,
        type: ['dropdown', 'radio'].includes(definition.fieldType) ? 'select' : definition.fieldType,
        options: Array.isArray(options) ? options.map((option) => typeof option === 'object' ? option : ({ value: option, label: option })) : [],
      };
    });
  const allBasicFields = [...basicFields, ...dynamicFields];
  const normalizedQuery = query.trim().toLowerCase();
  const visibleBasicFields = allBasicFields.filter((field) => (showEmpty || field.value !== null && field.value !== undefined && field.value !== '') && (!normalizedQuery || field.label.toLowerCase().includes(normalizedQuery)));
  const displayValue = (value) => value === null || value === undefined || value === ''
    ? <span className="cd-empty-value">Click to add</span>
    : <span className="cd-filled-value">{String(value)}</span>;

  const toggleGroup = (key) => setOpenGroups((current) => ({ ...current, [key]: !current[key] }));
  const runAction = (key) => onAction?.(key);

  const drawer = (
    <div className={inline ? 'cd-inline' : 'cd-overlay'} role={inline ? undefined : 'dialog'} aria-modal={inline ? undefined : 'true'} aria-label={inline ? undefined : 'Contact details'} onMouseDown={(event) => { if (!inline && event.target === event.currentTarget) onClose(); }}>
      <aside className="cd-drawer">
        <header className="cd-header">
          <div className="cd-header-top">
            <div className="cd-identity">
              <div className="cd-avatar" aria-hidden="true">{initials}</div>
              <div className="cd-identity-copy">
                <h2>{name}</h2>
                <p>{[contact?.title, contact?.company].filter(Boolean).join(' · ') || 'Contact'}</p>
                <div className="cd-socials">
                  {SOCIAL_NETWORKS.map(({ key, label, icon: Icon }) => contact?.[key] ? (
                    <a key={key} href={contact[key]} target="_blank" rel="noreferrer" aria-label={`${label} profile`} title={`${label} profile`}>
                      <Icon size={13} />
                    </a>
                  ) : null)}
                </div>
              </div>
            </div>
            <div className="cd-header-actions">
              <button type="button" className="cd-secondary-btn" onClick={() => onAction?.('see-all-details')}>
                <ExternalLink size={13} /> See all details
              </button>
              <button type="button" className="cd-icon-btn" onClick={onClose} aria-label="Close contact details" title="Close">
                <X size={18} />
              </button>
            </div>
          </div>

          <div className="cd-score-row">
            <div><span>Score</span><strong>{Number(contact?.aiScore) || 0}</strong></div>
            <div><span>Customer fit</span><div className="cd-stars" aria-label="Customer fit rating">★ ★ ★ ☆ ☆</div></div>
          </div>

          <div className="cd-actions" aria-label="Contact actions">
            {ACTIONS.map(({ key, label, Icon, primary }) => (
              <button key={key} type="button" className={`cd-action-btn${primary ? ' is-primary' : ''}`} onClick={() => runAction(key)}>
                <Icon size={13} /> {label}
              </button>
            ))}
            <button type="button" className="cd-action-btn" onClick={() => runAction('more')} aria-label="More actions" title="More actions"><MoreHorizontal size={14} /></button>
          </div>
        </header>

        <div className="cd-content">
          <div className="cd-title-row">
            <h3>Contact details</h3>
          </div>

          <div className="cd-tabs" role="tablist" aria-label="Contact detail groups">
            <button type="button" className="is-active" role="tab" aria-selected="true">All details</button>
          </div>

          <div className="cd-tools">
            <label className="cd-search">
              <Search size={14} />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search fields" aria-label="Search fields" />
            </label>
            <label className="cd-toggle"><input type="checkbox" checked={showEmpty} onChange={(event) => setShowEmpty(event.target.checked)} /><span aria-hidden="true" /> Show empty fields</label>
          </div>

          <section className="cd-all-details">
            <h4>All details</h4>
            <div className="cd-tags"><Tag size={13} /><span>Tags</span><div className="cd-tag-values">{tags.map((tag) => <button type="button" className="cd-tag-value" key={String(tag)} onClick={() => onFieldSave?.({ key: 'tags' }, tags.filter((item) => String(item) !== String(tag)))} title={`Remove ${String(tag)}`}>{String(tag)} ×</button>)}<form className="cd-tag-form" onSubmit={(event) => { event.preventDefault(); const next = tagDraft.trim(); if (!next || tags.some((tag) => String(tag).toLowerCase() === next.toLowerCase())) return; onFieldSave?.({ key: 'tags' }, [...tags, next]); setTagDraft(''); }}><input value={tagDraft} onChange={(event) => setTagDraft(event.target.value)} placeholder="Add tag" aria-label="Add tag" /></form></div></div>
          </section>

          <div className="cd-groups">
            {GROUPS.map((group) => (
              <div id={`cd-${group.key}`} key={group.key}>
                <ContactDetailsGroup label={group.label} open={openGroups[group.key]} onToggle={() => toggleGroup(group.key)} showHeader={false}>
                  <div className="cd-basic-fields" aria-label={`${group.label} fields`}>
                    <div className="cd-basic-grid">
                      {visibleBasicFields.map((field) => <div className="cd-basic-field" key={field.key}><span>{field.label}</span>{field.owner ? (
                        <InlineField
                          value={contact?.assignedToId ?? ''}
                          display={field.value || <span className="cd-empty-value">Unassigned</span>}
                          type="select"
                          options={staff.map((user) => ({ value: user.id, label: user.name || user.email }))}
                          onSave={(value) => onOwnerChange?.(value)}
                        />
                      ) : field.readOnly ? (
                        displayValue(field.value)
                      ) : (
                        <InlineField value={field.value ?? ''} display={displayValue(field.value)} type={field.type === 'number' ? 'number' : 'text'} options={field.options || []} onSave={(value) => onFieldSave?.(field, value)} />
                      )}</div>)}
                    </div>
                    <div className="cd-telephone-group">
                      <div className="cd-telephone-label">Telephone numbers</div>
                      <div className="cd-basic-grid">
                        {(!normalizedQuery || 'mobile'.includes(normalizedQuery)) && <div className="cd-basic-field"><span>Mobile</span><InlineField value={contact?.phone ?? ''} display={displayValue(contact?.phone)} onSave={(value) => onFieldSave?.({ key: 'phone' }, value)} /></div>}
                        {(!normalizedQuery || 'work phone'.includes(normalizedQuery)) && <div className="cd-basic-field"><span>Work phone</span><InlineField value={contact?.workPhone ?? customFields.workPhone ?? ''} display={displayValue(contact?.workPhone ?? customFields.workPhone)} onSave={(value) => onFieldSave?.({ key: customKey(['workPhone', 'work_phone']) || 'workPhone', custom: true }, value)} /></div>}
                      </div>
                    </div>
                  </div>
                </ContactDetailsGroup>
              </div>
            ))}
          </div>
        </div>
      </aside>
    </div>
  );

  return inline ? drawer : createPortal(drawer, document.body);
}
