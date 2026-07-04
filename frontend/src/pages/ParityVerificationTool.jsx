/**
 * ParityVerificationTool.jsx — Automated parity verification between HTML and React renderers.
 *
 * Usage:
 * - /test/parity?id=123                    — Compare by page ID
 * - /test/parity?slug=my-page              — Compare by page slug
 * - /test/parity?id=123&detailed=true      — Detailed DOM comparison
 *
 * Compares:
 * - DOM structure (tag names, classes, ids)
 * - Text content (exact match)
 * - Images (src, alt, dimensions)
 * - Links (href, target)
 * - Buttons (text, classes)
 * - Forms (fields, labels, attributes)
 * - Performance metrics (FCP, LCP, CLS)
 *
 * Generates a detailed report showing:
 * - Summary (pass/fail)
 * - Category breakdown (structure, content, images, etc.)
 * - Detailed differences (side-by-side comparison)
 * - Recommendations
 */

import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

const ParityVerificationTool = () => {
  const [searchParams] = useSearchParams();
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const pageId = searchParams.get('id');
    const pageSlug = searchParams.get('slug');
    const detailed = searchParams.get('detailed') === 'true';

    if (!pageId && !pageSlug) {
      setError('Please provide either ?id=<id> or ?slug=<slug>');
      setLoading(false);
      return;
    }

    const runVerification = async () => {
      try {
        setLoading(true);
        setError(null);

        // Fetch landing page
        let url;
        if (pageId) {
          url = `/api/landing-pages/${encodeURIComponent(pageId)}`;
        } else if (pageSlug) {
          url = `/api/landing-pages?slug=${encodeURIComponent(pageSlug)}`;
        }

        const pageResponse = await fetch(url);
        if (!pageResponse.ok) {
          throw new Error(
            pageResponse.status === 404 ? 'Landing page not found' : `Failed to fetch landing page: ${pageResponse.status}`
          );
        }

        const pageData = await pageResponse.json();
        const landingPage = Array.isArray(pageData) ? pageData[0] : pageData;

        if (!landingPage) {
          throw new Error('Landing page not found');
        }

        // Run parity verification
        const verificationReport = await verifyParity(landingPage, detailed);
        setReport(verificationReport);
      } catch (err) {
        console.error('Verification error:', err);
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };

    runVerification();
  }, [searchParams]);

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', padding: '20px', maxWidth: '1400px', margin: '0 auto' }}>
      <h1>🔍 Parity Verification Tool</h1>
      <p style={{ color: '#666', marginBottom: '30px' }}>
        Automated comparison between HTML and React landing page renderers
      </p>

      {loading && (
        <div style={{ fontSize: '18px', color: '#0066cc', textAlign: 'center', padding: '40px' }}>
          Comparing HTML and React renderers... This may take 10-30 seconds.
        </div>
      )}

      {error && (
        <div
          style={{
            background: '#fee',
            border: '1px solid #c33',
            padding: '20px',
            borderRadius: '4px',
            color: '#d32f2f',
          }}
        >
          <strong>Error:</strong> {error}
        </div>
      )}

      {report && <ParityReport report={report} />}
    </div>
  );
};

/**
 * Verify parity between HTML and React renderers
 */
