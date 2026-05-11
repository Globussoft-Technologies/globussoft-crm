const { bus } = require('./eventBus');
const notificationService = require('./notificationService');
const prisma = require('./prisma');

async function init(io) {
  // SLA Breach - Ticket
  bus.on('sla.breached', async ({ payload, tenantId }) => {
    try {
      const { ticketId, assigneeId } = payload;
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
      const { contactId, assigneeId } = payload;
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
      const { approverId, requesterId } = payload;
      await notificationService.notify({
        userId: requesterId,
        tenantId,
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
      const { leaveRequestId, requesterId, reason } = payload;
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
