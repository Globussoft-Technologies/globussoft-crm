import { useEffect, useMemo, useRef, useState } from 'react';
import { Upload, Plus, Trash2, ArrowUp, ArrowDown } from 'lucide-react';
import { getAuthToken } from '../utils/api';
import { useNotify } from '../utils/notify';
import { isUploadedS3Url } from '../utils/uploadDisplay';
import UploadedAssetChip from '../components/UploadedAssetChip';

function clone(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_err) {
    return Array.isArray(value) ? [...value] : value;
  }
}

function getWellnessRoot(content) {
  return Array.isArray(content)
    ? content.find((block) => block && block.type === 'columns' && block.props?.variant === 'wellness-campaign-page')
    : null;
}

function getSectionColumns(root) {
  return Array.isArray(root?.props?.columns) ? root.props.columns : [];
}

function findBlockInColumns(columns, blockId) {
  for (const column of Array.isArray(columns) ? columns : []) {
    const blocks = Array.isArray(column?.components) ? column.components : [];
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue;
      if (block.id === blockId) return block;
      const nested = findBlockInColumns(block.props?.columns, blockId);
      if (nested) return nested;
    }
  }
  return null;
}

function updateBlockInColumns(columns, blockId, updater) {
  let changed = false;
  const nextColumns = (Array.isArray(columns) ? columns : []).map((column) => {
    if (!column || typeof column !== 'object') return column;
    const blocks = Array.isArray(column.components) ? column.components : [];
    const nextBlocks = blocks.map((block) => {
      if (!block || typeof block !== 'object') return block;
      if (block.id === blockId) {
        changed = true;
        return updater(block);
      }
      if (!Array.isArray(block.props?.columns)) return block;
      const nested = updateBlockInColumns(block.props.columns, blockId, updater);
      if (!nested.changed) return block;
      changed = true;
      return { ...block, props: { ...block.props, columns: nested.columns } };
    });
    const blocksChanged = nextBlocks.some((block, index) => block !== blocks[index]);
    if (!blocksChanged) return column;
    changed = true;
    return { ...column, components: nextBlocks };
  });
  return { changed, columns: nextColumns };
}

function collectBlocks(blocks, acc = []) {
  (Array.isArray(blocks) ? blocks : []).forEach((block) => {
    if (!block || typeof block !== 'object') return;
    acc.push(block);
    (block.props?.columns || []).forEach((column) => collectBlocks(column?.components, acc));
  });
  return acc;
}

function firstBlockText(content, ids = []) {
  const flat = collectBlocks(content);
  for (const id of ids) {
    const match = flat.find((block) => block?.id === id && typeof block?.props?.text === 'string' && block.props.text.trim());
    if (match) return match.props.text;
  }
  const fallback = flat.find((block) => ['heading', 'text'].includes(block?.type) && typeof block?.props?.text === 'string' && block.props.text.trim());
  return fallback?.props?.text || '';
}

function pageCampaignName(page = {}, content) {
  const candidate = firstBlockText(content, ['hero-title-1', 'brand-name', 'cta-title', 'form-title-copy']) || page?.title || page?.name || page?.slug || 'Wellness Landing Page';
  return String(candidate).trim() || 'Wellness Landing Page';
}