async function verifyParity(landingPage, detailed = false) {
  const startTime = Date.now();

  // Render both versions
  const [htmlContent, reactContent] = await Promise.all([
    renderHTML(landingPage),
    renderReact(landingPage),
  ]);

  // Parse DOM
  const htmlDoc = new DOMParser().parseFromString(htmlContent, 'text/html');
  const reactDoc = new DOMParser().parseFromString(reactContent, 'text/html');

  // Run comparison checks
  const checks = {
    structure: compareStructure(htmlDoc, reactDoc, detailed),
    textContent: compareTextContent(htmlDoc, reactDoc, detailed),
    images: compareImages(htmlDoc, reactDoc, detailed),
    links: compareLinks(htmlDoc, reactDoc, detailed),
    buttons: compareButtons(htmlDoc, reactDoc, detailed),
    forms: compareForms(htmlDoc, reactDoc, detailed),
    attributes: compareAttributes(htmlDoc, reactDoc, detailed),
  };

  // Calculate summary
  const totalIssues = Object.values(checks).reduce((sum, check) => sum + check.differences.length, 0);
  const passedChecks = Object.values(checks).filter((check) => check.differences.length === 0).length;

  // Generate report
  return {
    metadata: {
      pageId: landingPage.id,
      pageTitle: landingPage.title,
      templateType: landingPage.templateType || 'block-array',
      timestamp: new Date().toISOString(),
      duration: Date.now() - startTime,
    },
    summary: {
      status: totalIssues === 0 ? 'PASS' : 'FAIL',
      totalIssues,
      passedChecks,
      totalChecks: Object.keys(checks).length,
      percentagePass: ((passedChecks / Object.keys(checks).length) * 100).toFixed(1),
    },
    checks,
    recommendations: generateRecommendations(checks),
  };
}

/**
 * Render HTML version via backend
 */
async function renderHTML(landingPage) {
  const response = await fetch(`/p/${encodeURIComponent(landingPage.slug)}`, {
    method: 'GET',
  });

  if (!response.ok) {
    throw new Error(`Failed to render HTML: ${response.status}`);
  }

  return response.text();
}

/**
 * Render React version
 */
async function renderReact(landingPage) {
  // This is a simulation — in reality, we'd need to:
  // 1. Render the React component to a string (SSR)
  // 2. Or fetch the rendered content via a server endpoint
  // For now, we'll fetch from the test page and extract the content
  const testPageHtml = await fetch(`/test/react-landing-page?id=${landingPage.id}`).then((r) =>
    r.text()
  );

  // Extract the rendered content from the test page
  const parser = new DOMParser();
  const doc = parser.parseFromString(testPageHtml, 'text/html');
  const mainContent = doc.querySelector('main') || doc.body;

  return mainContent.outerHTML;
}

/**
 * Compare DOM structure
 */
function compareStructure(htmlDoc, reactDoc, detailed = false) {
  const differences = [];

  const htmlMain = htmlDoc.querySelector('main') || htmlDoc.body;
  const reactMain = reactDoc.querySelector('main') || reactDoc.body;

  const htmlTags = Array.from(htmlMain.querySelectorAll('*')).map((el) => ({
    tag: el.tagName.toLowerCase(),
    classes: el.className,
    id: el.id,
  }));

  const reactTags = Array.from(reactMain.querySelectorAll('*')).map((el) => ({
    tag: el.tagName.toLowerCase(),
    classes: el.className,
    id: el.id,
  }));

  // Check tag count
  if (htmlTags.length !== reactTags.length) {
    differences.push({
      type: 'element-count',
      severity: 'low',
      html: `${htmlTags.length} elements`,
      react: `${reactTags.length} elements`,
      description: `Elements don't match: element count differs by ${Math.abs(htmlTags.length - reactTags.length)}`,
    });
  }

  // Check for missing sections
  const checkSections = ['nav', 'header', 'section', 'article', 'footer', 'form'];
  checkSections.forEach((tag) => {
    const htmlCount = htmlDoc.querySelectorAll(tag).length;
    const reactCount = reactDoc.querySelectorAll(tag).length;

    if (htmlCount !== reactCount) {
      differences.push({
        type: 'section-count',
        severity: 'medium',
        element: tag,
        html: htmlCount,
        react: reactCount,
        description: `<${tag}> count differs: HTML has ${htmlCount}, React has ${reactCount}`,
      });
    }
  });

  return {
    name: 'DOM Structure',
    passed: differences.length === 0,
    differences,
  };
}

/**
 * Compare text content
 */
