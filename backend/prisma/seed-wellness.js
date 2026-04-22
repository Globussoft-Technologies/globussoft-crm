/**
 * Seed script for the Enhanced Wellness demo tenant.
 *
 * Idempotent — safe to re-run. Will:
 *   - upsert Tenant slug "enhanced-wellness" with vertical="wellness"
 *   - upsert Rishu (admin), 3 doctors, 12 professionals, 2 helpers, 1 telecaller
 *   - upsert service catalog (hair transplant, Botox, fillers, haircut, slimming, Ayurveda, ...)
 *   - generate ~50 patients, ~200 visits over the last 90 days
 *   - generate ~30 active leads (as Contact rows scoped to this tenant)
 *   - generate 3 hand-crafted AgentRecommendation cards for the demo
 *
 * Run: cd backend && node prisma/seed-wellness.js
 */
const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");

const prisma = new PrismaClient();

const TENANT_SLUG = "enhanced-wellness";
const PASSWORD = "password123";

// ── Helpers ────────────────────────────────────────────────────────

const indianFirstNames = [
  "Aarav", "Vivaan", "Aditya", "Vihaan", "Arjun", "Sai", "Reyansh", "Krishna",
  "Ishaan", "Shaurya", "Atharv", "Advik", "Pranav", "Dhruv", "Kabir", "Rohan",
  "Ananya", "Aadhya", "Aaradhya", "Diya", "Sara", "Pari", "Anika", "Navya",
  "Ira", "Myra", "Aanya", "Riya", "Avni", "Saanvi", "Kiara", "Mira",
  "Rishabh", "Kunal", "Manish", "Suresh", "Ramesh", "Mahesh", "Rajesh", "Sandeep",
  "Pooja", "Priya", "Sneha", "Neha", "Kavita", "Sunita", "Anita", "Geeta",
];

const indianLastNames = [
  "Sharma", "Verma", "Singh", "Kumar", "Gupta", "Patel", "Shah", "Jain",
  "Mehta", "Agarwal", "Bansal", "Mishra", "Tiwari", "Yadav", "Reddy", "Nair",
  "Iyer", "Menon", "Das", "Bose", "Chatterjee", "Banerjee", "Mukherjee", "Sen",
];

