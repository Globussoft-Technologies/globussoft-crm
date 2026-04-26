/**
 * Sequence (drip) engine.
 *
 * Two execution paths coexist:
 *
 *   1. NEW step-list path (#9 rebuild).
 *      Sequence.steps populated with explicit SequenceStep rows referencing
 *      real EmailTemplate rows (for kind='email'), an SMS body (kind='sms'),
 *      a delay in minutes (kind='wait') or a condition clause-list
 *      (kind='condition'). Cursor is enrollment.currentStep (0-based int).
 *
 *   2. LEGACY ReactFlow JSON canvas path.
 *      Sequence.nodes / Sequence.edges are JSON. Cursor is
 *      enrollment.currentNode (string node id). Synthesises a generic email
 *      ("Automated Sequence: <label>") — kept untouched as a fallback so
 *      pre-rebuild sequences keep running.
 *
 * Reply detection (#7):
 *   processInboundReplies() runs on every tick. Scans EmailMessage rows
 *   where direction='INBOUND' AND threadId LIKE 'seq-%' AND
 *   sequenceReplyHandled IS NULL. For each match, parses the enrollmentId
 *   from the threadId, looks up the enrollment, and — if it is Active and
 *   the step it is parked on has pauseOnReply=true — flips status='Paused'
 *   and clears nextRun. Idempotent via the sequenceReplyHandled timestamp.
 */
const cron = require('node-cron');
const prisma = require('../lib/prisma');
const { evaluateCondition, renderTemplate } = require('../lib/eventBus');

// ── Mailgun (best-effort) ─────────────────────────────────────────────
const MAILGUN_API_KEY = process.env.MAILGUN_API_KEY;
const MAILGUN_DOMAIN = process.env.MAILGUN_DOMAIN || 'crm.globusdemos.com';
const FROM_EMAIL = `Globussoft CRM <noreply@${MAILGUN_DOMAIN}>`;

async function tryMailgunSend(to, subject, body) {
  if (!MAILGUN_API_KEY || !to) return { sent: false, reason: 'no_api_key_or_to' };
  try {
    const formData = new URLSearchParams();
    formData.append('from', FROM_EMAIL);
    formData.append('to', to);
    formData.append('subject', subject);
    formData.append('text', body);
    formData.append('html', String(body).replace(/\n/g, '<br>'));
    const response = await fetch(`https://api.mailgun.net/v3/${MAILGUN_DOMAIN}/messages`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + Buffer.from('api:' + MAILGUN_API_KEY).toString('base64') },
      body: formData,
    });
    if (response.ok) {
      const data = await response.json().catch(() => ({}));
      return { sent: true, id: data.id };
    }
    return { sent: false, reason: `mailgun_${response.status}` };
  } catch (err) {
    return { sent: false, reason: err.message };
  }
}

// Build the variable bag passed to renderTemplate / evaluateCondition.
// Supports `{{contact.name}}`, `{{contact.email}}`, plus a flat fallback
// (renderTemplate already does last-segment fallback when a path doesn't
// resolve nested).
function buildContextForEnrollment(enrollment) {
  const c = enrollment.contact || {};
  return {
    contact: {
      id: c.id,
      name: c.name,
      email: c.email,
      phone: c.phone,
      company: c.company,
      status: c.status,
    },
    enrollmentId: enrollment.id,
    sequenceId: enrollment.sequenceId,
    // Flat fallbacks for templates that author `{{name}}` directly:
    name: c.name,
    email: c.email,
    phone: c.phone,
    company: c.company,
  };
}

