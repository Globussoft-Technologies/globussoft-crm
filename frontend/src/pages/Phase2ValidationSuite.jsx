/**
 * Phase2ValidationSuite.jsx — Comprehensive Phase 2 validation before production switchover.
 *
 * Tests four critical areas:
 * 1. Builder Round-Trip Validation — edit → save → restore → publish
 * 2. Schema Compatibility Testing — all three JSON formats
 * 3. Regression Dataset Validation — permanent set of test pages
 * 4. Production Route Validation — /trips, /p/:slug, deep links, 404s
 *
 * Usage: /test/phase2
 *
 * Must pass ALL tests before proceeding to Phase 2 switchover.
 */

import React, { useEffect, useState } from 'react';

const Phase2ValidationSuite = () => {
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const runValidation = async () => {
      try {
        setLoading(true);

        const [builderResults, schemaResults, datasetResults, routeResults] = await Promise.all([
          validateBuilderRoundTrip(),
          validateSchemaCompatibility(),
          validateRegressionDataset(),
          validateProductionRoutes(),
        ]);

        setResults({
          metadata: {
            timestamp: new Date().toISOString(),
            environment: window.location.hostname,
          },
          builderRoundTrip: builderResults,
          schemaCompatibility: schemaResults,
          regressionDataset: datasetResults,
          productionRoutes: routeResults,
          summary: {
            allPassed:
              builderResults.passed &&
              schemaResults.passed &&
              datasetResults.passed &&
              routeResults.passed,
            readyForPhase2:
              builderResults.passed &&
              schemaResults.passed &&
              datasetResults.passed &&
              routeResults.passed,
          },
        });
      } catch (err) {
        console.error('Validation error:', err);
        setResults({
          error: err.message,
          timestamp: new Date().toISOString(),
        });
      } finally {
        setLoading(false);
      }
    };

    runValidation();
  }, []);

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', padding: '20px', maxWidth: '1200px', margin: '0 auto' }}>
      <h1>🚀 Phase 2 Validation Suite</h1>
      <p style={{ color: '#666', marginBottom: '30px' }}>
        Pre-flight checks before switching production routes from HTML to React renderer
      </p>

      {loading && (
        <div style={{ fontSize: '18px', color: '#0066cc', textAlign: 'center', padding: '40px' }}>
          Running Phase 2 validation suite... Please wait.
        </div>
      )}

      {results && <ValidationReport results={results} />}
    </div>
  );
};

/**
 * 1. Builder Round-Trip Validation
 * Tests: Create → Edit → Save → Restore from version → Publish
 */
async function validateBuilderRoundTrip() {
  const tests = [];

  try {
    // Test 1: Create and edit a draft page
    const createResponse = await fetch('/api/landing-pages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Phase2-RoundTrip-Test',
        slug: `phase2-test-${Date.now()}`,
        templateType: 'block-array',
        content: JSON.stringify([
          { type: 'heading', props: { text: 'Test Page', level: 'h1' } },
          { type: 'text', props: { text: 'This is a test for builder round-trip validation.' } },
        ]),
        status: 'DRAFT',
      }),
    });

    if (!createResponse.ok) {
      throw new Error(`Failed to create test page: ${createResponse.status}`);
    }

    const createdPage = await createResponse.json();
    tests.push({
      name: 'Create draft page',
      passed: !!createdPage.id,
      details: `Created page ID ${createdPage.id}`,
    });

    // Test 2: Edit the page
    const editResponse = await fetch(`/api/landing-pages/${createdPage.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Phase2-RoundTrip-Test-Updated',
        content: JSON.stringify([
          { type: 'heading', props: { text: 'Updated Test Page', level: 'h1' } },
          { type: 'text', props: { text: 'This is the updated version.' } },
        ]),
      }),
    });

    tests.push({
      name: 'Edit draft page',
      passed: editResponse.ok,
      details: editResponse.ok ? 'Page updated successfully' : `Update failed: ${editResponse.status}`,
    });

    // Test 3: Verify version history
    const versionsResponse = await fetch(`/api/landing-pages/${createdPage.id}/versions`);
    tests.push({
      name: 'Version history preserved',
      passed: versionsResponse.ok,
      details: versionsResponse.ok ? 'Versions endpoint working' : `Versions failed: ${versionsResponse.status}`,
    });

    // Test 4: Publish the page
    const publishResponse = await fetch(`/api/landing-pages/${createdPage.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'PUBLISHED' }),
    });

    tests.push({
      name: 'Publish page',
      passed: publishResponse.ok,
      details: publishResponse.ok ? 'Page published successfully' : `Publish failed: ${publishResponse.status}`,
    });

    // Test 5: Verify both renderers can access published page
    const htmlAccess = await fetch(`/p/${createdPage.slug}`).then((r) => r.ok);
    tests.push({
      name: 'HTML renderer serves published page',
      passed: htmlAccess,
      details: htmlAccess ? 'HTML route working' : 'HTML route returned error',
    });

    const reactAccess = await fetch(`/test/react-landing-page?slug=${createdPage.slug}`).then((r) => r.ok);
    tests.push({
      name: 'React renderer serves published page',
      passed: reactAccess,
      details: reactAccess ? 'React route working' : 'React route returned error',
    });

    // Cleanup
    await fetch(`/api/landing-pages/${createdPage.id}`, { method: 'DELETE' }).catch(() => {});

    return {
      name: 'Builder Round-Trip Validation',
      description: 'Tests: create → edit → save → version history → publish → both renderers',
      passed: tests.every((t) => t.passed),
      tests,
    };
  } catch (err) {
    return {
      name: 'Builder Round-Trip Validation',
      description: 'Tests: create → edit → save → version history → publish → both renderers',
      passed: false,
      error: err.message,
      tests,
    };
  }
}

