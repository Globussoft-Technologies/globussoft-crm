/**
 * FamilyTemplateRenderer.jsx — Renders family/religious/educational/luxury landing pages.
 * Supports the semantic content payload structure used by the family templates.
 * Used for templateType: educational-trip-v1, religious-tour-v1, family-trip-v1, luxury-tour-v1
 */

import React, { useEffect } from 'react';
import { safeUrl } from '../../utils/landingPageUtils';

/**
 * Generic family template section renderer.
 * Maps semantic content sections to React components.
 */

function NavSection({ config = {}, theme = {} }) {
  const { title, items = [] } = config;

  return (
    <nav
      style={{
        backgroundColor: theme.brandColor || '#122647',
        color: '#fff',
        padding: '16px 0',
        position: 'sticky',
        top: 0,
        zIndex: 100,
      }}
    >
      <div style={{ maxWidth: '1200px', margin: '0 auto', padding: '0 20px' }}>
        {title && (
          <h1
            style={{
              fontSize: '20px',
              fontWeight: '600',
              margin: '0',
              marginBottom: items.length > 0 ? '12px' : '0',
            }}
          >
            {title}
          </h1>
        )}
        {items.length > 0 && (
          <div style={{ display: 'flex', gap: '20px', flexWrap: 'wrap' }}>
            {items.map((item, idx) => (
              <a
                key={idx}
                href={item.url || '#'}
                style={{
                  color: '#fff',
                  textDecoration: 'none',
                  fontSize: '14px',
                  padding: '4px 0',
                }}
              >
                {item.label}
              </a>
            ))}
          </div>
        )}
      </div>
    </nav>
  );
}

function HeroSection({ config = {}, theme = {} }) {
  const { title, description, image, cta } = config;

  return (
    <section
      style={{
        backgroundImage: image ? `linear-gradient(rgba(0,0,0,0.4),rgba(0,0,0,0.4)),url('${safeUrl(image, 'image-src')}')` : undefined,
        backgroundColor: image ? undefined : theme.primaryColor || '#f5f5f5',
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        color: '#fff',
        padding: '100px 40px',
        textAlign: 'center',
        minHeight: '400px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {title && (
        <h1
          style={{
            fontSize: '48px',
            fontWeight: '700',
            margin: '0 0 20px 0',
          }}
        >
          {title}
        </h1>
      )}
      {description && (
        <p
          style={{
            fontSize: '18px',
            margin: '0 0 30px 0',
            maxWidth: '600px',
          }}
        >
          {description}
        </p>
      )}
      {cta && (
        <a
          href={cta.url || '#'}
          style={{
            display: 'inline-block',
            padding: '12px 32px',
            backgroundColor: theme.accentColor || '#d4af37',
            color: '#fff',
            textDecoration: 'none',
            borderRadius: '4px',
            fontWeight: '600',
            fontSize: '16px',
          }}
        >
          {cta.text}
        </a>
      )}
    </section>
  );
}

function ContentSection({ config = {}, theme = {} }) {
  const { title, description, image, layout = 'text-right' } = config;

  const imageElement = image && (
    <div
      style={{
        flex: 1,
        minHeight: '300px',
        backgroundImage: `url('${safeUrl(image, 'image-src')}')`,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        borderRadius: '8px',
      }}
    />
  );

  const textElement = (
    <div style={{ flex: 1, paddingRight: layout === 'text-right' ? '40px' : '0', paddingLeft: layout === 'text-left' ? '40px' : '0' }}>
      {title && (
        <h2
          style={{
            fontSize: '32px',
            fontWeight: '700',
            margin: '0 0 20px 0',
            color: theme.textColor || '#000',
          }}
        >
          {title}
        </h2>
      )}
      {description && (
        <p
          style={{
            fontSize: '16px',
            lineHeight: '1.8',
            color: theme.textColor2 || '#666',
            margin: '0',
          }}
        >
          {description}
        </p>
      )}
    </div>
  );

  return (
    <section
      style={{
        maxWidth: '1200px',
        margin: '0 auto',
        padding: '60px 40px',
        display: 'flex',
        gap: '40px',
        alignItems: 'center',
        flexWrap: 'wrap',
      }}
    >
      {layout === 'text-left' ? (
        <>
          {textElement}
          {imageElement}
        </>
      ) : (
        <>
          {imageElement}
          {textElement}
        </>
      )}
    </section>
  );
}

