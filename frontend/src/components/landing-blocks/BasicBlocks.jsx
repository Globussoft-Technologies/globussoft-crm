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

  const HeadingTag = level;
  return (
    <HeadingTag
      style={{
        color,
        textAlign: align,
        margin: '0 0 16px 0',
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

  return (
    <p
      style={{
        color,
        textAlign: align,
        fontSize,
        lineHeight: '1.6',
        margin: '0 0 16px 0',
      }}
    >
      {text}
    </p>
  );
}

export function ImageBlock({ props = {} }) {
  const width = props.width || '100%';
  const maxWidth = props.maxWidth || '100%';
  const alt = props.alt || '';
  const src = safeUrl(props.src, 'image-src');

  return (
    <div style={{ textAlign: 'center', margin: '0 0 16px 0' }}>
      <img
        src={src}
        alt={alt}
        style={{
          width,
          maxWidth,
          height: 'auto',
          borderRadius: '8px',
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
    <div style={{ textAlign: align, margin: '0 0 16px 0' }}>
      <a
        href={url}
        style={{
          display: 'inline-block',
          padding,
          background: bgColor,
          color,
          textDecoration: 'none',
          borderRadius: '6px',
          fontSize,
          fontWeight: '600',
          cursor: 'pointer',
        }}
      >
        {text}
      </a>
    </div>
  );
}

export function FormBlock({ props = {}, slug = '', pageId = null }) {
  const fields = props.fields || [];
  const submitText = props.submitText || 'Submit';
  const thankYouMessage = props.thankYouMessage || 'Thank you for your submission!';
  const enableCaptcha = !!props.enableCaptcha;
  const successRedirectUrl = props.successRedirectUrl || '';

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
      // Use pageId if available (React renderer), fallback to slug (HTML renderer)
      const endpoint = pageId
        ? `/api/landing-pages/${pageId}/submit`
        : `/p/${slug}/submit`;

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
          maxWidth: '480px',
          margin: '0 auto 16px',
          padding: '24px',
          background: '#f9fafb',
          borderRadius: '10px',
          border: '1px solid #e5e7eb',
        }}
      >
        {fields.map((field) => {
          const fieldId = `${formId}_${field.name}`;
          return (
            <div key={field.name} style={{ marginBottom: '12px' }}>
              <label
                htmlFor={fieldId}
                style={{
                  display: 'block',
                  marginBottom: '4px',
                  fontWeight: '500',
                  color: '#333',
                  fontSize: '14px',
                }}
              >
                {field.label || field.name}
              </label>
              <input
                id={fieldId}
                type={field.type || 'text'}
                name={field.name}
                value={formData[field.name] || ''}
                onChange={handleChange}
                required={field.required}
                style={{
                  width: '100%',
                  padding: '10px 12px',
                  border: '1px solid #d1d5db',
                  borderRadius: '6px',
                  fontSize: '15px',
                  boxSizing: 'border-box',
                }}
              />
            </div>
          );
        })}

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
            padding: '12px',
            background: '#2563eb',
            color: '#fff',
            border: 'none',
            borderRadius: '6px',
            fontSize: '15px',
            fontWeight: '600',
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

  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap,
        margin: '0 0 16px 0',
      }}
    >
      {columns.map((col, idx) => (
        <div
          key={idx}
          style={{
            flex: 1,
            minWidth: '250px',
          }}
        >
          {col.components &&
            col.components.map((c, cidx) => (
              <div key={cidx}>{renderBlock ? renderBlock(c) : null}</div>
            ))}
        </div>
      ))}
    </div>
  );
}
