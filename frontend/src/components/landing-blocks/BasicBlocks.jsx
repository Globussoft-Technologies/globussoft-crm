/**
 * BasicBlocks.jsx — Core block components (heading, text, image, button, form, etc.)
 * Used by block-array and travel_destination landing pages.
 */

import React, { useState, useRef, useEffect } from 'react';
import {
  BarChart3,
  CalendarDays,
  ClipboardList,
  Clock3,
  Eye,
  FileText,
  Leaf,
  Mail,
  MapPin,
  Sparkles,
  UserRound,
  UsersRound,
} from 'lucide-react';
import { escapeHtml, safeUrl, normalizeVideoEmbedUrl, isDirectVideoFile } from '../../utils/landingPageUtils';

const WELLNESS_ICON_COMPONENTS = {
  barChart: BarChart3,
  calendar: CalendarDays,
  clipboard: ClipboardList,
  clock: Clock3,
  document: FileText,
  eye: Eye,
  leaf: Leaf,
  mail: Mail,
  location: MapPin,
  person: UserRound,
  sparkles: Sparkles,
  users: UsersRound,
};

const WELLNESS_SYMBOL_ICONS = {
  '+': 'eye',
  o: 'person',
  ':)': 'users',
  '#': 'document',
};

const WELLNESS_DETAIL_ICONS = {
  date: 'calendar',
  time: 'clock',
  location: 'location',
  for: 'users',
};

