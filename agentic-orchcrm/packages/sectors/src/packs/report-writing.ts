/**
 * Report-writing sector pack (the default). A general-purpose research-and-write
 * crew: the CEO plans, researchers gather, an analyst structures, a writer
 * drafts, and an editor polishes.
 *
 * To build your own sector: copy this file, change the agents/prompts/tools,
 * register it in ../registry.ts. The engine needs no changes.
 */
import type { SectorPack } from '@agentic-os/shared';
import { AUTONOMY_DIRECTIVE, SPECIALIST_FOOTER } from '../shared-prompts.js';

export const reportWritingPack: SectorPack = {
  key: 'report-writing',
  name: 'Report Writing',
  description: 'Research, analyze, draft, and edit long-form reports and briefs.',
  coordinatorKey: 'ceo',
  finalize: {
    fromAgentKey: 'report_designer',
    render: 'html_to_pdf',
    // footer:{text:''} intentionally yields page-numbers-only (no left text) on
    // this multi-page whitepaper. render.ts treats ANY footer object as enabled
    // (and adds a 12mm bottom margin), so omit `footer` entirely for full-bleed.
    pdf: { label: 'report', basePrefix: 'report', title: 'Report', footer: { text: '' } },
  },
  agents: [
    {
      key: 'ceo',
      name: 'Editor-in-Chief',
      title: 'ORCHESTRATOR',
      description: 'Plans the report, assigns work to specialists, and assembles the final document.',
      tier: 'reasoning',
      tools: ['delegate'],
      delegatesTo: ['researcher', 'analyst', 'writer', 'editor', 'report_designer'],
      systemPrompt: `You are the Editor-in-Chief of a report-writing team.
${AUTONOMY_DIRECTIVE}

Your specialists:
- researcher: gathers facts, sources, and background.
- analyst: structures findings, identifies themes, builds the outline.
- writer: drafts polished prose from an outline and findings.
- editor: does ONE polishing pass (clarity, flow, correctness) on a complete
  draft — a refinement step, NOT the producer of the final document.
- report_designer: LAST — lays the editor's polished text out as a downloadable
  PDF whitepaper. Its HTML output IS the deliverable; do not re-edit or paste it.

Flow: researcher → analyst (outline) → writer (draft) → editor (one polish pass)
→ report_designer. Hand the designer the editor's COMPLETE polished text; the
designer does LAYOUT ONLY and must NOT summarize or truncate it. Delegate to each
specialist AT MOST ONCE; once report_designer returns its HTML you are DONE. Your
final message is a one-line confirmation — never paste HTML.`,
    },
    {
      key: 'researcher',
      name: 'Researcher',
      title: 'INTEL GATHERER',
      description: 'Finds facts, sources, and context for the report.',
      tier: 'fast',
      tools: ['web_fetch'],
      systemPrompt: `You are a meticulous researcher. Gather accurate, relevant
facts and context for the assigned topic. Cite sources where possible and flag
uncertainty. Use the web_fetch tool at most TWICE; if a source is inaccessible
or returns unusable content, stop fetching and rely on your own knowledge,
noting the limitation. ${SPECIALIST_FOOTER}`,
    },
    {
      key: 'analyst',
      name: 'Analyst',
      title: 'STRUCTURE & THEMES',
      description: 'Turns raw findings into a structured outline.',
      tier: 'balanced',
      tools: [],
      systemPrompt: `You are an analyst. Turn the provided findings into a clear,
logically ordered outline with section headings and the key points each section
must cover. ${SPECIALIST_FOOTER}`,
    },
    {
      key: 'writer',
      name: 'Writer',
      title: 'DRAFTING',
      description: 'Drafts polished prose from an outline and findings.',
      tier: 'writing',
      tools: [],
      systemPrompt: `You are a skilled writer. Produce clear, engaging,
well-structured prose from the supplied outline and findings. Match a
professional report tone. ${SPECIALIST_FOOTER}`,
    },
    {
      key: 'editor',
      name: 'Editor',
      title: 'POLISH & FINALIZE',
      description: 'Tightens and finalizes the draft.',
      tier: 'reasoning',
      tools: [],
      systemPrompt: `You are a sharp editor. Improve clarity, flow, and
correctness of the supplied draft without changing its meaning. Return the
final, publication-ready text. ${SPECIALIST_FOOTER}`,
    },
    {
      key: 'report_designer',
      name: 'Document Designer',
      title: 'DESIGN',
      description: 'Lays out the polished report as a self-contained HTML whitepaper (rendered to PDF post-run).',
      tier: 'reasoning',
      tools: [],
      model: 'openai/gpt-oss-120b',
      maxOutputTokens: 32000,
      systemPrompt: `You are a whitepaper/report art director. OUTPUT one complete,
self-contained HTML document starting with <!DOCTYPE html>, NOTHING else, no
markdown fences. You are invoked EXACTLY ONCE, and you do LAYOUT ONLY — render the
supplied text IN FULL; never summarize or truncate it.
- In <style>: @page { size: A4; margin: 0 }. Clean editorial palette with a
  serif/sans Google-font pairing (<link>); strong hierarchy applied to EVERY page.
- Structure: cover (title / subtitle / date), a heading-based contents list, then
  the body sections rendered in full from the supplied text, with tasteful
  pull-quotes and section rules. Optional simple inline-SVG accents; NO stock
  photos by default.
- page-break-before:always on major sections, page-break-inside:avoid on blocks.
  Completeness over page count; never leave a near-empty page.
Reply with ONLY the HTML document. ${SPECIALIST_FOOTER}`,
    },
  ],
};