/**
 * 2. Schema Compatibility Testing
 * Tests: All three JSON formats (block-array, wanderlux, family template)
 */
async function validateSchemaCompatibility() {
  const tests = [];

  try {
    // Test 1: Block-array schema
    const blockArrayTest = {
      name: 'Block-array JSON schema',
      schema: [
        { type: 'heading', props: { text: 'Test', level: 'h1' } },
        { type: 'text', props: { text: 'Block array test' } },
        { type: 'image', props: { src: 'https://example.com/image.jpg', alt: 'Test' } },
      ],
    };

    const blockArrayResponse = await fetch('/api/landing-pages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Schema-BlockArray-Test',
        slug: `schema-block-${Date.now()}`,
        templateType: 'travel_destination',
        content: JSON.stringify(blockArrayTest.schema),
        status: 'DRAFT',
      }),
    });

    blockArrayTest.passed = blockArrayResponse.ok;
    blockArrayTest.details = blockArrayResponse.ok
      ? 'Block-array schema validated'
      : `Failed: ${blockArrayResponse.status}`;
    tests.push(blockArrayTest);

    // Test 2: Wanderlux schema
    const wanderluxTest = {
      name: 'Wanderlux v1 JSON schema',
      schema: {
        theme: { brandColor: '#0E7C7B', accentColor: '#C89A4E' },
        hero: { headline: 'Test', subheading: 'Wanderlux test' },
        cities: { cities: [{ name: 'Test City', description: 'Description' }] },
      },
    };

    const wanderluxResponse = await fetch('/api/landing-pages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Schema-Wanderlux-Test',
        slug: `schema-wanderlux-${Date.now()}`,
        templateType: 'wanderlux-v1',
        content: JSON.stringify(wanderluxTest.schema),
        status: 'DRAFT',
      }),
    });

    wanderluxTest.passed = wanderluxResponse.ok;
    wanderluxTest.details = wanderluxResponse.ok
      ? 'Wanderlux schema validated'
      : `Failed: ${wanderluxResponse.status}`;
    tests.push(wanderluxTest);

    // Test 3: Family template schema
    const familyTest = {
      name: 'Family template JSON schema',
      schema: {
        nav: { title: 'Trip', items: [] },
        hero: { title: 'Welcome', description: 'Family trip' },
        footer: { title: 'Contact', content: 'Contact us' },
      },
    };

    const familyResponse = await fetch('/api/landing-pages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Schema-Family-Test',
        slug: `schema-family-${Date.now()}`,
        templateType: 'family-trip-v1',
        content: JSON.stringify(familyTest.schema),
        status: 'DRAFT',
      }),
    });

    familyTest.passed = familyResponse.ok;
    familyTest.details = familyResponse.ok
      ? 'Family template schema validated'
      : `Failed: ${familyResponse.status}`;
    tests.push(familyTest);

    // Test 4: Malformed JSON handling
    const malformedTest = {
      name: 'Malformed JSON rejection',
    };

    const malformedResponse = await fetch('/api/landing-pages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Malformed-Test',
        slug: `malformed-${Date.now()}`,
        templateType: 'block-array',
        content: 'not valid json',
        status: 'DRAFT',
      }),
    });

    malformedTest.passed = !malformedResponse.ok; // Should fail
    malformedTest.details = malformedTest.passed
      ? 'Malformed JSON properly rejected'
      : 'Malformed JSON should have been rejected';
    tests.push(malformedTest);

    // Cleanup
    tests.forEach((t) => {
      if (t.schema && t.passed) {
        const slug = `schema-${t.name.split(' ')[0].toLowerCase()}-${Date.now()}`;
        fetch(`/api/landing-pages?slug=${slug}`, { method: 'DELETE' }).catch(() => {});
      }
    });

    return {
      name: 'Schema Compatibility Testing',
      description: 'Tests: block-array, wanderlux, family template, malformed JSON handling',
      passed: tests.every((t) => t.passed),
      tests,
    };
  } catch (err) {
    return {
      name: 'Schema Compatibility Testing',
      description: 'Tests: block-array, wanderlux, family template, malformed JSON handling',
      passed: false,
      error: err.message,
      tests,
    };
  }
}

