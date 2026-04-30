const prisma = require("../lib/prisma");

exports.getAllTreatmentPlans = async (req, res) => {
    try {
        const tenantId = req.user?.tenantId || 1;

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
        const tenantId = req.user?.tenantId || 1;

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