// Service catalog matched to Dr. Haror's Wellness offerings (the franchise Rishu
// runs in Ranchi). Prices are realistic Indian market estimates; durations and
// radii reflect the call's segmentation (salon 3km, aesthetics ~Ranchi-wide ~30km,
// high-ticket transplants/contouring ~Jharkhand-wide ~200km).
const services = [
  // ── Hair Transplant (high-ticket, draws from all of Jharkhand) ───────
  { name: "Ultra Receptive Hair Transplant",      category: "hair-transplant", ticketTier: "high",   basePrice: 200000, durationMin: 540, targetRadiusKm: 200, description: "Premium custom hair transplant for advanced grade hair loss" },
  { name: "Unshaven FUE Hair Transplant",         category: "hair-transplant", ticketTier: "high",   basePrice: 175000, durationMin: 480, targetRadiusKm: 200, description: "FUE without shaving the donor area — minimal downtime" },
  { name: "Bio FUE Hair Transplant",              category: "hair-transplant", ticketTier: "high",   basePrice: 130000, durationMin: 480, targetRadiusKm: 200, description: "Bio-enriched FUE with growth factors for higher graft survival" },
  { name: "Direct Hair Transplant (DHI)",         category: "hair-transplant", ticketTier: "high",   basePrice: 150000, durationMin: 480, targetRadiusKm: 200, description: "DHI implanter pen technique — no pre-made channels" },
  { name: "Robotic Hair Transplant",              category: "hair-transplant", ticketTier: "high",   basePrice: 220000, durationMin: 540, targetRadiusKm: 200, description: "Robot-assisted graft extraction for precision" },
  { name: "Beard & Moustache Transplant",         category: "hair-transplant", ticketTier: "high",   basePrice: 90000,  durationMin: 360, targetRadiusKm: 200, description: "Facial hair restoration for thin or patchy beard" },
  { name: "Eyebrow Transplant",                   category: "hair-transplant", ticketTier: "high",   basePrice: 75000,  durationMin: 240, targetRadiusKm: 200, description: "Permanent natural-looking eyebrow restoration" },
  { name: "Body Hair Transplant",                 category: "hair-transplant", ticketTier: "high",   basePrice: 180000, durationMin: 540, targetRadiusKm: 200, description: "Body hair as donor for scalp restoration" },
  { name: "Hairline Reconstruction",              category: "hair-transplant", ticketTier: "high",   basePrice: 110000, durationMin: 360, targetRadiusKm: 200, description: "Natural hairline design + restoration" },
  { name: "Long Hair Transplant",                 category: "hair-transplant", ticketTier: "high",   basePrice: 195000, durationMin: 540, targetRadiusKm: 200, description: "Hair transplant without shaving — see results immediately" },
  { name: "Giga Session Hair Transplant",         category: "hair-transplant", ticketTier: "high",   basePrice: 250000, durationMin: 600, targetRadiusKm: 200, description: "Mega-session 4000+ grafts in a single sitting" },
  { name: "Failed Hair Transplant Repair",        category: "hair-transplant", ticketTier: "high",   basePrice: 160000, durationMin: 480, targetRadiusKm: 200, description: "Corrective procedure for unsatisfactory prior transplant" },

  // ── Hair Restoration (non-surgical, multi-session) ───────────────────
  { name: "QR 678 Hair Treatment",                category: "hair-restoration", ticketTier: "medium", basePrice: 8500,  durationMin: 45, targetRadiusKm: 50,  description: "Patented growth-factor formula for hair regeneration" },
  { name: "GFC Hair Treatment",                   category: "hair-restoration", ticketTier: "medium", basePrice: 7500,  durationMin: 45, targetRadiusKm: 50,  description: "Growth Factor Concentrate scalp injection" },
  { name: "Hair PRP Therapy",                     category: "hair-restoration", ticketTier: "medium", basePrice: 5500,  durationMin: 60, targetRadiusKm: 50,  description: "Platelet-rich plasma scalp injection for hair regrowth" },
  { name: "Mesogrow Therapy",                     category: "hair-restoration", ticketTier: "medium", basePrice: 6500,  durationMin: 45, targetRadiusKm: 50,  description: "Mesotherapy cocktail for scalp nourishment" },
  { name: "Exosomes Hair Therapy",                category: "hair-restoration", ticketTier: "high",   basePrice: 18000, durationMin: 60, targetRadiusKm: 100, description: "Stem-cell derived exosome therapy for hair regrowth" },
  { name: "Keravive Therapy",                     category: "hair-restoration", ticketTier: "medium", basePrice: 7000,  durationMin: 60, targetRadiusKm: 50,  description: "HydraFacial Keravive scalp cleansing + nourishment" },
  { name: "Scalp Micropigmentation",              category: "hair-restoration", ticketTier: "high",   basePrice: 45000, durationMin: 240, targetRadiusKm: 100, description: "Cosmetic tattoo for hair-density illusion" },
  { name: "Low Level Laser Light Therapy",        category: "hair-restoration", ticketTier: "low",    basePrice: 1500,  durationMin: 30, targetRadiusKm: 30,  description: "LLLT cap session for hair stimulation" },
  { name: "Stem Cell Therapy for Hair",           category: "hair-restoration", ticketTier: "high",   basePrice: 35000, durationMin: 90, targetRadiusKm: 100, description: "Autologous stem cells for hair regeneration" },
  { name: "Hair Thread Treatment",                category: "hair-restoration", ticketTier: "medium", basePrice: 12000, durationMin: 60, targetRadiusKm: 50,  description: "Threads to stimulate scalp circulation" },
  { name: "Scalp Peel",                           category: "hair-restoration", ticketTier: "low",    basePrice: 2500,  durationMin: 30, targetRadiusKm: 30,  description: "Chemical scalp peel for dandruff and oil control" },

  // ── Hair Concerns (consultations) ────────────────────────────────────
  { name: "Hair Loss Consultation",               category: "hair-concern", ticketTier: "low", basePrice: 800,  durationMin: 30, targetRadiusKm: 30, description: "Initial diagnostic consultation for hair-loss concerns" },
  { name: "Alopecia Areata Treatment",            category: "hair-concern", ticketTier: "medium", basePrice: 4500, durationMin: 30, targetRadiusKm: 50, description: "Per-session injection therapy for alopecia patches" },
  { name: "Dandruff Treatment",                   category: "hair-concern", ticketTier: "low", basePrice: 1200,  durationMin: 30, targetRadiusKm: 30, description: "Medicated treatment for chronic dandruff" },
  { name: "Premature Greying Treatment",          category: "hair-concern", ticketTier: "low", basePrice: 2000,  durationMin: 45, targetRadiusKm: 30, description: "Targeted therapy for early greying of hair" },

  // ── Skin Concerns / Dermatology ──────────────────────────────────────
  { name: "Dermatology Consultation",             category: "skin", ticketTier: "low",    basePrice: 800,   durationMin: 20, targetRadiusKm: 30, description: "Initial diagnostic skin consultation" },
  { name: "Acne Vulgaris Treatment",              category: "skin", ticketTier: "medium", basePrice: 3500,  durationMin: 30, targetRadiusKm: 30, description: "Customized active-acne treatment plan" },
  { name: "Eczema / Dermatitis Care",             category: "skin", ticketTier: "low",    basePrice: 1500,  durationMin: 30, targetRadiusKm: 30, description: "Diagnosis + topical/oral therapy for eczema" },
  { name: "Vitiligo Treatment",                   category: "skin", ticketTier: "medium", basePrice: 4500,  durationMin: 45, targetRadiusKm: 50, description: "Excimer laser + adjunctive therapy for vitiligo" },
  { name: "Melasma Treatment",                    category: "skin", ticketTier: "medium", basePrice: 5500,  durationMin: 45, targetRadiusKm: 30, description: "Multi-modal pigmentation correction for melasma" },
  { name: "Psoriasis Care",                       category: "skin", ticketTier: "medium", basePrice: 4000,  durationMin: 30, targetRadiusKm: 50, description: "Long-term psoriasis management plan" },
  { name: "PCOD Skin Care Plan",                  category: "skin", ticketTier: "medium", basePrice: 3000,  durationMin: 30, targetRadiusKm: 30, description: "PCOD-related acne and hirsutism management" },

  // ── Skin Surgery ─────────────────────────────────────────────────────
  { name: "Acne Scar Subscision",                 category: "skin-surgery", ticketTier: "medium", basePrice: 7500,  durationMin: 45, targetRadiusKm: 50,  description: "Subscision technique for atrophic acne scars" },
  { name: "Mole Removal (Surgical)",              category: "skin-surgery", ticketTier: "medium", basePrice: 4500,  durationMin: 30, targetRadiusKm: 30,  description: "Excision of moles with cosmetic closure" },
  { name: "Skin Tag Removal",                     category: "skin-surgery", ticketTier: "low",    basePrice: 2000,  durationMin: 20, targetRadiusKm: 30,  description: "Cautery / radiofrequency removal of skin tags" },
  { name: "Earlobe Repair",                       category: "skin-surgery", ticketTier: "medium", basePrice: 5500,  durationMin: 45, targetRadiusKm: 50,  description: "Surgical repair of torn or stretched earlobes" },
  { name: "Cyst / Lipoma Removal",                category: "skin-surgery", ticketTier: "medium", basePrice: 8500,  durationMin: 60, targetRadiusKm: 50,  description: "Surgical excision of cysts or lipomas" },
  { name: "Wart / Cautery Treatment",             category: "skin-surgery", ticketTier: "low",    basePrice: 1500,  durationMin: 20, targetRadiusKm: 30,  description: "Cautery / cryotherapy for warts and DPN" },

  // ── Under Eye ────────────────────────────────────────────────────────
  { name: "Dark Circles Removal Plan",            category: "under-eye", ticketTier: "medium", basePrice: 6500,  durationMin: 45, targetRadiusKm: 30, description: "Combination therapy for periorbital pigmentation" },
  { name: "Under Eye Fillers",                    category: "under-eye", ticketTier: "high",   basePrice: 32000, durationMin: 45, targetRadiusKm: 50, description: "HA fillers to correct hollow tear troughs" },
  { name: "Tear Trough Correction",               category: "under-eye", ticketTier: "high",   basePrice: 28000, durationMin: 45, targetRadiusKm: 50, description: "Cannula-based tear-trough volumization" },
  { name: "Under Eye Boosters",                   category: "under-eye", ticketTier: "medium", basePrice: 12000, durationMin: 30, targetRadiusKm: 30, description: "Skin-booster injections for under-eye texture" },

  // ── Acne & Acne Scars ────────────────────────────────────────────────
  { name: "Acne Peel",                            category: "acne", ticketTier: "low",    basePrice: 2500,  durationMin: 30, targetRadiusKm: 30, description: "Salicylic acid peel for active acne" },
  { name: "Carbon Peel (Laser)",                  category: "acne", ticketTier: "medium", basePrice: 4500,  durationMin: 45, targetRadiusKm: 30, description: "Q-switched laser carbon peel for oily/acne skin" },
  { name: "Chemical Peel",                        category: "acne", ticketTier: "medium", basePrice: 3500,  durationMin: 45, targetRadiusKm: 30, description: "Glycolic / TCA peel for skin renewal" },
  { name: "Dermaroller / Microneedling",          category: "acne", ticketTier: "medium", basePrice: 4000,  durationMin: 45, targetRadiusKm: 30, description: "Microneedling for scar remodelling and skin rejuvenation" },
  { name: "Fractional CO2 Laser",                 category: "acne", ticketTier: "high",   basePrice: 12000, durationMin: 60, targetRadiusKm: 50, description: "Fractional ablative laser for acne scars" },
  { name: "Radiofrequency Microneedling",         category: "acne", ticketTier: "high",   basePrice: 15000, durationMin: 60, targetRadiusKm: 50, description: "RF microneedling for deep acne scars and tightening" },

  // ── Pigmentation / Skin Brightening ──────────────────────────────────
  { name: "Cosmelan Depigmentation",              category: "pigmentation", ticketTier: "high",   basePrice: 25000, durationMin: 90, targetRadiusKm: 50, description: "Professional Cosmelan mask + take-home kit" },
  { name: "Vampire Facial (PRP)",                 category: "pigmentation", ticketTier: "medium", basePrice: 8500,  durationMin: 75, targetRadiusKm: 30, description: "Microneedling with autologous PRP" },
  { name: "HydraFacial Basic",                    category: "pigmentation", ticketTier: "medium", basePrice: 5500,  durationMin: 60, targetRadiusKm: 30, description: "Multi-step cleanse, exfoliate, hydrate" },
  { name: "HydraFacial Elite",                    category: "pigmentation", ticketTier: "medium", basePrice: 9500,  durationMin: 75, targetRadiusKm: 30, description: "Premium HydraFacial with boosters and LED" },
  { name: "Skin Boosters",                        category: "pigmentation", ticketTier: "high",   basePrice: 16000, durationMin: 45, targetRadiusKm: 50, description: "Injectable hydration boosters for glow" },
  { name: "Profhillo Bio-Remodelling",            category: "pigmentation", ticketTier: "high",   basePrice: 22000, durationMin: 45, targetRadiusKm: 50, description: "Bio-stimulating HA for skin remodelling" },
  { name: "Glow Peel",                            category: "pigmentation", ticketTier: "low",    basePrice: 2500,  durationMin: 30, targetRadiusKm: 30, description: "Quick brightening peel for glow" },

  // ── MediFacial ───────────────────────────────────────────────────────
  { name: "Korean Glass Skin Facial",             category: "medifacial", ticketTier: "medium", basePrice: 7500,  durationMin: 75, targetRadiusKm: 30, description: "K-beauty-style hydration + glow facial" },
  { name: "Diamond Polishing Facial",             category: "medifacial", ticketTier: "low",    basePrice: 2500,  durationMin: 45, targetRadiusKm: 20, description: "Microdermabrasion polish for smooth skin" },
  { name: "Oxy Facial",                           category: "medifacial", ticketTier: "low",    basePrice: 2200,  durationMin: 45, targetRadiusKm: 20, description: "Pure-oxygen infusion facial" },
  { name: "Power Glow Facial",                    category: "medifacial", ticketTier: "medium", basePrice: 4500,  durationMin: 60, targetRadiusKm: 30, description: "Signature anti-dull radiance facial" },
  { name: "7D Lift Facial",                       category: "medifacial", ticketTier: "high",   basePrice: 12000, durationMin: 90, targetRadiusKm: 30, description: "Multi-step lifting facial with HIFU touch" },
  { name: "Red Carpet Peel",                      category: "medifacial", ticketTier: "medium", basePrice: 4500,  durationMin: 45, targetRadiusKm: 30, description: "Quick brightening peel for events" },
  { name: "IV Glow Drip",                         category: "medifacial", ticketTier: "high",   basePrice: 8500,  durationMin: 60, targetRadiusKm: 30, description: "IV vitamin/glutathione drip for inner glow" },

  // ── Anti-Ageing / Injectables ────────────────────────────────────────
  { name: "Botox / Anti-Wrinkle Injection",       category: "anti-ageing", ticketTier: "high", basePrice: 25000, durationMin: 30, targetRadiusKm: 30, description: "Botulinum toxin for forehead/glabellar/crow's feet" },
  { name: "Cheek Fillers",                        category: "anti-ageing", ticketTier: "high", basePrice: 35000, durationMin: 60, targetRadiusKm: 50, description: "HA filler for cheek volumization and contour" },
  { name: "Lip Fillers",                          category: "anti-ageing", ticketTier: "high", basePrice: 28000, durationMin: 45, targetRadiusKm: 50, description: "HA filler for lip volume and shape enhancement" },
  { name: "Dermal Fillers (Full Face)",           category: "anti-ageing", ticketTier: "high", basePrice: 65000, durationMin: 90, targetRadiusKm: 50, description: "Multi-area HA filler liquid facelift" },
  { name: "Thread Lift",                          category: "anti-ageing", ticketTier: "high", basePrice: 55000, durationMin: 90, targetRadiusKm: 50, description: "PDO/PLLA thread lift for sagging skin" },
  { name: "HIFU Facelift",                        category: "anti-ageing", ticketTier: "high", basePrice: 35000, durationMin: 75, targetRadiusKm: 50, description: "High-intensity focused ultrasound non-surgical facelift" },
  { name: "Ulthera Lift",                         category: "anti-ageing", ticketTier: "high", basePrice: 95000, durationMin: 90, targetRadiusKm: 100, description: "FDA-approved ultrasound deep skin lift" },
  { name: "RF Skin Tightening",                   category: "anti-ageing", ticketTier: "medium", basePrice: 9500, durationMin: 60, targetRadiusKm: 30, description: "Radiofrequency skin tightening" },
  { name: "PDRN Treatment",                       category: "anti-ageing", ticketTier: "high", basePrice: 18000, durationMin: 60, targetRadiusKm: 50, description: "Salmon DNA injectable for skin regeneration" },
  { name: "Vampire Facelift",                     category: "anti-ageing", ticketTier: "high", basePrice: 28000, durationMin: 90, targetRadiusKm: 50, description: "PRP + filler combo for non-surgical facelift" },
  { name: "Double Chin Reduction",                category: "anti-ageing", ticketTier: "medium", basePrice: 18000, durationMin: 45, targetRadiusKm: 50, description: "Submental fat reduction injectable" },
  { name: "Non-Surgical Face Lift",               category: "anti-ageing", ticketTier: "high", basePrice: 45000, durationMin: 90, targetRadiusKm: 50, description: "Combination injectable + energy device facelift" },

  // ── Laser Hair Removal ───────────────────────────────────────────────
  { name: "Full Body Laser Hair Removal",         category: "laser-hair", ticketTier: "high",   basePrice: 65000, durationMin: 180, targetRadiusKm: 50, description: "Full body diode laser package (8 sessions)" },
  { name: "Face Laser Hair Removal",              category: "laser-hair", ticketTier: "medium", basePrice: 4500,  durationMin: 30, targetRadiusKm: 30, description: "Permanent facial hair reduction" },
  { name: "Underarm Laser Hair Removal",          category: "laser-hair", ticketTier: "low",    basePrice: 2500,  durationMin: 20, targetRadiusKm: 30, description: "Permanent underarm hair reduction" },
  { name: "Bikini Laser Hair Removal",            category: "laser-hair", ticketTier: "medium", basePrice: 5500,  durationMin: 30, targetRadiusKm: 30, description: "Bikini-line laser hair reduction" },
  { name: "Arms Laser Hair Removal",              category: "laser-hair", ticketTier: "medium", basePrice: 6500,  durationMin: 45, targetRadiusKm: 30, description: "Full-arm permanent hair reduction" },
  { name: "Legs Laser Hair Removal",              category: "laser-hair", ticketTier: "medium", basePrice: 8500,  durationMin: 60, targetRadiusKm: 30, description: "Full-leg permanent hair reduction" },

  // ── Laser Skin ───────────────────────────────────────────────────────
  { name: "Tattoo Removal (Laser)",               category: "laser-skin", ticketTier: "medium", basePrice: 3500, durationMin: 30, targetRadiusKm: 50, description: "Q-switched laser per session for tattoo removal" },
  { name: "Birthmark Removal",                    category: "laser-skin", ticketTier: "medium", basePrice: 4500, durationMin: 30, targetRadiusKm: 50, description: "Laser treatment for vascular/pigmented birthmarks" },
  { name: "Mole Laser Removal",                   category: "laser-skin", ticketTier: "low",    basePrice: 2500, durationMin: 20, targetRadiusKm: 30, description: "Laser ablation for benign moles" },

  // ── Body Contouring (very high-ticket, draws statewide) ──────────────
  { name: "Liposuction",                          category: "body-contouring", ticketTier: "high", basePrice: 250000, durationMin: 240, targetRadiusKm: 200, description: "Surgical fat removal from targeted areas" },
  { name: "Cryolipolysis (CoolSculpting)",        category: "body-contouring", ticketTier: "high", basePrice: 35000,  durationMin: 60,  targetRadiusKm: 100, description: "Non-invasive fat-freezing per area" },
  { name: "Body Shaping (Cavitation)",            category: "body-contouring", ticketTier: "medium", basePrice: 5500, durationMin: 60, targetRadiusKm: 30, description: "Ultrasonic cavitation inch-loss session" },
  { name: "Cellulite Treatment",                  category: "body-contouring", ticketTier: "medium", basePrice: 4500, durationMin: 60, targetRadiusKm: 30, description: "Combination therapy for cellulite reduction" },
  { name: "Gynecomastia Surgery",                 category: "body-contouring", ticketTier: "high", basePrice: 95000, durationMin: 180, targetRadiusKm: 200, description: "Male breast reduction surgery" },
  { name: "Eyelid Surgery (Blepharoplasty)",      category: "body-contouring", ticketTier: "high", basePrice: 75000, durationMin: 120, targetRadiusKm: 200, description: "Surgical correction of upper/lower eyelids" },
  { name: "Ozempic Weight Loss Plan",             category: "body-contouring", ticketTier: "high", basePrice: 15000, durationMin: 30,  targetRadiusKm: 50,  description: "Monthly Ozempic plan with monitoring" },
  { name: "Mounjaro Weight Loss Plan",            category: "body-contouring", ticketTier: "high", basePrice: 22000, durationMin: 30,  targetRadiusKm: 50,  description: "Monthly Mounjaro plan with monitoring" },
  { name: "Lipolysis Injections",                 category: "body-contouring", ticketTier: "medium", basePrice: 12000, durationMin: 45, targetRadiusKm: 50, description: "Targeted injectable for stubborn fat pockets" },
  { name: "Ear / Nose Piercing",                  category: "body-contouring", ticketTier: "low", basePrice: 1500, durationMin: 15, targetRadiusKm: 20, description: "Sterile ear and nose piercing service" },

  // ── Ayurveda (Rishu mentioned this; not on Dr Haror's main site) ─────
  { name: "Ayurveda Consultation",                category: "ayurveda", ticketTier: "low",    basePrice: 1500, durationMin: 45, targetRadiusKm: 30, description: "Initial doshic assessment and lifestyle plan" },
  { name: "Shirodhara",                           category: "ayurveda", ticketTier: "medium", basePrice: 2500, durationMin: 75, targetRadiusKm: 30, description: "Continuous warm-oil forehead therapy" },

  // ── Salon (3 km radius — Rishu's clinic includes a salon) ────────────
  { name: "Haircut & Styling",                    category: "salon", ticketTier: "low", basePrice: 500,  durationMin: 30, targetRadiusKm: 3, description: "Salon haircut + blow-dry" },
  { name: "Hair Color (Full Head)",               category: "salon", ticketTier: "low", basePrice: 2500, durationMin: 90, targetRadiusKm: 3, description: "Full-head professional hair coloring" },
];