function buildWellnessScaffold(page = {}, content = []) {
  const campaignName = pageCampaignName(page, content);
  const audience = page?.audience || 'your audience';
  const businessName = page?.businessName || campaignName;
  const sectorLabel = page?.sectorLabel || 'Wellness';
  const summary = page?.description || `${businessName} invites ${audience} to learn more, submit an enquiry, and receive a prompt follow-up.`;
  const location = page?.eventLocation || page?.location || 'Add location';
  const eventDate = page?.eventDate || 'Add date';
  const eventTime = page?.eventTime || 'Add time';

  const text = (id, value, extra = {}) => ({ id, type: 'text', props: { text: value, ...extra } });
  const heading = (id, value, level = 'h3', extra = {}) => ({ id, type: 'heading', props: { text: value, level, ...extra } });
  const button = (id, value, url, extra = {}) => ({ id, type: 'button', props: { text: value, url, ...extra } });
  const image = (id, alt) => ({ id, type: 'image', props: { src: '', alt, variant: 'wellness-hero-image', width: '100%', maxWidth: '100%' } });
  const form = () => ({
    id: 'lead-form',
    type: 'form',
    props: {
      title: page?.formTitle || 'Request More Information',
      submitText: page?.formSubmitText || 'Submit Enquiry',
      thankYouMessage: page?.formThankYou || `Thanks. We have received your enquiry for ${campaignName}.`,
      variant: 'wellness-consultation',
      fields: [
        { label: 'First Name', name: 'first_name', type: 'text', required: true, placeholder: 'e.g., John' },
        { label: 'Last Name', name: 'last_name', type: 'text', required: true, placeholder: 'e.g., Doe' },
        { label: 'Email Address', name: 'email', type: 'email', required: true, placeholder: 'e.g., name@example.com' },
        { label: 'Phone Number', name: 'phone', type: 'tel', required: true, placeholder: 'e.g., +91 98765 43210' },
        { label: 'Service of Interest', name: 'service_interest', type: 'select', required: false, options: [sectorLabel, campaignName, 'General Enquiry'] },
        { label: 'Tell Us More', name: 'message', type: 'textarea', required: false, placeholder: 'Share any questions or concerns...' },
      ],
    },
  });
  const section = (id, variant, columns, gap = '24px') => ({ id, type: 'columns', props: { variant, gap, columns } });

  return [
    section('wellness-page', 'wellness-campaign-page', [
      { fullWidth: true, components: [
        section('wellness-header-row', 'wellness-header-row', [
          { components: [
            text('brand-mark', page?.brandMark || '+', { align: 'center', color: '#b31d15', fontSize: '1.7rem', variant: 'wellness-logo-mark' }),
            heading('brand-name', page?.brandLine || businessName, 'h3', { align: 'left', color: '#1f2f2c', variant: 'wellness-logo' }),
            text('brand-subline', page?.brandSubline || sectorLabel, { align: 'left', color: '#5f6c67', fontSize: '0.82rem', variant: 'wellness-brand-subline' }),
          ] },
          { components: [
            text('top-nav', page?.navText || 'HOME   SERVICES   ABOUT US   CONTACT', { align: 'center', color: '#1f2f2c', fontSize: '0.78rem', variant: 'wellness-nav' }),
            button('top-cta', page?.topCta || 'Book Now', '#lead-form', { bgColor: '#b31d15', color: '#ffffff', align: 'right', size: 'small' }),
          ] },
        ], '8px'),
      ] },
      { fullWidth: true, components: [
        section('wellness-hero-row', 'wellness-hero-row', [
          { components: [
            text('hero-kicker', page?.heroKicker || 'VISIT - CALL - WRITE', { align: 'left', color: '#b31d15', fontSize: '0.8rem', variant: 'wellness-eyebrow' }),
            heading('hero-title-1', page?.heroTitleLine1 || campaignName, 'h1', { align: 'left', color: '#1f2f2c', variant: 'wellness-display' }),
            heading('hero-title-2', page?.heroTitleLine2 || '', 'h1', { align: 'left', color: '#b31d15', variant: 'wellness-hero-accent' }),
            text('hero-copy', page?.heroCopy || summary, { align: 'left', color: '#5f6c67', fontSize: '1.02rem', variant: 'wellness-body' }),
            button('hero-primary-cta', page?.heroPrimaryCta || 'Get Started', '#lead-form', { bgColor: '#b31d15', color: '#ffffff', align: 'left', size: 'medium' }),
            text('hero-note', page?.heroNote || 'Every submission is editable, trackable, and routed to the right team instantly.', { align: 'left', color: '#5f6c67', fontSize: '0.88rem', variant: 'wellness-note' }),
          ] },
          { components: [ image('hero-image', `${campaignName} hero image`) ] },
        ], '36px'),
      ] },
      { fullWidth: true, components: [
        section('wellness-details-strip', 'wellness-details-strip', [
          { components: [text('detail-date-label', 'Date', { align: 'center', color: '#b31d15', fontSize: '0.72rem', variant: 'wellness-detail-label' }), heading('detail-date-value', eventDate, 'h4', { align: 'center', color: '#1f2f2c', variant: 'wellness-detail-value' })] },
          { components: [text('detail-time-label', 'Time', { align: 'center', color: '#b31d15', fontSize: '0.72rem', variant: 'wellness-detail-label' }), heading('detail-time-value', eventTime, 'h4', { align: 'center', color: '#1f2f2c', variant: 'wellness-detail-value' })] },
          { components: [text('detail-location-label', 'Location', { align: 'center', color: '#b31d15', fontSize: '0.72rem', variant: 'wellness-detail-label' }), heading('detail-location-value', location, 'h4', { align: 'center', color: '#1f2f2c', variant: 'wellness-detail-value' })] },
          { components: [text('detail-audience-label', 'For', { align: 'center', color: '#b31d15', fontSize: '0.72rem', variant: 'wellness-detail-label' }), heading('detail-audience-value', audience, 'h4', { align: 'center', color: '#1f2f2c', variant: 'wellness-detail-value' })] },
        ], '8px'),
      ] },
      { fullWidth: true, components: [
        section('wellness-benefits-row', 'wellness-benefits-row', [
          { components: [
            text('benefits-kicker', page?.benefitsKicker || 'WHY CHOOSE US?', { align: 'left', color: '#b31d15', fontSize: '0.8rem', variant: 'wellness-eyebrow' }),
            heading('benefits-title', page?.benefitsTitle || campaignName, 'h2', { align: 'left', color: '#1f2f2c', variant: 'wellness-section-title' }),
            text('benefits-copy', page?.benefitsCopy || `A clear landing page helps visitors understand the ${sectorLabel.toLowerCase()} offer, trust the brand, and take the next step without friction.`, { align: 'left', color: '#5f6c67', fontSize: '0.98rem', variant: 'wellness-body' }),
          ] },
          { components: [
            section('benefit-grid', 'wellness-benefit-grid', [
              { components: [text('benefit-1-icon', '+', { align: 'center', color: '#b31d15', fontSize: '1.45rem', variant: 'wellness-badge' }), heading('benefit-1-title', page?.benefit1Title || 'Clear value', 'h4', { align: 'left', color: '#1f2f2c', variant: 'wellness-card-title' }), text('benefit-1-body', page?.benefit1Body || `Show visitors why the ${sectorLabel.toLowerCase()} offer matters and how it helps them.`, { align: 'left', color: '#5f6c67', fontSize: '0.94rem', variant: 'wellness-card-body' })] },
              { components: [text('benefit-2-icon', 'o', { align: 'center', color: '#b31d15', fontSize: '1.45rem', variant: 'wellness-badge' }), heading('benefit-2-title', page?.benefit2Title || 'Professional follow-up', 'h4', { align: 'left', color: '#1f2f2c', variant: 'wellness-card-title' }), text('benefit-2-body', page?.benefit2Body || 'The team can respond quickly with the right next step once the enquiry is submitted.', { align: 'left', color: '#5f6c67', fontSize: '0.94rem', variant: 'wellness-card-body' })] },
              { components: [text('benefit-3-icon', ':)', { align: 'center', color: '#b31d15', fontSize: '1.45rem', variant: 'wellness-badge' }), heading('benefit-3-title', page?.benefit3Title || 'Trust-building copy', 'h4', { align: 'left', color: '#1f2f2c', variant: 'wellness-card-title' }), text('benefit-3-body', page?.benefit3Body || 'Clear language and a polished layout make the page feel credible and easy to use.', { align: 'left', color: '#5f6c67', fontSize: '0.94rem', variant: 'wellness-card-body' })] },
              { components: [text('benefit-4-icon', '#', { align: 'center', color: '#b31d15', fontSize: '1.45rem', variant: 'wellness-badge' }), heading('benefit-4-title', page?.benefit4Title || 'Stronger conversions', 'h4', { align: 'left', color: '#1f2f2c', variant: 'wellness-card-title' }), text('benefit-4-body', page?.benefit4Body || 'A focused landing page keeps attention on the offer and the enquiry form.', { align: 'left', color: '#5f6c67', fontSize: '0.94rem', variant: 'wellness-card-body' })] },
            ], '8px'),
          ] },
        ], '28px'),
      ] },
      { fullWidth: true, components: [
        section('wellness-process-row', 'wellness-process-row', [
          { components: [
            heading('eligibility-title', page?.eligibilityTitle || 'Who is this for?', 'h3', { align: 'left', color: '#1f2f2c', variant: 'wellness-section-title' }),
            text('eligibility-copy', page?.eligibilityCopy || 'Use this section to explain who the offer is for, what should be prepared, and what the visitor can expect next.', { align: 'left', color: '#5f6c67', fontSize: '0.96rem', variant: 'wellness-body' }),
            text('eligibility-list', (page?.eligibilityBullets && Array.isArray(page.eligibilityBullets) ? page.eligibilityBullets : ['Clear service details', 'Simple enquiry process', 'Responsive follow-up', 'Editable by the admin']).map((bullet) => `- ${bullet}`).join('\n'), { align: 'left', color: '#1f2f2c', fontSize: '0.96rem', variant: 'wellness-bullet-list', whiteSpace: 'pre-line' }),
            button('eligibility-cta', page?.eligibilityCta || 'Know More', '#lead-form', { bgColor: '#fff8f7', color: '#b31d15', align: 'left', size: 'small' }),
          ] },
          { components: [
            heading('process-title', page?.processTitle || 'How it works', 'h3', { align: 'left', color: '#b31d15', variant: 'wellness-section-title' }),
            text('process-copy', page?.processCopy || 'A simple flow helps visitors move from interest to enquiry while keeping the team in control of the next steps.', { align: 'left', color: '#5f6c67', fontSize: '0.96rem', variant: 'wellness-body' }),
            section('steps-grid', 'wellness-step-grid', [
              { components: [heading('step-1-number', '1', 'h3', { align: 'center', color: '#b31d15', variant: 'wellness-step-number' }), heading('step-1-title', page?.step1Title || 'Review', 'h4', { align: 'center', color: '#1f2f2c', variant: 'wellness-card-title' }), text('step-1-body', page?.step1Body || `Visitors quickly understand the ${sectorLabel.toLowerCase()} offer and what to expect next.`, { align: 'center', color: '#5f6c67', fontSize: '0.92rem', variant: 'wellness-card-body' })] },
              { components: [heading('step-2-number', '2', 'h3', { align: 'center', color: '#b31d15', variant: 'wellness-step-number' }), heading('step-2-title', page?.step2Title || 'Enquire', 'h4', { align: 'center', color: '#1f2f2c', variant: 'wellness-card-title' }), text('step-2-body', page?.step2Body || 'They submit a short form with the essential details the team needs.', { align: 'center', color: '#5f6c67', fontSize: '0.92rem', variant: 'wellness-card-body' })] },
              { components: [heading('step-3-number', '3', 'h3', { align: 'center', color: '#b31d15', variant: 'wellness-step-number' }), heading('step-3-title', page?.step3Title || 'Follow up', 'h4', { align: 'center', color: '#1f2f2c', variant: 'wellness-card-title' }), text('step-3-body', page?.step3Body || 'The team reviews the enquiry and responds with confirmation or next steps.', { align: 'center', color: '#5f6c67', fontSize: '0.92rem', variant: 'wellness-card-body' })] },
              { components: [heading('step-4-number', '4', 'h3', { align: 'center', color: '#b31d15', variant: 'wellness-step-number' }), heading('step-4-title', page?.step4Title || 'Convert', 'h4', { align: 'center', color: '#1f2f2c', variant: 'wellness-card-title' }), text('step-4-body', page?.step4Body || 'A clear process improves trust and keeps the visitor moving toward action.', { align: 'center', color: '#5f6c67', fontSize: '0.92rem', variant: 'wellness-card-body' })] },
            ], '8px'),
          ] },
        ], '28px'),
      ] },
      { fullWidth: true, components: [
        section('wellness-impact-band', 'wellness-impact-band', [
          { components: [
            text('impact-kicker', page?.impactKicker || 'WHY IT WORKS', { align: 'left', color: '#fff4f1', fontSize: '0.8rem', variant: 'wellness-eyebrow' }),
            heading('impact-title', page?.impactTitle || `Built to capture leads for ${campaignName}.`, 'h2', { align: 'left', color: '#ffffff', variant: 'wellness-band-title' }),
            text('impact-copy', page?.impactCopy || 'The landing page highlights the strongest proof points without overwhelming the visitor, and the form stays easy to find.', { align: 'left', color: '#ffe7e3', fontSize: '0.94rem', variant: 'wellness-band-copy' }),
          ] },
          { components: [
            section('metrics-grid', 'wellness-metric-grid', [
              { components: [heading('metric-1-value', page?.metric1Value || '4', 'h2', { align: 'center', color: '#ffffff', variant: 'wellness-metric-value' }), text('metric-1-label', page?.metric1Label || 'Simple sections', { align: 'center', color: '#ffe7e3', fontSize: '0.86rem', variant: 'wellness-metric-label' })] },
              { components: [heading('metric-2-value', page?.metric2Value || '0', 'h2', { align: 'center', color: '#ffffff', variant: 'wellness-metric-value' }), text('metric-2-label', page?.metric2Label || 'Manual chasing', { align: 'center', color: '#ffe7e3', fontSize: '0.86rem', variant: 'wellness-metric-label' })] },
              { components: [heading('metric-3-value', page?.metric3Value || '100%', 'h2', { align: 'center', color: '#ffffff', variant: 'wellness-metric-value' }), text('metric-3-label', page?.metric3Label || 'Editable content', { align: 'center', color: '#ffe7e3', fontSize: '0.86rem', variant: 'wellness-metric-label' })] },
              { components: [heading('metric-4-value', page?.metric4Value || '1', 'h2', { align: 'center', color: '#ffffff', variant: 'wellness-metric-value' }), text('metric-4-label', page?.metric4Label || 'Lead pipeline', { align: 'center', color: '#ffe7e3', fontSize: '0.86rem', variant: 'wellness-metric-label' })] },
            ], '8px'),
          ] },
        ], '28px'),
      ] },
      { fullWidth: true, components: [
        section('wellness-cta-row', 'wellness-cta-row', [
          { components: [
            heading('cta-title', page?.ctaTitle || 'Ready to get started?', 'h3', { align: 'left', color: '#1f2f2c', variant: 'wellness-section-title' }),
            text('cta-copy', page?.ctaCopy || `Invite your visitors to take the next step with a clear, professional experience tailored to ${sectorLabel.toLowerCase()}.`, { align: 'left', color: '#5f6c67', fontSize: '0.96rem', variant: 'wellness-body' }),
            text('cta-note', page?.ctaNote || 'Your details will be captured in the CRM and shared with the right team for follow-up.', { align: 'left', color: '#5f6c67', fontSize: '0.86rem', variant: 'wellness-note' }),
          ] },
          { components: [ button('cta-button', page?.ctaText || 'Book Now', '#lead-form', { bgColor: '#b31d15', color: '#ffffff', align: 'center', size: 'large' }) ] },
        ], '8px'),
      ] },
      { fullWidth: true, components: [
        section('wellness-form-row', 'wellness-form-row', [
          { components: [
            text('form-kicker', 'Lead capture', { align: 'left', color: '#b31d15', fontSize: '0.76rem', variant: 'wellness-eyebrow' }),
            heading('form-title-copy', page?.formTitle || 'Request More Information', 'h3', { align: 'left', color: '#1f2f2c', variant: 'wellness-section-title' }),
            text('form-copy', page?.formCopy || 'Share your details and the team will follow up with confirmation and next steps.', { align: 'left', color: '#5f6c67', fontSize: '0.94rem', variant: 'wellness-body' }),
            form(),
          ] },
          { components: [
            text('register-kicker', page?.registerKicker || 'WHAT HAPPENS NEXT', { align: 'left', color: '#b31d15', fontSize: '0.76rem', variant: 'wellness-eyebrow' }),
            heading('register-title', page?.registerTitle || `A smoother way to join ${campaignName}.`, 'h2', { align: 'left', color: '#1f2f2c', variant: 'wellness-section-title' }),
            text('register-copy', page?.registerCopy || `Tell us a few details and the ${businessName} team will confirm availability, share preparation notes, and guide you through the next step.`, { align: 'left', color: '#4d5d58', fontSize: '1rem', variant: 'wellness-body' }),
            section('register-cards', 'wellness-step-grid', [
              { components: [heading('register-card-1-title', page?.registerCard1Title || 'Confirmation', 'h4', { align: 'left', color: '#1f2f2c', variant: 'wellness-card-title' }), text('register-card-1-body', page?.registerCard1Body || 'Your enquiry is captured in the CRM and routed to the right team.', { align: 'left', color: '#5f6c67', fontSize: '0.92rem', variant: 'wellness-card-body' })] },
              { components: [heading('register-card-2-title', page?.registerCard2Title || 'Personal follow-up', 'h4', { align: 'left', color: '#1f2f2c', variant: 'wellness-card-title' }), text('register-card-2-body', page?.registerCard2Body || 'A team member can respond with timing, venue, and preparation details.', { align: 'left', color: '#5f6c67', fontSize: '0.92rem', variant: 'wellness-card-body' })] },
              { components: [heading('register-card-3-title', page?.registerCard3Title || 'Secure records', 'h4', { align: 'left', color: '#1f2f2c', variant: 'wellness-card-title' }), text('register-card-3-body', page?.registerCard3Body || 'Every submission remains editable, trackable, and ready for lead follow-up.', { align: 'left', color: '#5f6c67', fontSize: '0.92rem', variant: 'wellness-card-body' })] },
              { components: [heading('register-card-4-title', page?.registerCard4Title || 'Clear next steps', 'h4', { align: 'left', color: '#1f2f2c', variant: 'wellness-card-title' }), text('register-card-4-body', page?.registerCard4Body || 'Visitors know exactly what will happen after they submit the form.', { align: 'left', color: '#5f6c67', fontSize: '0.92rem', variant: 'wellness-card-body' })] },
            ], '8px'),
          ] },
        ], '28px'),
      ] },
      { fullWidth: true, components: [
        section('wellness-footer-row', 'wellness-footer-row', [
          { components: [
            text('footer-brand-mark', page?.brandMark || '+', { align: 'left', color: '#b31d15', fontSize: '1.4rem', variant: 'wellness-logo-mark' }),
            heading('footer-brand-name', page?.brandLine || businessName, 'h4', { align: 'left', color: '#1f2f2c', variant: 'wellness-footer-brand' }),
            text('footer-links', page?.footerLinks || 'Home | Services | About Us | Contact', { align: 'left', color: '#5f6c67', fontSize: '0.84rem', variant: 'wellness-footer-links' }),
          ] },
          { components: [
            text('footer-contact', page?.footerContact || '+91 98765 43210\ninfo@company.com\nKoramangala, Bengaluru', { align: 'left', color: '#5f6c67', fontSize: '0.84rem', variant: 'wellness-footer-contact', whiteSpace: 'pre-line' }),
            text('footer-copy', page?.footerCopy || `(c) ${new Date().getFullYear()} ${businessName}. All rights reserved.`, { align: 'right', color: '#7b807a', fontSize: '0.78rem', variant: 'wellness-footer-copy' }),
          ] },
        ], '8px'),
      ] },
    ], '24px'),
  ];
}

