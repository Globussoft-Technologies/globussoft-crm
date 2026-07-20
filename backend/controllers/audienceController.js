

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

// Get Contacts By Status
/**
 * @swagger
 * /api/contacts/by-status:
 *   get:
 *     summary: Get contacts by status
 *     description: Fetch all contacts based on the provided status. If no status is passed, default status will be Customer.
 *     tags: [Contacts]
 *
 *     parameters:
 *       - in: query
 *         name: status
 *         required: false
 *         schema:
 *           type: string
 *           enum: [Lead, Prospect, Customer, Churned]
 *           default: Customer
 *         description: Contact status filter
 *
 *     responses:
 *       200:
 *         description: Contacts fetched successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *
 *                 message:
 *                   type: string
 *                   example: Contacts fetched successfully
 *
 *                 count:
 *                   type: integer
 *                   example: 3
 *
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: integer
 *                         example: 1
 *
 *                       name:
 *                         type: string
 *                         example: John Doe
 *
 *                       email:
 *                         type: string
 *                         example: john@example.com
 *
 *                       phone:
 *                         type: string
 *                         example: "9876543210"
 *
 *                       company:
 *                         type: string
 *                         example: Globussoft
 *
 *                       title:
 *                         type: string
 *                         example: Manager
 *
 *                       status:
 *                         type: string
 *                         example: Customer
 *
 *                       source:
 *                         type: string
 *                         example: Organic
 *
 *                       aiScore:
 *                         type: integer
 *                         example: 75
 *
 *                       createdAt:
 *                         type: string
 *                         format: date-time
 *                         example: 2026-04-24T10:00:00.000Z
 *
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *
 *                 message:
 *                   type: string
 *                   example: Internal server error
 */
// Generic-vertical-only Lead custom fields (Settings > Lead Fields /
// routes/lead_custom_fields.js) — mirrors attachLeadCustomFieldsBatch in
// routes/contacts.js so ConvertedLeads.jsx (which reads this endpoint, not
// GET /api/contacts) also gets one column per admin-defined field, with
// null for contacts that predate the field. Best-effort: a failure here
// returns the contacts unchanged rather than breaking the list.
async function attachLeadCustomFieldsBatch(contacts, tenantId) {
    if (!Array.isArray(contacts) || !contacts.length) return contacts;
    try {
        const definitions = await prisma.leadCustomFieldDefinition.findMany({ where: { tenantId } });
        if (!definitions.length) return contacts.map((c) => ({ ...c, customFields: {} }));
        const contactIds = contacts.map((c) => c.id).filter((id) => id != null);
        const values = await prisma.leadCustomFieldValue.findMany({
            where: { tenantId, contactId: { in: contactIds } },
        });
        const valuesByContact = new Map();
        for (const v of values) {
            if (!valuesByContact.has(v.contactId)) valuesByContact.set(v.contactId, []);
            valuesByContact.get(v.contactId).push(v);
        }
        const byFieldId = new Map(definitions.map((d) => [d.id, d]));
        return contacts.map((c) => {
            const customFields = {};
            for (const def of definitions) customFields[def.fieldKey] = null;
            for (const v of valuesByContact.get(c.id) || []) {
                const def = byFieldId.get(v.fieldId);
                if (!def) continue;
                const raw =
                    def.fieldType === "number" ? v.valueNumber
                    : def.fieldType === "date" ? v.valueDate
                    : def.fieldType === "checkbox" ? v.valueBool
                    : v.valueText;
                customFields[def.fieldKey] = raw;
            }
            return { ...c, customFields };
        });
    } catch (_e) {
        return contacts.map((c) => ({ ...c, customFields: {} }));
    }
}

exports.getContactsByStatus = async (req, res) => {
    try {
        const status = req.query.status || "Customer";

        const contacts = await prisma.contact.findMany({
            where: {
                status: status,
                tenantId: req.user.tenantId,
            },
            orderBy: {
                createdAt: "desc",
            },
        });

        if (!contacts || contacts.length === 0) {
            return res.status(200).json({
                success: true,
                message: `No contacts found for status ${status}`,
                count: 0,
                data: [],
            });
        }

        const withCustomFields = await attachLeadCustomFieldsBatch(contacts, req.user.tenantId);

        return res.status(200).json({
            success: true,
            message: "Contacts fetched successfully",
            count: withCustomFields.length,
            data: withCustomFields,
        });

    } catch (error) {
        console.error("Error fetching contacts:", error);
        return res.status(500).json({
            success: false,
            message: "Internal server error",
            status: 500
        });
    }
};