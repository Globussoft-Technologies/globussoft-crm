/**
 * LandingPageReactRenderer.jsx — Main dispatcher for React-based landing page rendering.
 *
 * Routes landing pages to the appropriate renderer based on templateType:
 * - wanderlux-v1 → WanderluxRenderer
 * - travel_destination + other block-arrays → BlockRenderer
 * - educational-trip-v1, religious-tour-v1, family-trip-v1, luxury-tour-v1 → FamilyTemplateRenderer
 *
 * This component can be tested independently without affecting the production
 * HTML renderer. Both renderers coexist during the transition.
 */

import React, { useEffect, useState } from 'react';
import BlockRenderer from './BlockRenderer';
import WanderluxRenderer from './WanderluxRenderer';
import FamilyTemplateRenderer from './FamilyTemplateRenderer';
import { getRendererType, parseContentJson } from '../../utils/landingPageUtils';

/**
 * Fallback renderer for unknown template types
 */
function FallbackRenderer({ landingPage = {} }) {
  return (
    <main style={{ padding: '40px', textAlign: 'center', maxWidth: '1000px', margin: '0 auto' }}>
      <h1>Landing Page</h1>
      <p style={{ color: '#666' }}>
        Template type "{landingPage.templateType || 'unknown'}" is not supported by the React renderer.
      </p>
      {landingPage.title && <h2>{landingPage.title}</h2>}
      {landingPage.description && <p>{landingPage.description}</p>}
    </main>
  );
}

/**
 * Main dispatcher component
 */
export default function LandingPageReactRenderer({ landingPage = null, slug = '' }) {
  const [renderError, setRenderError] = useState(null);

  // Validate input
  if (!landingPage) {
    return (
      <main style={{ padding: '40px', textAlign: 'center' }}>
        <h1>Error</h1>
        <p>No landing page data provided</p>
      </main>
    );
  }

  // Determine renderer type
  const rendererType = getRendererType(landingPage);

  // Validate content can be parsed
  const content = parseContentJson(landingPage);
  if (!content && landingPage.content) {
    return (
      <main style={{ padding: '40px', textAlign: 'center', maxWidth: '1000px', margin: '0 auto' }}>
        <h1>Error</h1>
        <p style={{ color: '#666' }}>
          Failed to parse landing page content. The JSON may be malformed.
        </p>
      </main>
    );
  }

  // Render error boundary
  if (renderError) {
    return (
      <main style={{ padding: '40px', textAlign: 'center', maxWidth: '1000px', margin: '0 auto' }}>
        <h1>Rendering Error</h1>
        <p style={{ color: '#d32f2f' }}>
          {renderError.message}
        </p>
        <details style={{ textAlign: 'left', marginTop: '20px' }}>
          <summary>Details</summary>
          <pre style={{ background: '#f5f5f5', padding: '10px', borderRadius: '4px', overflow: 'auto' }}>
            {renderError.stack}
          </pre>
        </details>
      </main>
    );
  }

  // Dispatch to appropriate renderer
  try {
    switch (rendererType) {
      case 'wanderlux':
        return <WanderluxRenderer landingPage={landingPage} />;

      case 'block-array':
        return <BlockRenderer landingPage={landingPage} />;

      case 'educational':
      case 'religious':
      case 'family':
      case 'luxury':
      case 'travel-premium':
        return <FamilyTemplateRenderer landingPage={landingPage} />;

      default:
        return <FallbackRenderer landingPage={landingPage} />;
    }
  } catch (error) {
    console.error('Landing page render error:', error);
    setRenderError(error);
    return (
      <main style={{ padding: '40px', textAlign: 'center', maxWidth: '1000px', margin: '0 auto' }}>
        <h1>Rendering Error</h1>
        <p style={{ color: '#d32f2f' }}>
          {error.message}
        </p>
      </main>
    );
  }
}

/**
 * Hook to fetch and render a landing page by slug
 * Useful for integration with React Router
 */
export function useLandingPage(slug) {
  const [landingPage, setLandingPage] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!slug) {
      setLoading(false);
      setLandingPage(null);
      return;
    }

    const fetchPage = async () => {
      try {
        setLoading(true);
        setError(null);

        const response = await fetch(`/api/landing-pages/by-slug/${encodeURIComponent(slug)}`);
        if (!response.ok) {
          throw new Error(`Failed to fetch landing page: ${response.status}`);
        }

        const data = await response.json();
        setLandingPage(data);
      } catch (err) {
        console.error('Error fetching landing page:', err);
        setError(err.message);
        setLandingPage(null);
      } finally {
        setLoading(false);
      }
    };

    fetchPage();
  }, [slug]);

  return { landingPage, loading, error };
}
