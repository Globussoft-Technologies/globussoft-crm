const prisma = require("./prisma");
const { notify } = require("./notificationService");

function leadDisplayName(contact) {
  if (!contact) return "A new lead";
  return contact.name || contact.email || contact.phone || `Lead #${contact.id}`;
}

async function notifyAdminsOfNewLead({ tenantId, contact, io }) {
  if (!tenantId || !contact?.id || contact.status !== "Lead") return [];

  try {
    const admins = await prisma.user.findMany({
      where: {
        tenantId,
        role: "ADMIN",
        deactivatedAt: null,
      },
      select: { id: true },
    });

    const leadName = leadDisplayName(contact);
    const results = [];
    for (const admin of admins) {
      results.push(await notify({
        userId: admin.id,
        tenantId,
        title: "New lead added",
        message: `${leadName} has been added to Leads.`,
        type: "info",
        category: "lead",
        priority: "normal",
        link: "/leads",
        entityType: "lead",
        entityId: contact.id,
        channels: ["db", "socket"],
        io,
      }));
    }
    return results;
  } catch (err) {
    console.error("[leadNotifications] admin lead notification failed:", err && err.message);
    return [];
  }
}

module.exports = {
  notifyAdminsOfNewLead,
};