// ── New step-list dispatcher ──────────────────────────────────────────
async function processStep(step, enrollment) {
  const ctx = buildContextForEnrollment(enrollment);

  if (step.kind === 'email') {
    // Render template if linked, otherwise fall back to a sane subject so
    // we never silently drop the step.
    let subject = `Sequence: step ${step.position}`;
    let body = '';
    if (step.emailTemplate) {
      subject = renderTemplate(step.emailTemplate.subject || subject, ctx);
      body = renderTemplate(step.emailTemplate.body || '', ctx);
    }
    const to = enrollment.contact?.email;
    if (!to) {
      // No address — skip silently rather than crash. Cursor still advances.
      return { advance: true };
    }

    // Persist the outbound row (engine source of truth) before attempting
    // delivery. threadId convention is `seq-<enrollmentId>` so #7 reply
    // detection can recover the enrollment from an inbound reply.
    await prisma.emailMessage.create({
      data: {
        subject,
        body,
        from: FROM_EMAIL,
        to,
        direction: 'OUTBOUND',
        contactId: enrollment.contact.id,
        tenantId: enrollment.tenantId,
        threadId: `seq-${enrollment.id}`,
        read: true,
      },
    });

    // Best-effort delivery.
    if (MAILGUN_API_KEY) {
      tryMailgunSend(to, subject, body).catch(() => {});
    }
    return { advance: true };
  }

  if (step.kind === 'sms') {
    if (enrollment.contact?.phone) {
      const body = renderTemplate(step.smsBody || '', ctx);
      await prisma.smsMessage.create({
        data: {
          to: enrollment.contact.phone,
          body: body || `Automated sequence message`,
          direction: 'OUTBOUND',
          status: 'QUEUED',
          contactId: enrollment.contact.id,
          tenantId: enrollment.tenantId,
        },
      });
    }
    return { advance: true };
  }

  if (step.kind === 'wait') {
    const minutes = Math.max(parseInt(step.delayMinutes, 10) || 0, 0);
    if (minutes > 0) {
      // Park: do not advance the cursor; just set nextRun.
      return {
        advance: true, // we DO advance past the wait so the next tick after
        // nextRun fires the FOLLOWING step (parking semantics: wait step =
        // delay before advancing past it).
        nextRun: new Date(Date.now() + minutes * 60_000),
      };
    }
    return { advance: true };
  }

  if (step.kind === 'condition') {
    const result = evaluateCondition(step.conditionJson, ctx);
    const fallback = step.position + 1;
    const target = result
      ? (step.trueNextPosition != null ? step.trueNextPosition : fallback)
      : (step.falseNextPosition != null ? step.falseNextPosition : fallback);
    return { advance: false, jumpTo: target };
  }

  // Unknown kind — fail-safe: advance so the enrollment is not stuck.
  return { advance: true };
}

async function processStepListEnrollment(enrollment, steps) {
  const stepsByPos = new Map(steps.map(s => [s.position, s]));
  let cursor = enrollment.currentStep == null ? 0 : enrollment.currentStep;
  let nextRun = null;
  let safety = 0; // condition jumps could in theory loop; guard.

  while (safety++ < 50) {
    const step = stepsByPos.get(cursor);
    if (!step) {
      // Past the last position — sequence complete.
      await prisma.sequenceEnrollment.update({
        where: { id: enrollment.id },
        data: { status: 'Completed', currentStep: cursor, nextRun: null },
      });
      return;
    }

    const result = await processStep(step, enrollment);

    if (result.nextRun) {
      // Wait step parked the enrollment. Advance the cursor (so the next
      // tick fires the step AFTER the wait), persist nextRun, exit.
      const advanced = result.advance ? cursor + 1 : cursor;
      await prisma.sequenceEnrollment.update({
        where: { id: enrollment.id },
        data: { currentStep: advanced, nextRun: result.nextRun },
      });
      return;
    }

    if (result.advance === false && result.jumpTo != null) {
      cursor = result.jumpTo;
      continue;
    }

    cursor += 1;
  }

  // Bailed on safety. Persist whatever cursor we got to and mark Active so
  // the next tick can retry. (Better than silently completing.)
  await prisma.sequenceEnrollment.update({
    where: { id: enrollment.id },
    data: { currentStep: cursor, nextRun },
  });
}

