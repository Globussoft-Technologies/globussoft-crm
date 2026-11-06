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
    genericFixedWhere: { status: { not: 'Lead' } },
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
    key: 'leads',
    model: 'contact',
    label: 'Leads',
    icon: 'UserPlus',
    color: '#6366f1',
    bg: 'rgba(99, 102, 241, 0.12)',
    border: 'rgba(99, 102, 241, 0.25)',
    searchFields: ['name', 'email', 'company', 'phone'],
    selectFields: ['id', 'name', 'email', 'company', 'status'],
    verticals: ['generic'],
    fixedWhere: { status: 'Lead' },
    renderHelper: { statusField: true }
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
  {
    key: 'campaignTemplates',
    model: 'emailTemplate',
    label: 'Templates',
    icon: 'LayoutTemplate',
    color: '#8b5cf6',
    bg: 'rgba(139, 92, 246, 0.12)',
    border: 'rgba(139, 92, 246, 0.25)',
    searchFields: ['name', 'subject', 'channel', 'category'],
    selectFields: ['id', 'name', 'subject', 'channel', 'category', 'updatedAt'],
    verticals: ['generic'],
    renderHelper: { statusField: true }
  },
  {
    key: 'webhookWorkflows',
    model: 'automationRule',
    label: 'Webhooks',
    icon: 'Code',
    color: '#10b981',
    bg: 'rgba(16, 185, 129, 0.12)',
    border: 'rgba(16, 185, 129, 0.25)',
    searchFields: ['name'],
    selectFields: ['id', 'name', 'actionType', 'targetState', 'isActive', 'updatedAt'],
    verticals: ['generic'],
    webhookOnly: true,
    renderHelper: { statusField: true }
  },
  {
    key: 'quotes', model: 'quote', label: 'Quotes', icon: 'FileText',
    color: '#0ea5e9', bg: 'rgba(14, 165, 233, 0.12)', border: 'rgba(14, 165, 233, 0.25)',
    searchFields: ['title'],
    selectFields: ['id', 'title', 'status'],
    verticals: ['generic']
  },
  {
    key: 'expenses', model: 'expense', label: 'Expenses', icon: 'Receipt',
    color: '#f97316', bg: 'rgba(249, 115, 22, 0.12)', border: 'rgba(249, 115, 22, 0.25)',
    searchFields: ['title', 'description', 'category'],
    selectFields: ['id', 'title', 'category', 'status', 'amount', 'currency'],
    verticals: ['generic']
  },
  {
    key: 'payments', model: 'payment', label: 'Payments', icon: 'CreditCard',
    color: '#10b981', bg: 'rgba(16, 185, 129, 0.12)', border: 'rgba(16, 185, 129, 0.25)',
    searchFields: ['description', 'gateway', 'gatewayId', 'plotPaymentReference'],
    selectFields: ['id', 'description', 'gateway', 'status', 'amount', 'currency'],
    verticals: ['generic']
  },
  {
    key: 'webForms', model: 'webForm', label: 'Web Forms', icon: 'Code',
    color: '#8b5cf6', bg: 'rgba(139, 92, 246, 0.12)', border: 'rgba(139, 92, 246, 0.25)',
    searchFields: ['name', 'slug', 'description'],
    selectFields: ['id', 'name', 'slug', 'isActive'],
    verticals: ['generic'], fixedWhere: { scope: 'generic' }
  },
  {
    key: 'landingPages', model: 'landingPage', label: 'Landing Sites', icon: 'PanelTop',
    color: '#ec4899', bg: 'rgba(236, 72, 153, 0.12)', border: 'rgba(236, 72, 153, 0.25)',
    searchFields: ['title', 'slug', 'description'],
    selectFields: ['id', 'title', 'slug', 'status'],
    verticals: ['generic']
  },
  {
    key: 'signatureRequests', model: 'signatureRequest', label: 'E-Signatures', icon: 'FileText',
    color: '#06b6d4', bg: 'rgba(6, 182, 212, 0.12)', border: 'rgba(6, 182, 212, 0.25)',
    searchFields: ['signerName', 'signerEmail', 'documentType'],
    selectFields: ['id', 'signerName', 'signerEmail', 'documentType', 'status'],
    verticals: ['generic']
  },
  {
    key: 'documentTemplates', model: 'documentTemplate', label: 'Document Templates', icon: 'LayoutTemplate',
    color: '#a855f7', bg: 'rgba(168, 85, 247, 0.12)', border: 'rgba(168, 85, 247, 0.25)',
    searchFields: ['name', 'type'], selectFields: ['id', 'name', 'type'], verticals: ['generic']
  },
  {
    key: 'pipelines', model: 'pipeline', label: 'Pipelines', icon: 'Briefcase',
    color: '#14b8a6', bg: 'rgba(20, 184, 166, 0.12)', border: 'rgba(20, 184, 166, 0.25)',
    searchFields: ['name'], selectFields: ['id', 'name', 'isDefault'], verticals: ['generic']
  },
  {
    key: 'playbooks', model: 'playbook', label: 'Playbooks', icon: 'BookOpen',
    color: '#f59e0b', bg: 'rgba(245, 158, 11, 0.12)', border: 'rgba(245, 158, 11, 0.25)',
    searchFields: ['name', 'stage'], selectFields: ['id', 'name', 'stage', 'isActive'], verticals: ['generic']
  },
  {
    key: 'abTests', model: 'abTest', label: 'A/B Tests', icon: 'FileSpreadsheet',
    color: '#ec4899', bg: 'rgba(236, 72, 153, 0.12)', border: 'rgba(236, 72, 153, 0.25)',
    searchFields: ['name'], selectFields: ['id', 'name', 'status', 'winningVariant'], verticals: ['generic']
  },
  {
    key: 'chatbots', model: 'chatbot', label: 'Chatbots', icon: 'MessageSquare',
    color: '#6366f1', bg: 'rgba(99, 102, 241, 0.12)', border: 'rgba(99, 102, 241, 0.25)',
    searchFields: ['name'], selectFields: ['id', 'name', 'isActive'], verticals: ['generic']
  },
  {
    key: 'slaPolicies', model: 'slaPolicy', label: 'SLA Policies', icon: 'Ticket',
    color: '#ef4444', bg: 'rgba(239, 68, 68, 0.12)', border: 'rgba(239, 68, 68, 0.25)',
    searchFields: ['name', 'priority'], selectFields: ['id', 'name', 'priority', 'isActive'], verticals: ['generic']
  },
  {
    key: 'liveChatSessions', model: 'liveChatSession', label: 'Live Chat', icon: 'MessageSquare',
    color: '#06b6d4', bg: 'rgba(6, 182, 212, 0.12)', border: 'rgba(6, 182, 212, 0.25)',
    searchFields: ['visitorName', 'visitorEmail', 'visitorId'],
    selectFields: ['id', 'visitorName', 'visitorEmail', 'visitorId', 'status'], verticals: ['generic']
  },
  {
    key: 'webVisitors', model: 'webVisitor', label: 'Web Visitors', icon: 'User',
    color: '#14b8a6', bg: 'rgba(20, 184, 166, 0.12)', border: 'rgba(20, 184, 166, 0.25)',
    searchFields: ['sessionId', 'ipAddress', 'country', 'city'],
    selectFields: ['id', 'sessionId', 'ipAddress', 'country', 'city', 'identified'], verticals: ['generic']
  },
  {
    key: 'socialPosts', model: 'socialPost', label: 'Social Media', icon: 'MessageSquare',
    color: '#3b82f6', bg: 'rgba(59, 130, 246, 0.12)', border: 'rgba(59, 130, 246, 0.25)',
    searchFields: ['content', 'platform', 'externalId'],
    selectFields: ['id', 'content', 'platform', 'status', 'scheduledFor'], verticals: ['generic']
  },
  {
    key: 'staffMembers', model: 'user', label: 'Staff', icon: 'Users',
    color: '#6366f1', bg: 'rgba(99, 102, 241, 0.12)', border: 'rgba(99, 102, 241, 0.25)',
    searchFields: ['name', 'email', 'phone', 'jobTitle'],
    selectFields: ['id', 'name', 'email', 'phone', 'jobTitle', 'role', 'deactivatedAt'],
    verticals: ['generic'], fixedWhere: { userType: 'STAFF' }
  },
  {
    key: 'salesTeams', model: 'salesTeam', label: 'Sales Teams', icon: 'Users',
    color: '#8b5cf6', bg: 'rgba(139, 92, 246, 0.12)', border: 'rgba(139, 92, 246, 0.25)',
    searchFields: ['name'], selectFields: ['id', 'name'], verticals: ['generic']
  },
  {
    key: 'territories', model: 'territory', label: 'Territories', icon: 'Map',
    color: '#10b981', bg: 'rgba(16, 185, 129, 0.12)', border: 'rgba(16, 185, 129, 0.25)',
    searchFields: ['name', 'regions'], selectFields: ['id', 'name', 'regions'], verticals: ['generic']
  },
  {
    key: 'pickupLocations', model: 'pickupLocation', label: 'Pickup Locations', icon: 'Map',
    color: '#f59e0b', bg: 'rgba(245, 158, 11, 0.12)', border: 'rgba(245, 158, 11, 0.25)',
    searchFields: ['name', 'address', 'notes'], selectFields: ['id', 'name', 'address', 'isActive'], verticals: ['generic']
  },
  {
    key: 'plotSites', model: 'plotSite', label: 'Plot Inventory', icon: 'Map',
    color: '#84cc16', bg: 'rgba(132, 204, 22, 0.12)', border: 'rgba(132, 204, 22, 0.25)',
    searchFields: ['name', 'plotNumber', 'block', 'address', 'referenceCode', 'area'],
    selectFields: ['id', 'name', 'plotNumber', 'block', 'referenceCode', 'availability'], verticals: ['generic']
  },
  {
    key: 'transportPersons', model: 'transportPerson', label: 'Transport Persons', icon: 'User',
    color: '#0ea5e9', bg: 'rgba(14, 165, 233, 0.12)', border: 'rgba(14, 165, 233, 0.25)',
    searchFields: ['name', 'phone', 'alternatePhone', 'vehicleType', 'vehicleNumber', 'serviceArea'],
    selectFields: ['id', 'name', 'phone', 'vehicleType', 'vehicleNumber', 'isActive'], verticals: ['generic']
  },
  {
    key: 'plotBrokers', model: 'plotBroker', label: 'Sales Executives', icon: 'User',
    color: '#a855f7', bg: 'rgba(168, 85, 247, 0.12)', border: 'rgba(168, 85, 247, 0.25)',
    searchFields: ['name', 'phone', 'email', 'agency'],
    selectFields: ['id', 'name', 'phone', 'email', 'agency', 'isActive'], verticals: ['generic']
  },
  {
    key: 'billingPersons', model: 'billingPerson', label: 'Billing Persons', icon: 'User',
    color: '#f97316', bg: 'rgba(249, 115, 22, 0.12)', border: 'rgba(249, 115, 22, 0.25)',
    searchFields: ['name', 'phone', 'email'], selectFields: ['id', 'name', 'phone', 'email', 'isActive'], verticals: ['generic']
  },
  {
    key: 'customerPickups', model: 'customerPickup', label: 'Customer Workflows', icon: 'Map',
    color: '#14b8a6', bg: 'rgba(20, 184, 166, 0.12)', border: 'rgba(20, 184, 166, 0.25)',
    searchFields: ['pickupAddress', 'sourceTranscriptId', 'sourceExcerpt'],
    selectFields: ['id', 'contactId', 'pickupAddress', 'sourceTranscriptId'], verticals: ['generic']
  },
  {
    key: 'auditLogs', model: 'auditLog', label: 'Audit Log', icon: 'FileText',
    color: '#64748b', bg: 'rgba(100, 116, 139, 0.12)', border: 'rgba(100, 116, 139, 0.25)',
    searchFields: ['action', 'entity', 'details'], selectFields: ['id', 'action', 'entity', 'entityId', 'createdAt'], verticals: ['generic']
  },
  {
    key: 'commissionProfiles', model: 'commissionProfile', label: 'Commission Profiles', icon: 'Award',
    color: '#f59e0b', bg: 'rgba(245, 158, 11, 0.12)', border: 'rgba(245, 158, 11, 0.25)',
    searchFields: ['name', 'basis', 'period', 'appliesToCategory', 'appliesToProduct'],
    selectFields: ['id', 'name', 'basis', 'period', 'isActive'], verticals: ['generic']
  },
  {
    key: 'commissionData', model: 'commissionData', label: 'Commission Data', icon: 'Award',
    color: '#f59e0b', bg: 'rgba(245, 158, 11, 0.12)', border: 'rgba(245, 158, 11, 0.25)',
    searchFields: ['employeeName'], selectFields: ['id', 'employeeName', 'periodStart', 'periodEnd'], verticals: ['generic']
  },
  {
    key: 'customEntities', model: 'customEntity', label: 'App Builder', icon: 'Code',
    color: '#8b5cf6', bg: 'rgba(139, 92, 246, 0.12)', border: 'rgba(139, 92, 246, 0.25)',
    searchFields: ['name', 'description'], selectFields: ['id', 'name', 'description'], verticals: ['generic']
  },
  {
    key: 'genericWhatsAppMessages', model: 'whatsAppMessage', label: 'WhatsApp', icon: 'MessageSquare',
    color: '#25d366', bg: 'rgba(37, 211, 102, 0.12)', border: 'rgba(37, 211, 102, 0.25)',
    searchFields: ['to', 'from', 'body', 'templateName'],
    selectFields: ['id', 'to', 'from', 'body', 'direction', 'status', 'createdAt'], verticals: ['generic']
  },
  {
    key: 'calendarEvents', model: 'calendarEvent', label: 'Calendar', icon: 'Calendar',
    color: '#3b82f6', bg: 'rgba(59, 130, 246, 0.12)', border: 'rgba(59, 130, 246, 0.25)',
    searchFields: ['title', 'description', 'location', 'attendees'],
    selectFields: ['id', 'title', 'location', 'provider', 'startTime', 'endTime'], verticals: ['generic']
  },
  {
    key: 'leadFieldDefinitions', model: 'leadCustomFieldDefinition', label: 'Lead Fields', icon: 'FileText',
    color: '#6366f1', bg: 'rgba(99, 102, 241, 0.12)', border: 'rgba(99, 102, 241, 0.25)',
    searchFields: ['label', 'fieldKey', 'fieldType', 'tooltip', 'placeholder'],
    selectFields: ['id', 'label', 'fieldKey', 'fieldType', 'isRequired'], verticals: ['generic']
  },
  {
    key: 'dealInsights', model: 'dealInsight', label: 'Deal Insights', icon: 'Brain',
    color: '#8b5cf6', bg: 'rgba(139, 92, 246, 0.12)', border: 'rgba(139, 92, 246, 0.25)',
    searchFields: ['type', 'insight', 'severity'],
    selectFields: ['id', 'dealId', 'type', 'insight', 'severity', 'isResolved'], verticals: ['generic']
  },
  {
    key: 'leadReportLeads', model: 'contact', label: 'Lead Reports', icon: 'FileSpreadsheet',
    color: '#6366f1', bg: 'rgba(99, 102, 241, 0.12)', border: 'rgba(99, 102, 241, 0.25)',
    searchFields: ['name', 'email', 'company', 'phone'],
    selectFields: ['id', 'name', 'email', 'company', 'status'],
    verticals: ['generic'], fixedWhere: { status: 'Lead' }
  },
  {
    key: 'reportSchedules', model: 'reportSchedule', label: 'Reports', icon: 'FileSpreadsheet',
    color: '#0ea5e9', bg: 'rgba(14, 165, 233, 0.12)', border: 'rgba(14, 165, 233, 0.25)',
    searchFields: ['name', 'reportType', 'groupBy', 'frequency', 'format'],
    selectFields: ['id', 'name', 'reportType', 'groupBy', 'frequency', 'format', 'enabled'], verticals: ['generic']
  },
  {
    key: 'agentReportAgents', model: 'user', label: 'Agent Reports', icon: 'Users',
    color: '#f59e0b', bg: 'rgba(245, 158, 11, 0.12)', border: 'rgba(245, 158, 11, 0.25)',
    searchFields: ['name', 'email', 'phone', 'jobTitle'],
    selectFields: ['id', 'name', 'email', 'phone', 'jobTitle', 'role', 'deactivatedAt'],
    verticals: ['generic'], fixedWhere: { userType: 'STAFF' }
  },
  {
    key: 'tenantSettings', model: 'tenantSetting', label: 'Settings', icon: 'Settings',
    color: '#64748b', bg: 'rgba(100, 116, 139, 0.12)', border: 'rgba(100, 116, 139, 0.25)',
    searchFields: ['key', 'category'], selectFields: ['id', 'key', 'category', 'updatedAt'],
    queryAliases: ['settings', 'configuration', 'tenant settings'], verticals: ['generic']
  },
  {
    key: 'notificationPreferences', model: 'notificationPreference', label: 'Notification Settings', icon: 'Bell',
    color: '#f43f5e', bg: 'rgba(244, 63, 94, 0.12)', border: 'rgba(244, 63, 94, 0.25)',
    searchFields: ['timezone', 'quietHoursStart', 'quietHoursEnd'],
    selectFields: ['id', 'timezone', 'quietHoursStart', 'quietHoursEnd', 'updatedAt'],
    queryAliases: ['notification', 'notifications', 'email alerts', 'push alerts', 'quiet hours'],
    verticals: ['generic'], scopeToUser: true
  },
  {
    key: 'revenueGoals', model: 'staffRevenueGoal', label: 'Revenue Goals', icon: 'Target',
    color: '#10b981', bg: 'rgba(16, 185, 129, 0.12)', border: 'rgba(16, 185, 129, 0.25)',
    searchFields: ['period', 'scope', 'scopeFilter', 'notes'],
    relationSearchFields: { user: ['name', 'email'] },
    selectFields: ['id', 'userId', 'period', 'periodStart', 'periodEnd', 'targetAmount', 'achievedAmount', 'scope', 'scopeFilter'],
    selectRelations: { user: ['name', 'email'] }, verticals: ['generic']
  },
  {
    key: 'workAssignmentStaff', model: 'user', label: 'Assign Staff Work', icon: 'ClipboardCheck',
    color: '#2563eb', bg: 'rgba(37, 99, 235, 0.12)', border: 'rgba(37, 99, 235, 0.25)',
    searchFields: ['name', 'email', 'phone', 'jobTitle'],
    selectFields: ['id', 'name', 'email', 'phone', 'jobTitle', 'role', 'deactivatedAt'],
    verticals: ['generic'], fixedWhere: { userType: 'STAFF' }
  },
  {
    key: 'transportWork', model: 'customerPickup', label: 'Transport Work', icon: 'Truck',
    color: '#2563eb', bg: 'rgba(37, 99, 235, 0.12)', border: 'rgba(37, 99, 235, 0.25)',
    searchFields: ['pickupAddress', 'sourceTranscriptId', 'sourceExcerpt'],
    relationSearchFields: { contact: ['name', 'email', 'phone', 'company'] },
    selectFields: ['id', 'contactId', 'pickupAddress', 'sourceTranscriptId'],
    selectRelations: { contact: ['name', 'email', 'phone', 'company'] },
    verticals: ['generic'], assignmentScope: 'transport'
  },
  {
    key: 'siteVisitWork', model: 'customerPickup', label: 'Site Visits', icon: 'Handshake',
    color: '#7c3aed', bg: 'rgba(124, 58, 237, 0.12)', border: 'rgba(124, 58, 237, 0.25)',
    searchFields: ['pickupAddress', 'sourceTranscriptId', 'sourceExcerpt'],
    relationSearchFields: { contact: ['name', 'email', 'phone', 'company'] },
    selectFields: ['id', 'contactId', 'pickupAddress', 'sourceTranscriptId'],
    selectRelations: { contact: ['name', 'email', 'phone', 'company'] },
    verticals: ['generic'], assignmentScope: 'broker'
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
