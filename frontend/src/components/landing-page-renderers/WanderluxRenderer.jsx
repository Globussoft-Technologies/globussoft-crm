/**
 * WanderluxRenderer.jsx — Renders a Wanderlux-v1 landing page.
 * Maps the Wanderlux config schema to React components.
 * Replaces the dc-runtime approach with pre-compiled React.
 */

import React, { useEffect } from 'react';
import { safeUrl } from '../../utils/landingPageUtils';

/**
 * Section components for Wanderlux config.
 * Each accepts { config, theme, slug } and renders the section.
 */

function HeroSection({ config = {}, theme = {}, slug = '' }) {
  const { headline, subheading, image, ctaText, ctaLink } = config;

  return (
    <section
      style={{
        backgroundImage: image ? `linear-gradient(rgba(0,0,0,0.3),rgba(0,0,0,0.3)),url('${safeUrl(image, 'image-src')}')` : undefined,
        backgroundColor: image ? undefined : theme.lightBg || '#f5f5f5',
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        color: theme.textColor || '#000',
        padding: '120px 40px',
        textAlign: 'center',
        minHeight: '500px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {headline && (
        <h1
          style={{
            fontSize: '48px',
            fontWeight: '700',
            margin: '0 0 20px 0',
            fontFamily: theme.serifFont || 'Georgia, serif',
            color: '#fff',
            textShadow: '0 2px 8px rgba(0,0,0,0.3)',
          }}
        >
          {headline}
        </h1>
      )}
      {subheading && (
        <p
          style={{
            fontSize: '20px',
            margin: '0 0 40px 0',
            color: '#fff',
            textShadow: '0 1px 4px rgba(0,0,0,0.3)',
            maxWidth: '600px',
          }}
        >
          {subheading}
        </p>
      )}
      {ctaText && (
        <a
          href={ctaLink || '#'}
          style={{
            display: 'inline-block',
            padding: '12px 32px',
            backgroundColor: theme.accentColor || '#d4af37',
            color: '#fff',
            textDecoration: 'none',
            borderRadius: '4px',
            fontWeight: '600',
            fontSize: '16px',
            cursor: 'pointer',
          }}
        >
          {ctaText}
        </a>
      )}
    </section>
  );
}

function IntroSection({ config = {}, theme = {} }) {
  const { title, content } = config;

  return (
    <section
      style={{
        maxWidth: '1200px',
        margin: '0 auto',
        padding: '60px 40px',
        backgroundColor: theme.panelBg || '#fff',
      }}
    >
      {title && (
        <h2
          style={{
            fontSize: '36px',
            fontWeight: '700',
            marginBottom: '24px',
            fontFamily: theme.serifFont || 'Georgia, serif',
            color: theme.textColor || '#000',
          }}
        >
          {title}
        </h2>
      )}
      {content && (
        <div
          style={{
            fontSize: '16px',
            lineHeight: '1.8',
            color: theme.textColor2 || '#666',
            maxWidth: '800px',
          }}
        >
          {content}
        </div>
      )}
    </section>
  );
}

