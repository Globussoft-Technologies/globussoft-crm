/**
 * TestReactLandingPage.jsx — Testing page for the React landing page renderer.
 *
 * Allows QA to test the React renderer on actual landing pages without
 * affecting production traffic.
 *
 * Usage:
 * - /test/react-landing-page?id=123 (render landing page with ID 123)
 * - /test/react-landing-page?slug=my-page (render landing page with slug "my-page")
 *
 * This page will be removed or hidden after the migration is complete.
 */

import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import LandingPageReactRenderer from '../components/landing-page-renderers/LandingPageReactRenderer';
import TopScrollSync from '../components/TopScrollSync';

export default function TestReactLandingPage() {
  const [searchParams] = useSearchParams();
  const [landingPage, setLandingPage] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showHtmlComparison, setShowHtmlComparison] = useState(false);

  const pageId = searchParams.get('id');
  const pageSlug = searchParams.get('slug');

  useEffect(() => {
    if (!pageId && !pageSlug) {
      setError('Please provide either ?id=<id> or ?slug=<slug>');
      setLoading(false);
      return;
    }

    const fetchPage = async () => {
      try {
        setLoading(true);
        setError(null);

        let url;
        if (pageId) {
          url = `/api/landing-pages/${encodeURIComponent(pageId)}`;
        } else if (pageSlug) {
          url = `/api/landing-pages?slug=${encodeURIComponent(pageSlug)}`;
        }

        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`Failed to fetch landing page: ${response.status}`);
        }

        const data = await response.json();

        // If we got a list, use the first item
        if (Array.isArray(data)) {
          if (data.length === 0) {
            throw new Error('Landing page not found');
          }
          setLandingPage(data[0]);
        } else {
          setLandingPage(data);
        }
      } catch (err) {
        console.error('Error fetching landing page:', err);
        setError(err.message);
        setLandingPage(null);
      } finally {
        setLoading(false);
      }
    };

    fetchPage();
  }, [pageId, pageSlug]);

  if (loading) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: '100vh',
          fontSize: '18px',
          color: '#666',
        }}
      >
        Loading landing page...
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: '40px', maxWidth: '1000px', margin: '0 auto' }}>
        <h1>Error</h1>
        <p style={{ color: '#d32f2f', fontSize: '16px' }}>{error}</p>
        <div style={{ background: '#f5f5f5', padding: '20px', borderRadius: '4px', marginTop: '20px' }}>
          <p style={{ margin: '0 0 10px 0', fontWeight: '600' }}>Usage:</p>
          <code style={{ display: 'block', marginBottom: '10px' }}>
            /test/react-landing-page?id=123
          </code>
          <code style={{ display: 'block' }}>
            /test/react-landing-page?slug=my-page-slug
          </code>
        </div>
      </div>
    );
  }

  if (!landingPage) {
    return (
      <div style={{ padding: '40px', maxWidth: '1000px', margin: '0 auto' }}>
        <h1>No Landing Page</h1>
        <p>The landing page could not be found.</p>
      </div>
    );
  }

  return (
    <div>
      {/* Debug toolbar */}
      <div
        style={{
          position: 'fixed',
          bottom: '20px',
          right: '20px',
          background: '#1f2937',
          color: '#fff',
          padding: '16px',
          borderRadius: '8px',
          fontSize: '12px',
          zIndex: 1000,
          maxWidth: '300px',
          boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
        }}
      >
        <div style={{ marginBottom: '8px', fontWeight: '600' }}>React Renderer Test</div>
        <div style={{ fontSize: '11px', marginBottom: '8px', color: '#ccc' }}>
          <div>ID: {landingPage.id}</div>
          <div>Title: {landingPage.title}</div>
          <div>Type: {landingPage.templateType || 'block-array'}</div>
          <div>Status: {landingPage.status}</div>
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            onClick={() => setShowHtmlComparison(!showHtmlComparison)}
            style={{
              background: '#2563eb',
              color: '#fff',
              border: 'none',
              padding: '6px 10px',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '11px',
            }}
          >
            {showHtmlComparison ? 'Hide' : 'View'} HTML
          </button>
          <a
            href={`/p/${landingPage.slug}`}
            target="_blank"
            rel="noreferrer"
            style={{
              background: '#059669',
              color: '#fff',
              padding: '6px 10px',
              borderRadius: '4px',
              textDecoration: 'none',
              fontSize: '11px',
              display: 'inline-block',
            }}
          >
            HTML Version
          </a>
        </div>
      </div>

      {/* Main renderer */}
      <LandingPageReactRenderer landingPage={landingPage} slug={landingPage.slug} />

      {/* HTML comparison panel */}
      {showHtmlComparison && (
        <div
          style={{
            position: 'fixed',
            bottom: '120px',
            right: '20px',
            background: '#fff',
            border: '1px solid #ccc',
            borderRadius: '8px',
            padding: '16px',
            maxWidth: '400px',
            maxHeight: '300px',
            overflowY: 'auto',
            fontSize: '11px',
            zIndex: 999,
            boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
          }}
        >
          <div style={{ fontWeight: '600', marginBottom: '12px' }}>Landing Page Info</div>
          <TopScrollSync>
          <table
            style={{
              width: '100%',
              borderCollapse: 'collapse',
              fontSize: '11px',
            }}
          >
            <tbody>
              <tr style={{ borderBottom: '1px solid #e5e7eb' }}>
                <td style={{ padding: '4px 8px', fontWeight: '600' }}>ID</td>
                <td style={{ padding: '4px 8px' }}>{landingPage.id}</td>
              </tr>
              <tr style={{ borderBottom: '1px solid #e5e7eb' }}>
                <td style={{ padding: '4px 8px', fontWeight: '600' }}>Title</td>
                <td style={{ padding: '4px 8px' }}>{landingPage.title}</td>
              </tr>
              <tr style={{ borderBottom: '1px solid #e5e7eb' }}>
                <td style={{ padding: '4px 8px', fontWeight: '600' }}>Slug</td>
                <td style={{ padding: '4px 8px' }}>{landingPage.slug}</td>
              </tr>
              <tr style={{ borderBottom: '1px solid #e5e7eb' }}>
                <td style={{ padding: '4px 8px', fontWeight: '600' }}>Type</td>
                <td style={{ padding: '4px 8px' }}>{landingPage.templateType || 'block-array'}</td>
              </tr>
              <tr style={{ borderBottom: '1px solid #e5e7eb' }}>
                <td style={{ padding: '4px 8px', fontWeight: '600' }}>Status</td>
                <td style={{ padding: '4px 8px' }}>{landingPage.status}</td>
              </tr>
              <tr style={{ borderBottom: '1px solid #e5e7eb' }}>
                <td style={{ padding: '4px 8px', fontWeight: '600' }}>Generated by AI</td>
                <td style={{ padding: '4px 8px' }}>{landingPage.generatedByAi ? 'Yes' : 'No'}</td>
              </tr>
              <tr style={{ borderBottom: '1px solid #e5e7eb' }}>
                <td style={{ padding: '4px 8px', fontWeight: '600' }}>Created</td>
                <td style={{ padding: '4px 8px' }}>
                  {landingPage.createdAt ? new Date(landingPage.createdAt).toLocaleDateString() : 'N/A'}
                </td>
              </tr>
            </tbody>
          </table>
          </TopScrollSync>
        </div>
      )}
    </div>
  );
}
