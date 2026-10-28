import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, BriefcaseBusiness, FileText, Pencil, Settings2, NotebookPen, Search, Users, X, Phone } from 'lucide-react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { fetchApi } from '../utils/api';
import { formatMoney } from '../utils/money';
import { convertCurrencyStrict } from '../utils/currency';
import { generatedDealName } from '../utils/dealDisplay';
import { formatDate, formatDateMedium, formatDateTime } from '../utils/date';
import { useNotify } from '../utils/notify';
import { AuthContext } from '../appContexts';
import { EmailModal, MeetingModal } from '../components/contact/ActionModals';
import { patchContact } from '../components/contact/contactActions';
import { dedupeTags, fallbackTagColor, GENERIC_TAG_COLORS, normalizeTagRecords, tagKey, tagTextColor } from '../components/contact/ContactDetailsDrawer';
import { RichText, sanitizeRichTextHtml, truncateRichTextHtml } from '../utils/richText';
import RichTextNotePreview from '../components/contact/RichTextNotePreview';
import '../components/contact/ContactProfile.css';
import '../components/contact/ContactDetailsDrawer.css';
import CallifiedLeadCallDialog from '../components/CallifiedLeadCallDialog';

const EMPTY = '—';
const tabs = ['Overview', 'Deal details', 'Activities', 'Deal team', 'Contacts', 'Conversations', 'Products', 'Quotes', 'Files'];

export const dealFieldSections = [
  { key: 'basicInformation', label: 'Basic information', fields: [
    ['relatedContact', 'Related contact', 'relation'], ['relatedAccount', 'Related account', 'text'], ['dealType', 'Deal type', 'text'],
    ['dealName', 'Deal name', 'text'], ['currency', 'Currency', 'text'], ['dealValue', 'Deal value', 'currency'], ['pipeline', 'Pipeline', 'relation'],
    ['dealStage', 'Deal stage', 'relation'], ['lostReason', 'Lost reason', 'text'], ['closedDate', 'Closed date', 'date'], ['salesOwner', 'Sales owner', 'relation'],
  ] },
  { key: 'hiddenFields', label: 'Hidden fields', fields: [
    ['tags', 'Tags', 'tags'], ['baseValue', 'Deal value in base currency', 'currency'], ['paymentStatus', 'Payment status', 'text'], ['probability', 'Probability (%)', 'percent'],
    ['territory', 'Territory', 'text'], ['forecastCategory', 'Forecast category', 'text'], ['expectedClose', 'Expected close date', 'date'],
  ] },
  { key: 'sourceInformation', label: 'Source information', fields: [['source', 'Source', 'text'], ['campaign', 'Campaign', 'text']] },
  { key: 'systemInformation', label: 'System information', fields: [
    ['lastActivityType', 'Last activity type', 'text'], ['lastActivityDate', 'Last activity date', 'dateTime'], ['age', 'Age (in days)', 'text'], ['recentNote', 'Recent note', 'text'],
    ['activeSequences', 'Active sales sequences', 'text'], ['completedSequences', 'Completed sales sequences', 'text'], ['createdBy', 'Created by', 'relation'], ['createdAt', 'Created at', 'relative'],
    ['updatedBy', 'Updated by', 'relation'], ['updatedAt', 'Updated at', 'relative'], ['webForm', 'Web form', 'text'], ['upcomingActivities', 'Upcoming activities', 'text'],
    ['stageUpdatedAt', 'Deal stage updated at', 'relative'], ['lastAssignedAt', 'Last assigned at', 'relative'], ['expectedDealValue', 'Expected deal value', 'currency'],
  ] },
];

function personName(person) { return person?.name || [person?.firstName, person?.lastName].filter(Boolean).join(' ') || person?.email || ''; }
function parseTags(value) { if (Array.isArray(value)) return value; if (!value) return undefined; try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : undefined; } catch { return undefined; } }
function slug(value) { return String(value || '').toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, ''); }
function parseGenericDealTypes(value) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed : [];
  } catch (_error) {
    return [];
  }
}
function relative(value) { if (!value) return EMPTY; const ms = Date.now() - new Date(value).getTime(); if (!Number.isFinite(ms)) return EMPTY; const days = Math.floor(ms / 86400000); if (days > 0) return `${days} day${days === 1 ? '' : 's'} ago`; const hours = Math.floor(ms / 3600000); return hours > 0 ? `${hours} hour${hours === 1 ? '' : 's'} ago` : 'Just now'; }
function plainText(value) { return String(value || '').replace(/<[^>]*>/g, ''); }
function openFullNote(value) {
  const overlay = document.createElement('div');
  overlay.className = 'cp-overlay cp-generic-note-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Full note');
  const modal = document.createElement('div');
  modal.className = 'cp-modal cp-modal-wide';
  modal.addEventListener('click', (event) => event.stopPropagation());
  const head = document.createElement('div');
  head.className = 'cp-modal-head';
  const heading = document.createElement('h3');
  heading.textContent = 'Full note';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'cp-icon-btn';
  close.setAttribute('aria-label', 'Close');
  close.textContent = '×';
  close.addEventListener('click', () => overlay.remove());
  head.append(heading, close);
  const body = document.createElement('div');
  body.className = 'cp-modal-body cp-generic-note-full';
  body.innerHTML = sanitizeRichTextHtml(value);
  modal.append(head, body);
  overlay.append(modal);
  overlay.addEventListener('click', () => overlay.remove());
  document.body.append(overlay);
}
function appendRichTextPreview(parent, value, emptyText = '') {
  const preview = truncateRichTextHtml(value, 50);
  const content = document.createElement('div');
  content.className = 'cp-generic-note-preview';
  if (preview.html) content.innerHTML = preview.html;
  else if (emptyText) content.textContent = emptyText;
  parent.append(content);
  if (preview.truncated) {
    const extend = document.createElement('button');
    extend.type = 'button';
    extend.className = 'cp-note-extend';
    extend.textContent = 'View full note';
    extend.addEventListener('click', (event) => { event.stopPropagation(); openFullNote(value); });
    parent.append(extend);
  }
}
function fieldValue(deal, key, pipeline, latestNote) {
  const owner = personName(deal.owner); const contact = deal.contact;
  const values = {
    relatedContact: personName(contact), relatedAccount: contact?.company, dealType: deal.dealType, dealName: deal.title, currency: deal.currency,
    dealValue: deal.amount, pipeline: pipeline?.name, dealStage: deal.stage, lostReason: deal.lostReason, closedDate: deal.closedAt || (['won', 'lost'].includes(slug(deal.stage)) ? deal.updatedAt : null),
    salesOwner: owner, tags: parseTags(deal.tags || contact?.tags || contact?.tagsJson), baseValue: deal.baseAmount || deal.amount, paymentStatus: deal.paymentStatus, probability: deal.probability,
    territory: deal.territory || contact?.territory, forecastCategory: deal.forecastCategory, expectedClose: deal.expectedClose, source: deal.source || contact?.source,
    campaign: deal.campaign?.name || deal.campaignName, lastActivityType: deal.activities?.[0]?.type, lastActivityDate: deal.activities?.[0]?.createdAt, age: deal.createdAt ? `${Math.max(0, Math.floor((Date.now() - new Date(deal.createdAt).getTime()) / 86400000))} days` : null,
    recentNote: latestNote?.description, activeSequences: deal.activeSequences, completedSequences: deal.completedSequences, createdBy: deal.createdBy ? personName(deal.createdBy) : owner,
    createdAt: deal.createdAt, updatedBy: deal.updatedBy ? personName(deal.updatedBy) : owner, updatedAt: deal.updatedAt || deal.createdAt, webForm: deal.webForm?.name || deal.webForm,
    upcomingActivities: deal.upcomingActivities, stageUpdatedAt: deal.stageUpdatedAt, lastAssignedAt: deal.lastAssignedAt, expectedDealValue: deal.expectedValue || (Number(deal.amount || 0) * Number(deal.probability || 0) / 100),
  };
  return values[key];
}
function display(value, type, deal) { if (value == null || value === '' || (Array.isArray(value) && value.length === 0)) return EMPTY; if (type === 'currency') return formatMoney(value, { currency: deal.currency }); if (type === 'date') return formatDateMedium(value); if (type === 'dateTime') return formatDateTime(value); if (type === 'relative') return relative(value); if (type === 'percent') return `${value}%`; if (type === 'tags') return Array.isArray(value) ? value.join(', ') : value; return String(value); }

const inlineEditStyles = `.deal-inline-editor{position:fixed;z-index:10000;width:min(270px,calc(100vw - 28px));padding:10px;background:var(--modal-bg,#fff);border:1px solid var(--border-color);border-radius:7px;box-shadow:0 8px 24px rgba(15,23,42,.18)}.deal-inline-editor label{display:grid;gap:5px;font-size:11px;color:var(--text-secondary)}.deal-inline-editor input,.deal-inline-editor select,.deal-inline-editor textarea{width:100%;box-sizing:border-box;border:1px solid var(--border-color);border-radius:5px;padding:7px;background:var(--input-bg,var(--surface-color));color:var(--text-primary);font:inherit}.deal-inline-editor textarea{min-height:58px;resize:vertical}.deal-inline-editor-actions{display:flex;justify-content:flex-end;gap:7px;margin-top:9px}.deal-inline-editor-actions button{font-size:11px;padding:5px 9px}.deal-inline-editor .deal-edit-error{margin:7px 0 0}`;
const stageChevronStyles = `.deal-reference-tracker .deal-stages{gap:0}.deal-reference-tracker .deal-stage{position:relative;z-index:1;justify-content:center;min-height:20px;padding:0 14px 0 10px;border-right:0;clip-path:polygon(0 0,calc(100% - 10px) 0,100% 50%,calc(100% - 10px) 100%,0 100%)}.deal-reference-tracker .deal-stage:not(:first-child){margin-left:-1px;padding-left:14px;clip-path:polygon(10px 0,calc(100% - 10px) 0,100% 50%,calc(100% - 10px) 100%,10px 100%,0 50%)}.deal-reference-tracker .deal-stage:hover{z-index:2}`;
const dealTagStyles = `.deal-tag-line{position:relative;display:flex;align-items:center;flex-wrap:wrap;gap:6px}.deal-tag-line .cd-tag-chip{font-size:11px}.deal-tag-picker{left:0}`;
function InfoCard({ title, children, className = '', headingProps = {} }) { return <section className={`deal-info-card ${className}`}><style>{referenceStyles + editStyles + inlineEditStyles + '.deal-reference-actions{display:none}.deal-reference-cards{min-height:0;align-items:stretch}.deal-reference-cards>.deal-info-card,.deal-reference-cards>.deal-side-cards{min-height:0}.deal-reference-notes{align-self:stretch;min-height:0;overflow:hidden;contain:size}.deal-reference-notes .deal-card-heading{flex:0 0 auto}.deal-reference-notes .deal-notes-list{flex:1 1 auto;width:100%;min-height:0;height:auto;overflow-y:auto;overflow-x:hidden}' + stageChevronStyles}</style><div className="deal-card-heading"><h2 {...headingProps}>{title}</h2></div>{children}</section>; }
const editablePairFields = { 'Deal name': 'title', 'Deal value': 'amount', 'Deal amount': 'amount', Currency: 'currency', 'Expected close date': 'expectedClose', 'Related contact': 'contactId', 'Assigned sales owner': 'assignedToId', 'Deal type': 'dealType', Pipeline: 'pipelineId', 'Probability (%)': 'probability', 'Lost reason': 'lostReason', 'Deal stage': 'stage', Stage: 'stage' };
function openDealFieldEditor(field, event) { const fieldBox = event.currentTarget.parentElement?.getBoundingClientRect() || event.currentTarget.getBoundingClientRect(); window.dispatchEvent(new CustomEvent('deal-details-edit', { detail: { field, anchor: fieldBox } })); }
function Pair({ label, value, type = 'text', deal }) { const field = editablePairFields[label]; return <div className="deal-pair"><span>{label}</span><strong>{display(value, type, deal)}</strong>{field && <button type="button" className="deal-pair-edit" aria-label={`Edit ${label}`} onClick={(event) => openDealFieldEditor(field, event)}><Pencil size={12} /></button>}</div>; }
function Section({ section, deal, pipeline, latestNote, showEmpty }) {
  const fields = section.fields.filter(([key]) => showEmpty || fieldValue(deal, key, pipeline, latestNote) !== undefined);
  return <section className="deal-field-section"><div className="deal-section-heading"><strong>{section.label}</strong></div><div className="deal-field-grid">{fields.map(([key, label, type]) => { const value = fieldValue(deal, key, pipeline, latestNote); if (!showEmpty && (value == null || value === '' || (Array.isArray(value) && !value.length))) return null; const field = editablePairFields[label]; return <div className="deal-field" key={key}><span>{label}</span><strong>{display(value, type, deal)}</strong>{field && <button type="button" className="deal-pair-edit" aria-label={`Edit ${label}`} onClick={(event) => openDealFieldEditor(field, event)}><Pencil size={12} /></button>}</div>; })}</div></section>;
}