function replaceContentBlock(content, blockId, updater) {
  const next = clone(content);
  const root = getWellnessRoot(next);
  if (!root) return content;
  const result = updateBlockInColumns(root.props?.columns, blockId, updater);
  if (!result.changed) return content;
  root.props.columns = result.columns;
  return next;
}

function moveSection(content, sectionIndex, delta) {
  const next = clone(content);
  const root = getWellnessRoot(next);
  if (!root) return content;
  const cols = getSectionColumns(root).slice();
  const nextIndex = sectionIndex + delta;
  if (nextIndex < 0 || nextIndex >= cols.length) return content;
  const [item] = cols.splice(sectionIndex, 1);
  cols.splice(nextIndex, 0, item);
  root.props.columns = cols;
  return next;
}

async function uploadImage(file) {
  const fd = new FormData();
  fd.append('image', file);
  const token = getAuthToken();
  const res = await fetch('/api/landing-pages/upload', {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: fd,
  });
  if (!res.ok) {
    let msg = `Upload failed (${res.status})`;
    try {
      const data = await res.json();
      if (data?.error) msg = data.error;
    } catch (_err) {
      // ignore
    }
    throw new Error(msg);
  }
  const json = await res.json();
  if (!json?.url) throw new Error('Upload returned no URL');
  return json.url;
}

