/**
 * Orchestrator — the public entry point. A human hands it ONE goal; it runs the
 * sector's coordinator (CEO) agent, which autonomously delegates to specialists
 * via the `delegate` tool. Delegation is recursive but depth-capped.
 *
 * This is the only object apps need to know about to start a run.
 */
import type { AgentDefinition, OrchestrationEvent, OrchestrationEventType } from '@agentic-os/shared';
import { newEventId, newRunId } from '@agentic-os/shared';
import { getAgent, getSectorPack, resolveArtDirection, wrapArtDirection } from '@agentic-os/sectors';
import {
  looksLikeHtml,
  renderHtmlToArtifact,
  measureEditorialBlocks,
  buildBrochureHtml,
  parseBrochureContent,
  buildFallbackBrochureContent,
  ensureBriefCoverage,
  getTemplate,
  type BrandKit,
  type LogoPlacement,
} from '@agentic-os/tools';
import { runAgent, type EngineDeps } from '../agent/agent-loop.js';
import type { RunStore } from '../run/events.js';

export interface RunGoalArgs {
  /** Provide to resume/attach to a known id; otherwise one is generated. */
  runId?: string;
  /** Which sector pack to load, e.g. "report-writing". */
  sectorKey: string;
  /** The single instruction from the human. */
  goal: string;
  /**
   * Optional design style for sectors that offer them (see finalize.styles).
   * Resolved to art-direction and injected into the finalize agent's prompt.
   * Allowlisted at the API boundary.
   */
  styleKey?: string;
  /**
   * Optional, TRUSTED brand kit resolved at the API boundary (logo as an inert
   * data: URI built from an uploaded file + optional name/contact/colours/socials).
   * Never LLM-supplied. The logo PLACEMENT is parsed from `goal` here (the caller
   * passes the kit WITHOUT a `placement`, or it is overwritten) — UNLESS the kit
   * carries a `custom` placement from the visual placer, which is clamped numbers/
   * enums (server-validated) and OVERRIDES the parsed placement in the engine.
   */
  brand?: BrandKit;
}

/**
 * Parse where the user wants their logo from the natural-language goal, into a
 * FIXED enum (never raw user text → no injection into CSS/markup). Defaults to a
 * tasteful 'cover' mark when the prompt says nothing about placement.
 */
export function parseLogoPlacement(goal: string): LogoPlacement {
  const g = ` ${(goal || '').toLowerCase()} `;
  const mentionsLogo = /\b(logo|brand ?mark|emblem|wordmark|crest|insignia)\b/.test(g);
  const everyPage = /\b(every|each|all)\s+pages?\b|\bon\s+all\s+pages?\b|\brunning\b|\bheader\b/.test(g);
  const left = /\b(top|upper)[\s-]*left\b|\bleft[\s-]*(top|corner)\b/.test(g);
  const right = /\b(top|upper)[\s-]*right\b|\bright[\s-]*(top|corner)\b/.test(g);
  const footer = /\bfooter\b|\bbottom\b|\bfoot of (the )?page\b/.test(g);
  const coverOnly = /\b(cover|front|title)\s*(page)?\s*(only|just)\b|\bonly\b.*\bcover\b/.test(g);
  const coverWord = /\bcover\b|\bfront\s*page\b|\btitle\s*page\b/.test(g);
  if (!mentionsLogo && !left && !right && !everyPage && !footer) return 'cover';
  // An explicit "only/just the cover" wins outright.
  if (coverOnly) return 'cover-only';
  // "Every / all pages" (or "footer of every page"): a repeating mark on every
  // page, which ALSO keeps the prominent cover mark. When a side is named with it
  // ("…on every page, top-left"), honour the side; otherwise default to top-left.
  // Checked BEFORE a bare side so "prominently on the cover AND on every page,
  // top-left" gives both — prominent cover + a subtle corner mark throughout —
  // rather than collapsing to a cover-corner-only mark.
  if (everyPage || footer) {
    if (right) return 'top-right';
    return 'top-left';
  }
  if (left) return 'top-left';
  if (right) return 'top-right';
  return 'cover';
}