// ── Legacy ReactFlow path (preserved verbatim) ────────────────────────
const findNextNodeId = (currentNodeId, edges) => {
  const outgoingEdge = edges.find(e => e.source === currentNodeId);
  return outgoingEdge ? outgoingEdge.target : null;
};

const processNodeLegacy = async (node, enrollment) => {
  const label = node.data?.label || '';

  if (label.startsWith('ACTION: Send Email')) {
    await prisma.emailMessage.create({
      data: {
        subject: `Automated Sequence: ${label}`,
        body: `This is an automated drip email generated by a Sequence Engine action.`,
        from: 'system@crm.com',
        to: enrollment.contact.email,
        direction: 'OUTBOUND',
        contactId: enrollment.contact.id,
        threadId: `seq-${enrollment.id}`,
        read: true,
        tenantId: enrollment.tenantId,
      },
    });
    return { delayMinutes: 0 };
  }

  if (label.startsWith('DELAY:')) {
    const daysMatch = label.match(/(\d+)\s*Days?/i);
    const hoursMatch = label.match(/(\d+)\s*Hours?/i);
    const minsMatch = label.match(/(\d+)\s*Min(?:ute)?s?/i);
    let delayMinutes = 60;
    if (daysMatch) delayMinutes = parseInt(daysMatch[1]) * 1440;
    else if (hoursMatch) delayMinutes = parseInt(hoursMatch[1]) * 60;
    else if (minsMatch) delayMinutes = parseInt(minsMatch[1]);
    return { delayMinutes };
  }

  if (label.startsWith('ACTION: Send SMS')) {
    if (enrollment.contact.phone) {
      await prisma.smsMessage.create({
        data: {
          to: enrollment.contact.phone,
          body: `Automated sequence message for ${enrollment.contact.name}`,
          direction: 'OUTBOUND',
          status: 'QUEUED',
          contactId: enrollment.contact.id,
          tenantId: enrollment.tenantId,
        },
      });
    }
    return { delayMinutes: 0 };
  }

  if (label.startsWith('ACTION: Send WhatsApp')) {
    if (enrollment.contact.phone) {
      await prisma.whatsAppMessage.create({
        data: {
          to: enrollment.contact.phone,
          body: `Automated WhatsApp sequence message for ${enrollment.contact.name}`,
          direction: 'OUTBOUND',
          status: 'QUEUED',
          contactId: enrollment.contact.id,
        },
      });
    }
    return { delayMinutes: 0 };
  }

  if (label.startsWith('ACTION: Send Push')) return { delayMinutes: 0 };
  if (label.startsWith('CONDITION:')) return { delayMinutes: 0 };
  return { delayMinutes: 0 };
};

async function processLegacyEnrollment(enrollment) {
  const { sequence } = enrollment;
  if (!sequence.nodes) return;

  let nodes = [];
  let edges = [];
  try {
    nodes = JSON.parse(sequence.nodes);
    edges = JSON.parse(sequence.edges || '[]');
  } catch (err) {
    console.error(`Error parsing sequence graph for ID: ${sequence.id}`);
    return;
  }

  let currentNodeId = enrollment.currentNode;
  if (!currentNodeId) {
    const triggerNode = nodes.find(n => n.type === 'input');
    currentNodeId = triggerNode ? triggerNode.id : nodes[0]?.id;
  }
  let activeNode = nodes.find(n => n.id === currentNodeId);

  let keepProcessing = true;
  let nextRun = enrollment.nextRun;

  while (activeNode && keepProcessing) {
    const result = await processNodeLegacy(activeNode, enrollment);
    if (result.delayMinutes > 0) {
      nextRun = new Date(Date.now() + result.delayMinutes * 60000);
      currentNodeId = findNextNodeId(activeNode.id, edges);
      keepProcessing = false;
    } else {
      currentNodeId = findNextNodeId(activeNode.id, edges);
      if (!currentNodeId) {
        activeNode = null;
        keepProcessing = false;
      } else {
        activeNode = nodes.find(n => n.id === currentNodeId);
      }
    }
  }

  if (!currentNodeId) {
    await prisma.sequenceEnrollment.update({
      where: { id: enrollment.id },
      data: { status: 'Completed', currentNode: null, nextRun: null },
    });
  } else {
    await prisma.sequenceEnrollment.update({
      where: { id: enrollment.id },
      data: { currentNode: currentNodeId, nextRun },
    });
  }
}