function isWellnessServiceInterestField(field) {
  const name = String(field?.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const label = String(field?.label || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return ['serviceinterest', 'service', 'treatmentofinterest'].includes(name)
    || label === 'serviceofinterest';
}

function getWellnessFormFields(props = {}) {
  const fields = Array.isArray(props.fields) ? props.fields : [];
  if (props.variant !== 'wellness-consultation') return fields;
  return fields.filter((field) => !isWellnessServiceInterestField(field));
}

const WELLNESS_NAV_TARGETS = {
  home: 'wellness-home',
  services: 'wellness-services',
  service: 'wellness-services',
  about: 'wellness-about',
  'about us': 'wellness-about',
  contact: 'wellness-contact',
};

function getWellnessNavItems(value) {
  const text = String(value || '').trim();
  const tokens = text
    .split(/\s{2,}|\s*\|\s*|\s*[·•]\s*|\s*,\s*/)
    .map((item) => item.trim())
    .filter(Boolean);
  const items = tokens.length > 1 ? tokens : ['Home', 'Services', 'About Us', 'Contact']
    .filter((label) => new RegExp(`\\b${label.replace(/\s+/g, '\\s+')}\\b`, 'i').test(text));
  return (items.length ? items : ['Home', 'Services', 'About Us', 'Contact']).map((label) => ({
    label,
    target: WELLNESS_NAV_TARGETS[label.toLowerCase()] || '',
  }));
}

export function WellnessNav({ text = '', align = 'right', color = 'var(--wellness-muted, #63766b)', fontSize = '0.82rem' }) {
  return (
    <nav
      className="landing-text landing-text--wellness-nav wellness-nav"
      aria-label="Wellness campaign navigation"
      style={{ color, textAlign: align, fontSize }}
    >
      {getWellnessNavItems(text).map((item) => (
        item.target
          ? <a key={`${item.label}-${item.target}`} href={`#${item.target}`}>{item.label}</a>
          : <span key={item.label}>{item.label}</span>
      ))}
    </nav>
  );
}

export function getWellnessIconName(props = {}) {
  const variant = props.variant || '';
  const text = String(props.text || '').trim();
  if (props.icon && WELLNESS_ICON_COMPONENTS[props.icon]) return props.icon;
  if (variant === 'wellness-badge') return WELLNESS_SYMBOL_ICONS[text] || '';
  if (variant === 'wellness-detail-label') {
    const detailText = text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (WELLNESS_DETAIL_ICONS[detailText]) return WELLNESS_DETAIL_ICONS[detailText];
    if (detailText.includes('date')) return 'calendar';
    if (detailText.includes('time')) return 'clock';
    if (detailText.includes('location') || detailText.includes('venue')) return 'location';
    if (detailText === 'for' || detailText.includes('audience') || detailText.includes('attend')) return 'users';
  }
  if (variant === 'wellness-logo-mark' && text === '+') return 'leaf';
  return '';
}

export function WellnessIcon({ name, size = 20, strokeWidth = 2, ...props }) {
  const Icon = WELLNESS_ICON_COMPONENTS[name] || Sparkles;
  return <Icon aria-hidden="true" size={size} strokeWidth={strokeWidth} {...props} />;
}

export function HeadingBlock({ props = {} }) {
  const level = props.level || 'h1';
  const align = props.align || 'left';
  const color = props.color || '#1a1a1a';
  const text = props.text || '';
  const variant = props.variant || '';
  const HeadingTag = level;
  const wellnessInk = variant === 'wellness-metric-value' || variant === 'wellness-band-title' || variant.startsWith('wellness-footer')
    ? 'var(--wellness-inverse, #ffffff)'
    : variant === 'wellness-hero-accent'
      ? 'var(--wellness-primary, #2f6b50)'
      : 'var(--wellness-ink, #173b35)';
  

  const variantStyle = variant === 'wellness-logo'
    ? { fontSize: '0.92rem', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 800, margin: '0' }
    : variant === 'wellness-display'
      ? { fontSize: 'clamp(2rem, 5vw, 3.4rem)', lineHeight: 1.05, fontWeight: 800, margin: '0 0 16px 0' }
      : variant === 'wellness-section-title' || variant === 'wellness-card-title'
        ? { fontSize: variant === 'wellness-card-title' ? '1.25rem' : '1.35rem', fontWeight: 800, margin: '0 0 10px 0' }
        : variant === 'wellness-metric-value'
          ? { fontSize: 'clamp(1.15rem, 1.4vw, 1.85rem)', lineHeight: 1.08, fontWeight: 900, margin: '0 0 8px', textShadow: '0 2px 16px rgba(0,0,0,0.28)' }
        : {};

  return (
    <HeadingTag
      className={variant ? `landing-heading landing-heading--${variant}` : undefined}
      style={{
        color: variant.startsWith('wellness-') ? wellnessInk : color,
        textAlign: align,
        margin: '0 0 16px 0',
        ...variantStyle,
      }}
    >
      {text}
    </HeadingTag>
  );
}

export function TextBlock({ props = {} }) {
  const align = props.align || 'left';
  const color = props.color || '#444';
  const fontSize = props.fontSize || '16px';
  const text = props.text || '';
  const variant = props.variant || '';
  const iconName = getWellnessIconName(props);
  if (variant === 'wellness-logo-mark' && String(text).trim() === '+' && !iconName) return null;

  if (variant === 'wellness-nav') {
    return <WellnessNav text={text} align={align} color="var(--wellness-muted, #63766b)" fontSize={fontSize} />;
  }

  const variantStyle = variant === 'wellness-nav'
    ? { textTransform: 'uppercase', letterSpacing: '0.16em', fontWeight: 700, margin: 0, lineHeight: 1.4 }
    : variant === 'wellness-eyebrow'
      ? { textTransform: 'uppercase', letterSpacing: '0.14em', fontWeight: 700, margin: '0 0 14px' }
      : variant === 'wellness-detail'
        ? { margin: '0 0 10px', lineHeight: 1.45 }
        : variant === 'wellness-detail-label'
          ? { margin: '0 0 6px', lineHeight: 1.25 }
        : variant === 'wellness-metric-label'
          ? { margin: 0, color: '#fff4ef', fontWeight: 700, lineHeight: 1.35, maxWidth: '100%', minWidth: 0, overflowWrap: 'anywhere' }
        : variant === 'wellness-footer'
          ? { margin: 0, padding: '22px 24px', background: '#202a27', color: '#ffffff', textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 700 }
          : {};

  const style = {
    color: variant === 'wellness-eyebrow' || variant === 'wellness-badge'
      ? 'var(--wellness-primary, #2f6b50)'
      : variant === 'wellness-metric-label' || variant === 'wellness-band-copy' || variant.startsWith('wellness-footer')
        ? 'var(--wellness-inverse, #ffffff)'
        : variant.startsWith('wellness-')
          ? 'var(--wellness-muted, #63766b)'
          : color,
    textAlign: align,
    fontSize,
    lineHeight: '1.6',
    margin: '0 0 16px 0',
    ...variantStyle,
  };

  if (iconName && (variant === 'wellness-badge' || variant === 'wellness-logo-mark')) {
    return (
      <span
        className={variant ? `landing-text landing-text--${variant}` : undefined}
        style={style}
        aria-label={variant === 'wellness-badge' ? 'Wellness benefit' : 'Wellness brand'}
      >
        <WellnessIcon name={iconName} size={variant === 'wellness-logo-mark' ? 24 : 20} />
      </span>
    );
  }

  const content = iconName && variant === 'wellness-detail-label'
    ? (
      <span className="wellness-detail-label-content">
        <span className="wellness-detail-icon"><WellnessIcon name={iconName} size={18} /></span>
        <span>{text}</span>
      </span>
    )
    : text;

  return (
    <p className={variant ? `landing-text landing-text--${variant}` : undefined} style={style}>
      {content}
    </p>
  );
}

export function ImageBlock({ props = {} }) {
  const width = props.width || '100%';
  const alt = props.alt || '';
  const src = safeUrl(props.src, 'image-src');
  const variant = props.variant || '';
  const isWellnessEventImage = variant === 'wellness-event-image';
  const isWellnessHeroImage = variant === 'wellness-hero-image';
  const isWellnessGalleryImage = variant === 'wellness-gallery-image';
  const isWellnessCtaImage = variant === 'wellness-cta-image';
  const maxWidth = isWellnessEventImage ? '100%' : (props.maxWidth || '100%');

  if (isWellnessHeroImage || isWellnessGalleryImage || isWellnessCtaImage) {
    const mediaClass = isWellnessHeroImage ? 'wellness-media--hero' : isWellnessGalleryImage ? 'wellness-media--gallery' : 'wellness-media--cta';
    return (
      <figure className={`wellness-media ${mediaClass}`}>
        {src ? <img src={src} alt={alt} /> : <span className="wellness-media-placeholder">{isWellnessHeroImage ? 'Wellness campaign' : isWellnessGalleryImage ? 'Your campaign story' : 'Wellness experience'}</span>}
      </figure>
    );
  }

  return (
    <div style={{ textAlign: 'center', margin: isWellnessEventImage ? '0' : '0 0 20px 0' }}>
      <img
        src={src}
        alt={alt}
        style={{
          width: isWellnessEventImage ? '100%' : width,
          maxWidth,
          height: isWellnessEventImage ? '360px' : 'auto',
          objectFit: isWellnessEventImage ? 'cover' : undefined,
          display: 'block',
          margin: '0 auto',
          borderRadius: isWellnessEventImage ? '18px' : '24px',
          boxShadow: isWellnessEventImage ? '0 18px 45px rgba(31, 47, 44, 0.12)' : '0 24px 60px rgba(15, 23, 42, 0.10)',
          border: isWellnessEventImage ? '1px solid #d8d2c3' : '1px solid rgba(148, 163, 184, 0.15)',
          background: '#f4f1e8',
        }}
      />
    </div>
  );
}

export function ButtonBlock({ props = {} }) {
  const color = props.color || '#ffffff';
  const bgColor = props.bgColor || '#2563eb';
  const align = props.align || 'center';
  const size = props.size || 'medium';
  const text = props.text || 'Click';
  const isWellnessCta = ['#b31d15', '#fff8f7'].includes(String(bgColor).toLowerCase()) || String(props.url || '').startsWith('#event-details');
  const url = safeUrl(isWellnessCta ? '#lead-form' : props.url, 'link-href');

  const padding =
    size === 'large' ? '16px 40px' : size === 'small' ? '8px 20px' : '12px 32px';
  const fontSize =
    size === 'large' ? '18px' : size === 'small' ? '13px' : '15px';

  return (
    <div style={{ textAlign: align, margin: isWellnessCta ? 0 : '0 0 20px 0' }}>
      <a
        href={url}
        style={{
          display: 'inline-block',
          padding,
          background: `linear-gradient(135deg, ${bgColor}, ${bgColor})`,
          color,
          textDecoration: 'none',
          borderRadius: '999px',
          fontSize,
          fontWeight: '700',
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
          cursor: 'pointer',
          boxShadow: '0 14px 28px rgba(15, 23, 42, 0.12)',
        }}
      >
        {text}
      </a>
    </div>
  );
}

export function FormBlock({ props = {}, slug = '', pageId = null, submitEndpoint = '' }) {
  const fields = getWellnessFormFields(props);
  const submitText = props.submitText || 'Submit';
  const thankYouMessage = props.thankYouMessage || 'Thank you for your submission!';
  const enableCaptcha = !!props.enableCaptcha;
  const successRedirectUrl = props.successRedirectUrl || '';
  const formTitle = props.title || '';
  const formVariant = props.variant || '';

  const [formData, setFormData] = useState({});
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState('');
  const formId = `form_${Math.random().toString(36).substr(2, 8)}`;
  const domFormId = formVariant === 'wellness-consultation' ? 'lead-form' : formId;

  const handleChange = (e) => {
    setFormData({
      ...formData,
      [e.target.name]: e.target.value,
    });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    if (enableCaptcha && !turnstileToken) {
      setError('Please complete the CAPTCHA challenge.');
      return;
    }

    setLoading(true);
    setError('');

    const data = { ...formData };
    if (enableCaptcha) {
      data.cfTurnstileToken = turnstileToken;
    }

    try {
      const endpoint = submitEndpoint || (pageId
        ? `/api/landing-pages/${pageId}/submit`
        : `/p/${slug}/submit`);

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });

      const result = await response.json();

      if (result.error) {
        setError(result.error);
        setLoading(false);
        return;
      }

      // Check for redirect URL from backend response OR from form props
      const redirectUrl = result.successRedirectUrl || successRedirectUrl;
      if (redirectUrl) {
        try {
          const u = new URL(redirectUrl);
          if (u.protocol === 'http:' || u.protocol === 'https:') {
            window.location.assign(redirectUrl);
            return;
          }
        } catch (_e) {
          // Fall through to thank-you message if URL is invalid
        }
      }

      setSubmitted(true);
      setFormData({});
      setLoading(false);
    } catch (err) {
      setError('Something went wrong. Please try again.');
      setLoading(false);
    }
  };

  if (submitted) {
    return (
      <div
        style={{
          maxWidth: '480px',
          margin: '0 auto 16px',
          padding: '24px',
          backgroundColor: '#f0fdf4',
          borderRadius: '10px',
          border: '1px solid #dcfce7',
          textAlign: 'center',
          color: '#16a34a',
          fontWeight: '500',
        }}
      >
        {thankYouMessage}
      </div>
    );
  }

  const turnstileSiteKey =
    props.turnstileSiteKey || import.meta.env.VITE_TURNSTILE_SITE_KEY || '1x00000000000000000000AA';

  return (
    <>
      {enableCaptcha && (
        <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer />
      )}
      <form
        id={domFormId}
        onSubmit={handleSubmit}
        style={{
          width: '100%',
          maxWidth: formVariant === 'wellness-consultation' ? '100%' : '480px',
          margin: formVariant === 'wellness-consultation' ? '0 0 20px' : '0 auto 20px',
          padding: formVariant === 'wellness-consultation' ? '36px' : '28px',
          background: formVariant === 'wellness-consultation' ? 'var(--wellness-surface, #ffffff)' : 'linear-gradient(180deg, #fffdf8 0%, #faf7ef 100%)',
          borderRadius: formVariant === 'wellness-consultation' ? '18px' : '24px',
          border: formVariant === 'wellness-consultation' ? '1px solid var(--wellness-border, #cfe3d9)' : '1px solid rgba(148, 163, 184, 0.22)',
          borderTop: formVariant === 'wellness-consultation' ? '2px solid var(--wellness-primary, #1f8a70)' : undefined,
          boxShadow: formVariant === 'wellness-consultation' ? '0 18px 55px rgba(31, 47, 44, 0.08)' : '0 24px 80px rgba(15, 23, 42, 0.10)',
          boxSizing: 'border-box',
        }}
      >
        {formTitle && (
          <h2 style={{ margin: '0 0 28px', color: 'var(--wellness-ink, #173b35)', fontFamily: "Georgia, 'Times New Roman', serif", fontSize: '1.75rem', fontWeight: 500 }}>
            {formTitle}
          </h2>
        )}

        <div style={{ display: formVariant === 'wellness-consultation' ? 'flex' : 'block', flexWrap: 'wrap', gap: formVariant === 'wellness-consultation' ? '0 16px' : 0 }}>
        {fields.map((field, index) => {
          const fieldId = `${formId}_${field.name}`;
          const fieldType = field.type || 'text';
          const controlStyle = {
            width: '100%',
            padding: formVariant === 'wellness-consultation' ? '14px 16px' : '10px 12px',
            border: formVariant === 'wellness-consultation' ? '1px solid var(--wellness-border, #d7e2d0)' : '1px solid #d1d5db',
            borderRadius: formVariant === 'wellness-consultation' ? '10px' : '6px',
            fontSize: '15px',
            boxSizing: 'border-box',
            background: formVariant === 'wellness-consultation' ? 'var(--wellness-bg, #f7fbf4)' : '#ffffff',
            backgroundColor: formVariant === 'wellness-consultation' ? 'var(--wellness-bg, #f7fbf4)' : '#ffffff',
            backgroundImage: 'none',
            color: 'var(--wellness-ink, #173b2c)',
            opacity: 1,
            colorScheme: 'light',
            WebkitTextFillColor: 'var(--wellness-ink, #173b2c)',
            appearance: fieldType === 'select' ? 'auto' : undefined,
            boxShadow: formVariant === 'wellness-consultation' ? 'none' : 'inset 0 0 0 9999px #fffdf7',
          };
          const isHalfWidth = formVariant === 'wellness-consultation' && index < 2;
          return (
            <div key={field.name} style={{ marginBottom: formVariant === 'wellness-consultation' ? '18px' : '12px', flex: isHalfWidth ? '1 1 calc(50% - 8px)' : '1 1 100%', minWidth: isHalfWidth ? '0' : '100%', boxSizing: 'border-box' }}>
              <label
                htmlFor={fieldId}
                style={{
                  display: 'block',
                  marginBottom: formVariant === 'wellness-consultation' ? '8px' : '4px',
                  fontWeight: '600',
                  color: formVariant === 'wellness-consultation' ? 'var(--wellness-muted, #63766b)' : '#333',
                  fontSize: formVariant === 'wellness-consultation' ? '12px' : '14px',
                  letterSpacing: formVariant === 'wellness-consultation' ? '0.12em' : 0,
                  textTransform: formVariant === 'wellness-consultation' ? 'uppercase' : 'none',
                }}
              >
                {field.label || field.name}{field.required && formVariant === 'wellness-consultation' ? ' *' : ''}
              </label>
              {fieldType === 'textarea' ? (
                <textarea
                  className={formVariant === 'wellness-consultation' ? 'wellness-form-control' : undefined}
                  id={fieldId}
                  name={field.name}
                  value={formData[field.name] || ''}
                  onChange={handleChange}
                  required={field.required}
                  placeholder={field.placeholder || ''}
                  rows={4}
                  style={{ ...controlStyle, resize: 'vertical', minHeight: '98px' }}
                />
              ) : fieldType === 'select' ? (
                <select
                  className={formVariant === 'wellness-consultation' ? 'wellness-form-control' : undefined}
                  id={fieldId}
                  name={field.name}
                  value={formData[field.name] || ''}
                  onChange={handleChange}
                  required={field.required}
                  style={controlStyle}
                >
                  {(field.options || []).map((option) => (
                    <option key={String(option)} value={String(option)}>{String(option)}</option>
                  ))}
                </select>
              ) : (
                <input
                  className={formVariant === 'wellness-consultation' ? 'wellness-form-control' : undefined}
                  id={fieldId}
                  type={fieldType}
                  name={field.name}
                  value={formData[field.name] || ''}
                  onChange={handleChange}
                  required={field.required}
                  placeholder={field.placeholder || ''}
                  style={controlStyle}
                />
              )}
            </div>
          );
        })}
        </div>

        {enableCaptcha && (
          <div style={{ margin: '0 0 12px 0' }}>
            <div
              className="cf-turnstile"
              data-sitekey={turnstileSiteKey}
              data-callback={`${formId}_onTurnstile`}
            />
          </div>
        )}

        {error && (
          <div style={{ color: '#dc2626', marginBottom: '12px', fontSize: '14px' }}>
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={loading}
          style={{
            width: '100%',
            padding: formVariant === 'wellness-consultation' ? '16px' : '12px',
            background: formVariant === 'wellness-consultation' ? 'linear-gradient(135deg, var(--wellness-primary, #1f8a70), var(--wellness-primary-deep, #126052))' : '#2563eb',
            color: '#fff',
            border: 'none',
            borderRadius: formVariant === 'wellness-consultation' ? '999px' : '6px',
            fontSize: '15px',
            fontWeight: '700',
            letterSpacing: formVariant === 'wellness-consultation' ? '0.1em' : 0,
            textTransform: formVariant === 'wellness-consultation' ? 'uppercase' : 'none',
            cursor: loading ? 'not-allowed' : 'pointer',
            opacity: loading ? 0.6 : 1,
          }}
        >
          {loading ? 'Submitting...' : submitText}
        </button>
      </form>
      {enableCaptcha && (
        <script>
          {`window.${formId}_onTurnstile = function(token) { window.__turnstileToken_${formId} = token; }`}
        </script>
      )}
    </>
  );
}

export function DividerBlock({ props = {} }) {
  const color = props.color || '#e5e7eb';
  const margin = props.margin || '24px';

  return (
    <hr
      style={{
        border: 'none',
        borderTop: `1px solid ${color}`,
        margin: `${margin} 0`,
      }}
    />
  );
}

export function SpacerBlock({ props = {} }) {
  const height = props.height || '32px';
  return <div style={{ height }} />;
}

export function VideoBlock({ props = {} }) {
  const width = props.width || '100%';
  const url = props.url || '';

  const normalized = normalizeVideoEmbedUrl(url);
  const isVideoFile = isDirectVideoFile(normalized);
  const safeVideoUrl = safeUrl(normalized, 'iframe-src');

  if (isVideoFile) {
    return (
      <div style={{ textAlign: 'center', margin: '0 0 16px 0' }}>
        <video
          controls
          preload="metadata"
          src={safeVideoUrl}
          style={{
            width,
            maxWidth: '100%',
            borderRadius: '8px',
          }}
        />
      </div>
    );
  }

  return (
    <div style={{ textAlign: 'center', margin: '0 0 16px 0' }}>
      <iframe
        title="Embedded video"
        src={safeVideoUrl}
        style={{
          width,
          maxWidth: '100%',
          aspectRatio: '16 / 9',
          border: 'none',
          borderRadius: '8px',
        }}
        allowFullScreen
      />
    </div>
  );
}

export function ColumnsBlock({ props = {}, renderBlock }) {
  const columns = props.columns || [];
  const gap = props.gap || '24px';
  const variant = props.variant || '';
  const isWellnessCampaignPage = variant === 'wellness-campaign-page';
  const isWellnessHeaderRow = variant === 'wellness-header-row';
  const isWellnessHeroRow = variant === 'wellness-hero-row';
  const isWellnessDetailsStrip = variant === 'wellness-details-strip';
  const isWellnessGalleryRow = variant === 'wellness-gallery-row';
  const isWellnessBenefitsRow = variant === 'wellness-benefits-row';
  const isWellnessProcessRow = variant === 'wellness-process-row';
  const isWellnessImpactBand = variant === 'wellness-impact-band';
  const isWellnessCtaRow = variant === 'wellness-cta-row';
  const isWellnessFormRow = variant === 'wellness-form-row';
  const isWellnessFooterRow = variant === 'wellness-footer-row';
  const isWellnessRegistrationRow = variant === 'wellness-registration-row';
  const isWellnessBenefitCards = variant === 'wellness-benefit-cards';
  const isWellnessBenefitGrid = variant === 'wellness-benefit-grid';
  const isWellnessStepGrid = variant === 'wellness-step-grid';
  const isWellnessMetricGrid = variant === 'wellness-metric-grid';
  const isWellnessConsultation = variant === 'wellness-consultation';
  const looksLikeWellnessSupporting = columns.some((col) => (col.components || []).some((child) => ['why-title', 'after-title'].includes(child.id)));
  const isWellnessSupporting = variant === 'wellness-supporting' || looksLikeWellnessSupporting;
  const isWellnessCardGrid = isWellnessBenefitGrid || isWellnessStepGrid || isWellnessMetricGrid;
  const isWellnessSection = isWellnessCampaignPage || isWellnessHeaderRow || isWellnessHeroRow || isWellnessDetailsStrip || isWellnessGalleryRow || isWellnessBenefitsRow || isWellnessProcessRow || isWellnessImpactBand || isWellnessCtaRow || isWellnessFormRow || isWellnessFooterRow || isWellnessRegistrationRow || isWellnessBenefitCards || isWellnessCardGrid || isWellnessConsultation || isWellnessSupporting;
  const isWellnessInnerRow = isWellnessHeaderRow || isWellnessHeroRow || isWellnessDetailsStrip || isWellnessGalleryRow || isWellnessBenefitsRow || isWellnessProcessRow || isWellnessCtaRow || isWellnessFormRow || isWellnessFooterRow || isWellnessRegistrationRow || isWellnessBenefitCards || isWellnessCardGrid;
  const hasFullWidthSupport = isWellnessConsultation && columns.some((col) => col.fullWidth);

  const baseContainerStyle = isWellnessCampaignPage ? {
    display: 'flex',
    flexWrap: 'wrap',
    gap,
    alignItems: 'stretch',
    width: '100%',
    maxWidth: 'none',
    minWidth: '0',
    margin: '0 auto',
    padding: 0,
    background: 'var(--wellness-bg, #f4fbf7)',
    color: 'var(--wellness-ink, #173b35)',
    borderRadius: 0,
    border: 'none',
    boxShadow: 'none',
    boxSizing: 'border-box',
    overflow: 'visible',
  } : {
    display: 'flex',
    flexWrap: 'wrap',
    gap,
    alignItems: (isWellnessHeaderRow || isWellnessFooterRow || isWellnessFormRow) ? 'center' : 'stretch',
    justifyContent: isWellnessHeaderRow ? 'space-between' : ((isWellnessFooterRow || isWellnessFormRow) ? 'center' : 'flex-start'),
    width: isWellnessDetailsStrip ? 'calc(100% - 112px)' : '100%',
    maxWidth: isWellnessSection ? '100%' : undefined,
    margin: isWellnessDetailsStrip ? '0 56px 34px' : isWellnessInnerRow ? 0 : (isWellnessConsultation && !hasFullWidthSupport ? '0 auto 0' : (isWellnessSection ? '0 auto 24px' : '0 0 20px 0')),
    padding: isWellnessHeaderRow ? '28px 56px' : isWellnessHeroRow ? '64px 56px 58px' : isWellnessDetailsStrip ? '22px 24px' : isWellnessGalleryRow ? '18px 56px 36px' : isWellnessBenefitsRow ? '34px 56px 32px' : isWellnessProcessRow ? '28px 56px 36px' : isWellnessImpactBand ? '32px 56px' : isWellnessCtaRow ? '28px 56px' : isWellnessFormRow ? '72px 56px 76px' : isWellnessFooterRow ? '40px 56px' : isWellnessRegistrationRow ? '28px 64px 56px' : (isWellnessBenefitCards || isWellnessCardGrid) ? '0' : (isWellnessSection ? (isWellnessConsultation ? '36px' : '0 56px 36px') : '0'),
    background: isWellnessImpactBand ? 'linear-gradient(90deg, var(--wellness-primary-deep, #126052) 0%, var(--wellness-primary, #1f8a70) 100%)' : isWellnessMetricGrid ? 'transparent' : isWellnessFormRow ? 'var(--wellness-surface-soft, #e8f4ee)' : isWellnessFooterRow ? 'var(--wellness-surface, #ffffff)' : (isWellnessHeaderRow ? 'var(--wellness-surface, #ffffff)' : (isWellnessInnerRow || isWellnessConsultation || isWellnessSupporting ? 'var(--wellness-bg, #f4fbf7)' : 'transparent')),
    color: isWellnessImpactBand ? '#ffffff' : (isWellnessSection ? 'var(--wellness-ink, #173b35)' : 'inherit'),
    borderRadius: isWellnessHeaderRow ? 0 : isWellnessDetailsStrip ? '16px' : (isWellnessImpactBand ? 0 : isWellnessConsultation ? (hasFullWidthSupport ? '18px' : '18px 18px 0 0') : (isWellnessSupporting ? '0 0 18px 18px' : 0)),
    border: isWellnessDetailsStrip ? '1px solid var(--wellness-border, #cfe3d9)' : 'none',
    borderTop: isWellnessFooterRow ? '1px solid var(--wellness-border, #cfe3d9)' : 'none',
    borderBottom: isWellnessHeaderRow ? '1px solid var(--wellness-border, #cfe3d9)' : 'none',
    boxShadow: isWellnessDetailsStrip ? '0 18px 45px rgba(31, 47, 44, 0.08)' : (isWellnessImpactBand ? 'inset 0 1px 0 rgba(255,255,255,0.18)' : 'none'),
    boxSizing: 'border-box',
    overflow: 'visible',
  };
  const containerStyle = isWellnessCardGrid
    ? {
      ...baseContainerStyle,
      display: 'grid',
      gridTemplateColumns: isWellnessMetricGrid ? 'repeat(4, minmax(0, 1fr))' : 'repeat(4, minmax(0, 1fr))',
      gap: '16px',
      width: '100%',
      maxWidth: '100%',
      margin: 0,
      padding: 0,
      alignItems: 'stretch',
      background: 'transparent',
      border: 'none',
      borderRadius: 0,
      boxShadow: 'none',
    }
    : baseContainerStyle;

  const columnStyle = (col, idx) => {
    let flex = col.fullWidth ? '1 1 100%' : '1 1 0';
    if (isWellnessHeaderRow) flex = idx === 0 ? '0 0 360px' : '1 1 auto';
    if (isWellnessHeroRow) flex = idx === 1 ? '0 1 560px' : '1 1 0';
    if (isWellnessDetailsStrip) flex = '1 1 0';
    if (isWellnessGalleryRow) flex = '1 1 0';
    if (isWellnessBenefitsRow) flex = idx === 0 ? '0 1 360px' : '1 1 0';
    if (isWellnessProcessRow) flex = idx === 0 ? '0 1 360px' : '1 1 0';
    if (isWellnessImpactBand) flex = idx === 0 ? '0 1 360px' : '1 1 0';
    if (isWellnessCtaRow) flex = idx === 0 ? '1 1 0' : '0 1 280px';
    if (isWellnessFormRow) flex = columns.length === 1 ? '0 1 560px' : (idx === 0 ? '0 1 520px' : '1 1 520px');
    if (isWellnessFooterRow) flex = '1 1 300px';
    if (isWellnessBenefitCards) flex = '1 1 100%';
    if (isWellnessCardGrid) flex = isWellnessMetricGrid ? '1 1 220px' : '1 1 0';
    if (isWellnessConsultation && idx === 1) flex = '0 1 480px';

    return {
      flex: isWellnessCardGrid ? 'none' : flex,
      minWidth: isWellnessCardGrid ? 0 : (col.fullWidth ? '100%' : (isWellnessHeaderRow ? (idx === 0 ? '280px' : '0') : isWellnessHeroRow ? (idx === 1 ? '420px' : '500px') : (isWellnessDetailsStrip || isWellnessGalleryRow) ? '0' : isWellnessBenefitsRow ? (idx === 0 ? '360px' : '360px') : isWellnessProcessRow ? (idx === 0 ? '360px' : '320px') : isWellnessImpactBand ? (idx === 0 ? '320px' : '220px') : isWellnessCardGrid ? '220px' : isWellnessFormRow ? (columns.length === 1 ? '420px' : (idx === 0 ? '420px' : '420px')) : isWellnessCtaRow ? (idx === 0 ? '320px' : '240px') : isWellnessRegistrationRow ? (idx === 0 ? '540px' : '360px') : isWellnessSection ? '240px' : '260px')),
      maxWidth: '100%',
      boxSizing: 'border-box',
      display: 'flex',
      flexDirection: (isWellnessHeaderRow && idx === 1) || isWellnessDetailsStrip ? 'row' : 'column',
      gap: isWellnessHeaderRow ? '28px' : isWellnessDetailsStrip ? 0 : isWellnessBenefitCards ? '10px' : '16px',
      width: isWellnessCardGrid ? '100%' : undefined,
      height: isWellnessCardGrid ? '100%' : undefined,
      padding: isWellnessDetailsStrip ? '30px 34px' : (isWellnessMetricGrid ? '28px 22px' : ((isWellnessBenefitCards || isWellnessCardGrid || isWellnessSupporting) ? '24px' : 0)),
      minHeight: isWellnessDetailsStrip ? '154px' : (isWellnessMetricGrid ? '132px' : undefined),
      background: isWellnessMetricGrid ? 'linear-gradient(180deg, var(--wellness-primary-deep, #126052), var(--wellness-primary, #1f8a70))' : ((isWellnessBenefitCards || isWellnessCardGrid || isWellnessSupporting) ? 'var(--wellness-surface, #ffffff)' : 'transparent'),
      border: isWellnessMetricGrid ? '1px solid rgba(255,255,255,0.36)' : ((isWellnessBenefitCards || isWellnessCardGrid || isWellnessSupporting) ? '1px solid var(--wellness-border, #cfe3d9)' : 'none'),
      borderRadius: (isWellnessBenefitCards || isWellnessCardGrid || isWellnessSupporting) ? '14px' : 0,
      boxShadow: isWellnessMetricGrid ? '0 18px 36px rgba(23,59,53,0.24)' : ((isWellnessBenefitCards || isWellnessCardGrid || isWellnessSupporting) ? '0 14px 35px rgba(23,59,53,0.07)' : 'none'),
      justifyContent: isWellnessHeaderRow && idx === 1 ? 'space-between' : (isWellnessImpactBand || isWellnessDetailsStrip ? 'center' : undefined),
      alignItems: isWellnessHeaderRow ? (idx === 0 ? 'flex-start' : 'center') : (isWellnessFooterRow ? (idx === 0 ? 'flex-start' : idx === columns.length - 1 ? 'flex-end' : 'center') : (isWellnessDetailsStrip || isWellnessMetricGrid || (isWellnessFormRow && columns.length === 1) ? 'center' : undefined)),
      textAlign: isWellnessHeaderRow ? (idx === 0 ? 'left' : 'right') : (isWellnessFooterRow ? (idx === 0 ? 'left' : idx === columns.length - 1 ? 'right' : 'center') : (isWellnessDetailsStrip ? 'left' : (isWellnessMetricGrid || (isWellnessFormRow && columns.length === 1) ? 'center' : undefined))),
      color: isWellnessMetricGrid ? '#ffffff' : undefined,
      overflowWrap: isWellnessDetailsStrip ? 'anywhere' : undefined,
    };
  };

  const wellnessVariantClass = variant.replace(/[^a-z0-9_-]/gi, '-').toLowerCase();
  const wellnessLayoutClass = isWellnessCampaignPage
    ? ` wellness-campaign--${String(props.layoutId || 'editorial').replace(/[^a-z0-9_-]/gi, '-').toLowerCase()}`
    : '';
  const wellnessClass = isWellnessCampaignPage
      ? `wellness-shell wellness-layout wellness-layout--${wellnessVariantClass}${wellnessLayoutClass}`
    : isWellnessSection
      ? `wellness-layout wellness-layout--${wellnessVariantClass}`
      : '';
  const wellnessAnchorId = isWellnessCampaignPage
    ? 'wellness-home'
    : isWellnessBenefitsRow
      ? 'wellness-services'
      : isWellnessProcessRow
        ? 'wellness-about'
        : isWellnessFormRow || isWellnessRegistrationRow
          ? 'wellness-contact'
          : undefined;
  return (
    <div id={wellnessAnchorId} className={wellnessClass} style={containerStyle}>
      {columns.map((col, idx) => (
        <div key={idx} style={columnStyle(col, idx)}>
          {col.components &&
            (isWellnessHeroRow
              ? (() => {
                const heroButtons = col.components.filter((child) => child?.type === 'button');
                const preferredHeroButton = heroButtons.find((buttonBlock) => buttonBlock.id === 'hero-primary-cta') || heroButtons[0];
                return heroButtons.length > 1
                  ? col.components.filter((child) => child?.type !== 'button' || child === preferredHeroButton)
                  : col.components;
              })()
              : col.components
            ).map((c, cidx) => (
              <div key={cidx}>{renderBlock ? renderBlock(c) : null}</div>
            ))}
        </div>
      ))}
    </div>
  );
}