function CitiesSection({ config = {}, theme = {} }) {
  const { title, cities = [] } = config;

  return (
    <section
      style={{
        maxWidth: '1200px',
        margin: '0 auto',
        padding: '60px 40px',
      }}
    >
      {title && (
        <h2
          style={{
            fontSize: '36px',
            fontWeight: '700',
            marginBottom: '40px',
            fontFamily: theme.serifFont || 'Georgia, serif',
            textAlign: 'center',
            color: theme.textColor || '#000',
          }}
        >
          {title}
        </h2>
      )}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
          gap: '30px',
        }}
      >
        {cities.map((city, idx) => (
          <div
            key={idx}
            style={{
              borderRadius: '8px',
              overflow: 'hidden',
              boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
            }}
          >
            {city.image && (
              <div
                style={{
                  backgroundImage: `url('${safeUrl(city.image, 'image-src')}')`,
                  backgroundSize: 'cover',
                  backgroundPosition: 'center',
                  height: '240px',
                }}
              />
            )}
            <div style={{ padding: '20px', backgroundColor: theme.panelBg || '#fff' }}>
              {city.name && (
                <h3
                  style={{
                    fontSize: '18px',
                    fontWeight: '600',
                    margin: '0 0 8px 0',
                    color: theme.brandColor || '#000',
                  }}
                >
                  {city.name}
                </h3>
              )}
              {city.description && (
                <p
                  style={{
                    fontSize: '14px',
                    color: theme.textColor2 || '#666',
                    margin: '0',
                    lineHeight: '1.6',
                  }}
                >
                  {city.description}
                </p>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function HighlightsSection({ config = {}, theme = {} }) {
  const { title, items = [] } = config;

  return (
    <section
      style={{
        maxWidth: '1200px',
        margin: '0 auto',
        padding: '60px 40px',
      }}
    >
      {title && (
        <h2
          style={{
            fontSize: '36px',
            fontWeight: '700',
            marginBottom: '40px',
            fontFamily: theme.serifFont || 'Georgia, serif',
            textAlign: 'center',
            color: theme.textColor || '#000',
          }}
        >
          {title}
        </h2>
      )}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
          gap: '24px',
        }}
      >
        {items.map((item, idx) => (
          <div key={idx} style={{ textAlign: 'center' }}>
            {item.icon && (
              <div
                style={{
                  fontSize: '32px',
                  marginBottom: '12px',
                  color: theme.accentColor || '#d4af37',
                }}
              >
                {item.icon}
              </div>
            )}
            {item.title && (
              <h4
                style={{
                  fontSize: '16px',
                  fontWeight: '600',
                  margin: '12px 0 8px 0',
                  color: theme.textColor || '#000',
                }}
              >
                {item.title}
              </h4>
            )}
            {item.description && (
              <p
                style={{
                  fontSize: '14px',
                  color: theme.textColor2 || '#666',
                  margin: '0',
                  lineHeight: '1.6',
                }}
              >
                {item.description}
              </p>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function PricingSection({ config = {}, theme = {} }) {
  const { title, tiers = [] } = config;

  return (
    <section
      style={{
        maxWidth: '1200px',
        margin: '0 auto',
        padding: '60px 40px',
        backgroundColor: theme.softBg || '#f5f5f5',
      }}
    >
      {title && (
        <h2
          style={{
            fontSize: '36px',
            fontWeight: '700',
            marginBottom: '40px',
            fontFamily: theme.serifFont || 'Georgia, serif',
            textAlign: 'center',
            color: theme.textColor || '#000',
          }}
        >
          {title}
        </h2>
      )}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
          gap: '30px',
        }}
      >
        {tiers.map((tier, idx) => (
          <div
            key={idx}
            style={{
              backgroundColor: theme.panelBg || '#fff',
              padding: '30px',
              borderRadius: '8px',
              border: `1px solid ${theme.borderColor || '#e0e0e0'}`,
              textAlign: 'center',
            }}
          >
            {tier.name && (
              <h3
                style={{
                  fontSize: '18px',
                  fontWeight: '600',
                  margin: '0 0 12px 0',
                  color: theme.brandColor || '#000',
                }}
              >
                {tier.name}
              </h3>
            )}
            {tier.price !== undefined && (
              <div
                style={{
                  fontSize: '28px',
                  fontWeight: '700',
                  color: theme.accentColor || '#d4af37',
                  margin: '12px 0',
                }}
              >
                {tier.price == null ? 'TBD' : `${tier.currency || '₹'}${tier.price}`}
              </div>
            )}
            {tier.description && (
              <p
                style={{
                  fontSize: '14px',
                  color: theme.textColor2 || '#666',
                  margin: '12px 0',
                }}
              >
                {tier.description}
              </p>
            )}
            {tier.features && Array.isArray(tier.features) && (
              <ul
                style={{
                  listStyle: 'none',
                  padding: '12px 0',
                  margin: '0',
                  fontSize: '13px',
                  color: theme.textColor2 || '#666',
                  lineHeight: '1.8',
                }}
              >
                {tier.features.map((feature, fidx) => (
                  <li key={fidx}>✓ {feature}</li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function FaqSection({ config = {}, theme = {} }) {
  const { title, faqs = [] } = config;
  const [openIdx, setOpenIdx] = React.useState(null);

  return (
    <section
      style={{
        maxWidth: '900px',
        margin: '0 auto',
        padding: '60px 40px',
      }}
    >
      {title && (
        <h2
          style={{
            fontSize: '36px',
            fontWeight: '700',
            marginBottom: '40px',
            fontFamily: theme.serifFont || 'Georgia, serif',
            textAlign: 'center',
            color: theme.textColor || '#000',
          }}
        >
          {title}
        </h2>
      )}
      <div>
        {faqs.map((faq, idx) => (
          <div
            key={idx}
            style={{
              borderBottom: `1px solid ${theme.borderColor || '#e0e0e0'}`,
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
                color: theme.textColor || '#000',
              }}
            >
              {faq.question}
              <span style={{ fontSize: '20px' }}>{openIdx === idx ? '−' : '+'}</span>
            </button>
            {openIdx === idx && (
              <p
                style={{
                  margin: '12px 0 0 0',
                  color: theme.textColor2 || '#666',
                  fontSize: '14px',
                  lineHeight: '1.6',
                }}
              >
                {faq.answer}
              </p>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function FooterSection({ config = {}, theme = {} }) {
  const { title, content, links = [] } = config;

  return (
    <footer
      style={{
        backgroundColor: theme.footerColor || '#222',
        color: '#fff',
        padding: '40px',
        textAlign: 'center',
      }}
    >
      {title && (
        <h3
          style={{
            fontSize: '24px',
            fontWeight: '600',
            margin: '0 0 16px 0',
          }}
        >
          {title}
        </h3>
      )}
      {content && (
        <p
          style={{
            fontSize: '14px',
            margin: '0 0 16px 0',
            color: '#ccc',
          }}
        >
          {content}
        </p>
      )}
      {links && links.length > 0 && (
        <div
          style={{
            display: 'flex',
            justifyContent: 'center',
            gap: '24px',
            marginTop: '16px',
          }}
        >
          {links.map((link, idx) => (
            <a
              key={idx}
              href={link.url || '#'}
              style={{
                color: theme.accentColor || '#d4af37',
                textDecoration: 'none',
                fontSize: '14px',
              }}
            >
              {link.label}
            </a>
          ))}
        </div>
      )}
    </footer>
  );
}

/**
 * Main Wanderlux Renderer
 */
export default function WanderluxRenderer({ landingPage = {} }) {
  const config = landingPage.content || {};
  const slug = landingPage.slug || '';

  // Extract theme from config or use defaults
  const theme = config.theme || {
    brandColor: '#122647',
    accentColor: '#C89A4E',
    textColor: '#15242B',
    textColor2: '#5B6B70',
    lightBg: '#F7FAF9',
    panelBg: '#FFFFFF',
    softBg: '#E8F3F1',
    borderColor: '#DCE6E4',
    footerColor: '#072438',
    serifFont: "'Cormorant Garamond', Georgia, serif",
    sansFont: "'Inter', system-ui, sans-serif",
  };

  // Track analytics
  useEffect(() => {
    if (slug) {
      new Image().src = `/api/pages/${slug}/track?event=VISIT`;
    }
  }, [slug]);

  return (
    <main
      style={{
        fontFamily: theme.sansFont || 'system-ui, sans-serif',
        color: theme.textColor || '#000',
        margin: 0,
        padding: 0,
      }}
    >
      <style>{`
        * { box-sizing: border-box; }
        html, body { margin: 0; padding: 0; }
        a { color: ${theme.brandColor}; text-decoration: none; }
        a:hover { text-decoration: underline; }
      `}</style>

      {config.hero && <HeroSection config={config.hero} theme={theme} slug={slug} />}
      {config.intro && <IntroSection config={config.intro} theme={theme} />}
      {config.cities && <CitiesSection config={config.cities} theme={theme} />}
      {config.highlights && <HighlightsSection config={config.highlights} theme={theme} />}
      {config.investment && <PricingSection config={config.investment} theme={theme} />}
      {config.faqs && <FaqSection config={config.faqs} theme={theme} />}
      {config.footer && <FooterSection config={config.footer} theme={theme} />}
    </main>
  );
}
