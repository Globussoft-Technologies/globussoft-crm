const prisma = require("../lib/prisma");
const getDateRange = (startDate, endDate) => {
    let start, end;

    const now = new Date();

    if (startDate && endDate) {
        start = new Date(startDate);
        end = new Date(endDate);

        //  INVALID DATE CHECK
        if (isNaN(start) || isNaN(end)) {
            throw new Error("Invalid date format");
        }

        //  FUTURE DATE VALIDATION
        if (start > now || end > now) {
            throw new Error("Start or End date cannot be in the future");
        }

        //  LOGICAL VALIDATION
        if (start > end) {
            throw new Error("Start date cannot be greater than end date");
        }

    } else {
        // ✅ Default: last 1 month
        end = now;
        start = new Date();
        start.setMonth(start.getMonth() - 1);
    }

    // ✅ Normalize full day
    start.setHours(0, 0, 0, 0);
    end.setHours(23, 59, 59, 999);

    return { start, end };
};

exports.getPatientsSummary = async (req, res) => {
    try {
        const { startDate, endDate, skip = 0, limit = 10 } = req.query;
        const tenantId = req.user.tenantId;

        const parsedSkip = Number(skip) || 0;
        const parsedLimit = Math.min(Number(limit) || 10, 50);

        const { start, end } = getDateRange(startDate, endDate);

        //  GROUP BY (DB aggregation)
        const grouped = await prisma.visit.groupBy({
            by: ["patientId"],
            where: {
                tenantId,
                visitDate: {
                    gte: start,
                    lte: end,
                },
            },
            _count: { id: true },
            _sum: { amountCharged: true },
            _max: { visitDate: true },
            orderBy: {
                _max: { visitDate: "desc" },
            },
            skip: parsedSkip,
            take: parsedLimit,
        });

        //  TOTAL COUNT (compatible fix)
        const totalGrouped = await prisma.visit.groupBy({
            by: ["patientId"],
            where: {
                tenantId,
                visitDate: {
                    gte: start,
                    lte: end,
                },
            },
        });

        const totalCount = totalGrouped.length;

        //  FETCH PATIENT DATA
        const patientIds = grouped.map((g) => g.patientId);

        const patients = await prisma.patient.findMany({
            where: { id: { in: patientIds } },
            select: {
                id: true,
                name: true,
                phone: true,
            },
        });

        const patientMap = {};
        patients.forEach((p) => {
            patientMap[p.id] = p;
        });

        //  FINAL RESPONSE DATA
        const result = grouped.map((g) => ({
            id: g.patientId,
            name: patientMap[g.patientId]?.name || null,
            phone: patientMap[g.patientId]?.phone || null,
            totalVisits: g._count.id,
            totalRevenue: Number((g._sum.amountCharged || 0).toFixed(2)),
            lastVisit: g._max.visitDate,
        }));

        return res.json({
            success: true,
            count: totalCount,
            skip: parsedSkip,
            limit: parsedLimit,
            dateRange: { start, end },
            data: result,
        });
    } catch (err) {
        console.error(err);
        if (
            err.message.includes("date")
        ) {
            return res.status(400).json({
                success: false,
                error: err.message,
            });
        }

        res.status(500).json({
            success: false,
            error: "Something went wrong",
        });
    }
};

// GET /reports/patient/:id?startDate=&endDate=

exports.getPatientDetails = async (req, res) => {
    try {
        const { id } = req.params;
        const { startDate, endDate, skip = 0, limit = 10 } = req.query;
        const tenantId = req.user.tenantId;

        const parsedSkip = Number(skip) || 0;
        const parsedLimit = Math.min(Number(limit) || 10, 50);

        //  Use same helper
        const { start, end } = getDateRange(startDate, endDate);

        const patient = await prisma.patient.findFirst({
            where: {
                id: Number(id),
                tenantId,
            },
            select: {
                id: true,
                name: true,
                phone: true,
            },
        });

        if (!patient) {
            return res.status(404).json({ error: "Patient not found" });
        }

        const [visits, totalCount] = await Promise.all([
            prisma.visit.findMany({
                where: {
                    patientId: Number(id),
                    tenantId,
                    visitDate: {
                        gte: start,
                        lte: end,
                    },
                },
                include: {
                    doctor: { select: { id: true, name: true } },
                    service: { select: { id: true, name: true } },
                },
                orderBy: {
                    visitDate: "desc",
                },
                skip: parsedSkip,
                take: parsedLimit,
            }),

            prisma.visit.count({
                where: {
                    patientId: Number(id),
                    tenantId,
                    visitDate: {
                        gte: start,
                        lte: end,
                    },
                },
            }),
        ]);

        return res.json({
            success: true,
            count: totalCount,
            skip: parsedSkip,
            limit: parsedLimit,
            dateRange: { start, end }, //  consistency
            data: {
                patient,
                visits,
            },
        });
    } catch (err) {
        console.error(err);
        if (
            err.message.includes("date")
        ) {
            return res.status(400).json({
                success: false,
                error: err.message,
            });
        }

        res.status(500).json({
            success: false,
            error: "Something went wrong",
        });
    }
};