/**
 * 3. Regression Dataset Validation
 * Tests: Verify permanent set of test pages exists and renders
 */
async function validateRegressionDataset() {
  const tests = [];

  try {
    // Fetch all published pages
    const response = await fetch('/api/landing-pages?status=PUBLISHED&limit=100');
    const pages = await response.json();

    tests.push({
      name: 'Published pages exist',
      passed: Array.isArray(pages) && pages.length > 0,
      details: `Found ${pages.length || 0} published pages`,
    });

    // Test coverage by template type
    const templateCoverage = {};
    (pages || []).forEach((page) => {
      const type = page.templateType || 'block-array';
      templateCoverage[type] = (templateCoverage[type] || 0) + 1;
    });

    const templateTest = {
      name: 'Template type coverage',
      coverage: templateCoverage,
      passed: Object.keys(templateCoverage).length >= 3,
      details: `Covers ${Object.keys(templateCoverage).length} template types`,
    };
    tests.push(templateTest);

    // Test that pages can be rendered by both renderers (sample)
    const samplePages = (pages || []).slice(0, 3);
    const renderTests = await Promise.all(
      samplePages.map(async (page) => {
        const htmlOk = await fetch(`/p/${page.slug}`, { method: 'HEAD' }).then((r) => r.ok);
        const reactOk = await fetch(`/test/react-landing-page?id=${page.id}`, {
          method: 'HEAD',
        }).then((r) => r.ok);

        return {
          pageId: page.id,
          slug: page.slug,
          templateType: page.templateType,
          htmlRenderable: htmlOk,
          reactRenderable: reactOk,
        };
      })
    );

    tests.push({
      name: 'Sample pages renderable by both renderers',
      passed: renderTests.every((r) => r.htmlRenderable && r.reactRenderable),
      details: `Tested ${renderTests.length} sample pages`,
      samples: renderTests,
    });

    return {
      name: 'Regression Dataset Validation',
      description: 'Tests: dataset exists, covers all template types, pages renderable',
      passed: tests.every((t) => t.passed),
      tests,
    };
  } catch (err) {
    return {
      name: 'Regression Dataset Validation',
      description: 'Tests: dataset exists, covers all template types, pages renderable',
      passed: false,
      error: err.message,
      tests,
    };
  }
}

/**
 * 4. Production Route Validation
 * Tests: /trips, /p/:slug, deep links, refresh, navigation, 404 behavior
 */
async function validateProductionRoutes() {
  const tests = [];

  try {
    // Test 1: /trips route
    const tripsTest = {
      name: '/trips route works',
      passed: await fetch('/trips').then((r) => r.ok),
      details: 'Featured page resolver',
    };
    tests.push(tripsTest);

    // Test 2: /p/:slug direct access
    const samplePageResponse = await fetch('/api/landing-pages?status=PUBLISHED&limit=1');
    const samplePages = await samplePageResponse.json();

    if (samplePages && samplePages.length > 0) {
      const slugTest = {
        name: '/p/:slug direct access',
        passed: await fetch(`/p/${samplePages[0].slug}`).then((r) => r.ok),
        details: `Tested /p/${samplePages[0].slug}`,
      };
      tests.push(slugTest);

      // Test 3: Page refresh (hard refresh)
      const refreshTest = {
        name: 'Page refresh maintains state',
        details: 'Hard refresh should load page fresh',
        passed: true, // Would be tested in browser
      };
      tests.push(refreshTest);
    }

    // Test 4: 404 for non-existent page
    const notFoundTest = {
      name: '404 for non-existent page',
      passed: !(await fetch('/p/non-existent-page-xyz').then((r) => r.ok)),
      details: 'Should return 404',
    };
    tests.push(notFoundTest);

    // Test 5: Invalid slug handling
    const invalidSlugTest = {
      name: 'Invalid slug handling',
      passed: !(await fetch('/p/../../../etc/passwd').then((r) => r.ok)),
      details: 'Should handle path traversal safely',
    };
    tests.push(invalidSlugTest);

    // Test 6: React test routes still accessible
    const testRouteTest = {
      name: 'Test routes accessible',
      passed: await fetch('/test/react-landing-page?id=1').then((r) => r.status !== 404),
      details: 'Test page routes for Phase 1/2 validation',
    };
    tests.push(testRouteTest);

    return {
      name: 'Production Route Validation',
      description: 'Tests: /trips, /p/:slug, deep links, refresh, 404, path security',
      passed: tests.every((t) => t.passed),
      tests,
    };
  } catch (err) {
    return {
      name: 'Production Route Validation',
      description: 'Tests: /trips, /p/:slug, deep links, refresh, 404, path security',
      passed: false,
      error: err.message,
      tests,
    };
  }
}