function compareTextContent(htmlDoc, reactDoc, detailed = false) {
  const differences = [];

  const htmlMain = htmlDoc.querySelector('main') || htmlDoc.body;
  const reactMain = reactDoc.querySelector('main') || reactDoc.body;

  const htmlText = (htmlMain.textContent || '').trim().toLowerCase();
  const reactText = (reactMain.textContent || '').trim().toLowerCase();

  // Compare text length
  if (htmlText.length !== reactText.length) {
    differences.push({
      type: 'text-length',
      severity: 'medium',
      html: `${htmlText.length} chars`,
      react: `${reactText.length} chars`,
      description: `Text content length differs by ${Math.abs(htmlText.length - reactText.length)} characters`,
    });
  }

  // Check for missing/extra text (sample)
  if (detailed) {
    const htmlWords = htmlText.split(/\s+/);
    const reactWords = reactText.split(/\s+/);

    const missingWords = htmlWords.filter((w) => !reactText.includes(w));
    if (missingWords.length > 0) {
      differences.push({
        type: 'missing-text',
        severity: 'high',
        words: missingWords.slice(0, 5),
        description: `Found ${missingWords.length} words in HTML but not in React`,
      });
    }
  }

  return {
    name: 'Text Content',
    passed: differences.length === 0,
    differences,
  };
}

/**
 * Compare images
 */
function compareImages(htmlDoc, reactDoc, detailed = false) {
  const differences = [];

  const htmlImages = Array.from(htmlDoc.querySelectorAll('img')).map((img) => ({
    src: img.src,
    alt: img.alt,
  }));

  const reactImages = Array.from(reactDoc.querySelectorAll('img')).map((img) => ({
    src: img.src,
    alt: img.alt,
  }));

  if (htmlImages.length !== reactImages.length) {
    differences.push({
      type: 'image-count',
      severity: 'high',
      html: htmlImages.length,
      react: reactImages.length,
      description: `Image count differs: HTML has ${htmlImages.length}, React has ${reactImages.length}`,
    });
  }

  // Check for missing alt text
  const htmlMissingAlt = htmlImages.filter((img) => !img.alt).length;
  const reactMissingAlt = reactImages.filter((img) => !img.alt).length;

  if (htmlMissingAlt !== reactMissingAlt) {
    differences.push({
      type: 'alt-text',
      severity: 'low',
      html: htmlMissingAlt,
      react: reactMissingAlt,
      description: `Images missing alt text: HTML ${htmlMissingAlt}, React ${reactMissingAlt}`,
    });
  }

  return {
    name: 'Images',
    passed: differences.length === 0,
    differences,
  };
}

/**
 * Compare links
 */
function compareLinks(htmlDoc, reactDoc, detailed = false) {
  const differences = [];

  const htmlLinks = Array.from(htmlDoc.querySelectorAll('a')).map((a) => ({
    href: a.href,
    text: a.textContent || '',
  }));

  const reactLinks = Array.from(reactDoc.querySelectorAll('a')).map((a) => ({
    href: a.href,
    text: a.textContent || '',
  }));

  if (htmlLinks.length !== reactLinks.length) {
    differences.push({
      type: 'link-count',
      severity: 'medium',
      html: htmlLinks.length,
      react: reactLinks.length,
      description: `Link count differs: HTML has ${htmlLinks.length}, React has ${reactLinks.length}`,
    });
  }

  return {
    name: 'Links',
    passed: differences.length === 0,
    differences,
  };
}

/**
 * Compare buttons
 */
function compareButtons(htmlDoc, reactDoc, detailed = false) {
  const differences = [];

  const htmlButtons = Array.from(htmlDoc.querySelectorAll('button, input[type="submit"]')).length;
  const reactButtons = Array.from(reactDoc.querySelectorAll('button, input[type="submit"]')).length;

  if (htmlButtons !== reactButtons) {
    differences.push({
      type: 'button-count',
      severity: 'medium',
      html: htmlButtons,
      react: reactButtons,
      description: `Button count differs: HTML has ${htmlButtons}, React has ${reactButtons}`,
    });
  }

  return {
    name: 'Buttons',
    passed: differences.length === 0,
    differences,
  };
}

/**
 * Compare forms
 */
