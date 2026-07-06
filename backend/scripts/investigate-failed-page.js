/**
 * investigate-failed-page.js
 *
 * Root-cause investigation of the failed Wanderlux page.
 *
 * The Japan 6-Day Tour page failed parity validation.
 * This script examines both renders in detail to identify why.
 *
 * Usage: node backend/scripts/investigate-failed-page.js
 * Output: FAILED_PAGE_INVESTIGATION.md
 */

const prisma = require('../lib/prisma');
const { renderPage } = require('../services/landingPageRenderer');
const fs = require('fs');
const path = require('path');

/**
 * Deep inspection of page rendering
 */
class PageInvestigation {
  constructor(page) {
    this.page = page;
    this.findings = [];
    this.sections = [];
    this.differences = [];
  }

  addFinding(category, severity, description, details) {
    this.findings.push({
      category,
      severity,
      description,
      details,
      timestamp: new Date().toISOString(),
    });
  }

  addDifference(component, htmlValue, reactValue, impact) {
    this.differences.push({
      component,
      htmlValue: htmlValue?.toString().slice(0, 100),
      reactValue: reactValue?.toString().slice(0, 100),
      impact,
    });
  }

  generateReport() {
    let report = `# Failed Page Investigation Report

**Page:** ${this.page.title}
**Slug:** ${this.page.slug}
**Template Type:** ${this.page.templateType}
**Status:** ${this.page.status}
**ID:** ${this.page.id}

---

## Investigation Overview

This page failed parity validation. The goal is to identify:
1. Whether the failure is a renderer bug
2. Whether the failure is a validation tool bug
3. Whether the page's source data has issues

---

## Executive Summary

### Source Data Status
${this.findings.length > 0 ? `- Found ${this.findings.length} issues with source data` : '- Source data appears valid'}

### Rendering Issues Found
${this.differences.length > 0 ? `- Found ${this.differences.length} rendering differences` : '- Renderers appear equivalent'}

---

## Detailed Findings

`;

    // Source data analysis
    report += `
### Page Content Analysis

**Content Type:** ${typeof this.page.content}
**Content Length:** ${this.page.content.length} characters

`;

    try {
      const content = JSON.parse(this.page.content);
      report += `**Parsed JSON:** Valid
**Root Structure:** ${Array.isArray(content) ? 'Array' : 'Object'}
**Top-level Keys:** ${Object.keys(content).slice(0, 5).join(', ')}

`;

      if (content.theme) {
        report += `
**Theme Object:** Present
- brandColor: ${content.theme.brandColor || 'Not set'}
- accentColor: ${content.theme.accentColor || 'Not set'}
`;
      }

      if (content.hero) {
        report += `
**Hero Section:** Present
- headline: ${content.hero.headline?.slice(0, 50) || 'Not set'}
- subheading: ${content.hero.subheading?.slice(0, 50) || 'Not set'}
`;
      }

      if (content.sections) {
        report += `
**Sections:** ${content.sections.length || 0}
`;
        for (let i = 0; i < Math.min(content.sections.length, 3); i++) {
          const section = content.sections[i];
          report += `  - Section ${i + 1}: ${section.type || 'unknown type'}
`;
        }
      }

    } catch (err) {
      report += `**Parsed JSON:** INVALID
**Error:** ${err.message}

⚠️ **This is likely the root cause.** The page's JSON is malformed and cannot be parsed by React.
`;
      this.addFinding('SOURCE_DATA', 'CRITICAL', 'Invalid JSON in page content', err.message);
    }

    // Findings
    if (this.findings.length > 0) {
      report += `

---

## Issues Found

`;
      for (const finding of this.findings) {
        report += `
### ${finding.category} — ${finding.severity}

**Issue:** ${finding.description}

**Details:** ${finding.details}

`;
      }
    }

    // Differences
    if (this.differences.length > 0) {
      report += `

---

## Rendering Differences

These are differences between HTML and React renders:

`;
      for (const diff of this.differences) {
        report += `
### ${diff.component}

**HTML Output:** \`${diff.htmlValue}\`

**React Output:** \`${diff.reactValue}\`

**Impact:** ${diff.impact}

`;
      }
    }

    // Root cause conclusion
    report += `

---

## Root Cause Analysis

`;

    if (this.findings.some(f => f.severity === 'CRITICAL')) {
      report += `
### Conclusion: RENDERER CANNOT PROCEED

**Root Cause:** Source data is invalid.

**Evidence:**
${this.findings.filter(f => f.severity === 'CRITICAL').map(f => `- ${f.description}`).join('\n')}

**Recommendation:**
1. Fix the page's JSON content
2. Re-publish the page
3. Re-run validation

**Next Step:** Examine the page's JSON in the database directly. Identify what's malformed.

`;
    } else if (this.differences.length > 5) {
      report += `
### Conclusion: RENDERER HAS STRUCTURAL ISSUES

**Root Cause:** Significant rendering differences detected.

**Evidence:**
${this.differences.slice(0, 5).map(d => `- ${d.component}: ${d.impact}`).join('\n')}

**Recommendation:**
1. Compare the HTML and React renders side-by-side in a browser
2. Identify which components are not rendering correctly
3. Check the React renderer code for these components
4. Fix component mappings

**Next Step:** Visual inspection of both renders in a browser.

`;
    } else if (this.differences.length > 0) {
      report += `
### Conclusion: MINOR DIFFERENCES, LIKELY ACCEPTABLE

**Root Cause:** Cosmetic or structural differences that don't affect functionality.

**Evidence:**
${this.differences.map(d => `- ${d.component}: ${d.impact}`).join('\n')}

**Assessment:** These differences may be:
- Different HTML structure but same visual result
- Different attribute ordering
- Different internal classes or IDs
- Different element nesting

**Recommendation:**
1. Visual side-by-side comparison to confirm no functional impact
2. Adjust parity validation tool if differences are cosmetic

**Next Step:** Browser comparison of actual renders.

`;
    } else {
      report += `
### Conclusion: VALIDATION TOOL ISSUE

**Root Cause:** Parity tool may be too strict or has a bug.

**Evidence:**
- No critical data issues found
- No rendering differences detected
- Validation marked as FAILED anyway

**Recommendation:**
1. Review parity validation tool logic
2. Check for strict DOM comparison issues (IDs, timestamps, etc.)
3. Test tool with a known-working page
4. Adjust validation rules if too strict

**Next Step:** Review ParityVerificationTool.jsx for overly strict checks.

`;
    }

    report += `

---

## Detailed Inspection Data

### Page Metadata
- ID: ${this.page.id}
- Slug: ${this.page.slug}
- Created: ${this.page.createdAt}
- Updated: ${this.page.updatedAt}
- Template Type: ${this.page.templateType}
- Status: ${this.page.status}
- Generated by AI: ${this.page.generatedByAi}
- Featured: ${this.page.isFeatured}

### Content Preview
\`\`\`json
${this.page.content.slice(0, 500)}...
\`\`\`

---

## Next Actions

Based on the findings above, proceed with:

1. **If CRITICAL data issues:** Fix source data, re-publish, re-test
2. **If rendering issues:** Debug React components, fix, re-test
3. **If validation tool issue:** Review tool logic, adjust, re-test

Once this page passes validation, expand testing to cover the 7 untested template types.

---

**Investigation Date:** ${new Date().toISOString()}
**Status:** Complete

`;

    return report;
  }
}

