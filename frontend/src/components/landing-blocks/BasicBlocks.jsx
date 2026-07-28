/**
 * BasicBlocks.jsx — Core block components (heading, text, image, button, form, etc.)
 * Used by block-array and travel_destination landing pages.
 */

import React, { useState, useRef, useEffect } from 'react';
import { escapeHtml, safeUrl, normalizeVideoEmbedUrl, isDirectVideoFile } from '../../utils/landingPageUtils';

export function HeadingBlock({ props = {} }) {
  const level = props.level || 'h1';
  const align = props.align || 'left';
  const color = props.color || '#1a1a1a';
  const text = props.text || '';
  const variant = props.variant || '';
  const HeadingTag = level;

  const variantStyle = variant === 'wellness-logo'
    ? { fontSize: '0.92rem', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 700, margin: '0' }
    : variant === 'wellness-display'
      ? { fontSize: 'clamp(2rem, 5vw, 3.4rem)', lineHeight: 1.05, fontWeight: 800, margin: '0 0 16px 0' }
      : variant === 'wellness-section-title' || variant === 'wellness-card-title'
        ? { fontSize: variant === 'wellness-card-title' ? '1.25rem' : '1.35rem', fontWeight: 800, margin: '0 0 10px 0' }
        : {};

  return (
    <HeadingTag
      style={{
        color,
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

  const variantStyle = variant === 'wellness-nav'
    ? { textTransform: 'uppercase', letterSpacing: '0.16em', fontWeight: 700, margin: '10px 0 0' }
    : variant === 'wellness-eyebrow'
      ? { textTransform: 'uppercase', letterSpacing: '0.14em', fontWeight: 700, margin: '0 0 14px' }
      : variant === 'wellness-detail'
        ? { margin: '0 0 10px', lineHeight: 1.45 }
        : variant === 'wellness-footer'
          ? { margin: 0, padding: '22px 24px', background: '#202a27', color: '#ffffff', textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 700 }
          : {};

  return (
    <p
      style={{
        color,
        textAlign: align,
        fontSize,
        lineHeight: '1.6',
        margin: '0 0 16px 0',
        ...variantStyle,
      }}
    >
      {text}
    </p>
  );
}

export function ImageBlock({ props = {} }) {
  const width = props.width || '100%';
  const alt = props.alt || '';
  const src = safeUrl(props.src, 'image-src');
  const variant = props.variant || '';
  const isWellnessEventImage = variant === 'wellness-event-image';
  const maxWidth = isWellnessEventImage ? '100%' : (props.maxWidth || '100%');

  return (
    <div style={{ textAlign: 'center', margin: isWellnessEventImage ? '0' : '0 0 20px 0' }}>
      <img
        src={src}
        alt={alt}
        style={{
          width: isWellnessEventImage ? '100%' : width,
          maxWidth,
          height: isWellnessEventImage ? '310px' : 'auto',
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
  const url = safeUrl(props.url, 'link-href');

  const padding =
    size === 'large' ? '16px 40px' : size === 'small' ? '8px 20px' : '12px 32px';
  const fontSize =
    size === 'large' ? '18px' : size === 'small' ? '13px' : '15px';

  return (
    <div style={{ textAlign: align, margin: '0 0 20px 0' }}>
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
  const fields = props.fields || [];
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
        id={formId}
        onSubmit={handleSubmit}
        style={{
          width: '100%',
          maxWidth: formVariant === 'wellness-consultation' ? '100%' : '480px',
          margin: formVariant === 'wellness-consultation' ? '0 0 20px' : '0 auto 20px',
          padding: formVariant === 'wellness-consultation' ? '36px' : '28px',
          background: formVariant === 'wellness-consultation' ? '#fbfaf4' : 'linear-gradient(180deg, #fffdf8 0%, #faf7ef 100%)',
          borderRadius: formVariant === 'wellness-consultation' ? '18px' : '24px',
          border: formVariant === 'wellness-consultation' ? '1px solid #d8d2c3' : '1px solid rgba(148, 163, 184, 0.22)',
          borderTop: formVariant === 'wellness-consultation' ? '2px solid #7c6f45' : undefined,
          boxShadow: formVariant === 'wellness-consultation' ? '0 18px 55px rgba(31, 47, 44, 0.08)' : '0 24px 80px rgba(15, 23, 42, 0.10)',
          boxSizing: 'border-box',
        }}
      >
        {formTitle && (
          <h2 style={{ margin: '0 0 28px', color: '#1f2f2c', fontFamily: "Georgia, 'Times New Roman', serif", fontSize: '1.75rem', fontWeight: 500 }}>
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
            border: formVariant === 'wellness-consultation' ? '1px solid #c9c3b4' : '1px solid #d1d5db',
            borderRadius: formVariant === 'wellness-consultation' ? '8px' : '6px',
            fontSize: '15px',
            boxSizing: 'border-box',
            background: formVariant === 'wellness-consultation' ? '#fffdf7' : '#ffffff',
            backgroundColor: formVariant === 'wellness-consultation' ? '#fffdf7' : '#ffffff',
            backgroundImage: 'none',
            color: '#1f2937',
            opacity: 1,
            colorScheme: 'light',
            WebkitTextFillColor: '#1f2937',
            appearance: fieldType === 'select' ? 'auto' : undefined,
            boxShadow: 'inset 0 0 0 9999px #fffdf7',
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
                  color: formVariant === 'wellness-consultation' ? '#5e675f' : '#333',
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
            background: formVariant === 'wellness-consultation' ? 'linear-gradient(90deg, #b7ad8c, #d1a083)' : '#2563eb',
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
  const isWellnessRegistrationRow = variant === 'wellness-registration-row';
  const isWellnessBenefitCards = variant === 'wellness-benefit-cards';
  const isWellnessConsultation = variant === 'wellness-consultation';
  const looksLikeWellnessSupporting = columns.some((col) => (col.components || []).some((child) => ['why-title', 'after-title'].includes(child.id)));
  const isWellnessSupporting = variant === 'wellness-supporting' || looksLikeWellnessSupporting;
  const isWellnessSection = isWellnessCampaignPage || isWellnessHeaderRow || isWellnessHeroRow || isWellnessRegistrationRow || isWellnessBenefitCards || isWellnessConsultation || isWellnessSupporting;
  const isWellnessInnerRow = isWellnessHeaderRow || isWellnessHeroRow || isWellnessRegistrationRow || isWellnessBenefitCards;
  const hasFullWidthSupport = isWellnessConsultation && columns.some((col) => col.fullWidth);

  const containerStyle = isWellnessCampaignPage ? {
    display: 'flex',
    flexWrap: 'wrap',
    gap,
    alignItems: 'stretch',
    width: '1040px',
    maxWidth: '1040px',
    minWidth: '960px',
    margin: '0 auto 36px',
    padding: 0,
    background: '#fbfaf4',
    color: '#1f2f2c',
    borderRadius: '18px',
    border: '1px solid #d8d2c3',
    boxShadow: '0 28px 80px rgba(31, 47, 44, 0.14)',
    boxSizing: 'border-box',
    overflow: 'hidden',
  } : {
    display: 'flex',
    flexWrap: 'wrap',
    gap,
    alignItems: 'stretch',
    width: '100%',
    maxWidth: isWellnessSection ? '100%' : undefined,
    margin: isWellnessInnerRow ? 0 : (isWellnessConsultation && !hasFullWidthSupport ? '0 auto 0' : (isWellnessSection ? '0 auto 36px' : '0 0 20px 0')),
    padding: isWellnessHeaderRow ? '24px 56px 18px' : isWellnessHeroRow ? '30px 52px 22px' : isWellnessRegistrationRow ? '18px 56px 46px' : isWellnessBenefitCards ? 0 : (isWellnessSection ? (isWellnessConsultation ? '36px' : '0 44px 36px') : 0),
    background: isWellnessInnerRow || isWellnessConsultation || isWellnessSupporting ? '#fbfaf4' : 'transparent',
    color: isWellnessSection ? '#1f2f2c' : undefined,
    borderRadius: isWellnessConsultation ? (hasFullWidthSupport ? '18px' : '18px 18px 0 0') : (isWellnessSupporting ? '0 0 18px 18px' : 0),
    boxSizing: 'border-box',
    overflow: 'hidden',
  };

  const columnStyle = (col, idx) => {
    let flex = col.fullWidth ? '1 1 100%' : '1 1 0';
    if (isWellnessHeroRow) flex = idx === 1 ? '1 1 0' : '1.35 1 0';
    if (isWellnessRegistrationRow) flex = idx === 0 ? '1.15 1 0' : '0.85 1 0';
    if (isWellnessBenefitCards) flex = '1 1 100%';
    if (isWellnessConsultation && idx === 1) flex = '0 1 480px';

    return {
      flex,
      minWidth: col.fullWidth ? '100%' : (isWellnessHeroRow ? (idx === 1 ? '340px' : '460px') : isWellnessRegistrationRow ? (idx === 0 ? '540px' : '360px') : isWellnessSection ? '280px' : '260px'),
      maxWidth: '100%',
      boxSizing: 'border-box',
      display: 'flex',
      flexDirection: 'column',
      gap: isWellnessBenefitCards ? '10px' : '16px',
      padding: isWellnessBenefitCards ? '28px' : 0,
      background: isWellnessBenefitCards ? '#fffdf7' : 'transparent',
      border: isWellnessBenefitCards ? '1px solid #d8d2c3' : 'none',
      borderRadius: isWellnessBenefitCards ? '18px' : 0,
      boxShadow: isWellnessBenefitCards ? '0 14px 35px rgba(31, 47, 44, 0.06)' : 'none',
      justifyContent: isWellnessBenefitCards ? 'center' : undefined,
    };
  };

  return (
    <div style={containerStyle}>
      {columns.map((col, idx) => (
        <div key={idx} style={columnStyle(col, idx)}>
          {col.components &&
            col.components.map((c, cidx) => (
              <div key={cidx}>{renderBlock ? renderBlock(c) : null}</div>
            ))}
        </div>
      ))}
    </div>
  );
}
