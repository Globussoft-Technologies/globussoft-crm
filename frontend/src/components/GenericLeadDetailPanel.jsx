import { X, Copy } from 'lucide-react';
import { copyToClipboard } from '../utils/clipboard';
import { useNotify } from '../utils/notify';
import './GenericLeadDetailPanel.css';

export default function GenericLeadDetailPanel({ lead, onClose, onOpen, onEdit, canEdit, sourceLabel, closing = false }) {
  const notify = useNotify();
  const copy = async (value, label) => {
    try { await copyToClipboard(value); notify.success(`${label} copied`); }
    catch { notify.error('Unable to copy. Please select and copy the text manually.'); }
  };
  return <aside className={`generic-lead-detail-panel${closing ? ' generic-lead-detail-panel--closing' : ''}`} aria-label="Selected lead details" aria-hidden={closing || undefined} inert={closing ? '' : undefined} onKeyDown={event => { if (event.key === 'Escape') onClose(); }}>
    <header><span>Selected lead</span><button type="button" className="btn-secondary" onClick={onClose} aria-label="Close lead preview"><X size={16} /></button></header>
    <div className="generic-lead-detail-avatar" aria-hidden="true">{(lead.name || '?').charAt(0).toUpperCase()}</div>
    <div className="generic-lead-detail-copy-row"><h2>{lead.name || 'Unnamed lead'}</h2>{lead.name && <button type="button" aria-label="Copy lead name" onClick={() => copy(lead.name, 'Name')}><Copy size={12} /></button>}</div>
    <div className="generic-lead-detail-copy-row"><p>{lead.company || 'No company added'}</p>{lead.company && <button type="button" aria-label="Copy lead company" onClick={() => copy(lead.company, 'Company')}><Copy size={12} /></button>}</div>
    <h3>Contact information</h3>
    <dl>{[
      ['Email', lead.email || 'Not provided'], ['Phone', lead.phone || 'Not provided'],
      ['Title', lead.title || 'Not provided'], ['Source', sourceLabel || lead.source || 'Not provided'],
      ['Lead score', lead.aiScore == null ? 'Not scored' : `${lead.aiScore} / 100`],
      ['Assigned to', lead.assignedTo?.name || lead.assignedTo?.email || 'Unassigned'], ['Status', lead.status || 'Lead'],
    ].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    <div className="generic-lead-detail-actions"><button type="button" className="btn-primary" onClick={onOpen}>Open full detail</button>{canEdit && <button type="button" className="btn-secondary" onClick={onEdit}>Edit lead</button>}</div>
  </aside>;
}