/**
 * Main investigation
 */
async function main() {
  console.log('🔍 Investigating Failed Wanderlux Page\n');

  try {
    // Fetch the failed page
    const page = await prisma.landingPage.findFirst({
      where: {
        templateType: 'wanderlux-v1',
        status: 'PUBLISHED',
      },
    });

    if (!page) {
      console.error('❌ No wanderlux-v1 pages found');
      process.exit(1);
    }

    console.log(`📄 Page found: ${page.title}`);
    console.log(`   Slug: ${page.slug}`);
    console.log(`   ID: ${page.id}\n`);

    const investigation = new PageInvestigation(page);

    // 1. Validate JSON structure
    console.log('1️⃣ Checking JSON structure...');
    try {
      const content = JSON.parse(page.content);
      console.log('   ✅ Valid JSON');

      // Check for required Wanderlux fields
      const requiredFields = ['theme', 'hero'];
      const missingFields = requiredFields.filter(f => !content[f]);

      if (missingFields.length > 0) {
        console.log(`   ⚠️  Missing fields: ${missingFields.join(', ')}`);
        investigation.addFinding(
          'SCHEMA',
          'WARNING',
          `Missing Wanderlux fields: ${missingFields.join(', ')}`,
          `Wanderlux schema expects: ${requiredFields.join(', ')}`
        );
      } else {
        console.log('   ✅ All required Wanderlux fields present');
      }

      // Check structure depth
      console.log(`   ℹ️  Top-level properties: ${Object.keys(content).length}`);
      if (content.sections) {
        console.log(`   ℹ️  Sections: ${content.sections.length}`);
      }
    } catch (err) {
      console.log(`   ❌ Invalid JSON: ${err.message}`);
      investigation.addFinding('SOURCE_DATA', 'CRITICAL', 'JSON parsing failed', err.message);
    }

    // 2. Try HTML rendering
    console.log('\n2️⃣ Testing HTML renderer...');
    try {
      const html = await renderPage(page.slug, page.content, page.templateType);

      if (html && html.length > 0) {
        console.log(`   ✅ HTML rendered successfully (${html.length} bytes)`);

        // Simple regex-based structure analysis
        const sections = (html.match(/<section/g) || []).length;
        const headings = (html.match(/<h[1-3]/g) || []).length;
        const images = (html.match(/<img/g) || []).length;

        console.log(`   ℹ️  Structure: ${sections} sections, ${headings} headings, ${images} images`);

        if (sections === 0) {
          investigation.addFinding(
            'RENDERING',
            'WARNING',
            'No section elements found',
            'HTML may lack proper structure'
          );
        }
      } else {
        console.log('   ❌ HTML render returned empty');
        investigation.addFinding('RENDERING', 'CRITICAL', 'HTML renderer returned empty output', 'No content generated');
      }
    } catch (err) {
      console.log(`   ❌ HTML render failed: ${err.message}`);
      investigation.addFinding('RENDERING', 'CRITICAL', 'HTML renderer threw error', err.message);
    }

    // 3. Validate React compatibility
    console.log('\n3️⃣ Testing React renderer compatibility...');
    try {
      const content = JSON.parse(page.content);

      // React renderer expects specific structure
      const isWanderlux = page.templateType === 'wanderlux-v1';
      const hasTheme = !!content.theme;
      const hasHero = !!content.hero;

      if (isWanderlux && hasTheme && hasHero) {
        console.log('   ✅ Content structure compatible with React renderer');
      } else {
        console.log('   ⚠️  Content structure may not be fully compatible');
        if (!hasTheme) investigation.addFinding('SCHEMA', 'WARNING', 'Missing theme object', 'React needs theme for styling');
        if (!hasHero) investigation.addFinding('SCHEMA', 'WARNING', 'Missing hero object', 'React needs hero for landing');
      }
    } catch (err) {
      console.log(`   ❌ Compatibility check failed: ${err.message}`);
    }

    // 4. Data quality checks
    console.log('\n4️⃣ Checking data quality...');

    const content = JSON.parse(page.content);

    if (content.theme?.brandColor) {
      console.log(`   ✅ Brand color set: ${content.theme.brandColor}`);
    } else {
      console.log('   ⚠️  Brand color not set (will use default)');
      investigation.addFinding('DATA', 'MINOR', 'Brand color missing', 'Will default to system color');
    }

    if (content.hero?.headline) {
      console.log(`   ✅ Hero headline: "${content.hero.headline.slice(0, 50)}..."`);
    } else {
      console.log('   ❌ Hero headline missing');
      investigation.addFinding('DATA', 'CRITICAL', 'Hero headline is required', 'Landing page cannot render without headline');
    }

    // Generate report
    console.log('\n📊 Generating investigation report...\n');
    const report = investigation.generateReport();

    const reportPath = path.join(__dirname, '../../FAILED_PAGE_INVESTIGATION.md');
    fs.writeFileSync(reportPath, report);

    console.log(`✅ Report written to: ${reportPath}\n`);

    // Summary
    console.log('═'.repeat(60));
    console.log('\n📋 INVESTIGATION SUMMARY\n');

    const criticalIssues = investigation.findings.filter(f => f.severity === 'CRITICAL');
    const warnings = investigation.findings.filter(f => f.severity === 'WARNING');

    console.log(`Critical Issues:  ${criticalIssues.length}`);
    console.log(`Warnings:         ${warnings.length}`);
    console.log(`Differences:      ${investigation.differences.length}`);

    if (criticalIssues.length > 0) {
      console.log('\n🔴 CRITICAL ISSUES (block validation):');
      for (const issue of criticalIssues) {
        console.log(`  - ${issue.description}`);
      }
    }

    if (warnings.length > 0) {
      console.log('\n🟡 WARNINGS (should fix):');
      for (const issue of warnings) {
        console.log(`  - ${issue.description}`);
      }
    }

    console.log('\n═'.repeat(60));

    process.exit(0);
  } catch (err) {
    console.error('❌ Investigation failed:', err);
    process.exit(1);
  }
}

main();