const referenceStyles = `.deal-reference-layout{max-width:none;padding:6px;background:#f5f7fa}.deal-reference-header{display:grid;grid-template-columns:48px 1fr auto;gap:12px;align-items:center;padding:26px 16px 10px;background:var(--surface-color)}.deal-reference-header h1{font-size:16px;margin:0 0 8px}.deal-reference-header .deal-meta{margin:0;font-size:11px;gap:8px}.deal-avatar{width:48px;height:48px;display:grid;place-items:center;border-radius:3px;background:#b8f2d6;color:#35c995;font-weight:700}.deal-tag-line{grid-column:1/-1;color:var(--text-secondary);font-size:11px;padding-top:6px}.deal-reference-cards{display:grid;grid-template-columns:1.05fr 1.05fr 1.05fr 1.05fr;gap:8px;background:var(--surface-color);padding:0 16px;min-height:0;align-items:stretch}.deal-reference-cards>.deal-info-card,.deal-reference-cards>.deal-side-cards{margin:0;min-height:0}.deal-reference-cards .deal-info-card{padding:12px}.deal-reference-cards .deal-info-card h2{font-size:11px;font-weight:500;color:var(--text-secondary);margin-bottom:7px}.deal-reference-cards .deal-pair{display:block;border:0;padding:6px 0}.deal-reference-cards .deal-pair span,.deal-reference-cards .deal-pair strong{display:block;text-align:left;font-size:11px}.deal-reference-cards .deal-pair strong{color:#0645b5;margin-top:3px}.deal-reference-notes{grid-column:4;grid-row:1;display:flex;flex-direction:column;min-height:0;height:100%;box-sizing:border-box;overflow:hidden;contain:size}.deal-reference-notes .deal-card-heading{flex:0 0 auto}.deal-reference-notes .deal-notes-list{flex:1 1 auto;min-height:0;height:auto;max-height:none;overflow-y:auto;overflow-x:hidden}.deal-reference-notes textarea{min-height:120px}.deal-reference-notes .deal-note{background:transparent;padding:8px 0;border-top:1px solid var(--border-color);margin-top:4px}.deal-reference-actions{display:flex;gap:14px;padding:12px 16px;border-top:0;background:var(--surface-color);font-size:11px}.deal-reference-tracker{border-radius:0;margin:0;padding:12px 16px;background:var(--surface-color)}.deal-reference-tracker .deal-age{display:flex;justify-content:space-between;margin-bottom:8px}.deal-reference-tracker .deal-stages{display:flex;gap:0;margin:0;background:#dce3ec;border-radius:8px;overflow:hidden}.deal-reference-tracker .deal-stage{flex:1;justify-content:center;padding:5px;font-size:11px;background:#dce3ec;border-right:2px solid var(--surface-color)}.deal-reference-tracker .deal-stage span{display:none}.deal-reference-tracker .deal-stage.done{background:#bedcff}.deal-reference-workspace{display:grid;grid-template-columns:265px minmax(0,1fr);background:var(--surface-color);min-height:350px}.deal-reference-nav{border-right:1px solid var(--border-color);padding:20px 8px}.deal-reference-nav h2{font-size:14px;margin:0 0 18px;padding:0 8px}.deal-reference-nav button{display:block;width:100%;text-align:left;border:0;border-left:3px solid transparent;border-radius:4px;background:transparent;color:var(--text-secondary);padding:9px 10px;font-size:12px;cursor:pointer}.deal-reference-nav button.active{border-left-color:var(--primary-color,var(--accent-color));background:var(--subtle-bg);color:var(--text-primary);font-weight:700}.deal-reference-main{min-width:0;padding:14px 12px}.deal-reference-main .deal-details-content{border:0;padding:0;margin:0}.deal-reference-main .deal-field-grid{grid-template-columns:repeat(4,minmax(0,1fr));padding:6px}.deal-reference-main .deal-field-section{border-radius:0;margin:8px 0}.deal-reference-main .deal-section-heading{background:var(--subtle-bg);padding:9px}.deal-reference-main .deal-details-toolbar{padding:0 4px}.deal-reference-main .deal-field{padding:8px;font-size:11px}@media(max-width:1100px){.deal-reference-cards{grid-template-columns:repeat(2,minmax(0,1fr))}.deal-reference-notes{grid-column:auto;grid-row:auto}}@media(max-width:700px){.deal-reference-workspace{grid-template-columns:1fr}.deal-reference-nav{border-right:0;border-bottom:1px solid var(--border-color);padding:10px;display:flex;gap:4px;overflow-x:auto}.deal-reference-nav h2{display:none}.deal-reference-nav button{white-space:nowrap;width:auto}.deal-reference-main .deal-field-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}`;
const genericDealDetailsStyles = `.generic-deal-details-page{box-sizing:border-box;width:100%;min-width:0;min-height:calc(100vh - 64px);padding:6px;background:#f1f3f6;color:var(--text-primary);font-family:inherit}.generic-deal-details-page *, .generic-deal-details-page *::before, .generic-deal-details-page *::after{box-sizing:border-box}.generic-deal-details-page button{font:inherit}.generic-deal-details-page .deal-info-card{background:var(--surface-color);border:1px solid var(--border-color);border-radius:8px}.generic-deal-details-page .deal-reference-main{background:var(--surface-color)}.generic-deal-details-page .deal-card-heading{display:flex;justify-content:space-between;align-items:center;gap:8px}.generic-deal-details-page .deal-card-heading h2{margin:0}.generic-deal-details-page .deal-link{display:inline-flex;align-items:center;gap:6px;border:0;background:transparent;color:var(--primary-color,var(--accent-color));font-size:12px;font-weight:700;cursor:pointer;padding:0}.generic-deal-details-page .deal-details-toolbar{display:flex;justify-content:space-between;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:12px}.generic-deal-details-page .deal-details-toolbar h2{font-size:18px;margin:0 0 5px}.generic-deal-details-page .deal-details-toolbar>div>.deal-link{display:none}.generic-deal-details-page .deal-details-toolbar label:not(.deal-switch){display:flex;align-items:center;gap:7px;border:1px solid var(--border-color);border-radius:7px;padding:7px 9px;min-width:230px}.generic-deal-details-page .deal-details-toolbar input[aria-label="Search fields"]{border:0;outline:0;background:transparent;color:var(--text-primary);width:100%}.generic-deal-details-page .deal-switch{display:flex;gap:7px;align-items:center;color:var(--text-secondary);font-size:12px}.generic-deal-details-page .deal-field-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:0 18px;padding:6px 12px}.generic-deal-details-page .deal-field{position:relative;min-width:0;padding:10px 24px 10px 0;border-bottom:1px solid var(--border-color);font-size:11px}.generic-deal-details-page .deal-field span,.generic-deal-details-page .deal-field strong{display:block}.generic-deal-details-page .deal-field strong{margin-top:4px;font-size:12px;overflow-wrap:anywhere}.generic-deal-details-page .deal-pair{position:relative}.generic-deal-details-page .deal-pair span,.generic-deal-details-page .deal-pair strong{display:block}.generic-deal-details-page .deal-pair-edit{position:absolute;right:0;top:5px;border:0;background:transparent;color:var(--text-secondary);padding:3px;cursor:pointer}.generic-deal-details-page .deal-reference-cards{align-items:start}.generic-deal-details-page .deal-reference-notes{align-self:start;height:auto}.generic-deal-details-page .deal-reference-notes .deal-link{align-self:flex-start}.generic-deal-details-page .deal-reference-notes .deal-notes-list{display:grid;flex:0 1 auto;height:auto;max-height:280px;min-height:0;overflow-y:auto;overflow-x:hidden;scrollbar-width:thin}.generic-deal-details-page .deal-reference-notes .deal-note{display:flex;gap:9px;align-items:flex-start;min-width:0;margin:0;padding:8px 0;border-top:1px solid var(--border-color);background:transparent;font-size:11px}.generic-deal-details-page .deal-reference-notes .deal-note>div{min-width:0;flex:1 1 auto}.generic-deal-details-page .deal-reference-notes .deal-note strong{display:block;max-width:100%;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word}.generic-deal-details-page .deal-reference-notes .deal-note small{display:block;margin-top:4px;color:var(--text-secondary)}.generic-deal-details-page .deal-reference-notes .cp-generic-note-preview{font-weight:600}.generic-deal-details-page .deal-activity-list{display:grid;gap:11px}.generic-deal-details-page .deal-activity-list>div{display:flex;align-items:flex-start;gap:8px;font-size:11px}.generic-deal-details-page .deal-activity-list>div>svg{flex:0 0 auto;margin-top:1px}.generic-deal-details-page .deal-activity-list>div>.deal-activity-body{display:block;min-width:0;flex:1 1 auto}.generic-deal-details-page .deal-activity-list strong,.generic-deal-details-page .deal-activity-list small{display:block}.generic-deal-details-page .deal-activity-list strong{margin-bottom:4px}.generic-deal-details-page .deal-activity-list small{margin-top:5px;color:var(--text-secondary)}.generic-deal-details-page .deal-activity-pagination{display:flex;align-items:center;justify-content:flex-end;gap:8px;font-size:11px;color:var(--text-secondary);margin-top:14px}.generic-deal-details-page .deal-activity-page-button{border:1px solid var(--border-color);border-radius:5px;background:var(--surface-color);color:var(--text-primary);padding:5px 8px;cursor:pointer}.generic-deal-details-page .deal-activity-page-button:disabled{cursor:not-allowed;opacity:.5}.generic-deal-details-page .deal-conversations-head h2,.generic-deal-details-page .deal-team-head h2{display:none}.generic-deal-details-page .deal-conversations-head,.generic-deal-details-page .deal-team-head{justify-content:flex-end}@media(max-width:700px){.generic-deal-details-page .deal-reference-header{padding-left:12px;padding-right:12px}.generic-deal-details-page .deal-reference-cards{padding-left:8px;padding-right:8px}}`;

const editStyles = `.deal-card-heading{display:flex;justify-content:space-between;align-items:center;gap:8px}.deal-card-heading h2{margin-bottom:0}.deal-pair{position:relative;padding-right:24px}.deal-field{position:relative;padding-right:24px}.deal-pair-edit{position:absolute;right:0;top:5px;border:0;background:transparent;color:var(--text-secondary);padding:3px;cursor:pointer}.deal-pair-edit:hover{color:var(--primary-color,var(--accent-color))}.deal-related span{cursor:pointer;color:var(--primary-color,var(--accent-color))}.deal-related{justify-content:space-between}.deal-contact-arrow{border:0;background:transparent;color:var(--text-secondary);font-size:20px;line-height:1;padding:0 2px;cursor:pointer}.deal-contact-arrow:hover{color:var(--primary-color,var(--accent-color))}.deal-reference-main.deal-contact-active .deal-placeholder,.deal-reference-main.deal-products-active .deal-placeholder{display:none}.deal-contacts-table-wrap,.deal-products-workspace{overflow-x:auto;padding:2px}.deal-contacts-table,.deal-products-table{width:100%;border-collapse:collapse;text-align:left;font-size:12px}.deal-contacts-table th,.deal-products-table th{background:var(--table-header-bg,var(--subtle-bg));color:var(--text-secondary);font-weight:600;white-space:nowrap}.deal-contacts-table th,.deal-contacts-table td,.deal-products-table th,.deal-products-table td{padding:11px 12px;border-bottom:1px solid var(--border-color);vertical-align:middle}.deal-contact-person{display:flex;align-items:center;gap:8px;white-space:nowrap}.deal-contact-avatar{width:28px;height:28px;display:grid;place-items:center;border-radius:50%;background:#b8f2d6;color:#35c995;font-size:11px;font-weight:700}.deal-products-empty{text-align:center;color:var(--text-secondary);padding:24px!important}.deal-edit-overlay{display:none}.deal-edit-error{color:#b91c1c;font-size:11px}`;

function DealEditDialog({ deal, contacts, stages, pipelines, onClose, onSaved }) {
  const [form, setForm] = useState({ title: deal.title || '', amount: deal.amount ?? '', currency: deal.currency || 'USD', stage: slug(deal.stage), probability: deal.probability ?? 0, contactId: deal.contactId ? String(deal.contactId) : '', pipelineId: deal.pipelineId ? String(deal.pipelineId) : '', expectedClose: deal.expectedClose ? String(deal.expectedClose).slice(0, 10) : '', lostReason: deal.lostReason || '' });
  const [saving, setSaving] = useState(false); const [error, setError] = useState(''); const [open, setOpen] = useState(false);
  useEffect(() => { const show = (event) => { document.body.dataset.dealEditField = event.detail?.field || 'title'; setOpen(true); }; const hide = () => { delete document.body.dataset.dealEditField; setOpen(false); }; window.addEventListener('deal-details-edit', show); window.addEventListener('deal-details-edit-close', hide); return () => { window.removeEventListener('deal-details-edit', show); window.removeEventListener('deal-details-edit-close', hide); }; }, []);
  useEffect(() => { setForm({ title: deal.title || '', amount: deal.amount ?? '', currency: deal.currency || 'USD', stage: slug(deal.stage), probability: deal.probability ?? 0, contactId: deal.contactId ? String(deal.contactId) : '', pipelineId: deal.pipelineId ? String(deal.pipelineId) : '', expectedClose: deal.expectedClose ? String(deal.expectedClose).slice(0, 10) : '', lostReason: deal.lostReason || '' }); }, [deal]);
  const set = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));
  const submit = async (event) => {
    event.preventDefault();
    if (!form.title.trim() || form.amount === '' || Number(form.amount) < 0) { setError('Enter a valid deal name and amount.'); return; }
    setSaving(true); setError('');
    try {
      const updated = await fetchApi(`/api/deals/${deal.id}`, { method: 'PUT', body: JSON.stringify({ title: form.title.trim(), amount: Number(form.amount), currency: form.currency, stage: form.stage, probability: Number(form.probability), contactId: form.contactId ? Number(form.contactId) : null, pipelineId: form.pipelineId ? Number(form.pipelineId) : null, expectedClose: form.expectedClose || null, lostReason: form.lostReason || null }) });
      onSaved(updated); onClose();
    } catch (err) { setError(err?.serverMessage || err?.body?.error || 'Unable to save deal changes.'); } finally { setSaving(false); }
  };
  if (!open) return null;
  return <div className="deal-edit-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onClose(); }}><form className="deal-edit-dialog" role="dialog" aria-modal="true" aria-labelledby="edit-deal-title" onSubmit={submit}><div className="deal-edit-head"><h2 id="edit-deal-title">Edit deal</h2><button type="button" className="deal-icon-button" onClick={onClose} disabled={saving} aria-label="Close">×</button></div><div className="deal-edit-grid"><label>Deal name<input value={form.title} onChange={set('title')} required /></label><label>Amount<input type="number" min="0" step="0.01" value={form.amount} onChange={set('amount')} required /></label><label>Currency<select value={form.currency} onChange={set('currency')}><option>USD</option><option>INR</option><option>EUR</option><option>GBP</option></select></label><label>Stage<select value={form.stage} onChange={set('stage')} required><option value="">Click to select</option>{stages.map((stage) => <option key={stage.id} value={slug(stage.name)}>{stage.name}</option>)}</select></label><label>Probability<input type="number" min="0" max="100" value={form.probability} onChange={set('probability')} /></label><label>Related contact<select value={form.contactId} onChange={set('contactId')}><option value="">No contact</option>{contacts.map((contact) => <option key={contact.id} value={contact.id}>{contact.name || contact.email || `Contact #${contact.id}`}</option>)}</select></label><label>Pipeline<select value={form.pipelineId} onChange={set('pipelineId')}><option value="">No pipeline</option>{pipelines.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>Expected close date<input type="date" value={form.expectedClose} onChange={set('expectedClose')} /></label><label className="deal-edit-wide">Lost reason<textarea value={form.lostReason} onChange={set('lostReason')} /></label></div>{error && <p className="deal-edit-error" role="alert">{error}</p>}<div className="deal-edit-actions"><button type="button" className="deal-secondary" onClick={onClose} disabled={saving}>Cancel</button><button type="submit" className="deal-primary" disabled={saving}>{saving ? 'Saving…' : 'Save changes'}</button></div></form></div>;
}

function InlineDealEditor({ deal, stages, pipelines, genericDealTypes, isGeneric, onClose, onSaved }) {
  const [field, setField] = useState('');
  const [anchor, setAnchor] = useState(null);
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [contactQuery, setContactQuery] = useState('');
  const [contactOptions, setContactOptions] = useState([]);
  const [staffOptions, setStaffOptions] = useState([]);
  const [currencyOptions, setCurrencyOptions] = useState([]);
  const [currencyValue, setCurrencyValue] = useState(deal.currency || 'USD');
  const contactRequestId = useRef(0);
  useEffect(() => {
    const show = (event) => {
      const next = event.detail?.field || 'title';
      const values = { title: deal.title || '', amount: deal.amount ?? '', currency: deal.currency || 'USD', stage: slug(deal.stage), probability: deal.probability ?? 0, contactId: deal.contactId ? String(deal.contactId) : '', assignedToId: deal.contact?.assignedToId ? String(deal.contact.assignedToId) : '', dealType: deal.dealType || '', pipelineId: deal.pipelineId ? String(deal.pipelineId) : '', expectedClose: deal.expectedClose ? String(deal.expectedClose).slice(0, 10) : '', lostReason: deal.lostReason || '' };
      setField(next); setValue(values[next] ?? ''); setCurrencyValue(values.currency || 'USD'); setAnchor(event.detail?.anchor || null); setError(''); setContactQuery('');
    };
    const hide = () => { setField(''); setAnchor(null); };
    window.addEventListener('deal-details-edit', show); window.addEventListener('deal-details-edit-close', hide);
    return () => { window.removeEventListener('deal-details-edit', show); window.removeEventListener('deal-details-edit-close', hide); };
  }, [deal]);
  useEffect(() => {
    if (field !== 'contactId') return undefined;
    const requestId = ++contactRequestId.current;
    const timer = window.setTimeout(async () => {
      const params = new URLSearchParams({ fields: 'summary', limit: '50' });
      const query = contactQuery.trim();
      if (query) params.set('q', query);
      try {
        const result = await fetchApi(`/api/contacts?${params.toString()}`, { silent: true });
        if (requestId !== contactRequestId.current) return;
        const rows = Array.isArray(result) ? result : (result?.data || []);
        const currentContact = deal.contact?.id ? [deal.contact] : [];
        setContactOptions([...currentContact, ...rows].filter((contact, index, all) => all.findIndex((item) => String(item.id) === String(contact.id)) === index));
      } catch {
        if (requestId === contactRequestId.current) setContactOptions(deal.contact?.id ? [deal.contact] : []);
      }
    }, 200);
    return () => {
      window.clearTimeout(timer);
      if (contactRequestId.current === requestId) contactRequestId.current += 1;
    };
  }, [contactQuery, deal.contact, field]);
  useEffect(() => {
    if (field !== 'assignedToId') return undefined;
    let active = true;
    fetchApi('/api/staff?fields=summary', { silent: true })
      .then((result) => {
        if (!active) return;
        const rows = Array.isArray(result) ? result : (result?.users || result?.data || []);
        const current = deal.contact?.assignedTo ? [deal.contact.assignedTo] : [];
        setStaffOptions([...current, ...rows].filter((item, index, all) => all.findIndex((row) => String(row.id) === String(item.id)) === index));
      })
      .catch(() => { if (active) setStaffOptions(deal.contact?.assignedTo ? [deal.contact.assignedTo] : []); });
    return () => { active = false; };
  }, [deal.contact, field]);
  useEffect(() => {
    if (field !== 'amount' && !(field === 'currency' && isGeneric)) return undefined;
    let active = true;
    fetchApi('/api/currencies', { silent: true })
      .then((result) => { if (active) setCurrencyOptions(Array.isArray(result) ? result : (result?.data || [])); })
      .catch(() => { if (active) setCurrencyOptions([]); });
    return () => { active = false; };
  }, [field, isGeneric]);
  const submit = async (event) => {
    event.preventDefault();
    if (field === 'amount' && (value === '' || Number(value) < 0)) { setError('Enter a valid amount.'); return; }
    if (field === 'probability' && (Number(value) < 0 || Number(value) > 100)) { setError('Probability must be between 0 and 100.'); return; }
    setSaving(true); setError('');
    try {
      if (field === 'assignedToId') {
        if (!deal.contactId) throw new Error('This deal has no linked lead to assign.');
        const updatedContact = await fetchApi(`/api/contacts/${deal.contactId}/assign`, { method: 'PUT', body: JSON.stringify({ assignedToId: value ? Number(value) : null }) });
        onSaved({ contact: { ...deal.contact, ...updatedContact } }); onClose(); setField(''); return;
      }
      const body = { [field]: field === 'amount' && isGeneric ? convertCurrencyStrict(Number(value), deal.currency, currencyValue, currencyOptions) : field === 'amount' ? Number(value) : field === 'probability' ? Number(value) : ['contactId', 'pipelineId'].includes(field) ? (value ? Number(value) : null) : ['expectedClose', 'lostReason'].includes(field) ? (value || null) : field === 'stage' ? value : (value.trim ? value.trim() : value) };
      if (field === 'amount' && isGeneric) body.currency = currencyValue;
      if (field === 'currency' && isGeneric) body.amount = convertCurrencyStrict(deal.amount, deal.currency, value, currencyOptions);
      const updated = await fetchApi(`/api/deals/${deal.id}`, { method: 'PUT', body: JSON.stringify(body) });
      onSaved(updated); onClose(); setField('');
    } catch (err) { setError(err?.serverMessage || err?.body?.error || err?.message || 'Unable to save this field.'); } finally { setSaving(false); }
  };
  if (!field || !anchor) return null;
  const options = field === 'stage' ? stages : field === 'contactId' ? contactOptions : field === 'assignedToId' ? staffOptions : field === 'dealType' ? genericDealTypes.map((item) => ({ id: item.name, name: item.name })) : field === 'pipelineId' ? pipelines : [];
  const currencyChoices = [...(currencyOptions.length ? currencyOptions : ['USD', 'INR', 'EUR', 'GBP'].map((code) => ({ code }))), ...(deal.currency && !currencyOptions.some((item) => item.code === deal.currency) ? [{ code: deal.currency }] : [])].filter((item, index, list) => list.findIndex((row) => row.code === item.code) === index);
  const label = { title: 'Deal name', amount: 'Amount', currency: 'Currency', stage: 'Stage', probability: 'Probability', contactId: 'Related contact', assignedToId: 'Assigned sales owner', dealType: 'Deal type', pipelineId: 'Pipeline', expectedClose: 'Expected close date', lostReason: 'Lost reason' }[field];
  const top = Math.min(anchor.bottom + 4, window.innerHeight - 150);
  const left = Math.min(anchor.left, window.innerWidth - 285);
  return <form className="deal-inline-editor" role="dialog" aria-label={`Edit ${label}`} style={{ top, left }} onSubmit={submit} onMouseDown={(event) => event.stopPropagation()}><label>{label}{field === 'contactId' && <input aria-label="Search contacts" placeholder="Search contacts..." value={contactQuery} onChange={(event) => setContactQuery(event.target.value)} />}{['stage', 'currency', 'contactId', 'assignedToId', 'dealType', 'pipelineId'].includes(field) ? <select value={value} onChange={(event) => setValue(event.target.value)}>{field !== 'stage' && <option value="">{field === 'contactId' ? 'No contact' : field === 'assignedToId' ? 'Unassigned' : field === 'dealType' ? 'Select deal type' : field === 'pipelineId' ? 'No pipeline' : 'Select currency'}</option>}{field === 'currency' ? ['USD', 'INR', 'EUR', 'GBP'].map((item) => <option key={item}>{item}</option>) : options.map((item) => <option key={item.id} value={field === 'stage' ? slug(item.name) : item.id}>{item.name || item.email || `${field === 'contactId' ? 'Contact' : 'Staff'} #${item.id}`}</option>)}</select> : field === 'amount' ? <div className="deal-amount-editor"><input type="number" min="0" step="0.01" value={value} onChange={(event) => setValue(event.target.value)} required />{isGeneric && <select aria-label="Currency for deal amount" value={currencyValue} onChange={(event) => setCurrencyValue(event.target.value)}>{currencyChoices.map((item) => <option key={item.code} value={item.code}>{item.code}</option>)}</select>}</div> : field === 'lostReason' ? <textarea value={value} onChange={(event) => setValue(event.target.value)} /> : <input type={field === 'probability' ? 'number' : field === 'expectedClose' ? 'date' : 'text'} min={field === 'probability' ? '0' : undefined} max={field === 'probability' ? '100' : undefined} value={value} onChange={(event) => setValue(event.target.value)} required={field === 'title'} />}</label>{error && <p className="deal-edit-error" role="alert">{error}</p>}<div className="deal-inline-editor-actions"><button type="button" className="deal-secondary" onClick={onClose} disabled={saving}>Cancel</button><button type="submit" className="deal-primary" disabled={saving}>{saving ? 'Saving...' : 'Save'}</button></div></form>;
}

