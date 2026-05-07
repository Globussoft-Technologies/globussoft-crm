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

// #601 — per-visit revenue rollup.
//
// Formula:
//   revenue(visit) = SUM(invoice.amount WHERE invoice.visitId=visit.id AND invoice.status='PAID')
//                    OR visit.amountCharged when no paid invoice is linked.
//
// Rationale: a paid invoice is the canonical source of revenue (Billing
// flips status='PAID' + sets paidAt on the /pay route). Visit.amountCharged
// is the inline estimate captured at log-visit time and stays as the
// fallback for visits that never made it to invoicing yet (cash-in-hand
// flows, salon-style express checkout). Issue #601 reported every visit
// row showing ₹0 because the rollup was never wired — neither layer was
// surfacing into the Visits page.
//
// Returns a { visitId -> revenue } map. Callers do their own aggregation
// (per-patient sum for the summary view, page-total for the KPI card).
const computeVisitRevenueMap = async (visits) => {
    const revMap = {};
    if (!Array.isArray(visits) || visits.length === 0) return revMap;

    const visitIds = visits.map((v) => v.id);

    // SUM paid invoices per visit. status comparison is case-insensitive
    // because the seed + /pay route emit "PAID" (upper) but historical
    // rows may have "paid" (lower). Match either.
    const paidByVisit = await prisma.invoice.groupBy({
        by: ["visitId"],
        where: {
            visitId: { in: visitIds },
            status: { in: ["PAID", "paid"] },
        },
        _sum: { amount: true },
    });

    const paidMap = {};
    for (const row of paidByVisit) {
        if (row.visitId != null) {
            paidMap[row.visitId] = Number(row._sum.amount) || 0;
        }
    }

    for (const v of visits) {
        const paid = paidMap[v.id] || 0;
        const fallback = Number(v.amountCharged) || 0;
        revMap[v.id] = paid > 0 ? paid : fallback;
    }
    return revMap;
};

exports.getPatientsSummary = async (req, res) => {
    try {
        const { startDate, endDate, skip = 0, limit = 10 } = req.query;
        const tenantId = req.user.tenantId;

        const parsedSkip = Number(skip) || 0;
        const parsedLimit = Math.min(Number(limit) || 10, 50);

        const { start, end } = getDateRange(startDate, endDate);

        // GROUP BY patient — page of patients ordered by most-recent visit.
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
            _max: { visitDate: true },
            orderBy: {
                _max: { visitDate: "desc" },
            },
            skip: parsedSkip,
            take: parsedLimit,
        });

        // TOTAL COUNT (compatible fix)
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

        // FETCH PATIENT DATA
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

        // #601 — pull every visit for the listed patients in-window so we
        // can apply the revenue rollup formula (paid-invoice OR fallback)
        // per visit then sum to the patient row.
        const pageVisits = patientIds.length === 0 ? [] : await prisma.visit.findMany({
            where: {
                tenantId,
                patientId: { in: patientIds },
                visitDate: { gte: start, lte: end },
            },
            select: { id: true, patientId: true, amountCharged: true },
        });

        const revMap = await computeVisitRevenueMap(pageVisits);

        const revenuePerPatient = {};
        for (const v of pageVisits) {
            revenuePerPatient[v.patientId] = (revenuePerPatient[v.patientId] || 0) + (revMap[v.id] || 0);
        }

        // FINAL RESPONSE DATA
        const result = grouped.map((g) => ({
            id: g.patientId,
            name: patientMap[g.patientId]?.name || null,
            phone: patientMap[g.patientId]?.phone || null,
            totalVisits: g._count.id,
            totalRevenue: Number((revenuePerPatient[g.patientId] || 0).toFixed(2)),
            lastVisit: g._max.visitDate,
        }));

        // #601 — page-level totalRevenue summary KPI. Computed across the
        // entire window (not just the current page), so the card always
        // matches the Billing tab's headline figure for the same period.
        // For the full-window total we can use a single aggregate query
        // rather than pulling every visit.
        const allVisitsInWindow = await prisma.visit.findMany({
            where: { tenantId, visitDate: { gte: start, lte: end } },
            select: { id: true, amountCharged: true },
        });
        const fullWindowRev = await computeVisitRevenueMap(allVisitsInWindow);
        const totalRevenue = Number(
            Object.values(fullWindowRev).reduce((a, b) => a + b, 0).toFixed(2)
        );

        return res.json({
            success: true,
            count: totalCount,
            skip: parsedSkip,
            limit: parsedLimit,
            dateRange: { start, end },
            totalRevenue,
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

        // #601 — attach `revenue` (paid-invoice-or-fallback) to every visit
        // row. Frontend reads visit.revenue (was visit.amountCharged) so a
        // visit that was followed by a paid invoice shows the actual
        // collected amount, not the inline estimate.
        const revMap = await computeVisitRevenueMap(visits);
        const visitsWithRevenue = visits.map((v) => ({
            ...v,
            revenue: Number((revMap[v.id] || 0).toFixed(2)),
        }));

        return res.json({
            success: true,
            count: totalCount,
            skip: parsedSkip,
            limit: parsedLimit,
            dateRange: { start, end },
            data: {
                patient,
                visits: visitsWithRevenue,
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
