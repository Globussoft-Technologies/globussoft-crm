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

module.exports = router;