function DealContactWorkspace() {
  const [contactId, setContactId] = useState(null); const [contact, setContact] = useState(null); const [loading, setLoading] = useState(false); const [error, setError] = useState(''); const [target, setTarget] = useState(null);
  const location = useLocation();
  useEffect(() => { const open = (event) => { setContactId(event.detail?.contactId || null); window.dispatchEvent(new Event('deal-products-close')); window.dispatchEvent(new Event('deal-team-close')); window.dispatchEvent(new Event('deal-conversations-close')); }; const close = () => setContactId(null); window.addEventListener('deal-contact-open', open); window.addEventListener('deal-contact-close', close); return () => { window.removeEventListener('deal-contact-open', open); window.removeEventListener('deal-contact-close', close); }; }, []);
  useEffect(() => { const node = document.querySelector('.deal-reference-main'); setTarget(node); if (node) node.classList.toggle('deal-contact-active', Boolean(contactId)); return () => node?.classList.remove('deal-contact-active'); }, [contactId]);
  useEffect(() => { if (!contactId) { setContact(null); return undefined; } let active = true; setLoading(true); setError(''); fetchApi(`/api/contacts/${contactId}`, { silent: true }).then((data) => { if (active) setContact(data); }).catch((err) => { if (active) setError(err?.serverMessage || 'Unable to load contact details.'); }).finally(() => { if (active) setLoading(false); }); return () => { active = false; }; }, [contactId]);
  if (!target || !contactId) return null;
  const returnTo = `${location.pathname}${location.search}`;
  const content = loading ? <div className="deal-contact-state">Loading contact details...</div> : error ? <div className="deal-contact-state deal-error"><p>{error}</p><button type="button" className="deal-link" onClick={() => setContactId(null)}>Close</button></div> : contact ? <DealContactTable contact={contact} returnTo={returnTo} /> : null;
  return createPortal(<div className="deal-contact-workspace">{content}</div>, target);
}

function DealProductsWorkspace({ products }) {
  const [open, setOpen] = useState(false); const [target, setTarget] = useState(null);
  useEffect(() => { const show = () => { setOpen(true); window.dispatchEvent(new Event('deal-contact-close')); window.dispatchEvent(new Event('deal-team-close')); window.dispatchEvent(new Event('deal-conversations-close')); }; const hide = () => setOpen(false); window.addEventListener('deal-products-open', show); window.addEventListener('deal-products-close', hide); return () => { window.removeEventListener('deal-products-open', show); window.removeEventListener('deal-products-close', hide); }; }, []);
  useEffect(() => { const node = document.querySelector('.deal-reference-main'); setTarget(node); if (node) node.classList.toggle('deal-products-active', open); return () => node?.classList.remove('deal-products-active'); }, [open]);
  if (!open || !target) return null;
  return createPortal(<div className="deal-products-workspace"><table className="deal-products-table"><thead><tr><th>Product</th><th>Setup fee</th><th>Unit price</th><th>Quantity</th><th>Discount</th></tr></thead><tbody>{products.length ? products.map((product, index) => <tr key={`${product.name}-${index}`}><td>{product.name}</td><td>{formatMoney(product.setupFee || 0, { currency: product.currency || 'USD' })}</td><td>{formatMoney(product.unitPrice || 0, { currency: product.currency || 'USD' })}</td><td>{product.quantity}</td><td>{product.discount ?? 0}%</td></tr>) : <tr><td colSpan="5" className="deal-products-empty">No products linked</td></tr>}</tbody></table></div>, target);
}

const dealTeamStyles = `.deal-reference-main.deal-team-active .deal-placeholder{display:none}.deal-team-workspace{min-height:265px;padding:16px;background:var(--surface-color)}.deal-team-head{display:flex;justify-content:space-between;align-items:center;gap:12px}.deal-team-head h2{margin:0;font-size:14px}.deal-team-manage{display:none}.deal-team-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:9px;min-height:205px;color:#7890b1;text-align:center;font-size:11px}.deal-team-empty-icon{display:grid;place-items:center;width:72px;height:72px;border-radius:50%;background:#eef2f7;color:#aebaca}.deal-team-add{border:0;border-radius:4px;padding:7px 11px;background:#17395f;color:#fff;font-size:11px;font-weight:700;cursor:pointer}`;
function DealTeamWorkspace() {
  const [open, setOpen] = useState(false); const [target, setTarget] = useState(null); const [showMembers, setShowMembers] = useState(false); const [query, setQuery] = useState(''); const [members, setMembers] = useState([]); const [selectedMembers, setSelectedMembers] = useState([]);
  useEffect(() => { const show = () => { setOpen(true); window.dispatchEvent(new Event('deal-products-close')); window.dispatchEvent(new Event('deal-contact-close')); window.dispatchEvent(new Event('deal-conversations-close')); }; const hide = () => { setOpen(false); setShowMembers(false); }; window.addEventListener('deal-team-open', show); window.addEventListener('deal-team-close', hide); return () => { window.removeEventListener('deal-team-open', show); window.removeEventListener('deal-team-close', hide); }; }, []);
  useEffect(() => { const node = document.querySelector('.deal-reference-main'); setTarget(node); if (node) node.classList.toggle('deal-team-active', open); return () => node?.classList.remove('deal-team-active'); }, [open]);
  useEffect(() => { if (!showMembers) return undefined; let active = true; fetchApi('/api/staff', { silent: true }).then((result) => { if (active) setMembers(Array.isArray(result) ? result : result?.users || []); }).catch(() => { if (active) setMembers([]); }); return () => { active = false; }; }, [showMembers]);
  if (!open || !target) return null;
  const openMembers = () => setShowMembers(true);
  const addMember = (member) => { setSelectedMembers((current) => current.some((item) => item.id === member.id) ? current : [...current, member]); setQuery(''); };
  const memberName = (member) => member.name || [member.firstName, member.lastName].filter(Boolean).join(' ') || member.email || '';
  const visibleMembers = members.filter((member) => memberName(member).toLowerCase().includes(query.trim().toLowerCase()));
  return createPortal(<div className="deal-team-workspace"><style>{dealTeamStyles}</style><div className="deal-team-head"><h2>Deal team</h2><button type="button" className="deal-team-manage" onClick={openMembers}>Manage team members</button></div>{selectedMembers.length > 0 && <div>{selectedMembers.map((member) => <div key={member.id}>{memberName(member)}</div>)}</div>}{showMembers ? <div><input className="input-field" aria-label="Search sales members" placeholder="Search sales members" value={query} onChange={(event) => setQuery(event.target.value)} />{query.trim() ? (visibleMembers.length ? <div>{visibleMembers.map((member) => <button type="button" key={member.id} onClick={() => addMember(member)}>{memberName(member)}</button>)}</div> : <p>No sales members found.</p>) : null}</div> : selectedMembers.length === 0 && <div className="deal-team-empty"><div className="deal-team-empty-icon"><Users size={34} /></div><span>No deal team members found.</span><button type="button" className="deal-team-add" onClick={openMembers}>Add team members</button></div>}</div>, target);
}

function DealConversationsWorkspace({ dealId, contact }) {
  const [open, setOpen] = useState(false); const [target, setTarget] = useState(null); const [filter, setFilter] = useState('email'); const [items, setItems] = useState([]); const [refresh, setRefresh] = useState(0); const [emailOpen, setEmailOpen] = useState(false);
  useEffect(() => { const show = () => { setOpen(true); setRefresh((value) => value + 1); window.dispatchEvent(new Event('deal-team-close')); window.dispatchEvent(new Event('deal-products-close')); window.dispatchEvent(new Event('deal-contact-close')); }; const hide = () => setOpen(false); window.addEventListener('deal-conversations-open', show); window.addEventListener('deal-conversations-close', hide); return () => { window.removeEventListener('deal-conversations-open', show); window.removeEventListener('deal-conversations-close', hide); }; }, []);
  useEffect(() => { const node = document.querySelector('.deal-reference-main'); setTarget(node); if (node) node.classList.toggle('deal-conversations-active', open); return () => node?.classList.remove('deal-conversations-active'); }, [open]);
  useEffect(() => { if (!open) return undefined; let active = true; fetchApi(`/api/deals/${dealId}/timeline`, { silent: true }).then((result) => { if (active) setItems(Array.isArray(result) ? result : []); }).catch(() => { if (active) setItems([]); }); return () => { active = false; }; }, [dealId, open, refresh]);
  if (!open || !target) return null;
  const visible = items.filter((item) => filter === 'email' ? item.type === 'email' : item.type === 'call');
  return <>{createPortal(<div className="deal-conversations-workspace"><style>{`.deal-reference-main.deal-conversations-active .deal-placeholder{display:none}.deal-conversations-workspace{min-height:265px;padding:16px;background:var(--surface-color)}.deal-conversations-head{display:flex;justify-content:space-between;align-items:center}.deal-conversations-head h2{margin:0;font-size:14px}.deal-conversations-send{padding:7px 10px;border:1px solid var(--border-color);border-radius:4px;background:var(--surface-color);color:var(--text-primary);font-size:11px;cursor:pointer}.deal-conversations-tabs{display:flex;gap:18px;margin-top:20px;border-bottom:1px solid var(--border-color)}.deal-conversations-tabs button{border:0;border-bottom:2px solid transparent;background:none;color:var(--text-primary);padding:8px 0;font-size:11px;cursor:pointer}.deal-conversations-tabs button.active{color:var(--primary-color,var(--accent-color));border-bottom-color:var(--primary-color,var(--accent-color))}.deal-conversation-row{display:grid;grid-template-columns:35px minmax(0,1fr);gap:10px;padding:10px 0;border-bottom:1px solid var(--border-color);font-size:11px}.deal-conversation-avatar{display:grid;place-items:center;width:32px;height:32px;border-radius:50%;background:#dff4f0;color:#527f88}.deal-conversation-row strong,.deal-conversation-row small{display:block}.deal-conversation-row small{color:var(--text-secondary);margin-top:4px}.deal-conversations-empty{padding:28px 0;color:var(--text-secondary);font-size:11px}`}</style><div className="deal-conversations-head"><h2>Conversations</h2><button type="button" className="deal-conversations-send" onClick={() => setEmailOpen(true)}>Send email</button></div><div className="deal-conversations-tabs"><button type="button" className={filter === 'email' ? 'active' : ''} onClick={() => setFilter('email')}>Sales Emails &amp; Activities</button><button type="button" className={filter === 'call' ? 'active' : ''} onClick={() => setFilter('call')}>Call Logs</button></div>{visible.length ? visible.map((item) => <div className="deal-conversation-row" key={`${item.type}-${item.id}`}><div className="deal-conversation-avatar">{item.type === 'email' ? '✉' : '☎'}</div><div>{item.type === 'email' ? <RichText as="div" value={item.description || 'Email conversation'} /> : <strong>{item.description || 'Call log'}</strong>}<small>{item.createdAt ? formatDate(item.createdAt) : ''}</small></div></div>) : <div className="deal-conversations-empty">No {filter === 'email' ? 'email conversations' : 'call logs'} found.</div>}</div>, target)}{emailOpen && <EmailModal contact={contact} onClose={() => setEmailOpen(false)} onDone={() => setEmailOpen(false)} />}</>;
}

function DealMeetingModal({ contact, onDone }) {
  const [open, setOpen] = useState(false);
  useEffect(() => { const show = () => setOpen(true); window.addEventListener('deal-meeting-open', show); return () => window.removeEventListener('deal-meeting-open', show); }, []);
  if (!open || !contact) return null;
  return <MeetingModal contact={contact} onClose={() => setOpen(false)} onDone={() => { setOpen(false); onDone?.(); }} />;
}