export interface RunGoalResult {
  runId: string;
  result: string;
}

/**
 * The verbatim user brief, framed as the composer's AUTHORITATIVE source of truth.
 * Drift (a paraphrased duration / accent / count) is the #1 fidelity failure, so
 * the composer always receives the brief itself with an explicit "copy facts
 * exactly" instruction — the brief wins over any upstream paraphrase.
 */
const AUTHORITATIVE_BRIEF_HEADER =
  '===== ORIGINAL USER BRIEF — THE AUTHORITATIVE SOURCE OF TRUTH =====\n' +
  'Copy every concrete fact from this brief EXACTLY: trip DURATION (a "1 Day" trip is ONE day — never pad it into more days), all dates and clock times, the ROUTE and its stop order & count, group size, every price, all contacts, the agency name, and any stated ACCENT colours. Do NOT invent, pad, drop, or change a number. Map EVERY labelled block (itinerary, learning outcomes, inclusions, exclusions, important information, cancellation policy, about-us, call-to-action, etc.) into a field or a sections[] entry so nothing is lost.';

/**
 * Build the composer's task: the coordinator's instruction + the verbatim brief
 * (authoritative) + upstream specialists' outputs (real asset URLs / route-map /
 * copy / disclaimers, used verbatim — but the brief wins on any conflict).
 */
function composerThreadedTask(
  baseTask: string,
  goal: string,
  last: Record<string, string>,
  composerKey: string,
): string {
  const upstream = Object.entries(last)
    .filter(([k, v]) => k !== composerKey && Boolean(v))
    .map(([k, v]) => `----- ${k} output -----\n${v}`)
    .join('\n\n');
  const parts = [baseTask.trim(), `${AUTHORITATIVE_BRIEF_HEADER}\n${goal}`];
  if (upstream) {
    parts.push(
      `===== SOURCE MATERIAL — supporting research & copy (use real image URLs / route-map URL / disclaimers VERBATIM; where it conflicts with the brief above, the BRIEF wins) =====\n${upstream}`,
    );
  }
  return parts.join('\n\n');
}

/**
 * Guard against rendering a degenerate brochure (the parser's title fallback + a
 * default accent with NO body is a near-empty cover). Requires real body content.
 */
function hasBrochureBody(content: unknown): boolean {
  const c = content as Record<string, any> | null;
  return !!(
    c &&
    (c.intro ||
      c.highlights ||
      c.itinerary ||
      c.route?.cities?.length ||
      c.route?.places?.length ||
      c.inclusions ||
      c.pricing ||
      c.sections?.length ||
      c.heroQuery)
  );
}

/**
 * The trip length the brief STATES ("5-day", "5 Days · ", "Day 5 – …") → expected
 * itinerary day count, or 0 if none. Used by the completeness guard: a multi-day
 * brief whose composer output dropped the day-by-day itinerary is INCOMPLETE and
 * should be re-composed (the #1 cause of a stunted 2–3 page brochure). Capped to a
 * sane range so a stray number never forces a huge itinerary.
 */
function expectedDayCount(goal: string): number {
  const g = goal || '';
  let n = 0;
  for (const m of g.matchAll(/(\d+)\s*[-\s]?\s*(?:day|days|night|nights)\b/gi)) n = Math.max(n, parseInt(m[1]!, 10));
  for (const m of g.matchAll(/\bday\s*(\d+)\b/gi)) n = Math.max(n, parseInt(m[1]!, 10));
  return n >= 1 && n <= 30 ? n : 0;
}

/** Itinerary day count of a parsed brochure content (0 if none). */
function brochureDayCount(content: unknown): number {
  return (content as { itinerary?: { days?: unknown[] } } | null)?.itinerary?.days?.length ?? 0;
}

