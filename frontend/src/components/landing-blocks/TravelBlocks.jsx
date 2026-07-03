/**
 * TravelBlocks.jsx — Travel-specific block components (destinationHero, cityCards, etc.)
 * Used by travel_destination landing pages and Wanderlux pages.
 * These rely on the shared .trips-page CSS styling.
 */

import React, { useEffect, useState, useRef } from 'react';
import { escapeHtml, safeUrl } from '../../utils/landingPageUtils';

export function DestinationHeroBlock({ props = {}, slug = '' }) {
  const destination = props.destination || '';
  const headline = props.headline || '';
  const subhead = props.subhead || '';
  const posterUrl = props.posterUrl ? safeUrl(props.posterUrl, 'image-src') : '';
  const ctaText = props.ctaText || 'Reserve Your Spot';
  const ctaScrollTarget = props.ctaScrollTarget || '';
  const palette = props.palette || {};
  const bg = palette.bg || '#1f1a17';
  const fg = palette.fg || '#ffffff';
  const accent = palette.accent || '#b8893b';
  const countdownTo = props.countdownTo || null;

  const [countdownState, setCountdownState] = useState({
    d: '--',
    h: '--',
    m: '--',
    s: '--',
  });

  // Countdown timer
  useEffect(() => {
    if (!countdownTo) return;

    const tick = () => {
      const target = new Date(countdownTo).getTime();
      if (isNaN(target)) return;

      const diff = Math.max(0, target - Date.now());
      const d = Math.floor(diff / 86400000);
      const h = Math.floor((diff % 86400000) / 3600000);
      const m = Math.floor((diff % 3600000) / 60000);
      const s = Math.floor((diff % 60000) / 1000);

      setCountdownState({
        d: String(d).padStart(2, '0'),
        h: String(h).padStart(2, '0'),
        m: String(m).padStart(2, '0'),
        s: String(s).padStart(2, '0'),
      });
    };

    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [countdownTo]);

  const posterStyle = posterUrl
    ? {
        backgroundImage: `linear-gradient(rgba(0,0,0,0.45),rgba(0,0,0,0.65)),url('${posterUrl}')`,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
      }
    : {
        background: bg,
      };

  const handleCtaClick = (e) => {
    if (ctaScrollTarget) {
      e.preventDefault();
      const target = document.getElementById(ctaScrollTarget);
      if (target) {
        target.scrollIntoView({ behavior: 'smooth' });
      }
    }
  };

  return (
    <section
      className="t-hero"
      style={{
        ...posterStyle,
        color: fg,
        minHeight: '400px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        position: 'relative',
      }}
    >
      <div style={{ zIndex: 2, maxWidth: '800px', padding: '40px 20px' }}>
        {destination && (
          <span
            className="t-tag"
            style={{
              display: 'inline-block',
              padding: '6px 12px',
              background: `${accent}33`,
              color: accent,
              borderRadius: '4px',
              fontSize: '12px',
              fontWeight: '600',
              marginBottom: '16px',
            }}
          >
            {destination}
          </span>
        )}

        {headline && (
          <h1
            className="t-hero-headline"
            style={{
              fontSize: '48px',
              fontWeight: '700',
              margin: '16px 0',
              color: fg,
            }}
          >
            {headline}
          </h1>
        )}

        {subhead && (
          <p
            className="t-hero-subhead"
            style={{
              fontSize: '20px',
              margin: '16px 0 32px',
              color: `${fg}dd`,
              lineHeight: '1.6',
            }}
          >
            {subhead}
          </p>
        )}

        {countdownTo && (
          <div
            className="t-hero-countdown"
            style={{
              display: 'flex',
              justifyContent: 'center',
              gap: '20px',
              margin: '32px 0',
            }}
          >
            {[
              { unit: 'd', label: 'Days', value: countdownState.d },
              { unit: 'h', label: 'Hours', value: countdownState.h },
              { unit: 'm', label: 'Min', value: countdownState.m },
              { unit: 's', label: 'Sec', value: countdownState.s },
            ].map(({ unit, label, value }) => (
              <div
                key={unit}
                className="t-cd-cell"
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                }}
              >
                <div
                  className="t-cd-num"
                  style={{
                    fontSize: '32px',
                    fontWeight: '700',
                    color: accent,
                  }}
                >
                  {value}
                </div>
                <div
                  className="t-cd-lbl"
                  style={{
                    fontSize: '12px',
                    color: `${fg}99`,
                    marginTop: '4px',
                  }}
                >
                  {label}
                </div>
              </div>
            ))}
          </div>
        )}

        <a
          className="t-cta t-hero-cta"
          href={ctaScrollTarget ? `#${ctaScrollTarget}` : '#'}
          onClick={handleCtaClick}
          style={{
            display: 'inline-block',
            padding: '12px 32px',
            background: accent,
            color: '#fff',
            textDecoration: 'none',
            borderRadius: '6px',
            fontWeight: '600',
            fontSize: '16px',
            marginTop: '16px',
            cursor: 'pointer',
          }}
        >
          {ctaText}
        </a>
      </div>
    </section>
  );
}

