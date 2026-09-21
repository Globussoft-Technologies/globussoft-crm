import { createPortal } from 'react-dom';
import { useContext, useEffect, useState } from 'react';
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
import { AuthContext } from '../../appContexts';
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

export const GENERIC_TAG_COLORS = ['#2563eb', '#7c3aed', '#0891b2', '#059669', '#d97706', '#db2777', '#dc2626'];

export function tagKey(name) {
  return String(name || '').trim().toLowerCase();
}

export function fallbackTagColor(name) {
  let hash = 0;
  for (const char of String(name || '')) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  return GENERIC_TAG_COLORS[Math.abs(hash) % GENERIC_TAG_COLORS.length];
}

export function tagTextColor(color) {
  const hex = String(color || '').replace('#', '');
  if (hex.length !== 6) return '#fff';
  const [r, g, b] = [0, 2, 4].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
  return (r * 299 + g * 587 + b * 114) / 1000 > 155 ? '#0f172a' : '#fff';
}

export function normalizeTagRecords(data) {
  const values = Array.isArray(data) ? data : data?.tags || data?.data || [];
  const seen = new Set();
  return values.reduce((result, item) => {
    const name = typeof item === 'string' ? item.trim() : String(item?.name || '').trim();
    if (!name || seen.has(tagKey(name))) return result;
    seen.add(tagKey(name));
    result.push({ name, color: item?.color || fallbackTagColor(name) });
    return result;
  }, []);
}

export function dedupeTags(values) {
  const seen = new Set();
  return (Array.isArray(values) ? values : []).reduce((result, value) => {
    const name = String(value || '').trim();
    const key = tagKey(name);
    if (!name || seen.has(key)) return result;
    seen.add(key);
    result.push(name);
    return result;
  }, []);
}

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