function Card({ title, eyebrow, children }) {
  return (
    <section style={{ border: '1px solid var(--border-color)', borderRadius: 18, background: 'var(--surface-color)', padding: '1rem', boxShadow: 'var(--glass-shadow)', marginBottom: '1rem' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '1rem', marginBottom: '0.85rem' }}>
        <div>
          {eyebrow && <div style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-secondary)', marginBottom: '0.2rem' }}>{eyebrow}</div>}
          <h3 style={{ margin: 0, fontSize: '1rem', color: 'var(--text-primary)' }}>{title}</h3>
        </div>
      </div>
      {children}
    </section>
  );
}

function Field({ label, value, onChange, placeholder, type = 'text', multiline = false, rows = 3 }) {
  return (
    <label style={{ display: 'block', marginBottom: '0.8rem' }}>
      <div style={{ fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-secondary)', marginBottom: '0.35rem' }}>{label}</div>
      {multiline ? (
        <textarea
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value)}
          rows={rows}
          placeholder={placeholder}
          style={{ width: '100%', padding: '0.7rem 0.8rem', borderRadius: 10, border: '1px solid var(--border-color)', background: 'var(--bg-color)', color: 'var(--text-primary)', resize: 'vertical' }}
        />
      ) : (
        <input
          type={type}
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          style={{ width: '100%', padding: '0.7rem 0.8rem', borderRadius: 10, border: '1px solid var(--border-color)', background: 'var(--bg-color)', color: 'var(--text-primary)' }}
        />
      )}
    </label>
  );
}