function GridSection({ config = {}, theme = {} }) {
  const { title, items = [] } = config;

  return (
    <section
      style={{
        maxWidth: '1200px',
        margin: '0 auto',
        padding: '60px 40px',
        backgroundColor: theme.softBg || '#f9f9f9',
      }}
    >
      {title && (
        <h2
          style={{
            fontSize: '32px',
            fontWeight: '700',
            marginBottom: '40px',
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
          gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))',
          gap: '30px',
        }}
      >
        {items.map((item, idx) => (
          <div
            key={idx}
            style={{
              backgroundColor: '#fff',
              padding: '24px',
              borderRadius: '8px',
              textAlign: 'center',
              boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
            }}
          >
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
              <h3
                style={{
                  fontSize: '18px',
                  fontWeight: '600',
                  margin: '0 0 12px 0',
                  color: theme.textColor || '#000',
                }}
              >
                {item.title}
              </h3>
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

function TimelineSection({ config = {}, theme = {} }) {
  const { title, items = [] } = config;

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
            fontSize: '32px',
            fontWeight: '700',
            marginBottom: '40px',
            textAlign: 'center',
            color: theme.textColor || '#000',
          }}
        >
          {title}
        </h2>
      )}
      <div>
        {items.map((item, idx) => (
          <div
            key={idx}
            style={{
              display: 'flex',
              gap: '20px',
              marginBottom: '30px',
              paddingBottom: '30px',
              borderBottom: idx < items.length - 1 ? `1px solid ${theme.borderColor || '#e0e0e0'}` : 'none',
            }}
          >
            <div
              style={{
                minWidth: '50px',
                width: '50px',
                height: '50px',
                backgroundColor: theme.accentColor || '#d4af37',
                color: '#fff',
                borderRadius: '50%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontWeight: '600',
                fontSize: '18px',
              }}
            >
              {item.number || idx + 1}
            </div>
            <div>
              {item.title && (
                <h4
                  style={{
                    fontSize: '18px',
                    fontWeight: '600',
                    margin: '0 0 8px 0',
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
          </div>
        ))}
      </div>
    </section>
  );
}

function FaqSection({ config = {}, theme = {} }) {
  const { title, items = [] } = config;
  const [openIdx, setOpenIdx] = React.useState(null);

  return (
    <section
      style={{
        maxWidth: '900px',
        margin: '0 auto',
        padding: '60px 40px',
        backgroundColor: theme.softBg || '#f9f9f9',
      }}
    >
      {title && (
        <h2
          style={{
            fontSize: '32px',
            fontWeight: '700',
            marginBottom: '40px',
            textAlign: 'center',
            color: theme.textColor || '#000',
          }}
        >
          {title}
        </h2>
      )}
      <div>
        {items.map((item, idx) => (
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
              {item.question}
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
                {item.answer}
              </p>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function FooterSection({ config = {}, theme = {} }) {
  const { title, content, contact = {} } = config;

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
      {contact && (
        <div style={{ fontSize: '14px', color: '#ccc' }}>
          {contact.email && (
            <p style={{ margin: '8px 0' }}>
              Email: <a href={`mailto:${contact.email}`} style={{ color: theme.accentColor || '#d4af37' }}>{contact.email}</a>
            </p>
          )}
          {contact.phone && (
            <p style={{ margin: '8px 0' }}>
              Phone: <a href={`tel:${contact.phone}`} style={{ color: theme.accentColor || '#d4af37' }}>{contact.phone}</a>
            </p>
          )}
          {contact.address && <p style={{ margin: '8px 0' }}>{contact.address}</p>}
        </div>
      )}
    </footer>
  );
}

/**
 * Main Family Template Renderer
 */
export default function FamilyTemplateRenderer({ landingPage = {} }) {
  const content = landingPage.content || {};
  const slug = landingPage.slug || '';

  // Use or default theme
  const theme = {
    brandColor: '#122647',
    accentColor: '#C89A4E',
    primaryColor: '#f5f5f5',
    textColor: '#15242B',
    textColor2: '#5B6B70',
    softBg: '#E8F3F1',
    borderColor: '#DCE6E4',
    footerColor: '#072438',
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
        fontFamily: 'system-ui, -apple-system, sans-serif',
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

      {content.nav && <NavSection config={content.nav} theme={theme} />}
      {content.hero && <HeroSection config={content.hero} theme={theme} />}
      {content.marquee && <ContentSection config={content.marquee} theme={theme} />}
      {content.preview && <ContentSection config={content.preview} theme={theme} />}
      {content.programme && <TimelineSection config={content.programme} theme={theme} />}
      {content.itinerary && <TimelineSection config={content.itinerary} theme={theme} />}
      {content.cultural && <GridSection config={content.cultural} theme={theme} />}
      {content.highlights && <GridSection config={content.highlights} theme={theme} />}
      {content.safety && <GridSection config={content.safety} theme={theme} />}
      {content.amenities && <GridSection config={content.amenities} theme={theme} />}
      {content.faqs && <FaqSection config={content.faqs} theme={theme} />}
      {content.footer && <FooterSection config={content.footer} theme={theme} />}
    </main>
  );
}