export class Orchestrator {
  constructor(private readonly deps: EngineDeps) {}

  async run(args: RunGoalArgs): Promise<RunGoalResult> {
    const pack = getSectorPack(args.sectorKey);
    const coordinator = getAgent(pack, pack.coordinatorKey);
    const runId = args.runId ?? newRunId();
    const { store } = this.deps;

    // Run-scoped budget: total model calls + total billed USD, shared across
    // the CEO and every specialist so limits apply to the whole run. `capped`
    // flips when the step limit is hit so we finalize best-effort, not fail.
    const budget = { count: 0, spentUsd: 0, capped: false };
    const maxDepth = this.deps.config.orchestration.maxDelegationDepth;
    const maxPerPair = this.deps.config.orchestration.maxDelegationsPerPair;

    // Capture each agent's latest output so post-run finalization (e.g. render a
    // brochure designer's HTML to PDF) can use it without the model passing the
    // artifact through a tool call.
    const lastOutputByAgent: Record<string, string> = {};
    // Anti-loop state (per run): how many times each (parent->child) pair has
    // been delegated, and the set of normalized tasks already sent to each pair.
    // Tracking the full set — not just the previous task — catches A/B/A
    // oscillation, not only consecutive repeats.
    const delegationCounts = new Map<string, number>();
    const seenTasksByPair = new Map<string, Set<string>>();

    // Per-run agent overrides: when a sector offers selectable styles, clone its
    // finalize (designer) agent and append the chosen style's art-direction to a
    // *copy* of its system prompt. The shared pack/agent singletons are never
    // mutated (the engine is long-lived) and non-styled sectors get an empty map
    // (a strict no-op via resolveAgent below).
    const fin = pack.finalize;
    const agentOverrides = new Map<string, AgentDefinition>();
    // Art-direction injection applies ONLY to the HTML-designer path. For
    // 'brochure_json' the styleKey is a TEMPLATE key (the template owns the look),
    // so the composer prompt stays self-contained and is not rewritten.
    if (fin?.render === 'html_to_pdf' && fin?.styles?.length) {
      const base = getAgent(pack, fin.fromAgentKey);
      agentOverrides.set(fin.fromAgentKey, {
        ...base,
        systemPrompt: base.systemPrompt + wrapArtDirection(resolveArtDirection(args.styleKey)),
      });
    }
    const resolveAgent = (key: string): AgentDefinition => agentOverrides.get(key) ?? getAgent(pack, key);

    // Recursive delegation callback threaded through every agent loop.
    const invokeAgent = async (
      agentKey: string,
      task: string,
      parentKey: string,
      depth: number,
    ): Promise<string> => {
      if (depth > maxDepth) {
        // Soft stop (not a throw): nudge the parent to finish with what it has,
        // so an over-deep chain degrades gracefully instead of failing the run.
        return `Error: maximum delegation depth (${maxDepth}) reached. Do NOT delegate deeper — complete this task yourself with the information available and return your result.`;
      }
      const parent = getAgent(pack, parentKey);
      if (parent.delegatesTo && !parent.delegatesTo.includes(agentKey)) {
        return `Error: "${parentKey}" is not allowed to delegate to "${agentKey}". Allowed: ${parent.delegatesTo.join(', ')}.`;
      }
      const child = resolveAgent(agentKey);

      // Anti-loop guard: block re-delegating the same specialist past the per-pair
      // cap or with a task already issued to it. Returns a corrective string (no
      // throw, and deliberately no lifecycle event so UI agent-state isn't
      // corrupted) so the coordinator is steered to produce its final answer.
      const pairKey = `${parentKey}->${agentKey}`;
      const normTask = task.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 400);
      const priorCount = delegationCounts.get(pairKey) ?? 0;
      const seen = seenTasksByPair.get(pairKey) ?? new Set<string>();
      const isDuplicate = seen.has(normTask);
      if (priorCount >= maxPerPair || isDuplicate) {
        return `Error: you have already delegated to "${agentKey}" ${priorCount} time(s)${isDuplicate ? ' with a near-identical task' : ''}. Do NOT delegate to "${agentKey}" again — its result is already available to you. Integrate what you have and produce your FINAL deliverable now as your reply, with NO further tool calls.`;
      }
      delegationCounts.set(pairKey, priorCount + 1);
      seen.add(normTask);
      seenTasksByPair.set(pairKey, seen);

      // Auto-thread the ORIGINAL user brief (authoritative) + upstream specialists'
      // outputs into the finalize agent's task. The verbatim brief is the cure for
      // content drift: the coordinator/copywriter paraphrase facts (e.g. "1 Day" →
      // "2 Days", a named accent → an unrelated hex), so the composer must see the
      // source of truth itself — never only the small-model paraphrase. Upstream
      // outputs carry the real asset URLs / route-map / disclaimers verbatim.
      let effectiveTask = task;
      if (fin && agentKey === fin.fromAgentKey) {
        effectiveTask = composerThreadedTask(task, args.goal, lastOutputByAgent, agentKey);
      }

      emit(store, runId, 'delegation.started', agentKey, { task, from: parentKey }, parentKey);
      const result = await runAgent(this.deps, {
        runId,
        agent: child,
        task: effectiveTask,
        parentAgentKey: parentKey,
        depth,
        budget,
        invokeAgent,
      });
      // Capture for post-run finalize — but never let a capped placeholder clobber
      // a good earlier output (the brochure HTML must survive a later step-cap).
      if (result && (!budget.capped || !lastOutputByAgent[agentKey])) {
        lastOutputByAgent[agentKey] = result;
      }
      emit(store, runId, 'delegation.completed', agentKey, { result: result.slice(0, 600) }, parentKey);
      return result;
    };