function DealTagEditor({ deal, onSaved, onCatalogChange, open, setOpen }) {
  const [target, setTarget] = useState(null); const [catalog, setCatalog] = useState([]); const [loading, setLoading] = useState(false); const [search, setSearch] = useState(''); const [pending, setPending] = useState([]); const [saving, setSaving] = useState(false); const [creating, setCreating] = useState(false); const [error, setError] = useState(''); const [newName, setNewName] = useState(''); const [newColor, setNewColor] = useState(GENERIC_TAG_COLORS[0]); const [colorSaving, setColorSaving] = useState(''); const notify = useNotify();
  const tags = useMemo(
    () => parseTags(deal.contact?.tags || deal.contact?.tagsJson || deal.tags) || [],
    [deal.contact?.tags, deal.contact?.tagsJson, deal.tags],
  );
  useEffect(() => {
    if (open) {
      setPending(dedupeTags(tags));
      setSearch('');
      setNewName('');
      setError('');
      // Capture the existing anchor while handling the click so the portal
      // does not depend on a follow-up effect to discover its target.
      setTarget(document.querySelector('.deal-tag-line'));
    }
  }, [open, tags]);
  useEffect(() => {
    const remove = async (event) => {
      const name = event.detail?.name;
      if (!name || !deal.contact?.id) return;
      setSaving(true);
      try {
        const updated = await patchContact(deal.contact.id, { tags: tags.filter((tag) => tagKey(tag) !== tagKey(name)) });
        onSaved(updated);
      } catch (err) {
        notify.error(err?.body?.error || 'Could not remove tag.');
      } finally {
        setSaving(false);
      }
    };
    window.addEventListener('deal-tag-remove', remove);
    return () => { window.removeEventListener('deal-tag-remove', remove); };
  }, [deal.contact?.id, deal.contact?.tags, deal.contact?.tagsJson, deal.tags, tags, notify, onSaved]);
  useEffect(() => { setTarget(document.querySelector('.deal-tag-line')); }, [open]);
  useEffect(() => { let active = true; setLoading(true); fetchApi('/api/contacts/tags', { silent: true }).then((data) => { if (active) { const records = normalizeTagRecords(data); setCatalog(records); onCatalogChange?.(records); } }).catch(() => {}).finally(() => { if (active) setLoading(false); }); return () => { active = false; }; }, [onCatalogChange]);
  const records = [...catalog]; tags.forEach((tag) => { const name = String(tag); if (!records.some((record) => tagKey(record.name) === tagKey(name))) records.push({ name, color: fallbackTagColor(name) }); });
  const filtered = records.filter((record) => !search.trim() || record.name.toLowerCase().includes(search.trim().toLowerCase()));
  const selected = (name) => pending.some((tag) => tagKey(tag) === tagKey(name));
  const updateCatalog = (next) => { setCatalog(next); onCatalogChange?.(next); };
  const toggle = (name) => setPending((current) => current.some((tag) => tagKey(tag) === tagKey(name)) ? current.filter((tag) => tagKey(tag) !== tagKey(name)) : [...current, name]);
  const apply = async () => { setSaving(true); setError(''); try { const updated = await patchContact(deal.contact.id, { tags: dedupeTags(pending) }); onSaved(updated); setOpen(false); } catch (err) { setError(err?.body?.error || 'Could not save tags.'); notify.error(err?.body?.error || 'Could not save tags.'); } finally { setSaving(false); } };
  const create = async () => { const name = newName.trim(); if (!name) { setError('Enter a tag name.'); return; } if (records.some((record) => tagKey(record.name) === tagKey(name))) { setError('That tag already exists.'); return; } setCreating(true); setError(''); try { const created = await fetchApi('/api/contacts/tags', { method: 'POST', body: JSON.stringify({ name, color: newColor }) }); const record = normalizeTagRecords([created])[0] || { name, color: newColor }; updateCatalog([...catalog, record]); setPending((current) => [...current, record.name]); setNewName(''); } catch (err) { setError(err?.body?.error || 'Could not create tag.'); } finally { setCreating(false); } };
  const changeColor = async (name, color) => { const key = tagKey(name); const previous = catalog; setColorSaving(key); updateCatalog(catalog.map((record) => tagKey(record.name) === key ? { ...record, color } : record)); try { await fetchApi(`/api/contacts/tags/${encodeURIComponent(name)}`, { method: 'PATCH', body: JSON.stringify({ color }) }); } catch (err) { updateCatalog(previous); setError(err?.body?.error || 'Could not update tag color.'); } finally { setColorSaving(''); } };
  if (!open || !target || !deal.contact?.id) return null;
  return createPortal(<div className="cd-tag-picker deal-tag-picker" role="dialog" aria-label="Tag selector" onClick={(event) => event.stopPropagation()}>
    <div className="cd-tag-picker-head"><strong>Add tags</strong><button type="button" className="cd-tag-picker-close" onClick={() => setOpen(false)} aria-label="Close tag selector"><X size={14} /></button></div>
    <label className="cd-tag-picker-search"><Search size={13} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search tags" aria-label="Search tags" /></label>
    <div className="cd-tag-picker-list" role="listbox" aria-multiselectable="true">{loading ? <div className="cd-tag-picker-message">Loading tags...</div> : filtered.length ? filtered.map((record) => <div className={`cd-tag-option${selected(record.name) ? ' is-selected' : ''}`} key={record.name}><button type="button" role="option" aria-selected={selected(record.name)} onClick={() => toggle(record.name)}><span className="cd-tag-option-check">{selected(record.name) ? '✓' : ''}</span><span className="cd-tag-chip" style={{ background: record.color, borderColor: record.color, color: tagTextColor(record.color) }}>{record.name}</span></button><label className="cd-tag-color"><input type="color" value={record.color} onChange={(event) => changeColor(record.name, event.target.value)} disabled={colorSaving === tagKey(record.name)} aria-label={`Change color for ${record.name}`} /></label></div>) : <div className="cd-tag-picker-message">No tags available.</div>}</div>
    <form className="cd-create-tag" onSubmit={(event) => { event.preventDefault(); create(); }}><strong>Create new tag</strong><div className="cd-create-tag-row"><input value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="Tag name" aria-label="Add tag" /><input type="color" value={newColor} onChange={(event) => setNewColor(event.target.value)} aria-label="New tag color" /><button type="submit" disabled={creating}>{creating ? 'Creating...' : 'Create'}</button></div></form>
    {error && <div className="cd-tag-picker-error" role="alert">{error}</div>}
    <div className="cd-tag-picker-actions"><button type="button" className="cd-tag-picker-cancel" onClick={() => setOpen(false)}>Cancel</button><button type="button" className="cd-tag-picker-apply" onClick={apply} disabled={saving || creating}>{saving ? 'Applying...' : 'Apply tags'}</button></div>
  </div>, target);
}

function DealNoteModal({ contact, onSaved }) {
  const [open, setOpen] = useState(false); const [saving, setSaving] = useState(false); const editorRef = useRef(null);
  useEffect(() => { const show = () => setOpen(true); window.addEventListener('deal-note-open', show); return () => window.removeEventListener('deal-note-open', show); }, []);
  const formatNote = (command, value) => { editorRef.current?.focus(); document.execCommand(command, false, value); };
  const save = async () => { const description = editorRef.current?.innerHTML?.trim() || ''; if (!description || !contact?.id) return; setSaving(true); try { const activity = await fetchApi(`/api/contacts/${contact.id}/activities`, { method: 'POST', body: JSON.stringify({ type: 'Note', description }) }); onSaved?.(activity); setOpen(false); if (editorRef.current) editorRef.current.innerHTML = ''; } finally { setSaving(false); } };
  if (!open || !contact) return null;
  return <div className="cp-overlay cp-note-overlay" onClick={() => setOpen(false)} role="dialog" aria-modal="true" aria-label="Add note"><div className="cp-note-composer" onClick={(event) => event.stopPropagation()}><div className="cp-modal-head"><h3>Add note</h3><button type="button" className="cp-icon-btn" onClick={() => setOpen(false)} aria-label="Close"><X size={16} /></button></div><div className="cp-note-related">Contact: <strong>{contact.name}</strong></div><div ref={editorRef} className="cp-note-editor" contentEditable suppressContentEditableWarning data-placeholder="Start typing your note..." role="textbox" aria-label="Note content" /><div className="cp-note-toolbar" aria-label="Note formatting"><select aria-label="Font size" defaultValue="3" onChange={(event) => formatNote('fontSize', event.target.value)}><option value="2">12</option><option value="3">14</option><option value="4">16</option><option value="5">18</option></select><button type="button" onClick={() => formatNote('bold')} aria-label="Bold"><strong>B</strong></button><button type="button" onClick={() => formatNote('italic')} aria-label="Italic"><em>I</em></button><button type="button" onClick={() => formatNote('underline')} aria-label="Underline"><u>U</u></button><button type="button" onClick={() => formatNote('insertUnorderedList')} aria-label="Bulleted list">•≡</button><button type="button" onClick={() => formatNote('insertOrderedList')} aria-label="Numbered list">1≡</button><button type="button" onClick={() => formatNote('justifyLeft')} aria-label="Align left">≡</button><button type="button" onClick={() => formatNote('justifyCenter')} aria-label="Align center">☰</button></div><div className="cp-btn-row"><button type="button" className="cp-action-btn" onClick={() => setOpen(false)}>Cancel</button><button type="button" className="cp-action-btn cp-action-primary" onClick={save} disabled={saving}>{saving ? 'Saving...' : 'Done'}</button></div></div></div>;
}

function DealActivityOverviewModal({ deal }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState('all');
  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener('deal-activity-overview-open', show);
    return () => window.removeEventListener('deal-activity-overview-open', show);
  }, []);
  useEffect(() => {
    if (!open) return undefined;
    let active = true;
    setLoading(true);
    fetchApi(`/api/deals/${deal.id}/activities?limit=100&page=1`, { silent: true })
      .then((result) => { if (active) setItems(Array.isArray(result) ? result : (result?.data || [])); })
      .catch(() => { if (active) setItems(deal.activities || []); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [deal.id, deal.activities, open]);
  useEffect(() => {
    if (!open) return undefined;
    const heading = document.querySelector('.deal-activity-modal .deal-activity-modal-head h2');
    if (heading) heading.textContent = 'Activities';
    return undefined;
  }, [open]);
  if (!open) return null;
  const normalized = items.map((item) => {
    const type = String(item.type || 'Activity').toLowerCase();
    const category = type === 'note' ? 'notes' : type.includes('meeting') || type === 'appointment' ? 'meetings' : 'activities';
    return { ...item, category };
  });
  const meeting = deal.upcomingMeeting ? [{ id: `upcoming-${deal.upcomingMeeting.id || 'meeting'}`, category: 'meetings', type: 'Meeting', description: deal.upcomingMeeting.title || 'Upcoming meeting', createdAt: deal.upcomingMeeting.startAt }] : [];
  const visible = [...meeting, ...normalized].filter((item) => filter === 'all' || item.category === filter);
  return <div className="deal-activity-modal-overlay" role="dialog" aria-modal="true" aria-label="Notes, activities and meetings" onClick={() => setOpen(false)}><style>{'.deal-activity-modal-overlay{position:fixed;inset:0;z-index:11000;display:grid;place-items:center;padding:20px;background:transparent}.deal-activity-modal{position:relative;isolation:isolate;width:min(720px,calc(100vw - 32px));height:min(560px,calc(100vh - 48px));display:flex;flex-direction:column;overflow:hidden;opacity:1;background:#fff !important;border:1px solid var(--border-color);border-radius:10px;box-shadow:0 18px 50px rgba(15,23,42,.24)}.deal-activity-modal-head,.deal-activity-modal-tabs,.deal-activity-modal-list{background:#fff}.deal-activity-modal-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;padding:18px 20px;border-bottom:1px solid var(--border-color)}.deal-activity-modal-head h2{margin:0;font-size:16px}.deal-activity-modal-head p{margin:5px 0 0;color:var(--text-secondary);font-size:11px}.deal-activity-modal-tabs{display:flex;gap:20px;padding:0 20px;border-bottom:1px solid var(--border-color)}.deal-activity-modal-tabs button{border:0;border-bottom:2px solid transparent;background:transparent;color:var(--text-secondary);padding:11px 0;font-size:12px;cursor:pointer}.deal-activity-modal-tabs button.active{border-bottom-color:var(--primary-color,var(--accent-color));color:var(--text-primary);font-weight:700}.deal-activity-modal-list{flex:1;min-height:0;overflow:auto;padding:8px 20px}.deal-activity-modal-row{display:grid;grid-template-columns:30px minmax(0,1fr);gap:10px;padding:12px 0;border-bottom:1px solid var(--border-color);font-size:12px}.deal-activity-modal-row>div:last-child{min-width:0}.deal-activity-modal-row strong,.deal-activity-modal-row span,.deal-activity-modal-row small{display:block}.deal-activity-modal-row span{margin-top:4px;overflow-wrap:anywhere}.deal-activity-modal-row small{margin-top:5px;color:var(--text-secondary);font-size:10px}.deal-activity-modal-type{display:grid;place-items:center;width:26px;height:26px;border-radius:50%;background:var(--subtle-bg);color:var(--text-secondary);font-weight:700;font-size:11px}'}</style><div className="deal-activity-modal" onClick={(event) => event.stopPropagation()}><div className="deal-activity-modal-head"><div><h2>Notes, activities and meetings</h2><p>Complete history for this deal</p></div><button type="button" className="deal-icon-button" aria-label="Close" onClick={() => setOpen(false)}><X size={16} /></button></div><div className="deal-activity-modal-tabs">{[['all', 'All'], ['notes', 'Notes'], ['activities', 'Activities'], ['meetings', 'Meetings']].map(([key, label]) => <button type="button" key={key} className={filter === key ? 'active' : ''} onClick={() => setFilter(key)}>{label}</button>)}</div><div className="deal-activity-modal-list">{loading ? <div className="deal-empty">Loading history...</div> : visible.length ? visible.map((item) => <div className="deal-activity-modal-row" key={`${item.category}-${item.id}-${item.createdAt}`}><div className="deal-activity-modal-type">{item.category === 'notes' ? 'N' : item.category === 'meetings' ? 'M' : 'A'}</div><div><strong>{item.type || 'Activity'}</strong><span>{plainText(item.description) || 'No description'}</span><small>{item.createdAt ? formatDateTime(item.createdAt) : EMPTY}</small></div></div>) : <div className="deal-empty">No {filter === 'all' ? 'history' : filter} found.</div>}</div></div></div>;
}

function DealContactTable({ contact, returnTo }) {
  const navigate = useNavigate();
  const deals = Array.isArray(contact.deals) ? contact.deals : [];
  const stageKey = (deal) => slug(deal.stage);
  const wonDeals = deals.filter((deal) => stageKey(deal).includes('won') && !stageKey(deal).includes('lost'));
  const openDeals = deals.filter((deal) => !stageKey(deal).includes('won') && !stageKey(deal).includes('lost'));
  const lastContacted = Array.isArray(contact.activities) && contact.activities.length ? contact.activities[0].createdAt : null;
  const name = contact.name || [contact.firstName, contact.lastName].filter(Boolean).join(' ') || 'Unnamed contact';
  const initials = name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase();
  const total = (items) => items.reduce((sum, deal) => sum + Number(deal.amount || 0), 0);
  const openContact = () => { if (contact.id != null) navigate(`/contacts/${contact.id}`, { state: { returnTo } }); };
  return <div className="deal-contacts-table-wrap"><table className="deal-contacts-table"><thead><tr><th>Name</th><th>Email</th><th>Last Contacted Time</th><th>Open Deals Amount</th><th>Won Deals Amount</th></tr></thead><tbody><tr><td><span className="deal-contact-person"><span className="deal-contact-avatar">{initials}</span><strong onClick={openContact} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openContact(); } }} role={contact.id != null ? 'link' : undefined} tabIndex={contact.id != null ? 0 : undefined}>{name}</strong></span></td><td>{contact.email || EMPTY}</td><td>{lastContacted ? formatDateTime(lastContacted) : EMPTY}</td><td>{formatMoney(total(openDeals), { currency: deals[0]?.currency || 'USD' })}</td><td>{formatMoney(total(wonDeals), { currency: deals[0]?.currency || 'USD' })}</td></tr></tbody></table></div>;
}