const staffSeed = [
  // Demo accounts — easy to remember for live demos
  { email: "admin@wellness.demo", name: "Demo Admin", role: "ADMIN", wellnessRole: null },
  { email: "user@wellness.demo", name: "Demo User", role: "USER", wellnessRole: "professional" },
  // Doctors
  { email: "rishu@enhancedwellness.in", name: "Rishu Agarwal (Owner)", role: "ADMIN", wellnessRole: null },
  { email: "drharsh@enhancedwellness.in", name: "Dr. Harsh Kumar", role: "USER", wellnessRole: "doctor" },
  { email: "drmeena@enhancedwellness.in", name: "Dr. Meena Sharma", role: "USER", wellnessRole: "doctor" },
  { email: "drvikas@enhancedwellness.in", name: "Dr. Vikas Singh", role: "USER", wellnessRole: "doctor" },
  // Manager
  { email: "manager@enhancedwellness.in", name: "Pooja Mehta (Clinic Manager)", role: "MANAGER", wellnessRole: null },
  // Telecaller
  { email: "telecaller@enhancedwellness.in", name: "Ankita Verma", role: "USER", wellnessRole: "telecaller" },
  // Professionals — 12
  { email: "stylist1@enhancedwellness.in", name: "Ravi Pandey", role: "USER", wellnessRole: "professional" },
  { email: "stylist2@enhancedwellness.in", name: "Sneha Gupta", role: "USER", wellnessRole: "professional" },
  { email: "aestheticn1@enhancedwellness.in", name: "Priya Yadav", role: "USER", wellnessRole: "professional" },
  { email: "aestheticn2@enhancedwellness.in", name: "Kavita Iyer", role: "USER", wellnessRole: "professional" },
  { email: "slimming1@enhancedwellness.in", name: "Ramesh Patel", role: "USER", wellnessRole: "professional" },
  { email: "slimming2@enhancedwellness.in", name: "Suresh Nair", role: "USER", wellnessRole: "professional" },
  { email: "ayurveda1@enhancedwellness.in", name: "Sunita Mishra", role: "USER", wellnessRole: "professional" },
  { email: "ayurveda2@enhancedwellness.in", name: "Geeta Tiwari", role: "USER", wellnessRole: "professional" },
  { email: "laser1@enhancedwellness.in", name: "Manish Bansal", role: "USER", wellnessRole: "professional" },
  { email: "laser2@enhancedwellness.in", name: "Anita Das", role: "USER", wellnessRole: "professional" },
  { email: "skincare1@enhancedwellness.in", name: "Sandeep Bose", role: "USER", wellnessRole: "professional" },
  { email: "skincare2@enhancedwellness.in", name: "Neha Reddy", role: "USER", wellnessRole: "professional" },
  // Helpers
  { email: "helper1@enhancedwellness.in", name: "Mahesh Yadav", role: "USER", wellnessRole: "helper" },
  { email: "helper2@enhancedwellness.in", name: "Rajesh Singh", role: "USER", wellnessRole: "helper" },
];