// ── Reply detection (#7) ──────────────────────────────────────────────
async function processInboundReplies() {
  try {
    const replies = await prisma.emailMessage.findMany({
      where: {
        direction: 'INBOUND',
        threadId: { startsWith: 'seq-' },
        sequenceReplyHandled: null,
      },
      take: 200,
      orderBy: { createdAt: 'asc' },
    });

    for (const msg of replies) {
      const m = /^seq-(\d+)$/.exec(msg.threadId || '');
      if (!m) {
        // Mark handled anyway so we don't re-scan this row forever.
        await prisma.emailMessage.update({
          where: { id: msg.id },
          data: { sequenceReplyHandled: new Date() },
        }).catch(() => {});
        continue;
      }
      const enrollmentId = parseInt(m[1], 10);
      const enrollment = await prisma.sequenceEnrollment.findUnique({
        where: { id: enrollmentId },
      });
      if (!enrollment) {
        await prisma.emailMessage.update({
          where: { id: msg.id },
          data: { sequenceReplyHandled: new Date() },
        }).catch(() => {});
        continue;
      }

      let shouldPause = false;
      if (enrollment.status === 'Active') {
        // Look up the step the enrollment is parked on (step-list path).
        // If pauseOnReply=true, pause. If sequence has no steps (legacy
        // canvas) we pause unconditionally — matching the documented
        // default of "a reply pauses the drip".
        const cursor = enrollment.currentStep == null ? 0 : enrollment.currentStep;
        const step = await prisma.sequenceStep.findFirst({
          where: { sequenceId: enrollment.sequenceId, position: cursor },
        });
        if (step) {
          shouldPause = !!step.pauseOnReply;
        } else {
          shouldPause = true; // legacy canvas: default-pause on reply.
        }
      }

      if (shouldPause) {
        await prisma.sequenceEnrollment.update({
          where: { id: enrollment.id },
          data: { status: 'Paused', nextRun: null },
        });
      }
      await prisma.emailMessage.update({
        where: { id: msg.id },
        data: { sequenceReplyHandled: new Date() },
      }).catch(() => {});
    }
  } catch (err) {
    console.error('[sequenceEngine] processInboundReplies error:', err.message);
  }
}

// ── Main tick ─────────────────────────────────────────────────────────
const tickSequenceEngine = async () => {
  try {
    // 1. Detect inbound replies first so any pause kicks in BEFORE we
    //    advance an enrollment that just got a reply.
    await processInboundReplies();

    const now = new Date();
    const enrollments = await prisma.sequenceEnrollment.findMany({
      where: {
        status: 'Active',
        OR: [{ nextRun: null }, { nextRun: { lte: now } }],
      },
      include: {
        sequence: { include: { steps: { include: { emailTemplate: true }, orderBy: { position: 'asc' } } } },
        contact: true,
      },
    });

    for (const enrollment of enrollments) {
      const { sequence } = enrollment;
      if (!sequence.isActive) continue;

      const steps = sequence.steps || [];
      if (steps.length > 0) {
        await processStepListEnrollment(enrollment, steps);
      } else if (sequence.nodes) {
        await processLegacyEnrollment(enrollment);
      }
    }
  } catch (error) {
    console.error('Sequence Engine Error:', error);
  }
};

const initSequenceCron = () => {
  cron.schedule('* * * * *', () => {
    tickSequenceEngine();
  });
  console.log('Sequence Execution Engine initialized (cron: * * * * *)');
};

module.exports = {
  initSequenceCron,
  tickSequenceEngine,
  processInboundReplies, // exported for manual / test triggering
};