const dealDetailsLayoutStyles = `
.generic-deal-details-page {
  max-width: 1540px;
  margin: 0 auto;
  padding: 24px clamp(16px, 2vw, 32px) 40px;
  background: var(--subtle-bg);
}
.generic-deal-details-page .deal-reference-header {
  grid-template-columns: 56px minmax(0, 1fr) auto;
  gap: 14px 16px;
  padding: 22px 24px;
  margin-bottom: 16px;
  border: 1px solid var(--border-color);
  border-radius: 14px;
}
.generic-deal-details-page .deal-back-button {
  grid-column: 1 / -1;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  justify-self: start;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--primary-color, var(--accent-color));
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.generic-deal-details-page .deal-avatar {
  width: 56px;
  height: 56px;
  border-radius: 12px;
  font-size: 18px;
}
.generic-deal-details-page .deal-reference-header h1 {
  margin: 0 0 6px;
  font-size: clamp(20px, 1.6vw, 26px);
  line-height: 1.2;
}
.generic-deal-details-page .deal-reference-header .deal-meta {
  font-size: 14px;
}
.generic-deal-details-page .deal-header-stage {
  display: inline-flex;
  align-items: center;
  padding: 4px 9px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--accent-color) 12%, var(--surface-color));
  color: var(--primary-color, var(--accent-color));
  font-size: 12px;
  font-weight: 700;
}
.generic-deal-details-page .deal-tag-line {
  grid-column: 2 / -1;
  padding: 0;
  font-size: 13px;
}
.generic-deal-details-page .deal-reference-cards {
  grid-template-columns: repeat(2, minmax(0, 1fr)) minmax(270px, .85fr);
  grid-template-areas: 'overview status notes' 'related related related';
  gap: 12px;
  padding: 0;
  background: transparent;
  align-items: stretch;
}
.generic-deal-details-page .deal-reference-cards > .deal-info-card:first-child { grid-area: overview; }
.generic-deal-details-page .deal-reference-cards > .deal-info-card:nth-child(2) { grid-area: status; }
.generic-deal-details-page .deal-reference-cards > .deal-side-cards {
  grid-area: related;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}
.generic-deal-details-page .deal-reference-cards > .deal-reference-notes {
  grid-area: notes;
  height: auto;
  min-height: 170px;
  align-self: stretch;
  contain: none;
}
.generic-deal-details-page .deal-reference-cards .deal-info-card {
  padding: 18px 20px;
  border-radius: 12px;
  box-shadow: 0 2px 8px rgba(15, 23, 42, .03);
}
.generic-deal-details-page .deal-reference-cards .deal-side-cards .deal-info-card { margin: 0; }
.generic-deal-details-page .deal-reference-cards .deal-info-card h2 {
  margin: 0 0 12px;
  color: var(--text-primary);
  font-size: 15px;
  font-weight: 700;
}
.generic-deal-details-page .deal-reference-cards .deal-pair {
  padding: 9px 24px 9px 0;
  border-bottom: 1px solid var(--border-color);
}
.generic-deal-details-page .deal-reference-cards .deal-pair:last-child { border-bottom: 0; }
.generic-deal-details-page .deal-reference-cards .deal-pair span,
.generic-deal-details-page .deal-reference-cards .deal-pair strong { font-size: 13px; line-height: 1.4; }
.generic-deal-details-page .deal-reference-cards .deal-pair strong {
  color: var(--text-primary);
  font-weight: 600;
}
.generic-deal-details-page .deal-reference-cards .deal-pair-edit { top: 17px; }
.generic-deal-details-page .deal-side-cards .deal-empty,
.generic-deal-details-page .deal-side-cards .deal-related { font-size: 13px; }
.generic-deal-details-page .deal-reference-notes .deal-notes-list {
  align-content: start;
  max-height: 255px;
}
.generic-deal-details-page .deal-reference-notes .deal-link { font-size: 13px; }
.generic-deal-details-page .deal-reference-notes .deal-notes-list > .deal-empty {
  display: block;
  padding: 18px;
  border: 1px dashed var(--border-color);
  border-radius: 8px;
  background: var(--subtle-bg);
  text-align: center;
  font-size: 13px;
}
.generic-deal-details-page .deal-reference-tracker {
  margin: 16px 0;
  padding: 18px 20px;
  border: 1px solid var(--border-color);
  border-radius: 12px;
}
.generic-deal-details-page .deal-progress-heading {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: center;
  margin-bottom: 8px;
}
.generic-deal-details-page .deal-progress-heading h2 { margin: 0; font-size: 16px; }
.generic-deal-details-page .deal-progress-heading > span { display: none; }
.generic-deal-details-page .deal-progress-heading span { color: var(--text-secondary); font-size: 13px; }
.generic-deal-details-page .deal-reference-tracker .deal-age {
  margin-bottom: 12px;
  font-size: 12px;
  color: var(--text-secondary);
}
.generic-deal-details-page .deal-reference-tracker .deal-stages {
  gap: 8px;
  overflow-x: auto;
  background: transparent;
  border-radius: 0;
}
.generic-deal-details-page .deal-reference-tracker .deal-stage,
.generic-deal-details-page .deal-reference-tracker .deal-stage:not(:first-child) {
  min-width: 120px;
  min-height: 42px;
  margin: 0;
  padding: 8px 10px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  clip-path: none;
  background: var(--subtle-bg);
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 600;
  text-align: center;
  cursor: pointer;
}
.generic-deal-details-page .deal-reference-tracker .deal-stage.done { background: color-mix(in srgb, var(--accent-color) 10%, var(--surface-color)); }
.generic-deal-details-page .deal-reference-tracker .deal-stage.current {
  border-color: var(--accent-color);
  background: var(--accent-color);
  color: #fff;
}
.generic-deal-details-page .deal-reference-workspace {
  grid-template-columns: 200px minmax(0, 1fr);
  gap: 12px;
  min-height: 0;
  background: transparent;
}
.generic-deal-details-page .deal-reference-nav,
.generic-deal-details-page .deal-reference-main {
  border: 1px solid var(--border-color);
  border-radius: 12px;
  background: var(--surface-color);
}
.generic-deal-details-page .deal-reference-nav { padding: 18px 10px; }
.generic-deal-details-page .deal-reference-nav h2 { margin: 0 0 10px; padding: 0 10px; }
.generic-deal-details-page .deal-reference-nav button {
  margin: 2px 0;
  padding: 10px 12px;
  font-size: 13px;
}
.generic-deal-details-page .deal-reference-main { padding: 20px; }
.generic-deal-details-page .deal-details-toolbar { margin-bottom: 18px; }
.generic-deal-details-page .deal-details-toolbar h2 { font-size: 20px; }
.generic-deal-details-page .deal-reference-main .deal-field-grid {
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0 20px;
  padding: 4px 16px 12px;
}
.generic-deal-details-page .deal-reference-main .deal-field { padding: 12px 25px 12px 0; }
.generic-deal-details-page .deal-reference-main .deal-field span { font-size: 12px; }
.generic-deal-details-page .deal-reference-main .deal-field strong { font-size: 14px; line-height: 1.4; }
.generic-deal-details-page .deal-reference-main .deal-field-section {
  margin: 10px 0 16px;
  border-radius: 10px;
}
.generic-deal-details-page .deal-reference-main .deal-section-heading { padding: 12px 16px; }
@media (max-width: 1200px) {
  .generic-deal-details-page .deal-reference-cards {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    grid-template-areas: 'overview status' 'notes notes' 'related related';
  }
  .generic-deal-details-page .deal-reference-main .deal-field-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 760px) {
  .generic-deal-details-page { padding: 12px; }
  .generic-deal-details-page .deal-reference-header { grid-template-columns: 48px minmax(0, 1fr); padding: 18px; }
  .generic-deal-details-page .deal-avatar { width: 48px; height: 48px; }
  .generic-deal-details-page .deal-reference-actions { grid-column: 1 / -1; }
  .generic-deal-details-page .deal-tag-line { grid-column: 1 / -1; }
  .generic-deal-details-page .deal-reference-cards {
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas: 'overview' 'status' 'notes' 'related';
  }
  .generic-deal-details-page .deal-reference-cards > .deal-side-cards { grid-template-columns: minmax(0, 1fr); }
  .generic-deal-details-page .deal-reference-workspace { grid-template-columns: minmax(0, 1fr); }
  .generic-deal-details-page .deal-reference-nav { display: flex; gap: 4px; overflow-x: auto; padding: 8px; }
  .generic-deal-details-page .deal-reference-nav h2 { display: none; }
  .generic-deal-details-page .deal-reference-nav button { width: auto; white-space: nowrap; }
  .generic-deal-details-page .deal-reference-main { padding: 16px; }
}
@media (max-width: 520px) {
  .generic-deal-details-page .deal-reference-main .deal-field-grid { grid-template-columns: minmax(0, 1fr); }
  .generic-deal-details-page .deal-reference-tracker .deal-age { display: grid; gap: 4px; }
}
`;

function meetingSummary(deal) {
  const activity = (deal.activities || []).find((item) => String(item.type || '').toLowerCase() === 'meeting');
  const description = String(activity?.description || '');
  const title = description.match(/^Meeting:\s*(.+)$/m)?.[1] || deal.upcomingMeeting?.title || 'Scheduled meeting';
  const scheduled = description.match(/^Scheduled:\s*(.+)$/m)?.[1] || deal.upcomingMeeting?.startAt || activity?.createdAt;
  const attendees = description.match(/^Attendees:\s*(.+)$/m)?.[1] || deal.upcomingMeeting?.attendees?.map((item) => item.name || item.email).filter(Boolean).join(', ') || deal.contact?.name || '';
  return activity || deal.upcomingMeeting ? { title, scheduled, attendees } : null;
}

function DealCurrencyControl({ deal, onSaved, compact = false }) {
  const [currencies, setCurrencies] = useState([]);
  const [saving, setSaving] = useState(false);
  const notify = useNotify();
  useEffect(() => {
    let active = true;
    fetchApi('/api/currencies', { silent: true }).then((result) => {
      if (active) setCurrencies(Array.isArray(result) ? result : (result?.data || []));
    }).catch(() => { if (active) setCurrencies([]); });
    return () => { active = false; };
  }, []);
  const changeCurrency = async (event) => {
    const nextCurrency = event.target.value;
    if (!nextCurrency || nextCurrency === deal.currency || saving) return;
    setSaving(true);
    try {
      const convertedAmount = convertCurrencyStrict(deal.amount, deal.currency, nextCurrency, currencies);
      const updated = await fetchApi(`/api/deals/${deal.id}`, { method: 'PUT', body: JSON.stringify({ amount: convertedAmount, currency: nextCurrency }) });
      onSaved(updated);
      notify.success(`Deal amount converted to ${nextCurrency}.`);
    } catch (error) {
      notify.error(error?.body?.error || error?.message || 'Unable to convert the deal amount.');
    } finally {
      setSaving(false);
    }
  };
  const fallbackOptions = ['USD', 'INR', 'EUR', 'GBP'].map((code) => ({ code }));
  const options = [...(currencies.length ? currencies : fallbackOptions), ...(deal.currency && !currencies.some((currency) => currency.code === deal.currency) ? [{ code: deal.currency }] : [])].filter((currency, index, list) => list.findIndex((item) => item.code === currency.code) === index);
  return <div className={`deal-currency-control${compact ? ' compact' : ''}`}>{!compact && <span>Currency</span>}<select aria-label="Deal currency" value={deal.currency || 'USD'} onChange={changeCurrency} disabled={saving}>{options.map((currency) => <option key={currency.code} value={currency.code}>{currency.code}</option>)}</select></div>;
}

