import {
  LayoutDashboard,
  UserRound,
  MessagesSquare,
  Activity,
  Facebook,
  Github,
  Twitter,
} from 'lucide-react';

export const PROFILE_TABS = [
  { key: 'overview', label: 'Overview', icon: LayoutDashboard },
  { key: 'details', label: 'Contact details', icon: UserRound },
  { key: 'conversations', label: 'Conversation', icon: MessagesSquare },
  { key: 'activities', label: 'Activities', icon: Activity },
];

export const SOCIAL_NETWORKS = [
  { key: 'facebookUrl', label: 'Facebook', icon: Facebook, color: '#1877F2', placeholder: 'https://facebook.com/username' },
  { key: 'githubUrl', label: 'GitHub', icon: Github, color: '#181717', placeholder: 'https://github.com/username' },
  { key: 'twitterUrl', label: 'Twitter', icon: Twitter, color: '#000000', placeholder: 'https://x.com/username' },
];

export function normalizeSocialUrl(raw) {
  const v = typeof raw === 'string' ? raw.trim() : '';
  if (!v) return null;
  if (/^https?:\/\//i.test(v)) return v;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(v)) return null;
  return `https://${v}`;
}

export const LIFECYCLE_STAGES = ['Lead', 'Prospect', 'Customer'];

export const TERMINAL_STATUSES = ['Churned', 'Junk'];

export const DEAL_STAGES = ['lead', 'contacted', 'proposal', 'negotiation', 'won', 'lost'];

export const ACTIVITY_TYPES = ['Note', 'Call', 'Email', 'Meeting'];

export function buildOverviewSections(contact) {
  const owner = contact?.assignedTo?.name || contact?.assignedTo?.email || null;
  return [
    {
      title: 'Summary',
      priority: true,
      fields: [
        { key: 'email', label: 'Email', type: 'email' },
        { key: 'phone', label: 'Phone', type: 'phone' },
        { key: 'company', label: 'Company', type: 'text' },
        { key: 'title', label: 'Job title', type: 'text' },
        { key: '__owner', label: 'Sales owner', type: 'text', value: owner },
        { key: 'stateCode', label: 'Location', type: 'text' },
        { key: 'createdAt', label: 'Created', type: 'relative' },
      ],
    },
    {
      title: 'Business Information',
      priority: true,
      fields: [
        { key: 'company', label: 'Company', type: 'text' },
        { key: 'industry', label: 'Industry', type: 'text' },
        { key: 'companySize', label: 'Company size', type: 'text' },
        { key: 'website', label: 'Website', type: 'url' },
        { key: 'linkedin', label: 'LinkedIn', type: 'url' },
        { key: 'facebookUrl', label: 'Facebook', type: 'url' },
        { key: 'githubUrl', label: 'GitHub', type: 'url' },
        { key: 'twitterUrl', label: 'Twitter / X', type: 'url' },
        { key: 'title', label: 'Job title', type: 'text' },
        { key: 'subBrand', label: 'Sub-brand', type: 'text' },
      ],
    },
    {
      title: 'Preferences',
      priority: false,
      fields: [
        { key: 'treatmentOfInterest', label: 'Treatment of interest', type: 'text' },
        { key: 'tags', label: 'Tags', type: 'tags' },
        { key: 'birthDate', label: 'Birthday', type: 'date' },
        { key: 'anniversary', label: 'Anniversary', type: 'date' },
      ],
    },
    {
      title: 'Billing',
      priority: false,
      fields: [
        { key: 'gst', label: 'GSTIN', type: 'text' },
        { key: 'walletBalance', label: 'Wallet balance', type: 'money' },
        { key: 'billingStateCode', label: 'Billing state', type: 'text' },
        { key: 'stateCode', label: 'Residence state', type: 'text' },
      ],
    },
    {
      title: 'KYC / Verification',
      priority: false,
      fields: [
        { key: 'kycStatus', label: 'KYC status', type: 'status' },
        { key: 'kycVerifiedAt', label: 'Verified on', type: 'date' },
        { key: 'kycInitiatedAt', label: 'Initiated on', type: 'date' },
        { key: 'aadhaarLast4', label: 'Aadhaar (last 4)', type: 'text' },
        { key: 'emailVerifiedAt', label: 'Email verified', type: 'date' },
      ],
    },
    {
      title: 'Attribution',
      priority: false,
      fields: [
        { key: 'source', label: 'Source', type: 'text' },
        { key: 'firstTouchSource', label: 'First touch', type: 'text' },
        { key: 'lastTouchSource', label: 'Last touch', type: 'text' },
        { key: 'callifiedCampaignId', label: 'Call campaign', type: 'text' },
        { key: 'callifiedLeadStatus', label: 'Call outcome', type: 'text' },
        { key: 'referrerContactId', label: 'Referred by', type: 'hidden' },
      ],
    },
    {
      title: 'Record Information',
      priority: false,
      fields: [
        { key: 'createdAt', label: 'Created', type: 'datetime' },
        { key: 'updatedAt', label: 'Last updated', type: 'datetime' },
        { key: 'lastEnrichedAt', label: 'Last enriched', type: 'datetime' },
        { key: 'firstResponseAt', label: 'First response', type: 'datetime' },
        { key: 'slaBreached', label: 'SLA breached', type: 'boolean' },
      ],
    },
  ];
}