export default function ContactDetailsDrawer({ contact, onClose, onAction, onFieldSave, onOwnerChange, staff = [], inline = false, hideSms = false, genericTagsEnabled = false }) {
  const { tenant } = useContext(AuthContext);
  const isWellness = tenant?.vertical === 'wellness';
  const isTravel = tenant?.vertical === 'travel';
  const isGenericTagManager = genericTagsEnabled;
  const [openGroups, setOpenGroups] = useState(() => (
    Object.fromEntries(GROUPS.map((group) => [group.key, Boolean(group.openByDefault)]))
  ));
  const [showEmpty, setShowEmpty] = useState(true);
  const [query, setQuery] = useState('');
  const [customDefinitions, setCustomDefinitions] = useState([]);
  const [tagDraft, setTagDraft] = useState('');
  const tags = Array.isArray(contact?.tags) ? contact.tags : [];
  const [tagPickerOpen, setTagPickerOpen] = useState(false);
  const [tagCatalog, setTagCatalog] = useState([]);
  const [tagCatalogLoading, setTagCatalogLoading] = useState(false);
  const [tagSearch, setTagSearch] = useState('');
  const [pendingTags, setPendingTags] = useState(tags);
  const [tagSelectionSaving, setTagSelectionSaving] = useState(false);
  const [tagMutationError, setTagMutationError] = useState('');
  const [newTagName, setNewTagName] = useState('');
  const [newTagColor, setNewTagColor] = useState(GENERIC_TAG_COLORS[0]);
  const [tagCreating, setTagCreating] = useState(false);
  const [tagColorSaving, setTagColorSaving] = useState('');
  const [tagRemoving, setTagRemoving] = useState('');
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

  useEffect(() => {
    setPendingTags(dedupeTags(contact?.tags));
  }, [contact?.id, contact?.tags]);

  useEffect(() => {
    if (!isGenericTagManager) return undefined;
    let active = true;
    setTagCatalogLoading(true);
    setTagMutationError('');
    fetchApi('/api/contacts/tags', { silent: true }).then((data) => {
      if (active) setTagCatalog(normalizeTagRecords(data));
    }).catch(() => {
      if (active) setTagMutationError('Could not load tags.');
    }).finally(() => {
      if (active) setTagCatalogLoading(false);
    });
    return () => { active = false; };
  }, [isGenericTagManager]);

  const customFields = contact?.customFields || {};
  const customKey = (keys) => keys.find((key) => Object.prototype.hasOwnProperty.call(customFields, key));
  const basicFields = [
    { label: 'Email', key: 'email', value: contact?.email },
    { label: 'First name', key: 'firstName', value: contact?.firstName || nameParts[0] },
    { label: 'Last name', key: 'lastName', value: contact?.lastName || nameParts.slice(1).join(' ') },
    { label: 'Account', key: 'company', value: contact?.company },
    { label: 'Job title', key: 'title', value: contact?.title },
    { label: isWellness ? 'Assigned staff' : 'Sales owner', key: 'assignedToId', value: contact?.assignedTo?.name || contact?.assignedTo?.email, owner: true },
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
  const visibleBasicFields = allBasicFields.filter((field) => !(isTravel && field.key === 'keyword') && (showEmpty || field.value !== null && field.value !== undefined && field.value !== '') && (!normalizedQuery || field.label.toLowerCase().includes(normalizedQuery)));
  const displayValue = (value) => value === null || value === undefined || value === ''
    ? <span className="cd-empty-value">Click to add</span>
    : <span className="cd-filled-value">{String(value)}</span>;

  const toggleGroup = (key) => setOpenGroups((current) => ({ ...current, [key]: !current[key] }));
  const runAction = (key) => onAction?.(key);

  const allTagRecords = [...tagCatalog];
  tags.forEach((tag) => {
    const nameValue = String(tag || '').trim();
    if (nameValue && !allTagRecords.some((record) => tagKey(record.name) === tagKey(nameValue))) {
      allTagRecords.push({ name: nameValue, color: fallbackTagColor(nameValue) });
    }
  });
  const filteredTagRecords = allTagRecords.filter((record) => !tagSearch.trim() || record.name.toLowerCase().includes(tagSearch.trim().toLowerCase()));
  const tagColorMap = new Map(allTagRecords.map((record) => [tagKey(record.name), record.color || fallbackTagColor(record.name)]));
  const isPendingTag = (nameValue) => pendingTags.some((tag) => tagKey(tag) === tagKey(nameValue));

  const openTagPicker = () => {
    setPendingTags(dedupeTags(tags));
    setTagSearch('');
    setNewTagName('');
    setNewTagColor(GENERIC_TAG_COLORS[0]);
    setTagMutationError('');
    setTagPickerOpen(true);
  };

  const togglePendingTag = (nameValue) => {
    setPendingTags((current) => current.some((tag) => tagKey(tag) === tagKey(nameValue))
      ? current.filter((tag) => tagKey(tag) !== tagKey(nameValue))
      : [...current, nameValue]);
  };

  const applyPendingTags = async () => {
    const next = dedupeTags(pendingTags);
    setTagSelectionSaving(true);
    setTagMutationError('');
    try {
      await onFieldSave?.({ key: 'tags' }, next);
      setTagPickerOpen(false);
    } catch (_error) {
      setTagMutationError('Could not save tags.');
    } finally {
      setTagSelectionSaving(false);
    }
  };

  const removeGenericTag = async (nameValue) => {
    const next = tags.filter((tag) => tagKey(tag) !== tagKey(nameValue));
    setTagRemoving(nameValue);
    setTagMutationError('');
    try {
      await onFieldSave?.({ key: 'tags' }, next);
    } catch (_error) {
      setTagMutationError('Could not remove tag.');
    } finally {
      setTagRemoving('');
    }
  };

  const createGenericTag = async () => {
    const nameValue = newTagName.trim();
    if (!nameValue) {
      setTagMutationError('Enter a tag name.');
      return;
    }
    if (allTagRecords.some((record) => tagKey(record.name) === tagKey(nameValue))) {
      setTagMutationError('That tag already exists.');
      return;
    }
    setTagMutationError('');
    setTagCreating(true);
    try {
      const created = await fetchApi('/api/contacts/tags', {
        method: 'POST',
        body: JSON.stringify({ name: nameValue, color: newTagColor }),
      });
      const record = normalizeTagRecords([created])[0] || { name: nameValue, color: newTagColor };
      setTagCatalog((current) => [...current, record]);
      setPendingTags((current) => [...current, record.name]);
      setNewTagName('');
    } catch (_error) {
      setTagMutationError('Could not create tag.');
    } finally {
      setTagCreating(false);
    }
  };

  const changeGenericTagColor = async (nameValue, color) => {
    const key = tagKey(nameValue);
    const previous = tagCatalog;
    setTagColorSaving(key);
    setTagCatalog((current) => current.map((record) => tagKey(record.name) === key ? { ...record, color } : record));
    setTagMutationError('');
    try {
      await fetchApi(`/api/contacts/tags/${encodeURIComponent(nameValue)}`, {
        method: 'PATCH',
        body: JSON.stringify({ color }),
      });
    } catch (_error) {
      setTagCatalog(previous);
      setTagMutationError('Could not update tag color.');
    } finally {
      setTagColorSaving('');
    }
  };

  const drawer = (
    <div className={inline ? 'cd-inline' : 'cd-overlay'} role={inline ? undefined : 'dialog'} aria-modal={inline ? undefined : 'true'} aria-label={inline ? undefined : (isWellness ? 'Patient details' : 'Contact details')} onMouseDown={(event) => { if (!inline && event.target === event.currentTarget) onClose(); }}>
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
            {ACTIONS.filter(({ key }) => !(hideSms && key === 'sms')).map(({ key, label, Icon, primary }) => (
              <button key={key} type="button" className={`cd-action-btn${primary ? ' is-primary' : ''}`} onClick={() => runAction(key)}>
                <Icon size={13} /> {label}
              </button>
            ))}
            <button type="button" className="cd-action-btn" onClick={() => runAction('more')} aria-label="More actions" title="More actions"><MoreHorizontal size={14} /></button>
          </div>
        </header>

        <div className="cd-content">
          <div className="cd-title-row">
            <h3>{isWellness ? 'Patient details' : 'Contact details'}</h3>
          </div>

          {!isTravel && (
            <div className="cd-tabs" role="tablist" aria-label="Contact detail groups">
              <button type="button" className="is-active" role="tab" aria-selected="true">All details</button>
            </div>
          )}

          <div className="cd-tools">
            <label className="cd-search">
              <Search size={14} />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search fields" aria-label="Search fields" />
            </label>
            <label className="cd-toggle"><input type="checkbox" checked={showEmpty} onChange={(event) => setShowEmpty(event.target.checked)} /><span aria-hidden="true" /> Show empty fields</label>
          </div>

          <section className="cd-all-details">
            <h4>All details</h4>
            {isGenericTagManager ? (
              <div className="cd-tags cd-tag-manager">
                <Tag size={13} />
                <span>Tags</span>
                <div className="cd-tag-values">
                  {tags.map((tag) => {
                    const nameValue = String(tag);
                    const color = tagColorMap.get(tagKey(nameValue)) || fallbackTagColor(nameValue);
                    return (
                      <span className="cd-tag-chip" key={nameValue} style={{ background: color, borderColor: color, color: tagTextColor(color) }}>
                        <span>{nameValue}</span>
                        <button type="button" aria-label={`Remove tag ${nameValue}`} onClick={() => removeGenericTag(nameValue)} disabled={tagRemoving === nameValue}>×</button>
                      </span>
                    );
                  })}
                  <button type="button" className="cd-add-tag-btn" onClick={openTagPicker}>+ Add tag</button>
                  {tagPickerOpen && (
                    <div className="cd-tag-picker" role="dialog" aria-label="Tag selector">
                      <div className="cd-tag-picker-head"><strong>Add tags</strong><button type="button" className="cd-tag-picker-close" onClick={() => setTagPickerOpen(false)} aria-label="Close tag selector"><X size={14} /></button></div>
                      <label className="cd-tag-picker-search"><Search size={13} /><input value={tagSearch} onChange={(event) => setTagSearch(event.target.value)} placeholder="Search tags" aria-label="Search tags" /></label>
                      <div className="cd-tag-picker-list" role="listbox" aria-multiselectable="true">
                        {tagCatalogLoading ? <div className="cd-tag-picker-message">Loading tags...</div> : filteredTagRecords.length ? filteredTagRecords.map((record) => (
                          <div className={`cd-tag-option${isPendingTag(record.name) ? ' is-selected' : ''}`} key={record.name}>
                            <button type="button" role="option" aria-selected={isPendingTag(record.name)} onClick={() => togglePendingTag(record.name)}>
                              <span className="cd-tag-option-check">{isPendingTag(record.name) ? '✓' : ''}</span>
                              <span className="cd-tag-chip" style={{ background: record.color, borderColor: record.color, color: tagTextColor(record.color) }}>{record.name}</span>
                            </button>
                            <label className="cd-tag-color"><input type="color" value={record.color} onChange={(event) => changeGenericTagColor(record.name, event.target.value)} disabled={tagColorSaving === tagKey(record.name)} aria-label={`Change color for ${record.name}`} /></label>
                          </div>
                        )) : <div className="cd-tag-picker-message">No tags available.</div>}
                      </div>
                      <form className="cd-create-tag" onSubmit={(event) => { event.preventDefault(); createGenericTag(); }}>
                        <strong>Create new tag</strong>
                        <div className="cd-create-tag-row"><input value={newTagName} onChange={(event) => setNewTagName(event.target.value)} placeholder="Tag name" aria-label="New tag name" /><input type="color" value={newTagColor} onChange={(event) => setNewTagColor(event.target.value)} aria-label="New tag color" /><button type="submit" disabled={tagCreating}>{tagCreating ? 'Creating...' : 'Create'}</button></div>
                      </form>
                      {tagMutationError && <div className="cd-tag-picker-error" role="alert">{tagMutationError}</div>}
                      <div className="cd-tag-picker-actions"><button type="button" className="cd-tag-picker-cancel" onClick={() => setTagPickerOpen(false)}>Cancel</button><button type="button" className="cd-tag-picker-apply" onClick={applyPendingTags} disabled={tagSelectionSaving || tagCreating}>{tagSelectionSaving ? 'Applying...' : 'Apply tags'}</button></div>
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="cd-tags"><Tag size={13} /><span>Tags</span><div className="cd-tag-values">{tags.map((tag) => <button type="button" className="cd-tag-value" key={String(tag)} onClick={() => onFieldSave?.({ key: 'tags' }, tags.filter((item) => String(item) !== String(tag)))} title={`Remove ${String(tag)}`}>{String(tag)} ×</button>)}<form className="cd-tag-form" onSubmit={(event) => { event.preventDefault(); const next = tagDraft.trim(); if (!next || tags.some((tag) => String(tag).toLowerCase() === next.toLowerCase())) return; onFieldSave?.({ key: 'tags' }, [...tags, next]); setTagDraft(''); }}><input value={tagDraft} onChange={(event) => setTagDraft(event.target.value)} placeholder="Add tag" aria-label="Add tag" /></form></div></div>
            )}
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