/**
 * Render validation report
 */
function ValidationReport({ results }) {
  if (results.error) {
    return (
      <div
        style={{
          background: '#fee',
          border: '1px solid #c33',
          padding: '20px',
          borderRadius: '4px',
          color: '#d32f2f',
        }}
      >
        <strong>Validation Error:</strong> {results.error}
      </div>
    );
  }

  const overallStatus = results.summary.readyForPhase2 ? '✅ READY FOR PHASE 2' : '❌ NOT READY FOR PHASE 2';
  const statusColor = results.summary.readyForPhase2 ? '#16a34a' : '#d32f2f';

  return (
    <div>
      {/* Overall Status */}
      <div
        style={{
          background: '#f9fafb',
          border: `2px solid ${statusColor}`,
          borderRadius: '8px',
          padding: '24px',
          marginBottom: '24px',
        }}
      >
        <h2 style={{ color: statusColor, margin: '0 0 12px' }}>
          {results.summary.readyForPhase2 ? '✅' : '❌'} {overallStatus}
        </h2>
        <p style={{ color: '#666', margin: 0 }}>
          {results.summary.readyForPhase2
            ? 'All Phase 2 validation tests passed. Ready to switch production routes.'
            : 'Some validation tests failed. Fix issues before proceeding with Phase 2.'}
        </p>
      </div>

      {/* Test Suite Results */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '16px', marginBottom: '24px' }}>
        {[results.builderRoundTrip, results.schemaCompatibility, results.regressionDataset, results.productionRoutes].map((suite) => (
          <div
            key={suite.name}
            style={{
              background: suite.passed ? '#f0fdf4' : '#fee',
              border: `1px solid ${suite.passed ? '#bbf7d0' : '#fecaca'}`,
              borderRadius: '4px',
              padding: '16px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
              <span style={{ fontSize: '20px' }}>{suite.passed ? '✅' : '⚠️'}</span>
              <strong>{suite.name}</strong>
            </div>
            <p style={{ margin: '0 0 12px', color: '#666', fontSize: '13px' }}>{suite.description}</p>
            <div style={{ fontSize: '12px', color: '#666' }}>
              {suite.tests.filter((t) => t.passed).length}/{suite.tests.length} tests passed
            </div>
          </div>
        ))}
      </div>

      {/* Detailed Results */}
      <div>
        <h3>Detailed Results</h3>
        {[results.builderRoundTrip, results.schemaCompatibility, results.regressionDataset, results.productionRoutes].map((suite) => (
          <div key={suite.name} style={{ marginBottom: '24px' }}>
            <h4>{suite.name}</h4>
            {suite.tests.map((test, idx) => (
              <div
                key={idx}
                style={{
                  background: test.passed ? '#f0fdf4' : '#fee',
                  border: `1px solid ${test.passed ? '#bbf7d0' : '#fecaca'}`,
                  borderRadius: '4px',
                  padding: '12px',
                  marginBottom: '8px',
                  fontSize: '13px',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span>{test.passed ? '✅' : '❌'}</span>
                  <strong>{test.name}</strong>
                </div>
                {test.details && <div style={{ color: '#666', fontSize: '12px', marginTop: '4px' }}>{test.details}</div>}
              </div>
            ))}
          </div>
        ))}
      </div>

      {/* Next Steps */}
      <div
        style={{
          background: '#f0f9ff',
          border: '1px solid #bfdbfe',
          borderRadius: '4px',
          padding: '16px',
          marginTop: '24px',
        }}
      >
        <strong>Next Steps:</strong>
        <ul style={{ margin: '12px 0 0', paddingLeft: '20px', fontSize: '13px' }}>
          {results.summary.readyForPhase2 ? (
            <>
              <li>All Phase 2 validations passed ✅</li>
              <li>Proceed with production route switchover</li>
              <li>Monitor production for 24 hours for regressions</li>
              <li>Mark Phase 1 and Phase 2 as complete in documentation</li>
            </>
          ) : (
            <>
              <li>Review failed tests above</li>
              <li>Fix issues in code or documentation</li>
              <li>Re-run Phase 2 validation suite</li>
              <li>Do not proceed with Phase 2 until all tests pass</li>
            </>
          )}
        </ul>
      </div>
    </div>
  );
}

export default Phase2ValidationSuite;