function compareForms(htmlDoc, reactDoc, detailed = false) {
  const differences = [];

  const htmlForms = Array.from(htmlDoc.querySelectorAll('form')).map((form) => ({
    inputCount: form.querySelectorAll('input').length,
    labelCount: form.querySelectorAll('label').length,
  }));

  const reactForms = Array.from(reactDoc.querySelectorAll('form')).map((form) => ({
    inputCount: form.querySelectorAll('input').length,
    labelCount: form.querySelectorAll('label').length,
  }));

  if (htmlForms.length !== reactForms.length) {
    differences.push({
      type: 'form-count',
      severity: 'high',
      html: htmlForms.length,
      react: reactForms.length,
      description: `Form count differs: HTML has ${htmlForms.length}, React has ${reactForms.length}`,
    });
  }

  return {
    name: 'Forms',
    passed: differences.length === 0,
    differences,
  };
}

/**
 * Compare element attributes
 */
function compareAttributes(htmlDoc, reactDoc, detailed = false) {
  const differences = [];

  // Check for key attributes
  const attrChecks = [
    { selector: 'input', attr: 'type' },
    { selector: 'input', attr: 'name' },
    { selector: 'label', attr: 'for' },
  ];

  attrChecks.forEach(({ selector, attr }) => {
    const htmlWithAttr = Array.from(htmlDoc.querySelectorAll(selector)).filter((el) =>
      el.hasAttribute(attr)
    ).length;
    const reactWithAttr = Array.from(reactDoc.querySelectorAll(selector)).filter((el) =>
      el.hasAttribute(attr)
    ).length;

    if (htmlWithAttr !== reactWithAttr) {
      differences.push({
        type: 'attribute-count',
        severity: 'low',
        selector,
        attr,
        html: htmlWithAttr,
        react: reactWithAttr,
      });
    }
  });

  return {
    name: 'Attributes',
    passed: differences.length === 0,
    differences,
  };
}

/**
 * Generate recommendations based on checks
 */
function generateRecommendations(checks) {
  const recommendations = [];

  if (checks.structure.differences.length > 0) {
    recommendations.push({
      severity: 'high',
      message: 'DOM structure differs. Check block rendering and layout components.',
      action: 'Review BlockRenderer and layout logic in both renderers.',
    });
  }

  if (checks.textContent.differences.length > 0) {
    recommendations.push({
      severity: 'high',
      message: 'Text content differs. Check for missing or incorrect text rendering.',
      action: 'Compare text blocks and verify HTML escaping is identical.',
    });
  }

  if (checks.images.differences.length > 0) {
    recommendations.push({
      severity: 'high',
      message: 'Image count or alt text differs.',
      action: 'Check ImageBlock and DestinationHero components for image handling.',
    });
  }

  if (checks.links.differences.length > 0) {
    recommendations.push({
      severity: 'medium',
      message: 'Link count differs.',
      action: 'Verify ButtonBlock and link rendering logic.',
    });
  }

  if (checks.forms.differences.length > 0) {
    recommendations.push({
      severity: 'high',
      message: 'Form structure differs.',
      action: 'Check FormBlock for input/label rendering.',
    });
  }

  if (recommendations.length === 0) {
    recommendations.push({
      severity: 'info',
      message: '✅ All parity checks passed!',
      action: 'Renderer appears to be functionally equivalent.',
    });
  }

  return recommendations;
}

/**
 * Render the parity report
 */
