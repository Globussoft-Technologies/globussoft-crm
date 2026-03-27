const express = require("express");
const { PrismaClient } = require("@prisma/client");
const { verifyToken } = require("../middleware/auth");

const router = express.Router();
const prisma = new PrismaClient();

// Get all Custom Entities (Settings Schema Viewer)
router.get("/entities", verifyToken, async (req, res) => {
  try {
    const list = await prisma.customEntity.findMany({ include: { fields: true }});
    res.json(list);
  } catch(err) {
    res.status(500).json({ error: "Failed to read EAV entity schema mapping." });
  }
});

// Create new Entity Type & Fields
router.post("/entities", verifyToken, async (req, res) => {
  try {
    const { name, description, fields } = req.body; // fields: [{name, type}]
    
    // Prisma nested creation pipeline
    const entity = await prisma.customEntity.create({
      data: {
        name,
        description,
        fields: {
          create: fields.map(f => ({ name: f.name, type: f.type }))
        }
      },
      include: { fields: true }
    });
    res.status(201).json(entity);
  } catch(err) {
    res.status(500).json({ error: "Custom Object Schema mutation failed" });
  }
});

// Fetch all Custom Records for a specific Entity Name mapping
router.get("/records/:entityName", verifyToken, async (req, res) => {
  try {
    const entity = await prisma.customEntity.findUnique({
      where: { name: req.params.entityName },
      include: { fields: true }
    });
    
    if (!entity) return res.status(404).json({ error: "Entity definition missing." });
    
    // Fetch generic rows mapping values back to the EAV dictionary
    const records = await prisma.customRecord.findMany({
      where: { entityId: entity.id },
      include: { values: { include: { field: true } } }
    });
    
    // Transformation format for React UI tables
    const formatted = records.map(r => {
      const row = { id: r.id, createdAt: r.createdAt };
      r.values.forEach(v => {
        const valType = v.field.type;
        row[v.field.name] = (valType === 'Number' ? v.valueNum : valType === 'Boolean' ? v.valueBool : valType === 'Date' ? v.valueDate : v.valueStr);
      });
      return row;
    });
    
    res.json({ entity, records: formatted });
  } catch(err) {
    res.status(500).json({ error: "Record query compilation failed." });
  }
});

// Create a new Custom Record Instance within EAV Table
router.post("/records/:entityName", verifyToken, async (req, res) => {
  try {
    const entity = await prisma.customEntity.findUnique({
      where: { name: req.params.entityName },
      include: { fields: true }
    });
    
    if (!entity) return res.status(404).json({ error: "Entity constraint violation." });
    
    const payload = req.body; // { "License Plate": "ABC", "Wheels": 4 }
    
    const valuesData = entity.fields.map(field => {
      const val = payload[field.name];
      const out = { fieldId: field.id };
      if (field.type === 'Number') out.valueNum = parseFloat(val);
      else if (field.type === 'Boolean') out.valueBool = Boolean(val);
      else out.valueStr = val ? val.toString() : '';
      return out;
    });

    const record = await prisma.customRecord.create({
      data: {
        entityId: entity.id,
        values: { create: valuesData }
      }
    });
    
    res.status(201).json(record);
  } catch(err) {
    res.status(500).json({ error: "Dynamic allocation row creation failed." });
  }
});

module.exports = router;