    await store.setStatus(runId, 'running');
    emit(store, runId, 'run.started', coordinator.key, {
      sector: pack.key,
      goal: args.goal,
      ...(args.styleKey ? { styleKey: args.styleKey } : {}),
    });

    try {
      const coordinatorOutput = await runAgent(this.deps, {
        runId,
        agent: coordinator,
        task: args.goal,
        depth: 0,
        budget,
        invokeAgent,
      });

      // Post-run finalization: render an agent's HTML output into a downloadable
      // artifact (e.g. the brochure PDF) and make THAT the deliverable.
      let result = coordinatorOutput;
      let rendered = false;
      if (fin?.render === 'html_to_pdf') {
        const html = lastOutputByAgent[fin.fromAgentKey] ?? coordinatorOutput;
        if (looksLikeHtml(html)) {
          emit(store, runId, 'agent.tool_call', fin.fromAgentKey, { tool: 'render_pdf' });
          try {
            const art = await renderHtmlToArtifact(html, runId, fin.pdf);
            emit(store, runId, 'agent.tool_result', fin.fromAgentKey, { tool: 'render_pdf', result: art.url });
            const noun = fin.pdf?.label ?? 'document';
            result = `Your ${noun} is ready (${art.format.toUpperCase()}).\nDownload: ${art.url}`;
            rendered = true;
          } catch (err) {
            emit(store, runId, 'agent.tool_result', fin.fromAgentKey, { tool: 'render_pdf', error: (err as Error).message });
          }
        }
      } else if (fin?.render === 'brochure_json') {
        // Deterministic finalize — a valid brochure ALWAYS renders. Three escalating
        // attempts so the user never hits a "no PDF" dead-end:
        //   (1) parse the composer output the coordinator already gathered;
        //   (2) if it is missing or unusable (coordinator never reached the composer,
        //       or it drifted / returned the wrong shape), run the composer OURSELVES
        //       with the full source material — guaranteeing a clean JSON pass;
        //   (3) still nothing usable → build a faithful fallback from the brief.
        let content = parseBrochureContent(lastOutputByAgent[fin.fromAgentKey] ?? '');
        if (!hasBrochureBody(content) && !budget.capped) {
          const task = composerThreadedTask(
            'Compose the FINAL brochure JSON now from the material below. Output ONLY the JSON object — no commentary, no code fences.',
            args.goal,
            lastOutputByAgent,
            fin.fromAgentKey,
          );
          emit(store, runId, 'delegation.started', fin.fromAgentKey, { task: '(finalize) compose brochure JSON', from: coordinator.key }, coordinator.key);
          try {
            const composed = await runAgent(this.deps, {
              runId,
              agent: resolveAgent(fin.fromAgentKey),
              task,
              parentAgentKey: coordinator.key,
              depth: 1,
              budget,
              invokeAgent,
            });
            emit(store, runId, 'delegation.completed', fin.fromAgentKey, { result: composed.slice(0, 600) }, coordinator.key);
            if (composed && (!budget.capped || !lastOutputByAgent[fin.fromAgentKey])) {
              lastOutputByAgent[fin.fromAgentKey] = composed;
            }
            content = parseBrochureContent(composed);
          } catch (err) {
            // A hard stop during this EXTRA finalize compose (e.g. the USD budget cap
            // in runAgent) must NOT fail the whole run — fall through to the
            // brief-derived fallback so a PDF is still produced.
            emit(store, runId, 'delegation.completed', fin.fromAgentKey, {
              result: `(finalize compose skipped: ${(err as Error).message})`,
            });
          }
        }
        // COMPLETENESS GUARD — the #1 cause of an inconsistent, stunted PDF is the
        // composer (a cost-tier LLM) emitting a THIN brochure: it drops the day-by-day
        // itinerary even though the brief is a multi-day trip, so the engine (which
        // renders exactly what it's given) produces a 2–3 page shell. Detect that
        // against the brief's STATED day count and re-compose ONCE with a specific
        // deficiency nudge, keeping whichever pass is fuller. Model-agnostic — it makes
        // a cheap model far more consistent without forcing a pricier one.
        const wantDays = expectedDayCount(args.goal);
        if (!budget.capped && hasBrochureBody(content) && wantDays >= 3 && brochureDayCount(content) < Math.ceil(wantDays * 0.6)) {
          const got = brochureDayCount(content);
          const nudge =
            `\n\nCOMPLETENESS CHECK — your previous draft was INCOMPLETE: this is a ${wantDays}-DAY trip but its ` +
            `itinerary.days had ${got} entr${got === 1 ? 'y' : 'ies'}. Re-output the COMPLETE brochure JSON now — ` +
            `itinerary.days MUST contain all ${wantDays} days (one per day of the trip), plus every highlight/experience, ` +
            `the full route (routeLine + route.cities), inclusions, pricing and footer. Output ONLY the complete JSON object.`;
          const task = composerThreadedTask(
            'Re-compose the COMPLETE brochure JSON from the material below.' + nudge,
            args.goal,
            lastOutputByAgent,
            fin.fromAgentKey,
          );
          emit(store, runId, 'delegation.started', fin.fromAgentKey, { task: '(finalize) completeness re-compose', from: coordinator.key }, coordinator.key);
          try {
            const recomposed = await runAgent(this.deps, {
              runId,
              agent: resolveAgent(fin.fromAgentKey),
              task,
              parentAgentKey: coordinator.key,
              depth: 1,
              budget,
              invokeAgent,
            });
            emit(store, runId, 'delegation.completed', fin.fromAgentKey, { result: recomposed.slice(0, 600) }, coordinator.key);
            const retry = parseBrochureContent(recomposed);
            // Keep the retry only if it's genuinely fuller (more itinerary days).
            if (hasBrochureBody(retry) && brochureDayCount(retry) > got) {
              content = retry;
              lastOutputByAgent[fin.fromAgentKey] = recomposed;
            }
          } catch (err) {
            emit(store, runId, 'delegation.completed', fin.fromAgentKey, { result: `(completeness re-compose skipped: ${(err as Error).message})` });
          }
        }

        // Final guarantee: if we STILL have no usable body, synthesise one from the
        // brief so the deliverable is always a real PDF (never the bare coordinator
        // confirmation text with no download). When the composer DID produce content,
        // run the completeness backstop so any labelled brief block it dropped
        // (learning outcomes, inclusions, cancellation policy, …) is still included.
        const finalContent = (hasBrochureBody(content)
          ? ensureBriefCoverage(content as Parameters<typeof buildBrochureHtml>[0], args.goal)
          : buildFallbackBrochureContent(args.goal)) as Parameters<typeof buildBrochureHtml>[0];

        emit(store, runId, 'agent.tool_call', fin.fromAgentKey, { tool: 'render_pdf' });
        try {
          // The map defaults to a real geographic 2D basemap; the 3D country-silhouette
          // map is opt-in — only when the human's goal explicitly asks for "3D".
          const map3d = /\b3-?d\b|three[\s-]?dimensional|three[\s-]?d/i.test(args.goal);
          // Brand: the kit is server-resolved/trusted; the logo PLACEMENT is parsed
          // from the goal here so the user can just say "logo top-left" etc. If the
          // kit also carries a `custom` placement (from the visual placer) it rides
          // through this spread untouched and WINS over `placement` in the engine.
          // The measurer (headless Chrome) lets the engine paginate without ever
          // clipping; it self-falls-back to estimates if Chromium is absent.
          const brand: BrandKit | undefined = args.brand?.logoUrl
            ? { ...args.brand, placement: parseLogoPlacement(args.goal) }
            : args.brand;
          const html = await buildBrochureHtml(finalContent, getTemplate(args.styleKey), {
            map3d,
            measure: measureEditorialBlocks,
            ...(brand ? { brand } : {}),
          });
          const art = await renderHtmlToArtifact(html, runId, fin.pdf);
          emit(store, runId, 'agent.tool_result', fin.fromAgentKey, { tool: 'render_pdf', result: art.url });
          const noun = fin.pdf?.label ?? 'document';
          result = `Your ${noun} is ready (${art.format.toUpperCase()}).\nDownload: ${art.url}`;
          rendered = true;
        } catch (err) {
          emit(store, runId, 'agent.tool_result', fin.fromAgentKey, { tool: 'render_pdf', error: (err as Error).message });
        }
      }

      // If the run was step-capped and produced no rendered artifact, salvage the
      // best REAL specialist output (never a capped placeholder) and flag it
      // honestly, so a capped run still delivers something instead of a stub.
      if (budget.capped && !rendered) {
        const best = Object.values(lastOutputByAgent)
          .filter((t) => t && !t.startsWith('[Run hit the step limit'))
          .sort((a, b) => b.length - a.length)[0];
        if (best && best.length > result.length) result = best;
        result = `⚠️ This run reached the step limit before fully finishing; the result below is best-effort and may be incomplete.\n\n${result}`;
      }

      await store.setStatus(runId, 'completed', result);
      // Full result — this is the deliverable the dashboard renders.
      emit(store, runId, 'run.completed', coordinator.key, { result, capped: budget.capped });
      return { runId, result };
    } catch (err) {
      const message = (err as Error).message;
      await store.setStatus(runId, 'failed', message);
      emit(store, runId, 'run.failed', coordinator.key, { error: message });
      throw err;
    }
  }
}

function emit(
  store: RunStore,
  runId: string,
  type: OrchestrationEventType,
  agentKey: string,
  data: Record<string, unknown>,
  parentAgentKey?: string,
): void {
  const event: OrchestrationEvent = {
    id: newEventId(),
    runId,
    ts: new Date().toISOString(),
    type,
    agentKey,
    ...(parentAgentKey ? { parentAgentKey } : {}),
    data,
  };
  void store.appendEvent(event);
}
