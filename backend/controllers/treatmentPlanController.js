const prisma = require("../lib/prisma");

exports.getAllTreatmentPlans = async (req, res) => {
    try {
        // Strict tenant scope. The global auth guard guarantees req.user;
        // never fall back to tenantId=1 (silently leaks across tenants on
        // a malformed token). Reject with 401 if no tenant.
        if (!req.user?.tenantId) return res.status(401).json({ error: "no tenant" });
        const tenantId = req.user.tenantId;

        const treatmentPlans = await prisma.treatmentPlan.findMany({
            where: {

                tenantId: tenantId,
            },
            include: {
                patient: true,
                service: true,
            },
            orderBy: {
                createdAt: "desc",
            },
        });

        return res.status(200).json({
            success: true,
            count: treatmentPlans.length,
            data: treatmentPlans,
        });
    } catch (error) {
        console.error("Error fetching treatment plans:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch treatment plans",
            error: error.message,
        });
    }
};

exports.updateTreatmentPlan = async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;
        // Strict tenant scope. The global auth guard guarantees req.user;
        // never fall back to tenantId=1 (silently leaks across tenants on
        // a malformed token). Reject with 401 if no tenant.
        if (!req.user?.tenantId) return res.status(401).json({ error: "no tenant" });
        const tenantId = req.user.tenantId;

        if (!id) return res.status(400).json({ error: "Treatment plan ID required" });
        if (!status) return res.status(400).json({ error: "Status required" });

        const plan = await prisma.treatmentPlan.findFirst({
            where: { id: parseInt(id), tenantId },
        });

        if (!plan) return res.status(404).json({ error: "Treatment plan not found" });

        const updated = await prisma.treatmentPlan.update({
            where: { id: parseInt(id) },
            data: { status },
            include: { patient: true, service: true },
        });

        return res.status(200).json({
            success: true,
            data: updated,
        });
    } catch (error) {
        console.error("Error updating treatment plan:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to update treatment plan",
        });
    }
};