function ImageField({ value, onChange, label = 'Image URL' }) {
  const notify = useNotify();
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef(null);

  const onPick = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!/^image\//.test(file.type)) {
      notify.error('Pick an image file');
      return;
    }
    setUploading(true);
    try {
      const url = await uploadImage(file);
      onChange(url);
      notify.success('Image uploaded');
    } catch (err) {
      notify.error(err?.message || 'Upload failed');
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const showChip = isUploadedS3Url(value);
  return (
    <div style={{ marginBottom: '0.8rem' }}>
      <div style={{ fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-secondary)', marginBottom: '0.35rem' }}>{label}</div>
      {showChip ? (
        <UploadedAssetChip
          url={value}
          kind="image"
          uploading={uploading}
          onReplace={() => inputRef.current?.click()}
          onRemove={() => onChange('')}
        />
      ) : (
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <input
            type="text"
            value={value ?? ''}
            onChange={(e) => onChange(e.target.value)}
            placeholder="https://... or /uploads/..."
            style={{ flex: 1, padding: '0.7rem 0.8rem', borderRadius: 10, border: '1px solid var(--border-color)', background: 'var(--bg-color)', color: 'var(--text-primary)' }}
          />
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={uploading}
            style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', padding: '0.7rem 0.9rem', borderRadius: 10, border: '1px solid var(--border-color)', background: 'var(--surface-color)', cursor: uploading ? 'wait' : 'pointer', color: 'var(--text-primary)' }}
          >
            <Upload size={14} /> {uploading ? '...' : 'Upload'}
          </button>
        </div>
      )}
      <input ref={inputRef} type="file" accept="image/*" onChange={onPick} style={{ display: 'none' }} />
    </div>
  );
}

function FieldList({ fields, onChange }) {
  const list = Array.isArray(fields) ? fields : [];
  return (
    <div style={{ display: 'grid', gap: '0.75rem' }}>
      {list.map((field, idx) => (
        <div key={`${field.name || idx}`} style={{ border: '1px solid var(--border-color)', borderRadius: 12, padding: '0.8rem', background: 'var(--subtle-bg)' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
            <input
              value={field.label ?? ''}
              onChange={(e) => {
                const next = list.slice();
                next[idx] = { ...next[idx], label: e.target.value };
                onChange(next);
              }}
              placeholder="Field label"
              style={{ padding: '0.6rem 0.7rem', borderRadius: 8, border: '1px solid var(--border-color)', background: 'var(--surface-color)' }}
            />
            <input
              value={field.name ?? ''}
              onChange={(e) => {
                const next = list.slice();
                next[idx] = { ...next[idx], name: e.target.value };
                onChange(next);
              }}
              placeholder="field_name"
              style={{ padding: '0.6rem 0.7rem', borderRadius: 8, border: '1px solid var(--border-color)', background: 'var(--surface-color)' }}
            />
            <select
              value={field.type ?? 'text'}
              onChange={(e) => {
                const next = list.slice();
                next[idx] = { ...next[idx], type: e.target.value };
                onChange(next);
              }}
              style={{ padding: '0.6rem 0.7rem', borderRadius: 8, border: '1px solid var(--border-color)', background: 'var(--surface-color)' }}
            >
              <option value="text">Text</option>
              <option value="email">Email</option>
              <option value="tel">Phone</option>
              <option value="textarea">Textarea</option>
              <option value="select">Select</option>
            </select>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.85rem', color: 'var(--text-primary)', justifyContent: 'flex-end' }}>
              <input
                type="checkbox"
                checked={!!field.required}
                onChange={(e) => {
                  const next = list.slice();
                  next[idx] = { ...next[idx], required: e.target.checked };
                  onChange(next);
                }}
              />
              Required
            </label>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', marginTop: '0.5rem' }}>
            <input
              value={field.placeholder ?? ''}
              onChange={(e) => {
                const next = list.slice();
                next[idx] = { ...next[idx], placeholder: e.target.value };
                onChange(next);
              }}
              placeholder="Placeholder"
              style={{ flex: 1, padding: '0.6rem 0.7rem', borderRadius: 8, border: '1px solid var(--border-color)', background: 'var(--surface-color)' }}
            />
            <button
              type="button"
              onClick={() => onChange(list.filter((_, j) => j !== idx))}
              style={{ padding: '0.6rem 0.7rem', borderRadius: 8, border: '1px solid var(--border-color)', background: 'transparent', color: '#ef4444', cursor: 'pointer' }}
            >
              <Trash2 size={14} />
            </button>
          </div>
          {field.type === 'select' && (
            <Field
              label="Options"
              value={(field.options || []).join(', ')}
              onChange={(value) => {
                const next = list.slice();
                next[idx] = { ...next[idx], options: value.split(',').map((s) => s.trim()).filter(Boolean) };
                onChange(next);
              }}
              placeholder="Option 1, Option 2, Option 3"
            />
          )}
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...list, { label: 'New Field', name: `field_${Date.now()}`, type: 'text', required: false }])}
        style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', padding: '0.65rem 0.8rem', borderRadius: 10, border: '1px dashed var(--border-color)', background: 'transparent', color: 'var(--accent-color)', cursor: 'pointer', justifyContent: 'center' }}
      >
        <Plus size={14} /> Add field
      </button>
    </div>
  );
}

function SectionOrder({ sections, onMove }) {
  return (
    <Card title="Section order" eyebrow="Layout">
      <div style={{ display: 'grid', gap: '0.6rem' }}>
        {sections.map((section, index) => {
          const label = sectionLabels[section?.components?.[0]?.id] || section?.components?.[0]?.id || `Section ${index + 1}`;
          return (
            <div key={`${label}-${index}`} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.65rem 0.75rem', borderRadius: 10, border: '1px solid var(--border-color)', background: 'var(--subtle-bg)' }}>
              <GripLabel />
              <span style={{ flex: 1, minWidth: 0, fontSize: '0.85rem', color: 'var(--text-primary)' }}>{label}</span>
              <button type="button" onClick={() => onMove(index, -1)} disabled={index === 0} style={sectionBtnStyle(index === 0)}><ArrowUp size={14} /></button>
              <button type="button" onClick={() => onMove(index, 1)} disabled={index === sections.length - 1} style={sectionBtnStyle(index === sections.length - 1)}><ArrowDown size={14} /></button>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function GripLabel() {
  return <span aria-hidden="true" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, borderRadius: 6, background: 'var(--surface-color)', color: 'var(--text-secondary)', flexShrink: 0 }}>::</span>;
}

function sectionBtnStyle(disabled) {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 30,
    height: 30,
    borderRadius: 8,
    border: '1px solid var(--border-color)',
    background: 'var(--surface-color)',
    color: disabled ? 'var(--text-secondary)' : 'var(--text-primary)',
    opacity: disabled ? 0.45 : 1,
    cursor: disabled ? 'not-allowed' : 'pointer',
  };
}

const sectionLabels = {
  'wellness-header-row': 'Brand header',
  'wellness-hero-row': 'Hero',
  'wellness-details-strip': 'Event details',
  'wellness-benefits-row': 'Benefits and proof',
  'wellness-process-row': 'Eligibility and process',
  'wellness-impact-band': 'Impact band',
  'wellness-cta-row': 'Call to action',
  'wellness-form-row': 'Lead capture',
  'wellness-footer-row': 'Footer',
};

function SectionEditor({ title, eyebrow, children }) {
  return <Card title={title} eyebrow={eyebrow}>{children}</Card>;
}

function editText(edit, id) {
  return (value) => edit(id, (block) => ({ ...block, props: { ...block.props, text: value } }));
}

export default function LandingPageWellnessEditor({ content, onChange, page }) {
  const hasRoot = !!getWellnessRoot(content);
  const resolvedContent = useMemo(
    () => (hasRoot ? content : buildWellnessScaffold(page, content)),
    [content, hasRoot, page],
  );
  const root = getWellnessRoot(resolvedContent) || null;
  const sections = useMemo(() => getSectionColumns(root), [root]);
  const bootstrappedRef = useRef(false);

  useEffect(() => {
    if (hasRoot || bootstrappedRef.current) return;
    bootstrappedRef.current = true;
    onChange(resolvedContent);
  }, [hasRoot, onChange, resolvedContent]);

  const edit = (blockId, updater) => {
    const next = replaceContentBlock(resolvedContent, blockId, updater);
    if (next !== resolvedContent) onChange(next);
  };

  const move = (index, delta) => {
    const next = moveSection(resolvedContent, index, delta);
    if (next !== resolvedContent) onChange(next);
  };

  const header = {
    brandMark: findBlockInColumns(sections, 'brand-mark'),
    brandName: findBlockInColumns(sections, 'brand-name'),
    brandSubline: findBlockInColumns(sections, 'brand-subline'),
    navText: findBlockInColumns(sections, 'top-nav'),
    topCta: findBlockInColumns(sections, 'top-cta'),
  };
  const hero = {
    kicker: findBlockInColumns(sections, 'hero-kicker'),
    title1: findBlockInColumns(sections, 'hero-title-1'),
    title2: findBlockInColumns(sections, 'hero-title-2'),
    copy: findBlockInColumns(sections, 'hero-copy'),
    primary: findBlockInColumns(sections, 'hero-primary-cta'),
    note: findBlockInColumns(sections, 'hero-note'),
    image: findBlockInColumns(sections, 'hero-image'),
  };
  const details = {
    dateLabel: findBlockInColumns(sections, 'detail-date-label'),
    dateValue: findBlockInColumns(sections, 'detail-date-value'),
    timeLabel: findBlockInColumns(sections, 'detail-time-label'),
    timeValue: findBlockInColumns(sections, 'detail-time-value'),
    locationLabel: findBlockInColumns(sections, 'detail-location-label'),
    locationValue: findBlockInColumns(sections, 'detail-location-value'),
    audienceLabel: findBlockInColumns(sections, 'detail-audience-label'),
    audienceValue: findBlockInColumns(sections, 'detail-audience-value'),
  };
  const benefits = {
    kicker: findBlockInColumns(sections, 'benefits-kicker'),
    title: findBlockInColumns(sections, 'benefits-title'),
    copy: findBlockInColumns(sections, 'benefits-copy'),
    cards: [
      { icon: findBlockInColumns(sections, 'benefit-1-icon'), title: findBlockInColumns(sections, 'benefit-1-title'), body: findBlockInColumns(sections, 'benefit-1-body') },
      { icon: findBlockInColumns(sections, 'benefit-2-icon'), title: findBlockInColumns(sections, 'benefit-2-title'), body: findBlockInColumns(sections, 'benefit-2-body') },
      { icon: findBlockInColumns(sections, 'benefit-3-icon'), title: findBlockInColumns(sections, 'benefit-3-title'), body: findBlockInColumns(sections, 'benefit-3-body') },
      { icon: findBlockInColumns(sections, 'benefit-4-icon'), title: findBlockInColumns(sections, 'benefit-4-title'), body: findBlockInColumns(sections, 'benefit-4-body') },
    ],
  };
  const process = {
    eligibilityTitle: findBlockInColumns(sections, 'eligibility-title'),
    eligibilityCopy: findBlockInColumns(sections, 'eligibility-copy'),
    eligibilityList: findBlockInColumns(sections, 'eligibility-list'),
    eligibilityCta: findBlockInColumns(sections, 'eligibility-cta'),
    processTitle: findBlockInColumns(sections, 'process-title'),
    processCopy: findBlockInColumns(sections, 'process-copy'),
    steps: [
      { number: findBlockInColumns(sections, 'step-1-number'), title: findBlockInColumns(sections, 'step-1-title'), body: findBlockInColumns(sections, 'step-1-body') },
      { number: findBlockInColumns(sections, 'step-2-number'), title: findBlockInColumns(sections, 'step-2-title'), body: findBlockInColumns(sections, 'step-2-body') },
      { number: findBlockInColumns(sections, 'step-3-number'), title: findBlockInColumns(sections, 'step-3-title'), body: findBlockInColumns(sections, 'step-3-body') },
      { number: findBlockInColumns(sections, 'step-4-number'), title: findBlockInColumns(sections, 'step-4-title'), body: findBlockInColumns(sections, 'step-4-body') },
    ],
  };
  const impact = {
    kicker: findBlockInColumns(sections, 'impact-kicker'),
    title: findBlockInColumns(sections, 'impact-title'),
    copy: findBlockInColumns(sections, 'impact-copy'),
    metrics: [
      { value: findBlockInColumns(sections, 'metric-1-value'), label: findBlockInColumns(sections, 'metric-1-label') },
      { value: findBlockInColumns(sections, 'metric-2-value'), label: findBlockInColumns(sections, 'metric-2-label') },
      { value: findBlockInColumns(sections, 'metric-3-value'), label: findBlockInColumns(sections, 'metric-3-label') },
      { value: findBlockInColumns(sections, 'metric-4-value'), label: findBlockInColumns(sections, 'metric-4-label') },
    ],
  };
  const cta = {
    title: findBlockInColumns(sections, 'cta-title'),
    copy: findBlockInColumns(sections, 'cta-copy'),
    note: findBlockInColumns(sections, 'cta-note'),
    button: findBlockInColumns(sections, 'cta-button'),
  };
  const form = findBlockInColumns(sections, 'lead-form');
  const footer = {
    brandMark: findBlockInColumns(sections, 'footer-brand-mark'),
    brandName: findBlockInColumns(sections, 'footer-brand-name'),
    links: findBlockInColumns(sections, 'footer-links'),
    contact: findBlockInColumns(sections, 'footer-contact'),
    copy: findBlockInColumns(sections, 'footer-copy'),
  };

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 320px', gap: '1rem', alignItems: 'start', padding: '1.25rem' }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ marginBottom: '1rem' }}>
          <h2 style={{ margin: 0, fontSize: '1.35rem', color: 'var(--text-primary)' }}>Wellness Landing Page Editor</h2>
          <p style={{ margin: '0.35rem 0 0', color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
            Edit the marketing page sections directly. The public landing page and preview both use the same block tree.
          </p>
        </div>

        <SectionEditor title="Brand header" eyebrow="Section 1">
          <div style={{ display: 'grid', gap: '0.75rem' }}>
            <Field label="Brand mark" value={header.brandMark?.props?.text} onChange={editText(edit, 'brand-mark')} placeholder="+" />
            <Field label="Brand line" value={header.brandName?.props?.text} onChange={editText(edit, 'brand-name')} placeholder="Enhance Wellness Initiative" />
            <Field label="Brand subline" value={header.brandSubline?.props?.text} onChange={editText(edit, 'brand-subline')} placeholder="Wellness Initiative" />
            <Field label="Nav text" value={header.navText?.props?.text} onChange={editText(edit, 'top-nav')} placeholder="HOME   EVENTS   ABOUT US   DONATE   CONTACT" />
            <Field label="Top CTA" value={header.topCta?.props?.text} onChange={editText(edit, 'top-cta')} placeholder="Become a Donor" />
          </div>
        </SectionEditor>

        <SectionEditor title="Hero" eyebrow="Section 2">
          <Field label="Eyebrow" value={hero.kicker?.props?.text} onChange={editText(edit, 'hero-kicker')} placeholder="VISIT - CALL - WRITE" />
          <Field label="Headline line 1" value={hero.title1?.props?.text} onChange={editText(edit, 'hero-title-1')} placeholder="Campaign headline" />
          <Field label="Headline line 2" value={hero.title2?.props?.text} onChange={editText(edit, 'hero-title-2')} placeholder="Supporting line" />
          <Field label="Intro copy" value={hero.copy?.props?.text} onChange={editText(edit, 'hero-copy')} placeholder="Short intro copy" multiline rows={4} />
          <Field label="Primary CTA" value={hero.primary?.props?.text} onChange={editText(edit, 'hero-primary-cta')} placeholder="Get Started" />
          <Field label="Support note" value={hero.note?.props?.text} onChange={editText(edit, 'hero-note')} placeholder="Small helper note" multiline rows={2} />
          <ImageField label="Hero image" value={hero.image?.props?.src} onChange={(value) => edit('hero-image', (block) => ({ ...block, props: { ...block.props, src: value } }))} />
        </SectionEditor>

        <SectionEditor title="Event details" eyebrow="Section 3">
          <div style={{ display: 'grid', gap: '0.75rem' }}>
            <Field label="Date label" value={details.dateLabel?.props?.text} onChange={editText(edit, 'detail-date-label')} placeholder="Date" />
            <Field label="Date value" value={details.dateValue?.props?.text} onChange={editText(edit, 'detail-date-value')} placeholder="15 August 2026" />
            <Field label="Time label" value={details.timeLabel?.props?.text} onChange={editText(edit, 'detail-time-label')} placeholder="Time" />
            <Field label="Time value" value={details.timeValue?.props?.text} onChange={editText(edit, 'detail-time-value')} placeholder="10:00 AM - 4:00 PM" />
            <Field label="Location label" value={details.locationLabel?.props?.text} onChange={editText(edit, 'detail-location-label')} placeholder="Location" />
            <Field label="Location value" value={details.locationValue?.props?.text} onChange={editText(edit, 'detail-location-value')} placeholder="Koramangala, Bengaluru" />
            <Field label="Audience label" value={details.audienceLabel?.props?.text} onChange={editText(edit, 'detail-audience-label')} placeholder="For" />
            <Field label="Audience value" value={details.audienceValue?.props?.text} onChange={editText(edit, 'detail-audience-value')} placeholder="Audience segment" />
          </div>
        </SectionEditor>

        <SectionEditor title="Benefits and proof" eyebrow="Section 4">
          <Field label="Kicker" value={benefits.kicker?.props?.text} onChange={editText(edit, 'benefits-kicker')} placeholder="WHY CHOOSE THIS PAGE?" />
          <Field label="Title" value={benefits.title?.props?.text} onChange={editText(edit, 'benefits-title')} placeholder="A clear page can improve enquiries." />
          <Field label="Copy" value={benefits.copy?.props?.text} onChange={editText(edit, 'benefits-copy')} placeholder="A short professional paragraph tailored to the campaign" multiline rows={3} />
          {benefits.cards.map((card, index) => (
            <Card key={`benefit-${index}`} title={`Benefit card ${index + 1}`} eyebrow={`Card ${index + 1}`}>
              <Field label="Icon" value={card.icon?.props?.text} onChange={editText(edit, `benefit-${index + 1}-icon`)} placeholder="+" />
              <Field label="Title" value={card.title?.props?.text} onChange={editText(edit, `benefit-${index + 1}-title`)} placeholder="Card title" />
              <Field label="Body" value={card.body?.props?.text} onChange={editText(edit, `benefit-${index + 1}-body`)} placeholder="Card copy" multiline rows={3} />
            </Card>
          ))}
        </SectionEditor>

        <SectionEditor title="Eligibility and process" eyebrow="Section 5">
          <Field label="Eligibility title" value={process.eligibilityTitle?.props?.text} onChange={editText(edit, 'eligibility-title')} placeholder="Am I eligible?" />
          <Field label="Eligibility copy" value={process.eligibilityCopy?.props?.text} onChange={editText(edit, 'eligibility-copy')} placeholder="Eligibility explanation" multiline rows={3} />
          <Field label="Eligibility list" value={process.eligibilityList?.props?.text} onChange={editText(edit, 'eligibility-list')} placeholder="- Age between..." multiline rows={4} />
          <Field label="Eligibility CTA" value={process.eligibilityCta?.props?.text} onChange={editText(edit, 'eligibility-cta')} placeholder="Know More" />
          <Field label="Process title" value={process.processTitle?.props?.text} onChange={editText(edit, 'process-title')} placeholder="How it works" />
          <Field label="Process copy" value={process.processCopy?.props?.text} onChange={editText(edit, 'process-copy')} placeholder="Process explanation" multiline rows={3} />
          {process.steps.map((step, index) => (
            <Card key={`step-${index}`} title={`Step ${index + 1}`} eyebrow={`Step ${index + 1}`}>
              <Field label="Number" value={step.number?.props?.text} onChange={editText(edit, `step-${index + 1}-number`)} placeholder="1" />
              <Field label="Title" value={step.title?.props?.text} onChange={editText(edit, `step-${index + 1}-title`)} placeholder="Register" />
              <Field label="Body" value={step.body?.props?.text} onChange={editText(edit, `step-${index + 1}-body`)} placeholder="Step copy" multiline rows={3} />
            </Card>
          ))}
        </SectionEditor>

        <SectionEditor title="Impact band" eyebrow="Section 6">
          <Field label="Kicker" value={impact.kicker?.props?.text} onChange={editText(edit, 'impact-kicker')} placeholder="OUR IMPACT" />
          <Field label="Title" value={impact.title?.props?.text} onChange={editText(edit, 'impact-title')} placeholder="Together, we are making a difference." />
          <Field label="Copy" value={impact.copy?.props?.text} onChange={editText(edit, 'impact-copy')} placeholder="Impact copy" multiline rows={3} />
          {impact.metrics.map((metric, index) => (
            <Card key={`metric-${index}`} title={`Metric ${index + 1}`} eyebrow={`Metric ${index + 1}`}>
              <Field label="Value" value={metric.value?.props?.text} onChange={editText(edit, `metric-${index + 1}-value`)} placeholder="12,500+" />
              <Field label="Label" value={metric.label?.props?.text} onChange={editText(edit, `metric-${index + 1}-label`)} placeholder="Campaign result" />
            </Card>
          ))}
        </SectionEditor>

        <SectionEditor title="Call to action" eyebrow="Section 7">
          <Field label="Title" value={cta.title?.props?.text} onChange={editText(edit, 'cta-title')} placeholder="Ready to make a difference?" />
          <Field label="Copy" value={cta.copy?.props?.text} onChange={editText(edit, 'cta-copy')} placeholder="CTA copy" multiline rows={3} />
          <Field label="Note" value={cta.note?.props?.text} onChange={editText(edit, 'cta-note')} placeholder="CTA note" multiline rows={2} />
          <Field label="Button text" value={cta.button?.props?.text} onChange={editText(edit, 'cta-button')} placeholder="Get Started" />
        </SectionEditor>

        <SectionEditor title="Lead capture" eyebrow="Section 8">
          <Field label="Form title" value={form?.props?.title} onChange={(value) => edit('lead-form', (block) => ({ ...block, props: { ...block.props, title: value } }))} placeholder="Request a Consultation" />
          <Field label="Submit text" value={form?.props?.submitText} onChange={(value) => edit('lead-form', (block) => ({ ...block, props: { ...block.props, submitText: value } }))} placeholder="Get Started" />
          <Field label="Thank-you message" value={form?.props?.thankYouMessage} onChange={(value) => edit('lead-form', (block) => ({ ...block, props: { ...block.props, thankYouMessage: value } }))} multiline rows={3} />
          <FieldList fields={form?.props?.fields || []} onChange={(fields) => edit('lead-form', (block) => ({ ...block, props: { ...block.props, fields } }))} />
        </SectionEditor>

        <SectionEditor title="Footer" eyebrow="Section 9">
          <Field label="Brand mark" value={footer.brandMark?.props?.text} onChange={editText(edit, 'footer-brand-mark')} placeholder="+" />
          <Field label="Brand name" value={footer.brandName?.props?.text} onChange={editText(edit, 'footer-brand-name')} placeholder="Enhance Wellness Initiative" />
          <Field label="Links" value={footer.links?.props?.text} onChange={editText(edit, 'footer-links')} placeholder="Home | Events | About Us | Donate | Contact" />
          <Field label="Contact details" value={footer.contact?.props?.text} onChange={editText(edit, 'footer-contact')} placeholder="Phone, email, location" multiline rows={3} />
          <Field label="Copyright" value={footer.copy?.props?.text} onChange={editText(edit, 'footer-copy')} placeholder="(c) 2026 ..." />
        </SectionEditor>
      </div>

      <aside style={{ position: 'sticky', top: 16, minWidth: 0 }}>
        <SectionOrder sections={sections} onMove={move} />
        <Card title="Page info" eyebrow="Status">
          <div style={{ fontSize: '0.88rem', color: 'var(--text-secondary)', lineHeight: 1.7 }}>
            <div><strong>Title:</strong> {page?.title || 'Untitled'}</div>
            <div><strong>Slug:</strong> {page?.slug || '-'}</div>
            <div><strong>Status:</strong> {page?.status || '-'}</div>
            <div><strong>Sections:</strong> {sections.length}</div>
          </div>
        </Card>
        <Card title="Tips" eyebrow="Workflow">
          <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: '0.88rem', lineHeight: 1.6 }}>
            Edit the copy in the cards above, reorder sections from the right rail, then save from the main builder.
          </p>
        </Card>
      </aside>
    </div>
  );
}