function ScreenshotLayout({ deal, pipeline, stageRows, activeIndex, latestNote, products, onStageSelect, stageError, activityPageData, activityPage, activityLoading, onActivitiesOpen, onActivitiesPageChange, dealTagCatalog = [], onCall, isGeneric, onOpenTags, onDealUpdated }) {
  const [tab, setTab] = useState('Deal details');
  const [query, setQuery] = useState('');
  const [showEmpty, setShowEmpty] = useState(false);
  const navigate = useNavigate();
  const visibleSections = dealFieldSections.map((section) => ({ ...section, fields: section.fields.filter(([, label]) => !isGeneric || !['Pipeline', 'Deal name'].includes(label)).filter(([, label]) => !query || label.toLowerCase().includes(query.toLowerCase())) })).filter((section) => section.fields.length);
  const tags = parseTags(deal.tags || deal.contact?.tags || deal.contact?.tagsJson) || [];
  const recentMeeting = meetingSummary(deal);
  const tagColorMap = new Map(dealTagCatalog.map((record) => [tagKey(record.name), record.color || fallbackTagColor(record.name)]));
  const initials = String(deal.title || 'D').split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase();
  const navItems = tabs.filter((item) => !['Overview', 'Products', 'Quotes', 'Files'].includes(item));
  const selectTab = useCallback((nextTab) => { setTab(nextTab); if (nextTab === 'Activities') onActivitiesOpen?.(); }, [onActivitiesOpen]);
  useEffect(() => {
    const contactCard = [...document.querySelectorAll('.deal-side-cards .deal-info-card')].find((card) => card.querySelector('h2')?.textContent.startsWith('Contacts by sales owner'));
    const contactName = document.querySelector('.deal-reference-cards .deal-related span');
    const contactId = deal.contact?.id || deal.contactId;
    if (!contactCard || !contactName || !contactId) return undefined;
    const open = () => { setTab('Contacts'); window.dispatchEvent(new CustomEvent('deal-contact-open', { detail: { contactId } })); };
    const arrow = document.createElement('button'); arrow.type = 'button'; arrow.className = 'deal-contact-arrow'; arrow.setAttribute('aria-label', 'Open contact details'); arrow.textContent = '›'; arrow.addEventListener('click', open); contactName.parentElement?.appendChild(arrow);
    contactName.addEventListener('click', open);
    contactCard.addEventListener('click', open);
    return () => { contactName.removeEventListener('click', open); arrow.removeEventListener('click', open); contactCard.removeEventListener('click', open); arrow.remove(); };
  }, [deal.contact?.id, deal.contactId]);
  useEffect(() => {
    const productCard = [...document.querySelectorAll('.deal-side-cards .deal-info-card')].find((card) => card.querySelector('h2')?.textContent.startsWith('Products'));
    const productTitle = productCard?.querySelector('h2');
    const productTab = [...document.querySelectorAll('.deal-reference-nav button')].find((button) => button.textContent === 'Products');
    if (!productCard || !productTitle || !productTab) return undefined;
    const open = (event) => { event.stopPropagation(); setTab('Products'); window.dispatchEvent(new Event('deal-products-open')); };
    const arrow = document.createElement('button'); arrow.type = 'button'; arrow.className = 'deal-contact-arrow'; arrow.setAttribute('aria-label', 'Open products'); arrow.textContent = '›'; arrow.addEventListener('click', open); productTitle.parentElement?.appendChild(arrow);
    const cardOpen = () => { setTab('Products'); window.dispatchEvent(new Event('deal-products-open')); };
    productCard.addEventListener('click', cardOpen); productTab.addEventListener('click', cardOpen);
    return () => { arrow.removeEventListener('click', open); arrow.remove(); productCard.removeEventListener('click', cardOpen); productTab.removeEventListener('click', cardOpen); };
  }, [products.length]);
  useEffect(() => {
    const meetingCard = [...document.querySelectorAll('.deal-side-cards .deal-info-card')].find((card) => card.querySelector('h2')?.textContent === 'Upcoming meeting');
    if (!meetingCard || !deal.contact?.id) return undefined;
    const open = () => window.dispatchEvent(new Event('deal-meeting-open'));
    meetingCard.addEventListener('click', open);
    return () => meetingCard.removeEventListener('click', open);
  }, [deal.contact?.id, deal.upcomingMeeting?.startAt]);
  useEffect(() => {
    const notesCard = document.querySelector('.deal-reference-notes');
    const textarea = notesCard?.querySelector('textarea');
    const latest = notesCard?.querySelector('.deal-note');
    if (!notesCard || !textarea) return undefined;
    notesCard.style.display = 'flex';
    notesCard.style.flexDirection = 'column';
    textarea.style.display = 'none';
    if (latest) latest.style.display = 'none';
    const add = document.createElement('button');
    add.type = 'button'; add.className = 'deal-link'; add.textContent = 'Add note'; add.style.marginBottom = '10px';
    add.addEventListener('click', () => window.dispatchEvent(new Event('deal-note-open')));
    const list = document.createElement('div');
    list.className = 'deal-notes-list';
    list.style.cssText = 'display:grid;flex:1 1 0;height:0;min-height:0;gap:8px;margin-bottom:10px;padding-right:4px;min-width:0;box-sizing:border-box;overflow-y:auto;overflow-x:hidden';
    const notes = (deal.activities || []).filter((item) => String(item.type || '').toLowerCase() === 'note');
    notes.forEach((item) => {
      const row = document.createElement('div'); row.className = 'deal-note'; row.style.cssText = 'margin-bottom:0;min-width:0;overflow-wrap:anywhere;word-break:break-word';
      const body = document.createElement('div'); body.style.cssText = 'min-width:0;overflow-wrap:anywhere;word-break:break-word'; appendRichTextPreview(body, item.description, 'No notes available');
      const time = document.createElement('small'); time.textContent = relative(item.createdAt); body.append(time); row.append(body); list.append(row);
    });
    if (!notes.length) { const empty = document.createElement('span'); empty.className = 'deal-empty'; empty.textContent = 'No notes available'; list.append(empty); }
    const viewAll = document.createElement('button');
    viewAll.type = 'button'; viewAll.className = 'deal-link'; viewAll.textContent = 'View all activities'; viewAll.setAttribute('aria-label', 'View all notes'); viewAll.style.marginTop = 'auto'; viewAll.style.alignSelf = 'flex-start';
    viewAll.addEventListener('click', () => window.dispatchEvent(new Event('deal-activity-overview-open')));
    notesCard.append(add, list, viewAll);
    list.scrollTop = list.scrollHeight;
    return () => { add.remove(); list.remove(); viewAll.remove(); textarea.style.display = ''; if (latest) latest.style.display = ''; notesCard.style.display = ''; notesCard.style.flexDirection = ''; };
  }, [deal.activities, selectTab]);
  useEffect(() => {
    const card = document.querySelector('.deal-reference-cards > .deal-info-card:nth-child(2)');
    const heading = card?.querySelector('.deal-card-heading');
    if (!card || !heading || card.querySelector('.deal-details-scroll')) return undefined;
    const scroll = document.createElement('div');
    scroll.className = 'deal-details-scroll';
    while (heading.nextSibling) scroll.appendChild(heading.nextSibling);
    card.appendChild(scroll);
    card.style.display = 'flex';
    card.style.flexDirection = 'column';
    card.style.overflow = 'hidden';
    return () => {
      while (scroll.firstChild) card.appendChild(scroll.firstChild);
      scroll.remove();
      card.style.display = '';
      card.style.flexDirection = '';
      card.style.overflow = '';
    };
  }, [deal.id]);
  useEffect(() => {
    const teamTab = [...document.querySelectorAll('.deal-reference-nav button')].find((button) => button.textContent === 'Deal team');
    if (!teamTab) return undefined;
    const open = () => { selectTab('Deal team'); window.dispatchEvent(new Event('deal-team-open')); };
    const conversationsTab = [...document.querySelectorAll('.deal-reference-nav button')].find((button) => button.textContent === 'Conversations');
    const openConversations = () => { selectTab('Conversations'); window.dispatchEvent(new Event('deal-conversations-open')); };
    const contactsTab = [...document.querySelectorAll('.deal-reference-nav button')].find((button) => button.textContent === 'Contacts');
    const openContacts = () => { selectTab('Contacts'); if (deal.contact?.id || deal.contactId) window.dispatchEvent(new CustomEvent('deal-contact-open', { detail: { contactId: deal.contact?.id || deal.contactId } })); };
    const otherTabs = [...document.querySelectorAll('.deal-reference-nav button')].filter((button) => button !== teamTab && button !== conversationsTab && button !== contactsTab);
    const close = () => { window.dispatchEvent(new Event('deal-team-close')); window.dispatchEvent(new Event('deal-products-close')); window.dispatchEvent(new Event('deal-contact-close')); window.dispatchEvent(new Event('deal-conversations-close')); };
    teamTab.addEventListener('click', open);
    conversationsTab?.addEventListener('click', openConversations);
    contactsTab?.addEventListener('click', openContacts);
    otherTabs.forEach((button) => button.addEventListener('click', close));
    return () => { teamTab.removeEventListener('click', open); conversationsTab?.removeEventListener('click', openConversations); contactsTab?.removeEventListener('click', openContacts); otherTabs.forEach((button) => button.removeEventListener('click', close)); };
  }, []);
  useEffect(() => {
    if (tab !== 'Activities') return undefined;
    const content = document.querySelector('.deal-reference-main .deal-details-content');
    const existingList = content?.querySelector('.deal-activity-list');
    const heading = content?.querySelector('.deal-details-toolbar');
    if (!content || !heading) return undefined;
    let currentPage = 1;
    let disposed = false;
    const paginatedList = document.createElement('div');
    paginatedList.className = 'deal-activity-list';
    const pagination = document.createElement('div');
    pagination.className = 'deal-activity-pagination';
    pagination.style.cssText = 'display:flex;align-items:center;gap:8px;margin-left:auto;font-size:11px';
    if (existingList) existingList.style.display = 'none';
    content.appendChild(paginatedList);
    heading.appendChild(pagination);
    const loadPage = async (page) => {
      currentPage = page;
      paginatedList.textContent = 'Loading activities...';
      try {
        const result = await fetchApi(`/api/deals/${deal.id}/activities?page=${page}&limit=10`);
        if (disposed) return;
        const rows = Array.isArray(result) ? result : (result?.data || []);
        const totalPages = Math.max(1, Number(result?.totalPages) || 1);
        paginatedList.replaceChildren();
        if (!rows.length) { const empty = document.createElement('span'); empty.className = 'deal-empty'; empty.textContent = 'No activities available'; paginatedList.append(empty); }
        rows.forEach((item) => {
          const row = document.createElement('div');
          const icon = document.createElement('span'); icon.textContent = '▧'; icon.setAttribute('aria-hidden', 'true');
          const body = document.createElement('div'); body.className = 'deal-activity-body';
          const type = document.createElement('strong'); type.textContent = item.type || 'Activity';
          const description = document.createElement('div');
          if (['Email', 'Note'].includes(item.type)) appendRichTextPreview(description, item.description || '');
          else description.textContent = item.description || '';
          const date = document.createElement('small'); date.textContent = formatDate(item.createdAt);
          body.append(type, description, date); row.append(icon, body); paginatedList.append(row);
        });
        pagination.replaceChildren();
        if (totalPages > 1) {
          const previous = document.createElement('button'); previous.type = 'button'; previous.className = 'deal-activity-page-button'; previous.setAttribute('aria-label', 'Previous activities page'); previous.textContent = 'Previous'; previous.disabled = currentPage <= 1; previous.onclick = () => loadPage(currentPage - 1);
          const label = document.createElement('span'); label.textContent = `Page ${currentPage} of ${totalPages}`;
          const next = document.createElement('button'); next.type = 'button'; next.className = 'deal-activity-page-button'; next.setAttribute('aria-label', 'Next activities page'); next.textContent = 'Next'; next.disabled = currentPage >= totalPages; next.onclick = () => loadPage(currentPage + 1);
          pagination.append(previous, label, next);
        }
      } catch (_) { if (!disposed) paginatedList.textContent = 'Unable to load activities'; }
    };
    loadPage(1);
    return () => { disposed = true; existingList?.style.removeProperty('display'); paginatedList.remove(); pagination.remove(); };
  }, [deal.id, tab]);
  useEffect(() => {
    const placeholder = document.querySelector('.deal-reference-main .deal-placeholder');
    const actions = {
      Contacts: [{ label: 'Open Contacts', path: '/contacts' }],
      Conversations: [{ label: 'Open Inbox', path: '/inbox' }, { label: 'View call logs', path: '/callified-data' }],
    }[tab];
    if (!placeholder || !actions) return undefined;
    const container = document.createElement('div');
    container.className = 'deal-placeholder-actions';
    actions.forEach(({ label, path }) => {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'deal-link'; button.textContent = label;
      button.addEventListener('click', () => navigate(path));
      container.appendChild(button);
    });
    placeholder.appendChild(container);
    return () => container.remove();
  }, [navigate, tab]);

  return <div className="deal-reference-layout generic-deal-details-page">
    <style>{referenceStyles + genericDealDetailsStyles + editStyles + inlineEditStyles + stageChevronStyles + dealTagStyles + dealDetailsLayoutStyles}</style>
    <style>{'.generic-deal-details-page .deal-meeting-summary{display:grid;gap:5px;min-width:0}.generic-deal-details-page .deal-meeting-summary strong,.generic-deal-details-page .deal-meeting-summary span{display:block;overflow-wrap:anywhere}.generic-deal-details-page .deal-meeting-summary span{color:var(--text-secondary);font-size:11px}.generic-deal-details-page .deal-schedule-meeting{margin-top:12px}.generic-deal-details-page .deal-side-cards>.deal-documents-card{flex:0 0 auto}.generic-deal-details-page .deal-document-links{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));column-gap:18px;row-gap:2px}.generic-deal-details-page .deal-document-link{display:grid;grid-template-columns:18px minmax(0,1fr) auto;align-items:center;gap:8px;width:100%;padding:4px 0;border:0;background:transparent;color:var(--text-primary);text-align:left;cursor:pointer}.generic-deal-details-page .deal-document-link:hover{color:var(--primary-color,var(--accent-color))}.generic-deal-details-page .deal-document-link>svg{color:var(--text-secondary)}.generic-deal-details-page .deal-document-copy{display:grid;gap:1px;min-width:0}.generic-deal-details-page .deal-document-copy strong{font-size:12px}.generic-deal-details-page .deal-document-copy small{color:var(--text-secondary);font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.generic-deal-details-page .deal-document-count{display:grid;place-items:center;min-width:18px;height:18px;padding:0 5px;border-radius:999px;background:var(--subtle-bg);color:var(--text-secondary);font-size:10px}.generic-deal-details-page .deal-amount-row{display:flex;align-items:flex-end;gap:10px;border-bottom:1px solid var(--border-color)}.generic-deal-details-page .deal-amount-row>.deal-pair{flex:1 1 auto;border-bottom:0}.generic-deal-details-page .deal-currency-control{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:1px solid var(--border-color);font-size:12px}.generic-deal-details-page .deal-currency-control.compact{flex:0 0 auto;padding:0 0 8px;border-bottom:0}.generic-deal-details-page .deal-currency-control span{color:var(--text-primary)}.generic-deal-details-page .deal-currency-control select{min-width:76px;padding:5px 8px;border:1px solid var(--border-color);border-radius:6px;background:var(--surface-color);color:var(--text-primary);font:inherit}.deal-amount-editor{display:grid;grid-template-columns:minmax(0,1fr) 80px;gap:6px}.deal-amount-editor select{min-width:0}.deal-reference-layout .deal-reference-header{position:relative;grid-template-columns:28px 48px minmax(0,1fr) auto !important;column-gap:8px}.deal-reference-layout .deal-header-back{position:static;grid-column:1;grid-row:1;display:grid;place-items:center;width:28px;height:28px;padding:0;border:1px solid var(--border-color);border-radius:5px;background:var(--surface-color);color:var(--text-primary);cursor:pointer}.deal-reference-layout .deal-header-back:hover{background:var(--subtle-bg)}.deal-reference-layout .deal-avatar{grid-column:2;grid-row:1}.deal-reference-layout .deal-reference-header>div:nth-of-type(2){grid-column:3;grid-row:1}@media(max-width:700px){.generic-deal-details-page .deal-document-links{grid-template-columns:1fr}}'}</style>
    <style>{'.generic-deal-details-page { display: flex; flex-direction: column; min-height: auto !important; } .generic-deal-details-page > .deal-reference-header { order: 1; margin-bottom: 0; padding: 12px 24px 8px; grid-template-columns: 48px minmax(0, 1fr) auto; border: 1px solid var(--border-color); border-bottom: 0; border-radius: 8px 8px 0 0; } .generic-deal-details-page > .deal-reference-header .deal-avatar { width: 48px; height: 48px; } .generic-deal-details-page > .deal-reference-tracker { order: 2; margin-top: 0; padding: 8px 16px 14px; border: 1px solid var(--border-color); border-top: 0; border-radius: 0 0 8px 8px; } .generic-deal-details-page > .deal-reference-tracker .deal-age { display: none !important; } .generic-deal-details-page > .deal-reference-cards { order: 3; } .generic-deal-details-page > .deal-reference-workspace { display: grid !important; order: 4; } .generic-deal-details-page .deal-reference-tracker .deal-progress-heading { margin-bottom: 8px; } .generic-deal-details-page .deal-reference-tracker .deal-progress-heading h2 { font-size: 14px; } .generic-deal-details-page .deal-reference-tracker .deal-stages { display: flex; gap: 0; overflow: visible; border-radius: 0; background: transparent; } .generic-deal-details-page .deal-reference-tracker .deal-stage { position: relative; z-index: 1; min-height: 42px; margin: 0; padding: 0 24px 0 18px; border: 0; border-radius: 0; background: #d8dce2; color: #4b5563; font-size: 12px; font-weight: 600; white-space: nowrap; clip-path: polygon(0 0, calc(100% - 20px) 0, 100% 50%, calc(100% - 20px) 100%, 0 100%); } .generic-deal-details-page .deal-reference-tracker .deal-stage:not(:first-child) { margin-left: -1px; padding-left: 32px; clip-path: polygon(20px 0, calc(100% - 20px) 0, 100% 50%, calc(100% - 20px) 100%, 20px 100%, 0 50%); } .generic-deal-details-page .deal-reference-tracker .deal-stage.done { background: #d8dce2; color: #4b5563; } .generic-deal-details-page .deal-reference-tracker .deal-stage.current { z-index: 2; background: #b9c0ca; color: #1f2937; } .generic-deal-details-page .deal-reference-tracker .deal-stage:hover { z-index: 3; filter: brightness(.98); }'}</style>
    <style>{'.generic-deal-details-page > .deal-reference-tracker { padding: 0 16px 12px; } .generic-deal-details-page .deal-reference-tracker .deal-progress-heading { margin-bottom: 6px; } .generic-deal-details-page .deal-reference-tracker .deal-progress-heading h2 { font-size: 10px; font-weight: 500; letter-spacing: .04em; color: #5f6877; } .generic-deal-details-page .deal-reference-tracker .deal-stage { min-height: 30px; padding: 0 18px 0 12px; font-size: 11px; font-weight: 500; color: #5f6877; clip-path: polygon(0 0, calc(100% - 14px) 0, 100% 50%, calc(100% - 14px) 100%, 0 100%); } .generic-deal-details-page .deal-reference-tracker .deal-stage:not(:first-child) { padding-left: 24px; clip-path: polygon(14px 0, calc(100% - 14px) 0, 100% 50%, calc(100% - 14px) 100%, 14px 100%, 0 50%); } .generic-deal-details-page .deal-reference-tracker .deal-stage.done, .generic-deal-details-page .deal-reference-tracker .deal-stage.current { background: #e5e7eb; color: #5f6877; } .generic-deal-details-page .deal-reference-tracker .deal-stage.current { font-weight: 600; }'}</style>
    <style>{'.generic-deal-details-page .deal-reference-tracker .deal-stages { width: 100%; display: flex; gap: 0; overflow: visible; } .generic-deal-details-page .deal-reference-tracker .deal-stage { flex: 1 1 0; min-width: 0; min-height: 34px; margin: 0; padding: 0 12px; background: #F9FAFB; color: #374151; border: 1px solid #D1D5DB; border-right: 0; outline: 0; box-shadow: none; font-size: 13px; font-weight: 600; letter-spacing: .01em; clip-path: polygon(0 0, calc(100% - 10px) 0, 100% 50%, calc(100% - 10px) 100%, 0 100%); transition: background-color .15s ease, color .15s ease; } .generic-deal-details-page .deal-reference-tracker .deal-stage.current { z-index: 2; background: #9CA3AF; color: #1F2937; border-color: #D1D5DB !important; font-weight: 700; } .generic-deal-details-page .deal-reference-tracker .deal-stage:hover { background: #E5E7EB; color: #1F2937; } .generic-deal-details-page .deal-reference-tracker .deal-stage.current:hover { background: #9CA3AF; } .generic-deal-details-page .deal-reference-tracker .deal-stage:not(:first-child) { margin-left: 0; padding-left: 12px; clip-path: polygon(0 0, calc(100% - 10px) 0, 100% 50%, calc(100% - 10px) 100%, 0 100%); } .generic-deal-details-page .deal-reference-tracker .deal-stage:last-child { border-right: 1px solid #D1D5DB; } .generic-deal-details-page .deal-reference-tracker .deal-stage:nth-child(1) { z-index: 1; } .generic-deal-details-page .deal-reference-tracker .deal-stage:nth-child(2) { z-index: 2; } .generic-deal-details-page .deal-reference-tracker .deal-stage:nth-child(3) { z-index: 3; } .generic-deal-details-page .deal-reference-tracker .deal-stage:nth-child(4) { z-index: 4; } .generic-deal-details-page .deal-reference-tracker .deal-stage:nth-child(5) { z-index: 5; } @media (max-width: 700px) { .generic-deal-details-page .deal-reference-tracker .deal-stages { overflow-x: auto; padding-bottom: 2px; } .generic-deal-details-page .deal-reference-tracker .deal-stage { flex: 0 0 170px; } }'}</style>
    {isGeneric && <style>{'.app-main > main.generic-page-content:has(.generic-deal-details-page){height:auto !important;min-height:0 !important;overflow:visible !important}.generic-deal-details-page{height:auto;min-height:0 !important;max-height:none;overflow:visible}.generic-deal-details-page > .deal-reference-cards{flex:0 0 auto;min-height:0;overflow:visible;align-items:start}.generic-deal-details-page > .deal-reference-cards > .deal-info-card{height:auto}'}</style>}
    <style>{'.app-main > main.generic-page-content:has(.generic-deal-details-page){height:100% !important;min-height:0 !important;padding:clamp(1rem,3vw,2rem) !important;overflow:hidden !important}.generic-deal-details-page{height:100%;max-height:100%;min-height:0 !important;overflow:hidden}.generic-deal-details-page > .deal-reference-header,.generic-deal-details-page > .deal-reference-tracker{flex:0 0 auto}.generic-deal-details-page > .deal-reference-cards{flex:1 1 auto;min-height:0;overflow:hidden;align-items:stretch}.generic-deal-details-page > .deal-reference-cards > .deal-info-card,.generic-deal-details-page > .deal-reference-cards > .deal-side-cards{min-height:0;overflow:hidden}.generic-deal-details-page > .deal-reference-cards > .deal-info-card{height:100%}.generic-deal-details-page > .deal-reference-cards > .deal-info-card:nth-child(2){overflow:hidden}.generic-deal-details-page > .deal-reference-cards > .deal-info-card:nth-child(2) .deal-card-heading{flex:0 0 auto}.generic-deal-details-page .deal-details-scroll{flex:1 1 auto;min-height:0;margin-right:0;padding-right:4px;overflow-y:auto;overflow-x:hidden;scrollbar-width:thin}.generic-deal-details-page .deal-side-cards{display:flex;flex-direction:column;gap:8px;min-height:0}.generic-deal-details-page .deal-side-cards > .deal-info-card{flex:1 1 0;min-height:0;margin:0;overflow:hidden}.generic-deal-details-page .deal-reference-notes{align-self:stretch;height:100%}.generic-deal-details-page .deal-reference-notes .deal-notes-list{flex:1 1 0;height:0;max-height:none;min-height:0;overflow-y:auto}@media(max-width:700px){.app-main > main.generic-page-content:has(.generic-deal-details-page){height:auto !important;overflow:auto !important}.generic-deal-details-page{height:auto;max-height:none;overflow:visible}.generic-deal-details-page > .deal-reference-cards{overflow:visible}.generic-deal-details-page > .deal-reference-cards > .deal-info-card{height:auto}.generic-deal-details-page .deal-side-cards{display:block}.generic-deal-details-page .deal-side-cards > .deal-info-card{margin-bottom:8px;min-height:120px}}'}</style>
    {isGeneric && <style>{'.generic-deal-details-page .deal-reference-tracker .deal-stage{background:var(--subtle-bg,var(--surface-color)) !important;color:var(--text-primary) !important;border-color:var(--border-color) !important}.generic-deal-details-page .deal-reference-tracker .deal-stage.done{background:color-mix(in srgb,var(--text-primary) 10%,var(--surface-color)) !important;color:var(--text-primary) !important}.generic-deal-details-page .deal-reference-tracker .deal-stage.current{background:color-mix(in srgb,var(--text-primary) 22%,var(--surface-color)) !important;color:var(--text-primary) !important;border-color:var(--border-color) !important}.generic-deal-details-page .deal-reference-tracker .deal-stage:hover,.generic-deal-details-page .deal-reference-tracker .deal-stage.current:hover{background:color-mix(in srgb,var(--text-primary) 16%,var(--surface-color)) !important;color:var(--text-primary) !important}@media(max-width:1100px){.generic-deal-details-page > .deal-reference-cards{grid-template-columns:repeat(2,minmax(0,1fr));overflow:hidden}.generic-deal-details-page .deal-reference-tracker .deal-stages{overflow-x:auto;overflow-y:hidden}.generic-deal-details-page .deal-reference-tracker .deal-stage{flex:0 0 160px}}@media(max-width:700px){.generic-deal-details-page > .deal-reference-cards{grid-template-columns:1fr;overflow:visible}.generic-deal-details-page .deal-reference-tracker .deal-stage{flex-basis:150px}}'}</style>}
    {isGeneric && <style>{'.app-main > main.generic-page-content:has(.generic-deal-details-page){height:auto !important;min-height:0 !important;overflow:visible !important}.generic-deal-details-page{height:auto !important;min-height:0 !important;max-height:none !important;overflow:visible !important}.generic-deal-details-page > .deal-reference-cards{flex:0 0 auto !important;min-height:0;overflow:visible !important;align-items:start}.generic-deal-details-page > .deal-reference-cards > .deal-info-card{height:auto !important}'}</style>}
    {isGeneric && <style>{'.generic-deal-details-page{background:transparent}.generic-deal-details-page > .deal-reference-cards{grid-template-columns:repeat(3,minmax(0,1fr));align-items:stretch}.generic-deal-details-page > .deal-reference-cards > .deal-info-card{height:100% !important}'}</style>}
    {isGeneric && <style>{'.app-main > main.generic-page-content:has(.generic-deal-details-page){background:var(--surface-color) !important;padding:clamp(1rem,3vw,2rem) !important}.generic-deal-details-page{background:var(--surface-color) !important;padding:18px 20px 24px}.generic-deal-details-page > .deal-reference-header{background:var(--surface-color);border:1px solid var(--border-color);border-bottom:0;border-radius:14px 14px 0 0;padding:18px 20px 12px;box-shadow:none}.generic-deal-details-page > .deal-reference-tracker{background:var(--surface-color);border:1px solid var(--border-color);border-top:0;border-radius:0 0 14px 14px;padding:0 16px 16px}.generic-deal-details-page > .deal-reference-cards{gap:14px;padding:14px 0 0;background:transparent}.generic-deal-details-page > .deal-reference-cards > .deal-info-card{border:1px solid var(--border-color);border-radius:14px;background:var(--surface-color);box-shadow:none;padding:20px}.generic-deal-details-page .deal-reference-cards .deal-info-card h2{font-size:15px;margin-bottom:16px}.generic-deal-details-page .deal-reference-cards .deal-pair{padding:10px 24px 10px 0}.generic-deal-details-page .deal-reference-cards .deal-pair span,.generic-deal-details-page .deal-reference-cards .deal-pair strong{font-size:13px}.generic-deal-details-page .deal-reference-notes .deal-notes-list{padding-right:4px}.generic-deal-details-page .deal-reference-tracker .deal-progress-heading{padding-top:10px}@media(max-width:700px){.generic-deal-details-page{padding:12px}.generic-deal-details-page > .deal-reference-cards{padding-top:12px;gap:12px}.generic-deal-details-page > .deal-reference-cards > .deal-info-card{padding:16px}}'}</style>}
    {isGeneric && <style>{'.generic-deal-details-page > .deal-reference-tracker{border-bottom:1px solid var(--border-color) !important}'}</style>}
    {isGeneric && <style>{'.generic-deal-details-page .deal-reference-tracker .deal-stage.current{background:var(--primary-color,var(--accent-color)) !important;color:#fff !important;border-color:var(--primary-color,var(--accent-color)) !important}.generic-deal-details-page .deal-reference-tracker .deal-stage.current:hover{background:var(--primary-color,var(--accent-color)) !important;color:#fff !important}'}</style>}
    <header className="deal-reference-header">
      <button type="button" className="deal-header-back" aria-label="Back to deals" onClick={() => navigate('/pipeline')}><ArrowLeft size={13} /></button>
      <div className="deal-avatar">{initials}</div>
      <div><h1>{isGeneric ? generatedDealName(deal) : (deal.title || 'Untitled deal')}</h1><div className="deal-meta"><strong className="deal-header-amount">Amount: {formatMoney(deal.amount || 0, { currency: deal.currency })}</strong></div></div>
       <div className="deal-reference-actions"><button type="button" className="deal-link" onClick={() => navigate('/pipeline')}><ArrowLeft size={14} /> Back</button><button type="button" className="deal-primary" onClick={onCall} title={`Call ${personName(deal.contact) || 'associated contact'} via AI`}><Phone size={14} /> Call</button></div>
      <div className="deal-tag-line" onClick={(event) => { if (deal.contact?.id && !event.target.closest('.deal-tag-picker')) onOpenTags(); }}>{tags.length ? tags.map((tag) => { const name = String(tag); const color = tagColorMap.get(tagKey(name)) || fallbackTagColor(name); return <span className="cd-tag-chip" key={name} style={{ background: color, borderColor: color, color: tagTextColor(color) }}><span>{name}</span>{deal.contact?.id && <button type="button" aria-label={`Remove tag ${name}`} onClick={(event) => { event.stopPropagation(); window.dispatchEvent(new CustomEvent('deal-tag-remove', { detail: { name } })); }}>×</button>}</span>; }) : <span>Click to add tags</span>}{deal.contact?.id && <button type="button" className="deal-link deal-add-tag-button" aria-label="Add tag" onClick={(event) => { event.stopPropagation(); onOpenTags(); }}>+ Add tag</button>}</div>
    </header>
    <div className="deal-reference-cards">
      <InfoCard title="Lead details"><Pair label="Lead name" value={deal.contact?.name} deal={deal} /><Pair label="Company name" value={deal.contact?.company} deal={deal} /><Pair label="Email" value={deal.contact?.email} deal={deal} /><Pair label="Assigned sales owner" value={personName(deal.contact?.assignedTo || deal.owner)} deal={deal} /><Pair label="Lead source" value={deal.contact?.source} deal={deal} /><Pair label="Last activity date" value={deal.activities?.[0]?.createdAt || deal.updatedAt} type="dateTime" deal={deal} /></InfoCard>
      <InfoCard title="Deal details" headingProps={{ 'aria-hidden': 'true' }}><Pair label="Deal title" value={isGeneric ? generatedDealName(deal) : deal.title} deal={deal} /><Pair label="Deal type" value={deal.dealType} deal={deal} /><div className="deal-amount-row"><Pair label="Deal amount" value={deal.amount} type="currency" deal={deal} />{isGeneric && <DealCurrencyControl compact deal={deal} onSaved={onDealUpdated} />}</div><Pair label="Created date" value={deal.createdAt} type="date" deal={deal} /><Pair label="Expected close date" value={deal.expectedClose} type="date" deal={deal} /><Pair label="Close date" value={deal.closedAt} type="date" deal={deal} /><Pair label="Payment status" value={deal.paymentStatus} deal={deal} /></InfoCard>
      {!isGeneric && <div className="deal-side-cards"><InfoCard title="Contacts by sales owner"><div className="deal-related"><Users size={16} /><span>{personName(deal.contact?.assignedTo || deal.owner) || 'Unassigned'} ({deal.contact ? 1 : 0})</span></div></InfoCard><InfoCard title={`Products (${products.length})`}>{products.length ? products.map((product, index) => <div className="deal-product" key={`${product.name}-${index}`}><span>{product.name}</span><strong>{product.quantity}</strong></div>) : <span className="deal-empty">No products linked</span>}</InfoCard><InfoCard title="Upcoming meeting"><div className="deal-meeting-summary">{recentMeeting ? <><strong>{recentMeeting.title}</strong><span>{recentMeeting.scheduled ? formatDateTime(recentMeeting.scheduled) : 'Date and time not set'}</span><span>{recentMeeting.attendees ? `Members: ${recentMeeting.attendees}` : 'No members added'}</span></> : <span className="deal-empty">No upcoming meeting</span>}</div><button type="button" className="deal-link deal-schedule-meeting" onClick={(event) => { event.stopPropagation(); window.dispatchEvent(new Event('deal-meeting-open')); }}>Schedule meeting</button></InfoCard></div>}
      <InfoCard title="Notes" className="deal-reference-notes"><textarea aria-label="Deal note" placeholder="Type your note here..." readOnly onFocus={() => window.dispatchEvent(new Event('deal-note-open'))} /><div className="deal-note"><NotebookPen size={16} /><div><strong>{latestNote?.description || 'No notes available'}</strong>{latestNote && <small>Posted by {personName(latestNote.user) || 'CRM user'}, {relative(latestNote.createdAt)}</small>}</div></div></InfoCard>
    </div>
    <section className="deal-reference-tracker"><div className="deal-progress-heading"><h2>{isGeneric ? 'STATUS' : 'Deal progress'}</h2><span>{pipeline?.name || 'Pipeline'}</span></div><div className="deal-age"><span>Created {relative(deal.createdAt)}</span><span>Expected close date: {deal.expectedClose ? formatDateMedium(deal.expectedClose) : EMPTY}</span></div>{stageError ? <div className="deal-empty">{stageError}</div> : stageRows.length ? <div className="deal-stages">{stageRows.map((stage, index) => <button type="button" className={`deal-stage ${index < activeIndex ? 'done' : ''} ${index === activeIndex ? 'current' : ''}`} aria-current={index === activeIndex ? 'step' : undefined} key={stage.id || stage.name} onClick={() => onStageSelect(stage.name)}><span style={{ background: stage.color || 'var(--accent-color)' }} />{stage.name}</button>)}</div> : <div className="deal-empty">No stages configured for this pipeline.</div>}</section>
    <div className="deal-reference-workspace"><nav className="deal-reference-nav"><h2>Overview</h2>{navItems.map((item) => <button type="button" key={item} className={tab === item ? 'active' : ''} onClick={() => selectTab(item)}>{item}</button>)}</nav><main className="deal-reference-main"><div className="deal-details-content"><div className="deal-details-toolbar"><div><h2>{tab === 'Deal details' ? 'Deal details' : tab}</h2><button type="button" className="deal-link"><Settings2 size={14} /> Manage fields</button></div><label><Search size={15} /><input aria-label="Search fields" placeholder="Search fields" value={query} onChange={(event) => setQuery(event.target.value)} /></label><label className="deal-switch"><input type="checkbox" checked={showEmpty} onChange={(event) => setShowEmpty(event.target.checked)} /> Show empty fields</label></div>{tab === 'Activities' && <div className="deal-activity-list">{(deal.activities || []).slice(0, 10).map((item) => <div key={`${item.type}-${item.id}`}><FileText size={15} /><span><strong>{item.type || 'Activity'}</strong>{['Email', 'Note'].includes(item.type) ? <RichTextNotePreview value={item.description} /> : plainText(item.description)}<small>{formatDate(item.createdAt)}</small></span></div>)}</div>}{tab === 'Deal details' && visibleSections.map((section) => <Section key={section.key} section={section} deal={deal} pipeline={pipeline} latestNote={latestNote} showEmpty={showEmpty} />)}{!['Deal details', 'Activities'].includes(tab) && <div className="deal-placeholder"><FileText size={25} /><h2>{tab}</h2><p>This workspace is ready for {tab.toLowerCase()} data when that module is enabled.</p></div>}</div></main></div>
  </div>;
}

