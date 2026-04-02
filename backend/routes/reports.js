const express = require("express");
const { PrismaClient } = require("@prisma/client");

const router = express.Router();
const prisma = new PrismaClient();

// Dynamic BI Query Endpoint
router.get("/query", async (req, res) => {
  try {
    const { metric = "revenue", groupBy = "stage" } = req.query; 

    // Aggregate Revenue
    if (metric === "revenue") {
      const data = await prisma.deal.groupBy({
        by: [groupBy],
        _sum: { amount: true }
      });
      const formatted = data.map(d => ({ 
        name: String(d[groupBy]).toUpperCase(), 
        value: d._sum.amount || 0 
      })).filter(d => d.value > 0);
      
      return res.json(formatted);
    } 
    
    // Aggregate Deal Count
    if (metric === "count") {
      const data = await prisma.deal.groupBy({
        by: [groupBy],
        _count: { id: true }
      });
      const formatted = data.map(d => ({ 
        name: String(d[groupBy]).toUpperCase(), 
        value: d._count.id 
      }));
      
      return res.json(formatted);
    }

    res.status(400).json({ error: "Unsupported metric requested by BI Engine." });
  } catch (err) {
    console.error("[BI Engine Error]:", err);
    res.status(500).json({ error: "Failed to generate dynamic report payload." });
  }
});

// CSV Export Endpoint
router.get("/export-csv", async (req, res) => {
  try {
    const { metric = "revenue", groupBy = "stage" } = req.query;
    let formatted = [];

    if (metric === "revenue") {
      const data = await prisma.deal.groupBy({
        by: [groupBy],
        _sum: { amount: true },
      });
      formatted = data
        .map((d) => ({
          name: String(d[groupBy]).toUpperCase(),
          value: d._sum.amount || 0,
        }))
        .filter((d) => d.value > 0);
    } else if (metric === "count") {
      const data = await prisma.deal.groupBy({
        by: [groupBy],
        _count: { id: true },
      });
      formatted = data.map((d) => ({
        name: String(d[groupBy]).toUpperCase(),
        value: d._count.id,
      }));
    } else {
      return res.status(400).json({ error: "Unsupported metric for CSV export." });
    }

    let csv = "Name,Value\n";
    formatted.forEach((row) => {
      csv += `"${String(row.name).replace(/"/g, '""')}",${row.value}\n`;
    });

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=report.csv");
    res.send(csv);
  } catch (err) {
    console.error("[CSV Export Error]:", err);
    res.status(500).json({ error: "Failed to export CSV report." });
  }
});

module.exports = router;