const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const randomName = () => `${rand(indianFirstNames)} ${rand(indianLastNames)}`;
const randomPhone = () => `+9198${randInt(10000000, 99999999)}`;

// Tilt the random gen toward weekdays + clinic hours
const randomVisitDate = (daysAgoMax = 90) => {
  const d = new Date();
  d.setDate(d.getDate() - randInt(0, daysAgoMax));
  d.setHours(randInt(10, 19), [0, 15, 30, 45][randInt(0, 3)], 0, 0);
  return d;
};

// ── Main ───────────────────────────────────────────────────────────

async function main() {
  console.log("[seed-wellness] starting…");

  // 1. Tenant — country/currency/locale is what makes invoicing happen in INR
  const tenant = await prisma.tenant.upsert({
    where: { slug: TENANT_SLUG },
    update: {
      vertical: "wellness",
      name: "Enhanced Wellness",
      ownerEmail: "rishu@enhancedwellness.in",
      country: "IN", defaultCurrency: "INR", locale: "en-IN",
    },
    create: {
      slug: TENANT_SLUG,
      name: "Enhanced Wellness",
      vertical: "wellness",
      plan: "professional",
      ownerEmail: "rishu@enhancedwellness.in",
      country: "IN", defaultCurrency: "INR", locale: "en-IN",
    },
  });
  console.log(`[seed-wellness] tenant id=${tenant.id} slug=${tenant.slug} currency=${tenant.defaultCurrency}`);

  // Backfill any pre-existing Deal/Payment rows for this tenant that were created
  // before defaultCurrency rolled out — they default to USD which is wrong for India.
  const dealsBackfilled = await prisma.deal.updateMany({
    where: { tenantId: tenant.id, currency: "USD" },
    data: { currency: "INR" },
  });
  const paymentsBackfilled = await prisma.payment.updateMany({
    where: { tenantId: tenant.id, currency: "USD" },
    data: { currency: "INR" },
  });
  if (dealsBackfilled.count || paymentsBackfilled.count) {
    console.log(`[seed-wellness] backfilled USD→INR on ${dealsBackfilled.count} deals, ${paymentsBackfilled.count} payments`);
  }

  // 1a. Locations — Rishu currently runs only Ranchi. Multi-location is supported
  // in the schema; future franchises just add new rows here.
  const existingRanchi = await prisma.location.findFirst({ where: { tenantId: tenant.id, name: "Ranchi" } });
  const ranchi = existingRanchi
    ? await prisma.location.update({ where: { id: existingRanchi.id }, data: {
        addressLine: "The Ikon, Tagore Hill Road, Morabadi",
        city: "Ranchi", state: "Jharkhand", pincode: "834008", country: "India",
        phone: "+91 9637866666", email: "ranchi@enhancedwellness.in",
        latitude: 23.3978, longitude: 85.3192,
        hours: JSON.stringify({ mon: ["10:00","20:00"], tue: ["10:00","20:00"], wed: ["10:00","20:00"], thu: ["10:00","20:00"], fri: ["10:00","20:00"], sat: ["10:00","20:00"], sun: ["11:00","18:00"] }),
        isActive: true,
      } })
    : await prisma.location.create({ data: {
        name: "Ranchi", addressLine: "The Ikon, Tagore Hill Road, Morabadi",
        city: "Ranchi", state: "Jharkhand", pincode: "834008", country: "India",
        phone: "+91 9637866666", email: "ranchi@enhancedwellness.in",
        latitude: 23.3978, longitude: 85.3192,
        hours: JSON.stringify({ mon: ["10:00","20:00"], tue: ["10:00","20:00"], wed: ["10:00","20:00"], thu: ["10:00","20:00"], fri: ["10:00","20:00"], sat: ["10:00","20:00"], sun: ["11:00","18:00"] }),
        tenantId: tenant.id,
      } });
  console.log(`[seed-wellness] location: ${ranchi.name} (id=${ranchi.id})`);

  // Backfill existing patients + visits that predate the Location model
  const patientsBackfilled = await prisma.patient.updateMany({
    where: { tenantId: tenant.id, locationId: null },
    data: { locationId: ranchi.id },
  });
  const visitsBackfilled = await prisma.visit.updateMany({
    where: { tenantId: tenant.id, locationId: null },
    data: { locationId: ranchi.id },
  });
  if (patientsBackfilled.count || visitsBackfilled.count) {
    console.log(`[seed-wellness] backfilled locationId on ${patientsBackfilled.count} patients, ${visitsBackfilled.count} visits`);
  }

  // 2. Staff
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const userMap = {};
  for (const s of staffSeed) {
    const u = await prisma.user.upsert({
      where: { email: s.email },
      update: {
        name: s.name,
        role: s.role,
        wellnessRole: s.wellnessRole,
        tenantId: tenant.id,
      },
      create: {
        email: s.email,
        password: passwordHash,
        name: s.name,
        role: s.role,
        wellnessRole: s.wellnessRole,
        tenantId: tenant.id,
      },
    });
    userMap[s.email] = u;
  }
  console.log(`[seed-wellness] staff seeded: ${Object.keys(userMap).length}`);

  const doctors = Object.values(userMap).filter((u) => u.wellnessRole === "doctor");

  // 3. Services
  const serviceMap = {};
  for (const s of services) {
    const existing = await prisma.service.findFirst({
      where: { tenantId: tenant.id, name: s.name },
    });
    const svc = existing
      ? await prisma.service.update({ where: { id: existing.id }, data: { ...s, tenantId: tenant.id } })
      : await prisma.service.create({ data: { ...s, tenantId: tenant.id } });
    serviceMap[s.name] = svc;
  }
  console.log(`[seed-wellness] services seeded: ${Object.keys(serviceMap).length}`);

  // 4. Patients (50) — only seed if we have fewer than 10 already (idempotency)
  const existingPatientCount = await prisma.patient.count({ where: { tenantId: tenant.id } });
  if (existingPatientCount < 10) {
    const patients = [];
    for (let i = 0; i < 50; i++) {
      const p = await prisma.patient.create({
        data: {
          name: randomName(),
          email: `patient${i}@example.in`,
          phone: randomPhone(),
          dob: new Date(1970 + randInt(0, 40), randInt(0, 11), randInt(1, 28)),
          gender: rand(["M", "F"]),
          bloodGroup: rand(["A+", "B+", "O+", "AB+", "A-", "B-", "O-", "AB-"]),
          source: rand(["meta-ad", "google-ad", "walk-in", "referral", "whatsapp", "indiamart"]),
          tenantId: tenant.id,
          locationId: ranchi.id,
        },
      });
      patients.push(p);
    }
    console.log(`[seed-wellness] patients created: ${patients.length}`);

    // 5. Visits — historical (~165 over last 90 days, completed only)
    const allServices = Object.values(serviceMap);
    const noteByCategory = {
      hair: [
        "FUE session went smoothly. ~2200 grafts harvested, even density across recipient area. Post-op care explained, follow-up in 7 days.",
        "PRP injection completed. Patient tolerated procedure well, minor scalp tenderness expected for 24h. Next session in 4 weeks.",
        "Hair growth assessment: visible improvement in temples. Continue minoxidil + finasteride. Photos saved.",
      ],
      aesthetics: [
        "Botox 30 units administered to forehead and glabellar lines. Patient comfortable. Expect onset 5-7 days, full effect at 14 days.",
        "Dermal filler (1ml HA) injected — cheek volumization. Massaged to even out, mild swelling expected for 48h.",
        "Combined Botox + filler treatment. Discussed maintenance schedule (every 4-6 months for Botox, 12 months for filler).",
      ],
      skin: [
        "Glycolic peel applied (30%). Mild stinging during procedure, expected. Patient given post-care kit. Avoid sun for 1 week.",
        "HydraFacial completed — excellent results, patient very happy. Skin visibly brighter. Recommended monthly maintenance.",
        "Acne consultation + LED therapy session. Started on prescribed regimen, review in 4 weeks.",
      ],
      slimming: [
        "Cavitation session (60 min) — abdomen + flanks. 1.2cm reduction noted. 3 more sessions planned.",
        "Inch-loss measurement: down 2.5cm from baseline. Patient adhering to diet plan. Continue weekly.",
      ],
      ayurveda: [
        "Initial doshic assessment — Pitta-Vata constitution. Recommended dietary changes + herbal supplements. Follow-up in 3 weeks.",
        "Shirodhara session for stress. Patient reported deep relaxation. Weekly sessions for 6 weeks recommended.",
      ],
      salon: [
        "Haircut + styling completed. Patient satisfied with the new look.",
        "Hair color refresh — covered grays, root touch-up, blow-dry finish.",
      ],
    };
    const sourceWeighted = ["meta-ad", "meta-ad", "meta-ad", "meta-ad", "google-ad", "google-ad", "google-ad", "walk-in", "walk-in", "referral", "whatsapp", "indiamart"];

    let visitsCreated = 0;
    // Historical visits (last 90 days, NOT today/yesterday/tomorrow — those are scheduled separately)
    for (let i = 0; i < 165; i++) {
      const patient = rand(patients);
      const service = rand(allServices);
      const doctor = rand(doctors);
      const visitDate = randomVisitDate(90);
      // Skip if visit lands on today/yesterday — we'll seed those explicitly
      const daysFromNow = Math.floor((Date.now() - visitDate) / 86400000);
      if (daysFromNow < 2) continue;
      const cat = service.category || "general";
      await prisma.visit.create({
        data: {
          visitDate,
          status: "completed",
          notes: rand(noteByCategory[cat] || ["Visit completed successfully."]),
          amountCharged: service.basePrice * (0.9 + Math.random() * 0.2),
          patientId: patient.id,
          doctorId: doctor.id,
          serviceId: service.id,
          tenantId: tenant.id,
          locationId: ranchi.id,
        },
      });
      visitsCreated++;
    }
    console.log(`[seed-wellness] historical visits created: ${visitsCreated}`);

    // Today's appointments — mix of completed (morning) and in-progress/booked (afternoon)
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayApptHours = [9, 9, 10, 10, 11, 11, 12, 14, 14, 15, 15, 16, 16, 17, 17, 18];
    const now = new Date();
    let todaySeeded = 0;
    for (let i = 0; i < todayApptHours.length; i++) {
      const slot = new Date(today);
      slot.setHours(todayApptHours[i], (i % 4) * 15, 0, 0);
      const patient = rand(patients);
      const service = rand(allServices);
      const doctor = rand(doctors);
      const status = slot < now ? "completed" : (slot.getTime() - now.getTime() < 60 * 60 * 1000 ? "in-treatment" : "booked");
      await prisma.visit.create({
        data: {
          visitDate: slot,
          status,
          notes: status === "completed" ? rand(noteByCategory[service.category] || ["Visit completed."]) : null,
          amountCharged: status === "completed" ? service.basePrice * (0.95 + Math.random() * 0.1) : service.basePrice,
          patientId: patient.id,
          doctorId: doctor.id,
          serviceId: service.id,
          tenantId: tenant.id,
          locationId: ranchi.id,
        },
      });
      todaySeeded++;
    }
    console.log(`[seed-wellness] today's appointments: ${todaySeeded}`);

    // Yesterday — all completed
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const ydayHours = [9, 10, 10, 11, 11, 12, 12, 13, 14, 14, 15, 15, 16, 16, 17, 17, 18, 18, 19];
    let ydaySeeded = 0;
    for (let i = 0; i < ydayHours.length; i++) {
      const slot = new Date(yesterday);
      slot.setHours(ydayHours[i], (i % 4) * 15, 0, 0);
      const patient = rand(patients);
      const service = rand(allServices);
      const doctor = rand(doctors);
      await prisma.visit.create({
        data: {
          visitDate: slot,
          status: "completed",
          notes: rand(noteByCategory[service.category] || ["Visit completed."]),
          amountCharged: service.basePrice * (0.95 + Math.random() * 0.1),
          patientId: patient.id,
          doctorId: doctor.id,
          serviceId: service.id,
          tenantId: tenant.id,
          locationId: ranchi.id,
        },
      });
      ydaySeeded++;
    }
    console.log(`[seed-wellness] yesterday's visits: ${ydaySeeded}`);

    // Tomorrow — booked appointments only
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomHours = [9, 10, 10, 11, 12, 14, 14, 15, 15, 16, 17, 17];
    let tomSeeded = 0;
    for (let i = 0; i < tomHours.length; i++) {
      const slot = new Date(tomorrow);
      slot.setHours(tomHours[i], (i % 4) * 15, 0, 0);
      const patient = rand(patients);
      const service = rand(allServices);
      const doctor = rand(doctors);
      await prisma.visit.create({
        data: {
          visitDate: slot,
          status: "booked",
          amountCharged: service.basePrice,
          patientId: patient.id,
          doctorId: doctor.id,
          serviceId: service.id,
          tenantId: tenant.id,
          locationId: ranchi.id,
        },
      });
      tomSeeded++;
    }
    console.log(`[seed-wellness] tomorrow's bookings: ${tomSeeded}`);

    // 6. Treatment plans (10 active multi-session)
    const planServices = [
      serviceMap["Hair PRP Therapy"],
      serviceMap["Laser Hair Removal"],
      serviceMap["Slimming Session"],
      serviceMap["Chemical Peel"],
    ].filter(Boolean);
    for (let i = 0; i < 10; i++) {
      const patient = rand(patients);
      const svc = rand(planServices);
      if (!svc) continue;
      const total = randInt(4, 8);
      await prisma.treatmentPlan.create({
        data: {
          name: `${svc.name} — ${total}-session package`,
          totalSessions: total,
          completedSessions: randInt(1, total - 1),
          totalPrice: svc.basePrice * total * 0.85, // 15% bundle discount
          nextDueAt: new Date(Date.now() + randInt(1, 14) * 86400000),
          patientId: patient.id,
          serviceId: svc.id,
          tenantId: tenant.id,
        },
      });
    }
    console.log("[seed-wellness] treatment plans: 10");

    // 7. A few prescriptions + consent forms for clinical demo realism
    const recentVisits = await prisma.visit.findMany({
      where: { tenantId: tenant.id },
      take: 20,
      orderBy: { visitDate: "desc" },
    });
    for (const v of recentVisits.slice(0, 10)) {
      await prisma.prescription.create({
        data: {
          drugs: JSON.stringify([
            { name: "Minoxidil 5%", dosage: "1ml", frequency: "twice daily", duration: "12 weeks" },
            { name: "Finasteride 1mg", dosage: "1 tablet", frequency: "once daily", duration: "12 weeks" },
          ]),
          instructions: "Apply minoxidil only to dry scalp. Take finasteride after meals. Avoid harsh shampoos.",
          visitId: v.id,
          patientId: v.patientId,
          doctorId: v.doctorId,
          tenantId: tenant.id,
        },
      });
    }
    console.log("[seed-wellness] prescriptions: 10");

    for (const v of recentVisits.slice(0, 5)) {
      const svc = await prisma.service.findUnique({ where: { id: v.serviceId } });
      await prisma.consentForm.create({
        data: {
          templateName: svc && svc.category === "hair" ? "hair-transplant" : svc && svc.category === "aesthetics" ? "botox-fillers" : "general",
          patientId: v.patientId,
          serviceId: v.serviceId,
          tenantId: tenant.id,
        },
      });
    }
    console.log("[seed-wellness] consent forms: 5");
  } else {
    console.log(`[seed-wellness] patients already seeded (${existingPatientCount}), skipping clinical data`);
  }

  // 8. Active leads (Contacts) — 30 — create only if absent
  const existingLeadCount = await prisma.contact.count({
    where: { tenantId: tenant.id, status: "Lead" },
  });
  if (existingLeadCount < 5) {
    // Weighted to match the client's reality: ~60% Meta, ~20% Google, rest mixed
    const sources = [
      "meta-ad", "meta-ad", "meta-ad", "meta-ad", "meta-ad", "meta-ad",
      "google-ad", "google-ad",
      "whatsapp", "indiamart", "justdial", "walk-in", "referral",
    ];
    let leadsCreated = 0;
    for (let i = 0; i < 35; i++) {
      const name = randomName();
      const ageHours = Math.floor(Math.random() * 72); // last 3 days
      const createdAt = new Date(Date.now() - ageHours * 3600000);
      try {
        await prisma.contact.create({
          data: {
            name,
            email: `lead${Date.now()}-${i}@example.in`,
            phone: randomPhone(),
            status: "Lead",
            source: rand(sources),
            firstTouchSource: rand(sources),
            createdAt,
            tenantId: tenant.id,
          },
        });
        leadsCreated++;
      } catch (e) {
        // unique-violation → skip
      }
    }
    console.log(`[seed-wellness] leads created: ${leadsCreated}`);
  }

  // 8a. External API keys for partner products (Callified.ai, Globus Phone)
  // Idempotent: keep existing keys if present so the partners' env vars stay valid.
  const adminUser = userMap["admin@wellness.demo"] || userMap["rishu@enhancedwellness.in"];
  if (adminUser) {
    const partners = [
      { name: "Callified.ai (demo key)" },
      { name: "Globus Phone (demo key)" },
    ];
    const printedKeys = [];
    for (const p of partners) {
      const existing = await prisma.apiKey.findFirst({
        where: { tenantId: tenant.id, name: p.name },
      });
      if (existing) {
        printedKeys.push({ name: p.name, key: existing.keySecret, fresh: false });
      } else {
        const rawKey = `glbs_${crypto.randomBytes(24).toString("hex")}`;
        await prisma.apiKey.create({
          data: { name: p.name, keySecret: rawKey, userId: adminUser.id, tenantId: tenant.id },
        });
        printedKeys.push({ name: p.name, key: rawKey, fresh: true });
      }
    }
    console.log("[seed-wellness] partner API keys (give these to the respective teams):");
    for (const k of printedKeys) {
      console.log(`  ${k.fresh ? "[NEW]    " : "[exists] "}${k.name.padEnd(32)} ${k.key}`);
    }
  }

  // 9. Hand-crafted agent recommendations (always re-seeded for the demo)
  await prisma.agentRecommendation.deleteMany({ where: { tenantId: tenant.id } });
  await prisma.agentRecommendation.createMany({
    data: [
      {
        type: "campaign_boost",
        title: "Boost Hair Transplant campaign by ₹500/day",
        body: "Hair Transplant campaign hit 5.2x ROAS over the last 7 days — well above your 3x target. Adding ₹500/day budget should yield ~3 more high-ticket bookings per week without diluting CPL.",
        expectedImpact: "+3 hair transplant bookings/week, projected revenue +₹3L/week, ROAS holds at ~5x",
        priority: "high",
        goalContext: "Maximize ROAS on high-ticket services",
        tenantId: tenant.id,
      },
      {
        type: "occupancy_alert",
        title: "Tomorrow's slim-room utilisation only 30%",
        body: "Three of the four slimming slots tomorrow afternoon are empty. Suggest sending a 15% off WhatsApp blast to the 47 leads who enquired about slimming in the last 30 days.",
        expectedImpact: "Likely fills 2 of the 3 open slots (~₹7,000 same-day revenue)",
        priority: "medium",
        goalContext: "100% occupancy",
        tenantId: tenant.id,
      },
      {
        type: "lead_followup",
        title: "12 hot leads aging > 24h without first-call",
        body: "12 leads from yesterday's Meta ads haven't been called yet. Industry data says first-call within 5 minutes lifts conversion 9x. Reassign to telecaller Ankita who is currently free.",
        expectedImpact: "Recovers ~3-4 conversions worth ₹40k+ that would otherwise drop off",
        priority: "high",
        goalContext: "Zero missed leads",
        tenantId: tenant.id,
      },
    ],
  });
  console.log("[seed-wellness] agent recommendations: 3");

  console.log("\n[seed-wellness] DONE");
  console.log("\nLogin to Enhanced Wellness with:");
  console.log("  ── Demo accounts (use these for the live walkthrough) ──");
  console.log("  Demo admin:   admin@wellness.demo / password123");
  console.log("  Demo user:    user@wellness.demo / password123");
  console.log("  ── Real staff accounts ──");
  console.log("  Owner:        rishu@enhancedwellness.in / password123");
  console.log("  Doctor:       drharsh@enhancedwellness.in / password123");
  console.log("  Manager:      manager@enhancedwellness.in / password123");
  console.log("  Telecaller:   telecaller@enhancedwellness.in / password123");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