export default function DealDetails() {
  const { dealId } = useParams(); const navigate = useNavigate(); const [deal, setDeal] = useState(null); const [stages, setStages] = useState([]); const [pipelines, setPipelines] = useState([]); const [contacts, setContacts] = useState([]); const [dealTagCatalog, setDealTagCatalog] = useState([]); const [genericDealTypes, setGenericDealTypes] = useState([]); const [loading, setLoading] = useState(true); const [error, setError] = useState(''); const [tab, setTab] = useState('Deal details'); const [query, setQuery] = useState(''); const [showEmpty, setShowEmpty] = useState(false);
  const [stageError, setStageError] = useState('');
  const [tagEditorOpen, setTagEditorOpen] = useState(false);
  const [genericCallLead, setGenericCallLead] = useState(null);
  const { tenant } = useContext(AuthContext) || {};
  const isGeneric = !tenant?.vertical || tenant.vertical === 'generic';
  const notify = useNotify();
  const handleDealTagCatalogChange = useCallback((records) => {
    setDealTagCatalog(records);
  }, []);
  const load = useCallback(async () => {
    if (!/^\d+$/.test(String(dealId)) || Number(dealId) < 1) { setError('This deal could not be found.'); setLoading(false); return; }
    setLoading(true);
    setError('');
    try {
      const [dealResult, pipelinesResult, contactsResult, dealTypesResult] = await Promise.allSettled([
        fetchApi(`/api/deals/${dealId}`),
        fetchApi('/api/pipelines?fields=summary', { silent: true }),
        fetchApi('/api/contacts?limit=200', { silent: true }),
        isGeneric ? fetchApi('/api/tenant-settings/generic.dealTypes', { silent: true }) : Promise.resolve(null),
      ]);
      if (dealResult.status === 'rejected') throw dealResult.reason;
      const loadedDeal = dealResult.value;
      const loadedPipelines = pipelinesResult.status === 'fulfilled' && Array.isArray(pipelinesResult.value)
        ? pipelinesResult.value
        : [];
      const effectivePipelineId = loadedDeal?.pipelineId || (
        isGeneric ? loadedPipelines.find((item) => item.isDefault)?.id : null
      );
      const stagesResult = await Promise.allSettled([
        isGeneric
          ? effectivePipelineId
            ? fetchApi(`/api/pipeline_stages?pipelineId=${encodeURIComponent(effectivePipelineId)}`, { silent: true })
            : Promise.resolve([])
          : fetchApi('/api/pipeline_stages', { silent: true }),
      ]).then(([result]) => result);
      setDeal(loadedDeal);
      setGenericDealTypes(
        isGeneric && dealTypesResult.status === 'fulfilled'
          ? parseGenericDealTypes(dealTypesResult.value?.value)
          : [],
      );
      if (stagesResult.status === 'fulfilled' && Array.isArray(stagesResult.value)) {
        setStages(stagesResult.value);
        setStageError('');
      } else {
        setStages([]);
        setStageError(!isGeneric && effectivePipelineId ? 'Unable to load stages for this pipeline.' : '');
      }
      setPipelines(loadedPipelines);
      const contactRows = contactsResult.status === 'fulfilled' ? contactsResult.value : [];
      setContacts(Array.isArray(contactRows) ? contactRows : (contactRows?.data || []));
    } catch (err) {
      setError(err?.serverMessage || err?.message || 'Unable to load this deal.');
    } finally {
      setLoading(false);
    }
  }, [dealId, isGeneric]);
  useEffect(() => { load(); }, [load]);
  const pipeline = useMemo(() => {
    if (!deal) return null;
    if (deal.pipelineId) return pipelines.find((p) => String(p.id) === String(deal.pipelineId)) || null;
    return isGeneric ? pipelines.find((p) => p.isDefault) || null : null;
  }, [pipelines, deal, isGeneric]);
  const dealTypeStages = useMemo(() => {
    if (!isGeneric || !deal?.dealType) return [];
    const selectedType = genericDealTypes.find((type) => String(type?.name || '') === String(deal.dealType));
    return Array.isArray(selectedType?.stages) ? selectedType.stages.filter((stage) => stage?.name) : [];
  }, [deal?.dealType, genericDealTypes, isGeneric]);
  const stageRows = useMemo(() => {
    if (isGeneric && deal?.dealType) return dealTypeStages;
    if (stages.length) return stages;
    // Generic CRM must display the selected pipeline's assignments only. Do
    // not replace a missing assignment list with the deal's current stage.
    if (isGeneric) return [];
    return [{ name: deal?.stage || 'Current stage', color: 'var(--accent-color)' }];
  }, [dealTypeStages, stages, deal, isGeneric]);
  const latestNote = useMemo(() => { const note = (deal?.activities || []).find((a) => String(a.type || '').toLowerCase() === 'note') || (deal?.activities || [])[0]; return note ? { ...note, description: plainText(note.description) } : note; }, [deal]);
  const visibleSections = dealFieldSections.map((section) => ({ ...section, fields: section.fields.filter(([, label]) => !isGeneric || !['Pipeline', 'Deal name'].includes(label)).filter(([, label]) => !query || label.toLowerCase().includes(query.toLowerCase())) })).filter((section) => section.fields.length);
  const products = (deal?.quotes || []).flatMap((quote) => quote.lineItems || []).map((item) => ({ name: item.productName || item.name || 'Product', quantity: item.quantity || 1, setupFee: item.setupFee, unitPrice: item.unitPrice, discount: item.discount, currency: item.currency || deal?.currency }));
  const applyUpdatedDeal = (updated) => {
    setDeal((current) => ({ ...current, ...updated, contact: updated?.contact || current.contact, owner: updated?.owner || current.owner, activities: updated?.activities || current.activities, quotes: updated?.quotes || current.quotes }));
    const effectivePipelineId = updated?.pipelineId || (
      isGeneric ? pipelines.find((item) => item.isDefault)?.id : null
    );
    if (isGeneric && effectivePipelineId) {
      fetchApi(`/api/pipeline_stages?pipelineId=${encodeURIComponent(effectivePipelineId)}`, { silent: true })
        .then((nextStages) => {
          if (!Array.isArray(nextStages)) throw new Error('Invalid pipeline stages response');
          setStages(nextStages);
          setStageError('');
        })
        .catch(() => {
          setStages([]);
          setStageError('Unable to load stages for this pipeline.');
        });
    } else if (isGeneric) {
      setStages([]);
      setStageError('');
    }
  };
  const updateStage = async (stageName) => {
    const targetStage = slug(stageName);
    if (!targetStage || targetStage === slug(deal.stage)) return;
    const previousStage = deal.stage;
    setDeal((current) => ({ ...current, stage: targetStage }));
    try {
      const updated = await fetchApi(`/api/deals/${deal.id}`, { method: 'PUT', body: JSON.stringify({ stage: targetStage }) });
      applyUpdatedDeal(updated);
      notify.success('Lead stage updated successfully.');
    } catch (err) {
      setDeal((current) => ({ ...current, stage: previousStage }));
      notify.error(err?.body?.error || 'Unable to update lead stage.');
    }
  };
  const openDealCall = () => {
    const lead = deal?.contact;
    if (!lead?.id) {
      notify.error('This deal cannot be called because it has no associated CRM lead/contact.');
      return;
    }
    if (!lead.phone) {
      notify.error('Phone number is required to make a call.');
      return;
    }
    setGenericCallLead(lead);
  };
  if (loading) return <div className="deal-details-page"><div className="deal-loading"><div className="deal-skeleton" /><div className="deal-skeleton short" /><p>Loading deal details...</p></div></div>;
  if (error || !deal) return <div className="deal-details-page"><div className="deal-error"><h1>Deal not found</h1><p>{error || 'This deal is no longer available.'}</p><button type="button" className="deal-primary" onClick={() => navigate('/pipeline')}><ArrowLeft size={15} /> Back to Deals and Pipelines</button><button type="button" className="deal-link" onClick={load}>Try again</button></div></div>;
  const current = slug(deal.stage); const activeIndex = stageRows.findIndex((stage) => (deal.stageId != null && String(stage.id) === String(deal.stageId)) || slug(stage.name) === current); const notes = deal.activities || [];
  return <><ScreenshotLayout deal={deal} pipeline={pipeline} stageRows={stageRows} activeIndex={activeIndex} latestNote={latestNote} products={products} onStageSelect={updateStage} stageError={stageError} dealTagCatalog={dealTagCatalog} onCall={openDealCall} isGeneric={isGeneric} onOpenTags={() => setTagEditorOpen(true)} onDealUpdated={applyUpdatedDeal} /><InlineDealEditor deal={deal} contacts={contacts} stages={stages} pipelines={pipelines} genericDealTypes={genericDealTypes} isGeneric={isGeneric} onClose={() => window.dispatchEvent(new Event('deal-details-edit-close'))} onSaved={applyUpdatedDeal} /><DealContactWorkspace /><DealProductsWorkspace products={products} /><DealTeamWorkspace /><DealConversationsWorkspace dealId={deal.id} contact={deal.contact} /><DealMeetingModal contact={deal.contact} onDone={load} /><DealTagEditor deal={deal} open={tagEditorOpen} setOpen={setTagEditorOpen} onCatalogChange={handleDealTagCatalogChange} onSaved={(updated) => setDeal((current) => ({ ...current, contact: { ...current.contact, ...updated } }))} /><DealNoteModal contact={deal.contact} onSaved={(activity) => setDeal((current) => ({ ...current, activities: activity ? [activity, ...(current.activities || [])] : current.activities }))} /><DealActivityOverviewModal deal={deal} />{isGeneric && genericCallLead && <CallifiedLeadCallDialog lead={genericCallLead} onClose={() => setGenericCallLead(null)} onCalled={() => notify.success('Call initiated successfully.')} />}</>;
  // return <div className="deal-details-page"><style>{styles}</style><div className="deal-breadcrumb"><button type="button" className="deal-link" onClick={() => navigate('/pipeline')}><ArrowLeft size={15} /> Deals and Pipelines</button><span>/</span><span>{deal.title || 'Untitled deal'}</span></div><header className="deal-header"><div><div className="deal-title-row"><BriefcaseBusiness size={22} color="var(--accent-color)" /><h1>{deal.title || 'Untitled deal'}</h1></div><div className="deal-meta"><strong>{formatMoney(deal.amount || 0, { currency: deal.currency })}</strong><span>{deal.forecastCategory || deal.paymentStatus || EMPTY}</span><span>{Array.isArray(deal.tags) && deal.tags.length ? deal.tags.join(', ') : 'Click to add tags'}</span></div></div><button type="button" className="deal-secondary" onClick={() => navigate('/pipeline')}><ArrowLeft size={14} /> Back</button></header><div className="deal-top-grid"><InfoCard title="Overview"><Pair label="Related account" value={deal.contact?.company} deal={deal} /><Pair label="Sales owner" value={personName(deal.owner)} deal={deal} /><Pair label="Expected close date" value={deal.expectedClose} type="date" deal={deal} /><Pair label="Deal value" value={deal.amount} type="currency" deal={deal} /><Pair label="Forecast category" value={deal.forecastCategory} deal={deal} /><Pair label="Pipeline" value={pipeline?.name} deal={deal} /></InfoCard><InfoCard title="Status and assignment"><Pair label="Related contact" value={personName(deal.contact)} deal={deal} /><Pair label="Deal type" value={deal.dealType} deal={deal} /><Pair label="Lost reason" value={deal.lostReason} deal={deal} /><Pair label="Closed date" value={deal.closedAt} type="date" deal={deal} /><Pair label="Payment status" value={deal.paymentStatus} deal={deal} /></InfoCard><div className="deal-side-cards"><InfoCard title="Contacts by sales owner"><div className="deal-related"><Users size={16} /><span>{personName(deal.owner) || 'Unassigned'} ({deal.contact ? 1 : 0})</span></div></InfoCard><InfoCard title={`Products (${products.length})`}>{products.length ? products.map((p, i) => <div className="deal-product" key={`${p.name}-${i}`}><span>{p.name}</span><strong>{p.quantity}</strong></div>) : <span className="deal-empty">No products linked</span>}</InfoCard><InfoCard title="Upcoming meeting"><span className="deal-empty">{deal.upcomingMeeting?.title || 'No upcoming meeting'}</span>{deal.upcomingMeeting && <small>{formatDateTime(deal.upcomingMeeting.startAt)}</small>}</InfoCard></div></div><InfoCard title="Notes"><textarea aria-label="Deal note" placeholder="Type your note here..." readOnly /><div className="deal-note"><NotebookPen size={16} /><div><strong>{latestNote?.description || 'No notes available'}</strong>{latestNote && <small>Posted by {personName(latestNote.user) || 'CRM user'}, {relative(latestNote.createdAt)}</small>}</div></div><button type="button" className="deal-link">View all notes</button></InfoCard><section className="deal-tracker"><div className="deal-section-heading"><strong>Pipeline progress</strong><span>{pipeline?.name || 'Pipeline'}</span></div><div className="deal-stages">{stageRows.map((stage, index) => <div className={`deal-stage ${index <= activeIndex ? 'done' : ''} ${index === activeIndex ? 'current' : ''}`} key={stage.id || stage.name}><span style={{ background: stage.color || 'var(--accent-color)' }} />{stage.name}</div>)}</div><div className="deal-age">Created {relative(deal.createdAt)} · Expected close {deal.expectedClose ? formatDateMedium(deal.expectedClose) : EMPTY}</div></section><nav className="deal-tabs" aria-label="Deal workspace tabs">{tabs.map((item) => <button type="button" key={item} className={tab === item ? 'active' : ''} onClick={() => setTab(item)}>{item}</button>)}</nav>{tab === 'Overview' && <div className="deal-overview-grid"><InfoCard title="Deal summary"><Pair label="Stage" value={deal.stage} deal={deal} /><Pair label="Probability" value={deal.probability} type="percent" deal={deal} /><Pair label="Created" value={deal.createdAt} type="date" deal={deal} /></InfoCard><InfoCard title="Latest activity">{notes.length ? <div className="deal-activity-list">{notes.slice(0, 5).map((item) => <div key={`${item.type}-${item.id}`}><FileText size={15} /><span><strong>{item.type || 'Activity'}</strong>{item.description}<small>{formatDate(item.createdAt)}</small></span></div>)}</div> : <span className="deal-empty">No activities available</span>}</InfoCard></div>}{tab === 'Deal details' && <div className="deal-details-content"><div className="deal-details-toolbar"><div><h2>Deal details</h2><button type="button" className="deal-link"><Settings2 size={14} /> Manage fields</button></div><label><Search size={15} /><input aria-label="Search fields" placeholder="Search fields" value={query} onChange={(e) => setQuery(e.target.value)} /></label><label className="deal-switch"><input type="checkbox" checked={showEmpty} onChange={(e) => setShowEmpty(e.target.checked)} /> Show empty fields</label></div>{visibleSections.map((section) => <Section key={section.key} section={section} deal={deal} pipeline={pipeline} latestNote={latestNote} showEmpty={showEmpty} />)}</div>}{!['Overview', 'Deal details'].includes(tab) && <div className="deal-placeholder"><FileText size={25} /><h2>{tab}</h2><p>This workspace is ready for {tab.toLowerCase()} data when that module is enabled.</p></div>}</div>;
}

