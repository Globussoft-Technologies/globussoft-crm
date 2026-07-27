const { bus } = require('./eventBus');
const notificationService = require('./notificationService');
const prisma = require('./prisma');
const WELLNESS_ADMIN_ROLES = ['ADMIN', 'MANAGER'];

async function isWellnessTenant(tenantId) {
  try {
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { vertical: true }
    });
    return tenant?.vertical === 'wellness';
  } catch (err) {
    console.error('[notificationRulesEngine] tenant lookup error:', err.message);
    return false;
  }
}

async function getTenantAdminIds(tenantId) {
  const admins = await prisma.user.findMany({
    where: { tenantId, role: { in: WELLNESS_ADMIN_ROLES } },
    select: { id: true }
  });
  return admins.map((admin) => admin.id);
}

async function getPatientUserId(patientId) {
  if (!patientId) return null;
  const patient = await prisma.patient.findUnique({
    where: { id: patientId },
    select: { userId: true }
  });
  return patient?.userId ?? null;
}

async function notifyUserIds(userIds, baseNotification) {
  const uniqueIds = [...new Set(userIds.filter(Boolean))];
  for (const userId of uniqueIds) {
    await notificationService.notify({
      ...baseNotification,
      userId
    });
  }
}

async function init(io) {
  // SLA Breach - Ticket
  bus.on('sla.breached', async ({ payload, tenantId }) => {
    try {
      const { ticketId, _assigneeId } = payload;
      const ticket = await prisma.ticket.findUnique({
        where: { id: ticketId },
        select: { id: true, subject: true, assignedToId: true }
      });

      if (!ticket) return;

      // Notify assignee + admins
      const admins = await prisma.user.findMany({
        where: { tenantId, role: 'ADMIN' },
        select: { id: true }
      });

      const notifyIds = new Set(admins.map(a => a.id));
      if (ticket.assignedToId) notifyIds.add(ticket.assignedToId);

      for (const userId of notifyIds) {
        await notificationService.notify({
          userId,
          tenantId,
          category: 'ticket',
          type: 'sla_breach',
          title: '🚨 SLA Breach',
          message: `Ticket "${ticket.subject}" has breached SLA`,
          priority: 'high',
          link: `/tickets/${ticketId}`,
          entityType: 'ticket',
          entityId: ticketId,
          io
        });
      }
    } catch (err) {
      console.error('[notificationRulesEngine] sla.breached error:', err.message);
    }
  });

  // Lead SLA Breach
  bus.on('lead.sla_breached', async ({ payload, tenantId }) => {
    try {
      const { contactId, _assigneeId } = payload;
      const contact = await prisma.contact.findUnique({
        where: { id: contactId },
        select: { id: true, name: true, assignedToId: true }
      });

      if (!contact) return;

      const managers = await prisma.user.findMany({
        where: { tenantId, role: { in: ['ADMIN', 'MANAGER'] } },
        select: { id: true }
      });

      const notifyIds = new Set(managers.map(m => m.id));
      if (contact.assignedToId) notifyIds.add(contact.assignedToId);

      for (const userId of notifyIds) {
        await notificationService.notify({
          userId,
          tenantId,
          category: 'lead',
          type: 'sla_breach',
          title: '⏰ Lead SLA Breached',
          message: `Lead "${contact.name}" SLA has been breached`,
          priority: 'high',
          link: `/contacts/${contactId}`,
          entityType: 'lead',
          entityId: contactId,
          io
        });
      }
    } catch (err) {
      console.error('[notificationRulesEngine] lead.sla_breached error:', err.message);
    }
  });

  // Approval Created
  bus.on('approval.created', async ({ payload, tenantId }) => {
    try {
      const { approvalId } = payload;
      const managers = await prisma.user.findMany({
        where: { tenantId, role: { in: ['ADMIN', 'MANAGER'] } },
        select: { id: true }
      });

      for (const manager of managers) {
        await notificationService.notify({
          userId: manager.id,
          tenantId,
          category: 'approval',
          type: 'pending_approval',
          title: '✋ Approval Needed',
          message: 'New approval request pending your action',
          priority: 'normal',
          link: '/approvals',
          entityType: 'approval',
          entityId: approvalId,
          io
        });
      }
    } catch (err) {
      console.error('[notificationRulesEngine] approval.created error:', err.message);
    }
  });

  // Approval Approved
  bus.on('approval.approved', async ({ payload, tenantId }) => {
    try {
      const { _approverId, requesterId } = payload;
      await notificationService.notify({
        userId: requesterId,
        tenantId,
        category: 'approval',
        type: 'info',
        title: '✅ Approved',
        message: 'Your approval request has been approved',
        priority: 'low',
        link: '/approvals',
        entityType: 'approval',
        entityId: payload.approvalId,
        io
      });
    } catch (err) {
      console.error('[notificationRulesEngine] approval.approved error:', err.message);
    }
  });

  // Approval Rejected
  bus.on('approval.rejected', async ({ payload, tenantId }) => {
    try {
      const { requesterId } = payload;
      await notificationService.notify({
        userId: requesterId,
        tenantId,
        category: 'approval',
        type: 'warning',
        title: '❌ Rejected',
        message: 'Your approval request has been rejected',
        priority: 'normal',
        link: '/approvals',
        entityType: 'approval',
        entityId: payload.approvalId,
        io
      });
    } catch (err) {
      console.error('[notificationRulesEngine] approval.rejected error:', err.message);
    }
  });

  // Wellness appointment + finance notifications are routed by role so the
  // bell stays scoped to the right staff users. Generic tenants ignore
  // these events entirely.
  bus.on('visit.scheduled', async ({ payload, tenantId, io }) => {
    try {
      if (!(await isWellnessTenant(tenantId))) return;
      const { visitId, doctorId, patientId } = payload;
      const adminIds = await getTenantAdminIds(tenantId);
      const notifyIds = new Set(adminIds);
      if (doctorId) notifyIds.add(doctorId);

      // Booking notifications are staff-visible: admins/managers need to see
      // every new appointment, even when no doctor is assigned yet.
      await notifyUserIds([...notifyIds], {
        tenantId,
        category: 'appointment',
        type: 'appointment_booked',
        title: '📅 New Appointment Booked',
        message: 'A new appointment has been booked',
        priority: 'normal',
        link: `/wellness/patients/${patientId}`,
        entityType: 'visit',
        entityId: visitId,
        io
      });
    } catch (err) {
      console.error('[notificationRulesEngine] visit.scheduled error:', err.message);
    }
  });

  bus.on('visit.assigned', async ({ payload, tenantId, io }) => {
    try {
      if (!(await isWellnessTenant(tenantId))) return;
      const { visitId, doctorId, patientId } = payload;
      const patientUserId = await getPatientUserId(patientId);
      const notifyIds = new Set();
      if (doctorId) notifyIds.add(doctorId);
      if (patientUserId) notifyIds.add(patientUserId);

      await notifyUserIds([...notifyIds], {
        tenantId,
        category: 'appointment',
        type: 'doctor_assigned',
        title: '🩺 Doctor Assigned',
        message: 'A doctor has been assigned to your appointment',
        priority: 'normal',
        link: `/wellness/patients/${patientId}`,
        entityType: 'visit',
        entityId: visitId,
        io
      });
    } catch (err) {
      console.error('[notificationRulesEngine] visit.assigned error:', err.message);
    }
  });

  bus.on('visit.cancelled', async ({ payload, tenantId, io }) => {
    try {
      if (!(await isWellnessTenant(tenantId))) return;
      const { visitId, doctorId, patientId } = payload;
      const patientUserId = await getPatientUserId(patientId);
      const notifyIds = new Set(await getTenantAdminIds(tenantId));
      if (doctorId) notifyIds.add(doctorId);
      if (patientUserId) notifyIds.add(patientUserId);

      await notifyUserIds([...notifyIds], {
        tenantId,
        category: 'appointment',
        type: 'appointment_cancelled',
        title: '❌ Appointment Cancelled',
        message: `Appointment #${visitId} has been cancelled`,
        priority: 'normal',
        link: `/wellness/patients/${patientId}`,
        entityType: 'visit',
        entityId: visitId,
        io
      });
    } catch (err) {
      console.error('[notificationRulesEngine] visit.cancelled error:', err.message);
    }
  });

  bus.on('payment.collected', async ({ payload, tenantId, io }) => {
    try {
      if (!(await isWellnessTenant(tenantId))) return;
      const adminIds = await getTenantAdminIds(tenantId);
      if (!adminIds.length) return;

      const amount = payload?.amount ?? null;
      const entityId = payload?.invoiceId ?? payload?.paymentId ?? null;

      await notifyUserIds(adminIds, {
        tenantId,
        category: 'billing',
        type: 'payment_collected',
        title: '💸 Payment Received',
        message: amount != null ? `Payment of ₹${amount} has been collected` : 'A payment has been collected',
        priority: 'normal',
        link: '/wellness/billing',
        entityType: 'payment',
        entityId,
        io
      });
    } catch (err) {
      console.error('[notificationRulesEngine] payment.collected error:', err.message);
    }
  });

  bus.on('membership.enrolled', async ({ payload, tenantId, io }) => {
    try {
      if (!(await isWellnessTenant(tenantId))) return;
      const adminIds = await getTenantAdminIds(tenantId);
      if (!adminIds.length) return;

      await notifyUserIds(adminIds, {
        tenantId,
        category: 'membership',
        type: 'membership_purchased',
        title: '🪪 Membership Purchased',
        message: `Membership plan "${payload.planName}" was purchased`,
        priority: 'normal',
        link: '/wellness/memberships',
        entityType: 'membership',
        entityId: payload.membershipId,
        io
      });
    } catch (err) {
      console.error('[notificationRulesEngine] membership.enrolled error:', err.message);
    }
  });

  bus.on('membership.renewed', async ({ payload, tenantId, io }) => {
    try {
      if (!(await isWellnessTenant(tenantId))) return;
      const adminIds = await getTenantAdminIds(tenantId);
      if (!adminIds.length) return;

      await notifyUserIds(adminIds, {
        tenantId,
        category: 'membership',
        type: 'membership_renewed',
        title: '🔁 Membership Renewed',
        message: `Membership plan "${payload.planName}" was renewed`,
        priority: 'normal',
        link: '/wellness/memberships',
        entityType: 'membership',
        entityId: payload.membershipId,
        io
      });
    } catch (err) {
      console.error('[notificationRulesEngine] membership.renewed error:', err.message);
    }
  });

  bus.on('giftcard.redeemed', async ({ payload, tenantId, io }) => {
    try {
      if (!(await isWellnessTenant(tenantId))) return;
      if (payload?.source !== 'purchase') return;
      const adminIds = await getTenantAdminIds(tenantId);
      if (!adminIds.length) return;

      await notifyUserIds(adminIds, {
        tenantId,
        category: 'giftcard',
        type: 'giftcard_purchased',
        title: '🎁 Gift Card Purchased',
        message: `Gift card purchase of ₹${payload.amount ?? '0'} was completed`,
        priority: 'normal',
        link: '/wellness/giftcards',
        entityType: 'giftcard',
        entityId: payload.giftCardId,
        io
      });
    } catch (err) {
      console.error('[notificationRulesEngine] giftcard.redeemed error:', err.message);
    }
  });
  // Expense Created → notify all ADMIN/MANAGER roles for approval
  bus.on('expense.created', async ({ payload, tenantId, io }) => {
    try {
      console.log('[notificationRulesEngine.expense.created] Event received:', {
        expenseId: payload.expenseId,
        submitterName: payload.submitterName,
        submitterId: payload.submitterId,
        amount: payload.amount
      });

      const { expenseId, submitterName, amount, title } = payload;

      // Find all admins and managers in this tenant who should approve
      const approvers = await prisma.user.findMany({
        where: { tenantId, role: { in: ['ADMIN', 'MANAGER'] } },
        select: { id: true, name: true }
      });

      console.log(`[notificationRulesEngine.expense.created] Found ${approvers.length} approvers to notify`);

      for (const approver of approvers) {
        const result = await notificationService.notify({
          userId: approver.id,
          tenantId,
          category: 'expense',
          type: 'expense_pending',
          title: '💰 New Expense for Approval',
          message: `${submitterName} submitted an expense "${title}" for ₹${amount}`,
          priority: 'normal',
          link: '/expenses',
          entityType: 'expense',
          entityId: expenseId,
          io
        });
        console.log(`[notificationRulesEngine.expense.created] Notified ${approver.name} (id=${approver.id}):`, !!result);
      }
    } catch (err) {
      console.error('[notificationRulesEngine.expense.created] Error:', err.message, err.stack);
    }
  });

  // Expense Approved → notify the creator
  bus.on('expense.approved', async ({ payload, tenantId, io }) => {
    try {
      console.log('[notificationRulesEngine.expense.approved] Event received:', {
        expenseId: payload.expenseId,
        submitterId: payload.submitterId,
        title: payload.title,
        amount: payload.amount
      });

      const { expenseId, submitterId, title, amount } = payload;

      if (!submitterId) {
        console.warn('[notificationRulesEngine.expense.approved] No submitterId in payload');
        return;
      }

      const result = await notificationService.notify({
        userId: submitterId,
        tenantId,
        category: 'expense',
        type: 'success',
        title: '✅ Expense Approved',
        message: `Your expense "${title}" for ₹${amount} has been approved`,
        priority: 'low',
        link: '/expenses',
        entityType: 'expense',
        entityId: expenseId,
        io
      });
      console.log(`[notificationRulesEngine.expense.approved] Notified creator (id=${submitterId}):`, !!result);
    } catch (err) {
      console.error('[notificationRulesEngine.expense.approved] Error:', err.message, err.stack);
    }
  });

  // Expense Rejected → notify the creator
  bus.on('expense.rejected', async ({ payload, tenantId, io }) => {
    try {
      console.log('[notificationRulesEngine.expense.rejected] Event received:', {
        expenseId: payload.expenseId,
        submitterId: payload.submitterId,
        title: payload.title
      });

      const { expenseId, submitterId, title, amount, rejectionReason } = payload;

      if (!submitterId) {
        console.warn('[notificationRulesEngine.expense.rejected] No submitterId in payload');
        return;
      }

      const result = await notificationService.notify({
        userId: submitterId,
        tenantId,
        category: 'expense',
        type: 'error',
        title: '❌ Expense Rejected',
        message: `Your expense "${title}" for ₹${amount} was rejected: ${rejectionReason}`,
        priority: 'high',
        link: '/expenses',
        entityType: 'expense',
        entityId: expenseId,
        io
      });
      console.log(`[notificationRulesEngine.expense.rejected] Notified creator (id=${submitterId}):`, !!result);
    } catch (err) {
      console.error('[notificationRulesEngine.expense.rejected] Error:', err.message, err.stack);
    }
  });

  // Leave Requested
  bus.on('leave.requested', async ({ payload, tenantId }) => {
    try {
      const { leaveRequestId, requesterId, _reason } = payload;
      const requester = await prisma.user.findUnique({
        where: { id: requesterId },
        select: { name: true }
      });

      const admins = await prisma.user.findMany({
        where: { tenantId, role: 'ADMIN' },
        select: { id: true }
      });

      for (const admin of admins) {
        await notificationService.notify({
          userId: admin.id,
          tenantId,
          category: 'leave',
          type: 'leave_pending',
          title: '📋 Leave Request',
          message: `${requester?.name} has requested leave`,
          priority: 'normal',
          link: '/wellness/leave',
          entityType: 'leave',
          entityId: leaveRequestId,
          io
        });
      }
    } catch (err) {
      console.error('[notificationRulesEngine] leave.requested error:', err.message);
    }
  });

  // Leave Approved
  bus.on('leave.approved', async ({ payload, tenantId }) => {
    try {
      const { leaveRequestId, requesterId } = payload;
      await notificationService.notify({
        userId: requesterId,
        tenantId,
        category: 'leave',
        type: 'info',
        title: '✅ Leave Approved',
        message: 'Your leave request has been approved',
        priority: 'low',
        link: '/wellness/leave',
        entityType: 'leave',
        entityId: leaveRequestId,
        io
      });
    } catch (err) {
      console.error('[notificationRulesEngine] leave.approved error:', err.message);
    }
  });

  // Leave Denied
  bus.on('leave.denied', async ({ payload, tenantId }) => {
    try {
      const { leaveRequestId, requesterId } = payload;
      await notificationService.notify({
        userId: requesterId,
        tenantId,
        category: 'leave',
        type: 'warning',
        title: '❌ Leave Denied',
        message: 'Your leave request has been denied',
        priority: 'normal',
        link: '/wellness/leave',
        entityType: 'leave',
        entityId: leaveRequestId,
        io
      });
    } catch (err) {
      console.error('[notificationRulesEngine] leave.denied error:', err.message);
    }
  });
}

module.exports = { init };
