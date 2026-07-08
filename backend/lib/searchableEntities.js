/**
 * Searchable Entities Registry
 *
 * Central configuration for what entities are searchable via /api/search.
 * Adding a new searchable entity requires:
 *   1. Adding an entry to SEARCHABLE_ENTITIES below
 *   2. Adding a corresponding section to frontend Omnibar ENTITY_SECTIONS
 *
 * Each entry defines:
 *   - model: Prisma model name (must match prisma.{model}.findMany)
 *   - label: Display name in search results
 *   - icon: Lucide icon name (frontend use)
 *   - color & bg & border: Color scheme (frontend use)
 *   - searchFields: Prisma fields to search (OR conjunction)
 *   - selectFields: Prisma fields to return
 *   - conditional: Optional condition check (e.g., wellness-only)
 *   - renderHelper: Frontend rendering hints
 */

const SEARCHABLE_ENTITIES = [
  {
    key: 'contacts',
    model: 'contact',
    label: 'Contacts',
    icon: 'User',
    color: '#3b82f6',
    bg: 'rgba(59, 130, 246, 0.12)',
    border: 'rgba(59, 130, 246, 0.25)',
    searchFields: ['name', 'email', 'company', 'phone'],
    selectFields: ['id', 'name', 'email', 'company', 'status'],
    renderHelper: { primaryField: 'company', primaryFormat: (c) => c.company ? `${c.name} • ${c.company}` : c.name }
  },
  {
    key: 'deals',
    model: 'deal',
    label: 'Pipeline',
    icon: 'Briefcase',
    color: '#10b981',
    bg: 'rgba(16, 185, 129, 0.12)',
    border: 'rgba(16, 185, 129, 0.25)',
    searchFields: ['title'],
    selectFields: ['id', 'title', 'amount', 'stage', 'currency'],
    renderHelper: { includeAmount: true }
  },
  {
    key: 'sequences',
    model: 'sequence',
    label: 'Sequences',
    icon: 'Mail',
    color: '#06b6d4',
    bg: 'rgba(6, 182, 212, 0.12)',
    border: 'rgba(6, 182, 212, 0.25)',
    searchFields: ['name'],
    selectFields: ['id', 'name', 'isActive'],
    renderHelper: { statusField: true }
  },
  {
    key: 'campaigns',
    model: 'campaign',
    label: 'Campaigns',
    icon: 'Mail',
    color: '#8b5cf6',
    bg: 'rgba(139, 92, 246, 0.12)',
    border: 'rgba(139, 92, 246, 0.25)',
    searchFields: ['name'],
    selectFields: ['id', 'name', 'channel', 'status'],
    renderHelper: { statusField: true }
  },
  {
    key: 'invoices',
    model: 'invoice',
    label: 'Invoices',
    icon: 'FileText',
    color: '#f59e0b',
    bg: 'rgba(245, 158, 11, 0.12)',
    border: 'rgba(245, 158, 11, 0.25)',
    searchFields: ['invoiceNum'],
    selectFields: ['id', 'invoiceNum', 'status', 'amount'],
    renderHelper: { includeAmount: true, includeContact: true }
  },
  {
    key: 'tickets',
    model: 'ticket',
    label: 'Tickets',
    icon: 'Ticket',
    color: '#ef4444',
    bg: 'rgba(239, 68, 68, 0.12)',
    border: 'rgba(239, 68, 68, 0.25)',
    searchFields: ['subject', 'description'],
    selectFields: ['id', 'subject', 'status', 'priority'],
    renderHelper: { statusAndPriority: true }
  },
  {
    key: 'tasks',
    model: 'task',
    label: 'Tasks',
    icon: 'CheckSquare',
    color: '#06b6d4',
    bg: 'rgba(6, 182, 212, 0.12)',
    border: 'rgba(6, 182, 212, 0.25)',
    searchFields: ['title'],
    selectFields: ['id', 'title', 'status', 'priority'],
    renderHelper: { statusAndPriority: true }
  },
  {
    key: 'projects',
    model: 'project',
    label: 'Projects',
    icon: 'FolderKanban',
    color: '#8b5cf6',
    bg: 'rgba(139, 92, 246, 0.12)',
    border: 'rgba(139, 92, 246, 0.25)',
    searchFields: ['name'],
    selectFields: ['id', 'name', 'status'],
    renderHelper: { statusField: true }
  },
  {
    key: 'surveys',
    model: 'survey',
    label: 'Surveys',
    icon: 'FileSpreadsheet',
    color: '#14b8a6',
    bg: 'rgba(20, 184, 166, 0.12)',
    border: 'rgba(20, 184, 166, 0.25)',
    searchFields: ['title', 'name'],
    selectFields: ['id', 'title', 'name', 'type'],
    renderHelper: { typeField: true }
  },
  {
    key: 'contracts',
    model: 'contract',
    label: 'Contracts',
    icon: 'FileText',
    color: '#0ea5e9',
    bg: 'rgba(14, 165, 233, 0.12)',
    border: 'rgba(14, 165, 233, 0.25)',
    searchFields: ['title'],
    selectFields: ['id', 'title', 'status'],
    renderHelper: { statusField: true }
  },
  {
    key: 'estimates',
    model: 'estimate',
    label: 'Estimates',
    icon: 'FileSpreadsheet',
    color: '#84cc16',
    bg: 'rgba(132, 204, 22, 0.12)',
    border: 'rgba(132, 204, 22, 0.25)',
    searchFields: ['title', 'estimateNum'],
    selectFields: ['id', 'title', 'estimateNum', 'status'],
    renderHelper: { estimateNum: true }
  },
  {
    key: 'emails',
    model: 'emailMessage',
    label: 'Email',
    icon: 'Mail',
    color: '#f43f5e',
    bg: 'rgba(244, 63, 94, 0.12)',
    border: 'rgba(244, 63, 94, 0.25)',
    searchFields: ['subject', 'from', 'to'],
    selectFields: ['id', 'subject', 'from', 'to', 'direction', 'createdAt'],
    renderHelper: { emailFormat: true }
  },
  {
    key: 'whatsappMessages',
    model: 'whatsappMessage',
    label: 'WhatsApp',
    icon: 'Mail',
    color: '#25d366',
    bg: 'rgba(37, 211, 102, 0.12)',
    border: 'rgba(37, 211, 102, 0.25)',
    searchFields: ['body', 'phoneNumber'],
    selectFields: ['id', 'phoneNumber', 'body', 'direction', 'createdAt'],
    conditional: 'wellness', // Only search in wellness tenants
    renderHelper: { truncateBody: true }
  },
  {
    key: 'patients',
    model: 'patient',
    label: 'Patients',
    icon: 'HeartPulse',
    color: '#ec4899',
    bg: 'rgba(236, 72, 153, 0.12)',
    border: 'rgba(236, 72, 153, 0.25)',
    searchFields: ['name', 'phone', 'email'],
    selectFields: ['id', 'name', 'email', 'phone'],
    conditional: 'wellness', // Only search in wellness tenants
    renderHelper: { patientFormat: true }
  },
  {
    key: 'kbArticles',
    model: 'kbArticle',
    label: 'Knowledge Base',
    icon: 'BookOpen',
    color: '#14b8a6',
    bg: 'rgba(20, 184, 166, 0.12)',
    border: 'rgba(20, 184, 166, 0.25)',
    searchFields: ['title', 'content'],
    selectFields: ['id', 'title', 'slug', 'isPublished'],
    renderHelper: { publishedStatus: true }
  },
];

// Create a map for faster lookups
const ENTITY_MAP = new Map(SEARCHABLE_ENTITIES.map(e => [e.key, e]));

// Get all searchable entities
function getAllSearchableEntities() {
  return SEARCHABLE_ENTITIES;
}

// Get entity config by key
function getEntityConfig(key) {
  return ENTITY_MAP.get(key) || null;
}

// Get models that should be searched for a given vertical
function getSearchableModelsForVertical(vertical) {
  return SEARCHABLE_ENTITIES.filter(entity => {
    if (!entity.conditional) return true;
    if (entity.conditional === 'wellness') return vertical === 'wellness';
    return true;
  });
}

module.exports = {
  SEARCHABLE_ENTITIES,
  getAllSearchableEntities,
  getEntityConfig,
  getSearchableModelsForVertical,
};