const styles = `.deal-details-page{max-width:1500px;margin:0 auto;padding:24px 28px 48px;color:var(--text-primary)}.deal-breadcrumb{display:flex;gap:8px;align-items:center;font-size:12px;color:var(--text-secondary);margin-bottom:18px}.deal-link{display:inline-flex;align-items:center;gap:6px;border:0;background:none;color:var(--primary-color,var(--accent-color));font-weight:700;cursor:pointer;padding:0}.deal-header{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;margin-bottom:20px}.deal-title-row{display:flex;align-items:center;gap:10px}.deal-title-row h1{margin:0;font-size:26px}.deal-meta{display:flex;gap:16px;flex-wrap:wrap;margin:8px 0 0 32px;color:var(--text-secondary);font-size:13px}.deal-meta strong{color:var(--text-primary);font-size:16px}.deal-primary,.deal-secondary{display:inline-flex;align-items:center;gap:7px;border-radius:8px;padding:9px 13px;font-weight:700;cursor:pointer}.deal-primary{background:var(--primary-color,var(--accent-color));color:#fff;border:0}.deal-secondary{background:var(--surface-color);color:var(--text-primary);border:1px solid var(--border-color)}.deal-top-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-bottom:12px}.deal-info-card,.deal-tracker,.deal-details-content,.deal-placeholder{background:var(--surface-color);border:1px solid var(--border-color);border-radius:10px;padding:16px;margin-bottom:12px;min-width:0}.deal-info-card h2{font-size:14px;margin:0 0 14px}.deal-pair{display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:1px solid var(--border-color);font-size:12px}.deal-pair:last-child{border-bottom:0}.deal-pair span,.deal-field span,.deal-empty{color:var(--text-secondary)}.deal-pair strong{font-weight:600;text-align:right;overflow-wrap:anywhere}.deal-side-cards{min-width:0}.deal-side-cards .deal-info-card{margin-bottom:8px}.deal-related,.deal-product,.deal-note{display:flex;gap:9px;align-items:flex-start;font-size:12px}.deal-product{justify-content:space-between;padding:5px 0}.deal-info-card textarea{width:100%;min-height:64px;resize:vertical;border:1px solid var(--border-color);border-radius:7px;padding:10px;background:var(--input-bg,var(--surface-color));color:var(--text-primary);font:inherit;margin-bottom:12px}.deal-note{padding:10px;background:var(--subtle-bg);border-radius:7px;margin-bottom:10px}.deal-note small,.deal-info-card small,.deal-activity-list small{display:block;color:var(--text-secondary);margin-top:5px}.deal-section-heading{display:flex;justify-content:space-between;align-items:center;gap:12px;font-size:12px}.deal-section-heading span{color:var(--text-secondary);font-weight:400}.deal-stages{display:grid;grid-template-columns:repeat(auto-fit,minmax(100px,1fr));gap:8px;margin:18px 0 10px}.deal-stage{display:flex;align-items:center;gap:6px;color:var(--text-secondary);font-size:11px}.deal-stage span{width:10px;height:10px;border-radius:50%;opacity:.35}.deal-stage.done{color:var(--text-primary);font-weight:600}.deal-stage.done span{opacity:1}.deal-stage.current{color:var(--primary-color,var(--accent-color))}.deal-age{font-size:11px;color:var(--text-secondary)}.deal-tabs{display:flex;gap:4px;overflow-x:auto;border-bottom:1px solid var(--border-color);margin:18px 0 14px}.deal-tabs button{white-space:nowrap;border:0;border-bottom:2px solid transparent;background:none;color:var(--text-secondary);padding:11px 10px;font-size:12px;cursor:pointer}.deal-tabs button.active{color:var(--primary-color,var(--accent-color));border-bottom-color:var(--primary-color,var(--accent-color));font-weight:700}.deal-overview-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.deal-activity-list{display:grid;gap:11px}.deal-activity-list>div{display:flex;gap:8px;font-size:12px}.deal-activity-list strong{display:block;margin-bottom:3px}.deal-details-toolbar{display:flex;justify-content:space-between;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:12px}.deal-details-toolbar h2{font-size:18px;margin:0 0 5px}.deal-details-toolbar label:not(.deal-switch){display:flex;align-items:center;gap:7px;border:1px solid var(--border-color);border-radius:7px;padding:7px 9px;min-width:230px}.deal-details-toolbar input[aria-label="Search fields"]{border:0;outline:0;background:transparent;color:var(--text-primary);width:100%}.deal-switch{display:flex;gap:7px;align-items:center;color:var(--text-secondary);font-size:12px}.deal-field-section{border:1px solid var(--border-color);border-radius:8px;margin:10px 0;overflow:hidden}.deal-field-section>.deal-section-heading{padding:10px 12px;background:var(--subtle-bg);border-bottom:1px solid var(--border-color)}.deal-field-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:0 18px;padding:6px 12px}.deal-field{min-width:0;padding:10px 0;border-bottom:1px solid var(--border-color);font-size:11px}.deal-field span,.deal-field strong{display:block}.deal-field strong{margin-top:4px;font-size:12px;overflow-wrap:anywhere}.deal-placeholder,.deal-error,.deal-loading{min-height:280px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;text-align:center}.deal-error h1{margin:0}.deal-error p{color:var(--text-secondary)}.deal-loading{align-items:stretch;text-align:left}.deal-skeleton{height:120px;border-radius:10px;background:var(--subtle-bg);animation:deal-pulse 1.2s ease-in-out infinite}.deal-skeleton.short{height:22px;width:45%}@keyframes deal-pulse{50%{opacity:.45}}@media(max-width:900px){.deal-top-grid,.deal-overview-grid{grid-template-columns:1fr}.deal-field-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:600px){.deal-details-page{padding:18px 14px 36px}.deal-header{flex-direction:column}.deal-field-grid{grid-template-columns:1fr}.deal-meta{margin-left:0}.deal-title-row h1{font-size:22px}}`;