export function CityCardsBlock({ props = {} }) {
  const title = props.title || '';
  const subtitle = props.subtitle || '';
  const cards = Array.isArray(props.cards) ? props.cards : [];

  return (
    <section className="t-section t-cities">
      <div className="t-wrap" style={{ maxWidth: '1200px', margin: '0 auto', padding: '40px 20px' }}>
        {title && <h2 className="t-center" style={{ fontSize: '32px', marginBottom: '12px' }}>{title}</h2>}
        {subtitle && (
          <p className="t-center t-muted t-section-sub" style={{ color: '#666', marginBottom: '32px' }}>
            {subtitle}
          </p>
        )}
        <div
          className="t-city-grid"
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
            gap: '24px',
          }}
        >
          {cards.map((card, idx) => (
            <article key={idx} className="t-city-card">
              {card.img && (
                <div
                  className="t-city-img"
                  style={{
                    backgroundImage: `url('${safeUrl(card.img, 'image-src')}')`,
                    backgroundSize: 'cover',
                    backgroundPosition: 'center',
                    height: '240px',
                    borderRadius: '8px 8px 0 0',
                  }}
                />
              )}
              {!card.img && (
                <div
                  className="t-city-img t-city-img--empty"
                  style={{
                    height: '240px',
                    background: '#f0f0f0',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: '#999',
                    borderRadius: '8px 8px 0 0',
                  }}
                >
                  City image
                </div>
              )}
              <div className="t-city-card-body" style={{ padding: '16px' }}>
                {card.tag && (
                  <span style={{ display: 'inline-block', fontSize: '12px', fontWeight: '600', color: '#666', marginBottom: '8px' }}>
                    {card.tag}
                  </span>
                )}
                {card.title && <h3 className="t-city-title" style={{ fontSize: '18px', fontWeight: '600', margin: '8px 0' }}>{card.title}</h3>}
                {card.body && <p className="t-city-body t-muted" style={{ color: '#666', fontSize: '14px', margin: '8px 0' }}>{card.body}</p>}
                {card.benefit && (
                  <p style={{ marginTop: '12px', fontSize: '13px', color: '#555', fontStyle: 'italic' }}>
                    <strong style={{ fontStyle: 'normal' }}>Derived Benefit:</strong> "{card.benefit}"
                  </p>
                )}
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

export function HighlightsGridBlock({ props = {} }) {
  const title = props.title || '';
  const subtitle = props.subtitle || '';
  const items = Array.isArray(props.items) ? props.items : [];

  return (
    <section className="t-section t-highlights">
      <div className="t-wrap" style={{ maxWidth: '1200px', margin: '0 auto', padding: '40px 20px' }}>
        {title && <h2 className="t-center" style={{ fontSize: '32px', marginBottom: '12px' }}>{title}</h2>}
        {subtitle && (
          <p className="t-center t-muted t-section-sub" style={{ color: '#666', marginBottom: '32px' }}>
            {subtitle}
          </p>
        )}
        <div
          className="t-highlight-grid"
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
            gap: '24px',
          }}
        >
          {items.map((item, idx) => (
            <div key={idx} className="t-highlight" style={{ textAlign: 'center' }}>
              <div
                className="t-highlight-icon"
                style={{
                  fontSize: '32px',
                  color: '#2563eb',
                  marginBottom: '12px',
                }}
              >
                {item.icon || '◈'}
              </div>
              {item.title && <h4 className="t-highlight-title" style={{ fontSize: '16px', fontWeight: '600', margin: '8px 0' }}>{item.title}</h4>}
              {item.body && <p className="t-highlight-body t-muted" style={{ color: '#666', fontSize: '14px', margin: '8px 0' }}>{item.body}</p>}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

export function InclusionsGridBlock({ props = {} }) {
  const title = props.title || '';
  const items = Array.isArray(props.items) ? props.items : [];

  return (
    <section className="t-section t-inclusions" style={{ background: '#f9fafb', padding: '40px 20px' }}>
      <div className="t-wrap" style={{ maxWidth: '1200px', margin: '0 auto' }}>
        {title && <h2 className="t-center" style={{ fontSize: '32px', marginBottom: '32px' }}>{title}</h2>}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
            gap: '24px',
          }}
        >
          {items.map((item, idx) => (
            <div
              key={idx}
              style={{
                background: '#fff',
                padding: '16px',
                borderRadius: '8px',
                textAlign: 'center',
              }}
            >
              {item.icon && (
                <div style={{ fontSize: '24px', marginBottom: '8px' }}>{item.icon}</div>
              )}
              <h4 style={{ fontSize: '14px', fontWeight: '600', margin: '8px 0' }}>{item.title}</h4>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

export function TierPricingBlock({ props = {} }) {
  const title = props.title || '';
  const tiers = Array.isArray(props.tiers) ? props.tiers : [];

  return (
    <section className="t-section t-pricing" style={{ padding: '40px 20px' }}>
      <div className="t-wrap" style={{ maxWidth: '1200px', margin: '0 auto' }}>
        {title && <h2 className="t-center" style={{ fontSize: '32px', marginBottom: '32px' }}>{title}</h2>}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
            gap: '24px',
          }}
        >
          {tiers.map((tier, idx) => (
            <div
              key={idx}
              style={{
                border: '1px solid #e5e7eb',
                borderRadius: '8px',
                padding: '24px',
              }}
            >
              {tier.name && <h4 style={{ fontSize: '18px', fontWeight: '600', margin: '0 0 12px' }}>{tier.name}</h4>}
              {tier.price !== undefined && (
                <div style={{ fontSize: '24px', fontWeight: '700', color: '#2563eb', margin: '12px 0' }}>
                  {tier.price == null ? '—' : `${tier.currency || '₹'}${tier.price}`}
                </div>
              )}
              {tier.description && (
                <p style={{ color: '#666', fontSize: '14px', margin: '12px 0' }}>{tier.description}</p>
              )}
              {tier.features && Array.isArray(tier.features) && (
                <ul style={{ margin: '12px 0', paddingLeft: '20px', fontSize: '14px' }}>
                  {tier.features.map((feature, fidx) => (
                    <li key={fidx} style={{ margin: '4px 0' }}>
                      {feature}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

export function FaqAccordionBlock({ props = {} }) {
  const title = props.title || '';
  const faqs = Array.isArray(props.faqs) ? props.faqs : [];
  const [openIdx, setOpenIdx] = useState(null);

  return (
    <section className="t-section t-faq" style={{ padding: '40px 20px' }}>
      <div className="t-wrap" style={{ maxWidth: '800px', margin: '0 auto' }}>
        {title && <h2 className="t-center" style={{ fontSize: '32px', marginBottom: '32px' }}>{title}</h2>}
        <div>
          {faqs.map((faq, idx) => (
            <div
              key={idx}
              style={{
                borderBottom: '1px solid #e5e7eb',
                paddingBottom: '16px',
                marginBottom: '16px',
              }}
            >
              <button
                onClick={() => setOpenIdx(openIdx === idx ? null : idx)}
                style={{
                  width: '100%',
                  textAlign: 'left',
                  padding: '12px 0',
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: '16px',
                  fontWeight: '600',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
              >
                {faq.question}
                <span style={{ fontSize: '20px' }}>{openIdx === idx ? '−' : '+'}</span>
              </button>
              {openIdx === idx && (
                <p style={{ margin: '12px 0', color: '#666', fontSize: '14px', lineHeight: '1.6' }}>
                  {faq.answer}
                </p>
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

export function SafetyFeaturesBlock({ props = {} }) {
  const title = props.title || '';
  const features = Array.isArray(props.features) ? props.features : [];

  return (
    <section className="t-section t-safety" style={{ background: '#f0fdf4', padding: '40px 20px' }}>
      <div className="t-wrap" style={{ maxWidth: '1200px', margin: '0 auto' }}>
        {title && <h2 className="t-center" style={{ fontSize: '32px', marginBottom: '32px' }}>{title}</h2>}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
            gap: '24px',
          }}
        >
          {features.map((feature, idx) => (
            <div
              key={idx}
              style={{
                background: '#fff',
                padding: '20px',
                borderRadius: '8px',
                borderLeft: '4px solid #16a34a',
              }}
            >
              {feature.icon && (
                <div style={{ fontSize: '28px', marginBottom: '12px' }}>{feature.icon}</div>
              )}
              {feature.title && <h4 style={{ fontSize: '16px', fontWeight: '600', margin: '8px 0' }}>{feature.title}</h4>}
              {feature.description && (
                <p style={{ color: '#666', fontSize: '14px', margin: '8px 0' }}>{feature.description}</p>
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

export function ItineraryTimelineBlock({ props = {} }) {
  const title = props.title || '';
  const items = Array.isArray(props.items) ? props.items : [];

  return (
    <section className="t-section t-itinerary" style={{ padding: '40px 20px' }}>
      <div className="t-wrap" style={{ maxWidth: '800px', margin: '0 auto' }}>
        {title && <h2 className="t-center" style={{ fontSize: '32px', marginBottom: '32px' }}>{title}</h2>}
        <div>
          {items.map((item, idx) => (
            <div
              key={idx}
              style={{
                display: 'flex',
                gap: '20px',
                marginBottom: '24px',
                paddingBottom: '24px',
                borderBottom: idx < items.length - 1 ? '1px solid #e5e7eb' : 'none',
              }}
            >
              <div
                style={{
                  minWidth: '40px',
                  width: '40px',
                  height: '40px',
                  background: '#2563eb',
                  color: '#fff',
                  borderRadius: '50%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontWeight: '600',
                  fontSize: '16px',
                }}
              >
                {item.day || idx + 1}
              </div>
              <div>
                {item.title && <h4 style={{ fontSize: '16px', fontWeight: '600', margin: '0 0 8px' }}>{item.title}</h4>}
                {item.description && (
                  <p style={{ color: '#666', fontSize: '14px', margin: '0', lineHeight: '1.6' }}>
                    {item.description}
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

export function ContactFooterBlock({ props = {} }) {
  const title = props.title || 'Get In Touch';
  const email = props.email || '';
  const phone = props.phone || '';
  const address = props.address || '';

  return (
    <section className="t-section t-contact" style={{ background: '#1f2937', color: '#fff', padding: '40px 20px' }}>
      <div className="t-wrap" style={{ maxWidth: '600px', margin: '0 auto', textAlign: 'center' }}>
        {title && <h2 style={{ fontSize: '28px', marginBottom: '24px' }}>{title}</h2>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', alignItems: 'center' }}>
          {email && (
            <a href={`mailto:${email}`} style={{ color: '#60a5fa', textDecoration: 'none', fontSize: '16px' }}>
              {email}
            </a>
          )}
          {phone && (
            <a href={`tel:${phone}`} style={{ color: '#60a5fa', textDecoration: 'none', fontSize: '16px' }}>
              {phone}
            </a>
          )}
          {address && <p style={{ color: '#d1d5db', fontSize: '14px', margin: 0 }}>{address}</p>}
        </div>
      </div>
    </section>
  );
}