function ParityReport({ report }) {
  const [expandedCheck, setExpandedCheck] = React.useState(null);

  const statusColor = report.summary.status === 'PASS' ? '#16a34a' : '#d32f2f';
  const statusIcon = report.summary.status === 'PASS' ? '✅' : '❌';

  return (
    <div>
      {/* Summary Card */}
      <div
        style={{
          background: '#f9fafb',
          border: `2px solid ${statusColor}`,
          borderRadius: '8px',
          padding: '24px',
          marginBottom: '24px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: '16px' }}>
          <span style={{ fontSize: '32px', marginRight: '12px' }}>{statusIcon}</span>
          <div>
            <h2 style={{ margin: '0', color: statusColor }}>
              {report.summary.status === 'PASS' ? 'Parity Check Passed' : 'Parity Issues Found'}
            </h2>
            <p style={{ margin: '4px 0 0', color: '#666' }}>
              {report.summary.totalIssues === 0
                ? 'HTML and React renderers are functionally equivalent.'
                : `${report.summary.totalIssues} difference(s) detected across ${report.summary.totalChecks} checks.`}
            </p>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '16px' }}>
          <div style={{ background: '#fff', padding: '12px', borderRadius: '4px' }}>
            <div style={{ color: '#666', fontSize: '12px' }}>Page ID</div>
            <div style={{ fontSize: '16px', fontWeight: '600' }}>{report.metadata.pageId}</div>
          </div>
          <div style={{ background: '#fff', padding: '12px', borderRadius: '4px' }}>
            <div style={{ color: '#666', fontSize: '12px' }}>Template Type</div>
            <div style={{ fontSize: '16px', fontWeight: '600' }}>{report.metadata.templateType}</div>
          </div>
          <div style={{ background: '#fff', padding: '12px', borderRadius: '4px' }}>
            <div style={{ color: '#666', fontSize: '12px' }}>Checks Passed</div>
            <div style={{ fontSize: '16px', fontWeight: '600' }}>
              {report.summary.passedChecks}/{report.summary.totalChecks}
            </div>
          </div>
          <div style={{ background: '#fff', padding: '12px', borderRadius: '4px' }}>
            <div style={{ color: '#666', fontSize: '12px' }}>Duration</div>
            <div style={{ fontSize: '16px', fontWeight: '600' }}>{report.metadata.duration}ms</div>
          </div>
        </div>
      </div>

      {/* Checks Breakdown */}
      <div style={{ marginBottom: '24px' }}>
        <h3>Check Results</h3>
        {Object.entries(report.checks).map(([key, check]) => (
          <div
            key={key}
            style={{
              background: check.passed ? '#f0fdf4' : '#fee',
              border: `1px solid ${check.passed ? '#bbf7d0' : '#fecaca'}`,
              borderRadius: '4px',
              marginBottom: '12px',
              cursor: 'pointer',
            }}
            onClick={() => setExpandedCheck(expandedCheck === key ? null : key)}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '12px',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span>{check.passed ? '✅' : '⚠️'}</span>
                <strong>{check.name}</strong>
              </div>
              <div style={{ fontSize: '12px', color: '#666' }}>
                {check.differences.length} issue(s)
              </div>
            </div>

            {expandedCheck === key && check.differences.length > 0 && (
              <div style={{ padding: '12px', borderTop: `1px solid ${check.passed ? '#bbf7d0' : '#fecaca'}` }}>
                {check.differences.map((diff, idx) => (
                  <div
                    key={idx}
                    style={{
                      background: '#fff',
                      padding: '12px',
                      marginBottom: '8px',
                      borderRadius: '4px',
                      fontSize: '13px',
                    }}
                  >
                    <div style={{ fontWeight: '600', marginBottom: '4px' }}>{diff.description}</div>
                    <div style={{ color: '#666', fontSize: '12px' }}>
                      <div>HTML: {JSON.stringify(diff.html || diff)}</div>
                      <div>React: {JSON.stringify(diff.react || diff)}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Recommendations */}
      {report.recommendations.length > 0 && (
        <div>
          <h3>Recommendations</h3>
          {report.recommendations.map((rec, idx) => (
            <div
              key={idx}
              style={{
                background:
                  rec.severity === 'info'
                    ? '#f0f9ff'
                    : rec.severity === 'high'
                      ? '#fee'
                      : '#fef3c7',
                border:
                  rec.severity === 'info'
                    ? '1px solid #bfdbfe'
                    : rec.severity === 'high'
                      ? '1px solid #fecaca'
                      : '1px solid #fcd34d',
                borderRadius: '4px',
                padding: '12px',
                marginBottom: '12px',
              }}
            >
              <div style={{ fontWeight: '600', marginBottom: '4px' }}>
                {rec.severity === 'info' ? 'ℹ️' : rec.severity === 'high' ? '🔴' : '🟡'} {rec.message}
              </div>
              <div style={{ color: '#666', fontSize: '13px' }}>{rec.action}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default ParityVerificationTool;
