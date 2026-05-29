// Consumption-unit catalogue + conversion for AutoConsumptionRule.
//
// Background — `Product.unit` is the canonical base unit a product is stocked
// in. `AutoConsumptionRule.unit` is what the admin typed at the rule level
// (e.g. "15 ml" against a product stocked in "ltr"). The applier needs to
// convert ruleQty (rule.unit) → product.unit before deducting.
//
// Conversion table is intentionally tiny — only volume (ml ↔ ltr) and mass
// (gm ↔ kg). Count-style units (piece / unit / bottle / tube / pack) cannot
// convert into one another — they must match exactly.

const ALLOWED_UNITS = [
  "ml",
  "gm",
  "kg",
  "piece",
  "unit",
  "bottle",
  "tube",
  "pack",
  "ltr",
];

// Each unit's base + factor toward base. Volume base = ml, mass base = gm.
// Count-style units each form their own singleton "family" — they only
// convert to themselves.
const TABLE = {
  ml: { family: "volume", toBase: 1 },
  ltr: { family: "volume", toBase: 1000 },
  gm: { family: "mass", toBase: 1 },
  kg: { family: "mass", toBase: 1000 },
  piece: { family: "piece" },
  unit: { family: "unit" },
  bottle: { family: "bottle" },
  tube: { family: "tube" },
  pack: { family: "pack" },
};

function isAllowedUnit(u) {
  return typeof u === "string" && ALLOWED_UNITS.includes(u);
}

// True iff fromUnit can be converted to toUnit losslessly.
function isConvertible(fromUnit, toUnit) {
  if (!isAllowedUnit(fromUnit) || !isAllowedUnit(toUnit)) return false;
  if (fromUnit === toUnit) return true;
  return TABLE[fromUnit].family === TABLE[toUnit].family;
}

// Convert qty in `fromUnit` to the equivalent qty in `toUnit`. Throws if
// the pair isn't convertible — callers should pre-check with isConvertible.
function convertQuantity(qty, fromUnit, toUnit) {
  if (fromUnit === toUnit) return qty;
  if (!isConvertible(fromUnit, toUnit)) {
    throw new Error(`Cannot convert ${fromUnit} → ${toUnit}`);
  }
  // Both in the same volume/mass family — multiply through the base.
  const inBase = qty * TABLE[fromUnit].toBase;
  return inBase / TABLE[toUnit].toBase;
}

module.exports = {
  ALLOWED_UNITS,
  isAllowedUnit,
  isConvertible,
  convertQuantity,
};
