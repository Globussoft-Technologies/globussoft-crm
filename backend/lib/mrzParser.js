// ICAO 9303 TD3 (passport) Machine-Readable Zone parser.
//
// A TD3 MRZ is two lines of 44 characters each, drawn from the alphabet
// [A-Z0-9<] ('<' is the filler). It encodes the canonical passport fields
// plus check digits, which is exactly why we lean on it for OCR: even when
// the visual zone is a messy scan, the MRZ is a fixed-layout, self-checking
// string. This module is PURE — it takes already-OCR'd text and returns
// parsed fields + check-digit validity. No image / OCR engine here, so it is
// fully deterministic and unit-testable; the OCR step lives in
// services/passportOcrClient.js.
//
// Layout reference (TD3):
//   Line 1: P<ISSUER SURNAME<<GIVEN<NAMES<<<…            (positions)
//     [0]    document type 'P'
//     [1]    type sub-code (often '<')
//     [2-4]  issuing state (3 alpha)
//     [5-43] name field: SURNAME '<<' GIVEN '<' NAMES, '<' padded
//   Line 2: NNNNNNNNN C AAA YYMMDD C S YYMMDD C OOOOOOOOOOOOOO C C
//     [0-8]   passport number (9)
//     [9]     passport-number check digit
//     [10-12] nationality (3 alpha)
//     [13-18] date of birth YYMMDD
//     [19]    DOB check digit
//     [20]    sex (M/F/<)
//     [21-26] date of expiry YYMMDD
//     [27]    expiry check digit
//     [28-41] personal number / optional data (14)
//     [42]    optional-data check digit
//     [43]    composite check digit

const MRZ_LINE_LEN = 44;

// Per-character numeric value for the ICAO check-digit algorithm.
// Digits → their value; A–Z → 10–35; '<' (filler) → 0.
function charValue(ch) {
  if (ch >= "0" && ch <= "9") return ch.charCodeAt(0) - 48;
  if (ch >= "A" && ch <= "Z") return ch.charCodeAt(0) - 55; // 'A' (65) → 10
  return 0; // '<' and anything unexpected
}

// ICAO 9303 check digit: weight the characters 7,3,1 repeating, sum, mod 10.
function computeCheckDigit(str) {
  const weights = [7, 3, 1];
  let sum = 0;
  for (let i = 0; i < str.length; i++) {
    sum += charValue(str[i]) * weights[i % 3];
  }
  return sum % 10;
}

// A MRZ check field is a single digit; '<' is sometimes used to mean 0.
function checkField(value, checkChar) {
  const expected = checkChar === "<" ? 0 : parseInt(checkChar, 10);
  if (!Number.isInteger(expected)) return false;
  return computeCheckDigit(value) === expected;
}

// YYMMDD → ISO YYYY-MM-DD. MRZ carries no century, so we pivot:
//   - dob:    a 2-digit year that would land in the future is 19xx
//             (nobody is born in the future).
//   - expiry: passports are issued from 2000 onward; treat <70 as 20xx,
//             >=70 as 19xx (covers the rare backfilled / legacy doc).
// Returns null for structurally invalid dates so the caller can null the
// field rather than emit a bogus date.
function parseMrzDate(yymmdd, kind, nowYearLast2) {
  if (!/^\d{6}$/.test(yymmdd)) return null;
  const yy = parseInt(yymmdd.slice(0, 2), 10);
  const mm = parseInt(yymmdd.slice(2, 4), 10);
  const dd = parseInt(yymmdd.slice(4, 6), 10);
  if (mm < 1 || mm > 12 || dd < 1) return null;

  let year;
  if (kind === "dob") {
    const pivot = typeof nowYearLast2 === "number" ? nowYearLast2 : 0;
    year = yy <= pivot ? 2000 + yy : 1900 + yy;
  } else {
    year = yy < 70 ? 2000 + yy : 1900 + yy;
  }

  // Reject calendar-impossible days (Feb 30, Apr 31, Feb 29 in a non-leap
  // year). The function contract is "null for structurally invalid dates".
  const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInMonth = [31, isLeap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (dd > daysInMonth[mm - 1]) return null;

  const mmStr = String(mm).padStart(2, "0");
  const ddStr = String(dd).padStart(2, "0");
  return `${year}-${mmStr}-${ddStr}`;
}

// Normalize one OCR'd line into MRZ alphabet: uppercase, common OCR
// confusions repaired, non-MRZ chars dropped. We DON'T pad/truncate here —
// length handling happens in the line-pair finder so we can score candidates.
function normalizeLine(raw) {
  return String(raw || "")
    .toUpperCase()
    .replace(/[«»«»]/g, "<") // stray guillemets → filler
    .replace(/\s+/g, "") // MRZ has no spaces
    .replace(/[^A-Z0-9<]/g, ""); // drop anything outside the MRZ alphabet
}

// Pad/truncate a normalized line to exactly 44 MRZ chars.
function toFixedLen(line) {
  if (line.length >= MRZ_LINE_LEN) return line.slice(0, MRZ_LINE_LEN);
  return line.padEnd(MRZ_LINE_LEN, "<");
}

// Score how MRZ-line-like a normalized string is, so we can pick the right
// two lines out of full-page OCR noise. Heuristics: closeness to 44 chars,
// presence of filler '<', and a strong boost for the classic MRZ prefix.
function mrzLineScore(line) {
  if (!line || line.length < 20) return 0;
  const fillers = (line.match(/</g) || []).length;
  const lenScore = 1 - Math.min(Math.abs(line.length - MRZ_LINE_LEN), 24) / 24;
  const fillerScore = fillers > 0 ? Math.min(fillers / 8, 1) : 0;
  const prefixScore = /^P[A-Z<]/.test(line) ? 0.4 : 0;
  return lenScore * 0.5 + fillerScore * 0.3 + prefixScore;
}

// TD3 line 1 (name line): document type + issuer + SURNAME<<GIVEN. Starts
// with 'P', or is letter-dominated with a '<<' name separator.
function looksLikeNameLine(l) {
  if (/^P[A-Z<]/.test(l)) return true;
  const letters = (l.match(/[A-Z]/g) || []).length;
  const digits = (l.match(/[0-9]/g) || []).length;
  return l.includes("<<") && letters > digits * 2;
}

// TD3 line 2 (data line): passport number + dates + check digits — digit-heavy.
function looksLikeDataLine(l) {
  const digits = (l.match(/[0-9]/g) || []).length;
  return digits >= 6;
}

// Find the TD3 line pair in OCR text. Identifies the name line vs the data
// line by STRUCTURE (not source order), so a data line that OCRs above the
// name line — or a name line that isn't followed by another candidate — is
// still mapped correctly. Returns { line1, line2 } (44 chars each) or null.
function findMrzLines(text) {
  const lines = String(text || "").split(/\r?\n/).map(normalizeLine).filter(Boolean);

  // Strong anchor: any line that looks like a TD3 name line. Even if the OCR
  // mangled the second line, we can still pair it with the nearest plausible
  // data-looking line.
  const nameIdx = lines.findIndex((l) => looksLikeNameLine(l) && l.length >= 20);
  if (nameIdx >= 0) {
    const name = lines[nameIdx];
    // Prefer a different line that looks like a data line and is close in the
    // source text (within 3 lines, since MRZ lines are adjacent).
    const nearby = lines
      .map((l, idx) => ({ l, idx, s: mrzLineScore(l) }))
      .filter((c) => c.idx !== nameIdx && looksLikeDataLine(c.l) && Math.abs(c.idx - nameIdx) <= 3)
      .sort((a, b) => b.s - a.s);
    if (nearby.length) {
      const data = nearby[0];
      return { line1: toFixedLen(name), line2: toFixedLen(data.l) };
    }
    // No data-looking neighbour found → just take the next non-empty line as
    // the data line; the parser will validate/reject it.
    if (lines[nameIdx + 1]) {
      return { line1: toFixedLen(name), line2: toFixedLen(lines[nameIdx + 1]) };
    }
  }

  // Fallback: score-based candidate pairing.
  const candidates = lines
    .map((l, idx) => ({ l, idx, s: mrzLineScore(l) }))
    .filter((c) => c.s > 0.35);

  if (candidates.length >= 2) {
    const names = candidates.filter((c) => looksLikeNameLine(c.l)).sort((a, b) => b.s - a.s);
    const datas = candidates.filter((c) => looksLikeDataLine(c.l)).sort((a, b) => b.s - a.s);
    const name = names[0];
    const data = datas.find((c) => !name || c.idx !== name.idx);
    if (name && data) return { line1: toFixedLen(name.l), line2: toFixedLen(data.l) };
    const top2 = candidates.slice().sort((a, b) => b.s - a.s).slice(0, 2).sort((a, b) => a.idx - b.idx);
    return { line1: toFixedLen(top2[0].l), line2: toFixedLen(top2[1].l) };
  }

  return null;
}

function cleanName(seg) {
  return seg.replace(/</g, " ").replace(/\s+/g, " ").trim();
}

// Parse a TD3 line pair (each must be 44 chars). Returns the structured
// result; `valid` is true only when all individual check digits pass.
function parseTd3(line1, line2, nowYearLast2) {
  const l1 = toFixedLen(normalizeLine(line1));
  const l2 = toFixedLen(normalizeLine(line2));

  // Line 1 — type, issuer, names.
  const documentType = l1[0] === "P" ? "P" : l1.slice(0, 1).replace(/</g, "");
  const issuingCountry = l1.slice(2, 5).replace(/</g, "");
  const nameField = l1.slice(5);
  const [surnamePart, givenPart = ""] = nameField.split("<<");
  const surname = cleanName(surnamePart || "");
  const givenNames = cleanName(givenPart);

  // Line 2 — number, nationality, dob, sex, expiry, check digits.
  const passportNumberRaw = l2.slice(0, 9);
  const passportNumber = passportNumberRaw.replace(/</g, "");
  const passportNumberCheck = l2[9];
  const nationality = l2.slice(10, 13).replace(/</g, "");
  const dobRaw = l2.slice(13, 19);
  const dobCheck = l2[19];
  const sexRaw = l2[20];
  const expiryRaw = l2.slice(21, 27);
  const expiryCheck = l2[27];
  const optionalData = l2.slice(28, 42);
  const optionalCheck = l2[42];
  const compositeCheck = l2[43];

  const checks = {
    passportNumber: checkField(passportNumberRaw, passportNumberCheck),
    dateOfBirth: checkField(dobRaw, dobCheck),
    dateOfExpiry: checkField(expiryRaw, expiryCheck),
  };
  // Composite check covers number+check, dob+check, expiry+check, optional+check.
  const compositeBasis =
    l2.slice(0, 10) + l2.slice(13, 20) + l2.slice(21, 28) + l2.slice(28, 43);
  checks.composite = checkField(compositeBasis, compositeCheck);
  // Optional-data check only meaningful when optional data is present.
  if (optionalData.replace(/</g, "").length > 0) {
    checks.optionalData = checkField(optionalData, optionalCheck);
  }

  const sex = sexRaw === "M" || sexRaw === "F" ? sexRaw : sexRaw === "<" ? "X" : sexRaw;

  const fields = {
    documentType: documentType || null,
    issuingCountry: issuingCountry || null,
    surname: surname || null,
    givenNames: givenNames || null,
    passportNumber: passportNumber || null,
    nationality: nationality || null,
    dateOfBirth: parseMrzDate(dobRaw, "dob", nowYearLast2),
    sex: sex || null,
    dateOfExpiry: parseMrzDate(expiryRaw, "expiry", nowYearLast2),
    optionalData: optionalData.replace(/</g, "") || null,
  };

  // The check digits that always apply (number, dob, expiry, composite).
  const coreChecks = ["passportNumber", "dateOfBirth", "dateOfExpiry", "composite"];
  const passed = coreChecks.filter((k) => checks[k]).length;
  const valid = passed === coreChecks.length;

  return {
    valid,
    checks,
    checksPassed: passed,
    checksTotal: coreChecks.length,
    fields,
    mrz: `${l1}\n${l2}`,
  };
}

// Parse a DDMMYYYY date as found on some non-ICAO passports (e.g. UAE) that
// encode full day/month/year in the MRZ instead of the ICAO YYMMDD+check digit.
// Returns ISO YYYY-MM-DD or null.
function parseFullDate(ddmmyyyy, _kind) {
  if (!/^\d{8}$/.test(ddmmyyyy)) return null;
  const dd = parseInt(ddmmyyyy.slice(0, 2), 10);
  const mm = parseInt(ddmmyyyy.slice(2, 4), 10);
  const yyyy = parseInt(ddmmyyyy.slice(4, 8), 10);
  if (mm < 1 || mm > 12 || dd < 1) return null;
  if (yyyy < 1900 || yyyy > 2100) return null;
  const isLeap = (yyyy % 4 === 0 && yyyy % 100 !== 0) || yyyy % 400 === 0;
  const daysInMonth = [31, isLeap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (dd > daysInMonth[mm - 1]) return null;
  return `${yyyy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}

// Non-ICAO TD3 fallback used by some issuing states (notably UAE). The second
// line drops the ICAO check digits and uses full DDMMYYYY dates, shifting the
// layout:
//   [0-8]   passport number
//   [9-11]  nationality
//   [12-19] date of birth DDMMYYYY
//   [20]    sex
//   [21-28] date of expiry DDMMYYYY
//   [29-42] optional data
//   [43]    final check character (ignored — no universal algorithm)
function parseTd3FullDate(line1, line2, _nowYearLast2) {
  const l1 = toFixedLen(normalizeLine(line1));
  const l2 = toFixedLen(normalizeLine(line2));

  // Strong signal: the "passport-number check digit" position is a letter,
  // which means the nationality field starts immediately after the number.
  if (!/^[A-Z]$/.test(l2[9])) return null;
  if (!/^\d{8}$/.test(l2.slice(12, 20))) return null;
  if (!/^\d{8}$/.test(l2.slice(21, 29))) return null;
  const sexRaw = l2[20];
  if (!/^[MF<X]$/.test(sexRaw)) return null;

  const documentType = l1[0] === "P" ? "P" : l1.slice(0, 1).replace(/</g, "");
  // Non-ICAO line 1 often omits the 3-letter issuing-country field and places
  // the surname directly after the leading "P<" (e.g. UAE passports show
  // "P<BINNASSER<<HUDA<AL..."). Treat everything after "P<" as the name field.
  const nameField = l1.slice(2);
  const [surnamePart, givenPart = ""] = nameField.split("<<");
  const surname = cleanName(surnamePart || "");
  const givenNames = cleanName(givenPart);

  const passportNumber = l2.slice(0, 9).replace(/</g, "") || null;
  const nationality = l2.slice(9, 12).replace(/</g, "") || null;
  const dateOfBirth = parseFullDate(l2.slice(12, 20), "dob");
  const dateOfExpiry = parseFullDate(l2.slice(21, 29), "expiry");
  const sex = sexRaw === "M" || sexRaw === "F" ? sexRaw : sexRaw === "<" ? "X" : sexRaw;

  const fields = {
    documentType: documentType || null,
    issuingCountry: null, // non-ICAO line 1 does not reliably carry this field
    surname: surname || null,
    givenNames: givenNames || null,
    passportNumber,
    nationality,
    dateOfBirth,
    sex: sex || null,
    dateOfExpiry,
    optionalData: l2.slice(29, 43).replace(/</g, "") || null,
  };

  // No check digits to validate; mark it as a fallback parse.
  return {
    valid: false,
    checks: { passportNumber: false, dateOfBirth: false, dateOfExpiry: false, composite: false },
    checksPassed: 0,
    checksTotal: 4,
    fields,
    mrz: `${l1}\n${l2}`,
    nonIcao: true,
  };
}

// Swap map for the most common OCR-B / printed-passport character confusions.
// MRZ uses a constrained alphabet, so a misread DOB digit or passport-number
// character can often be repaired by trying the visually-similar glyph.
const OCR_CONFUSIONS = {
  // Letters that OCR commonly reads as digits.
  toDigit: { O: "0", o: "0", I: "1", l: "1", S: "5", s: "5", B: "8", Q: "9", q: "9", Z: "2", z: "2", G: "6" },
  // Digits that OCR commonly reads as letters.
  toAlpha: { 0: "O", 1: "I", 5: "S", 8: "B", 2: "Z", 6: "G", 9: "Q" },
  // Characters that OCR commonly reads as the MRZ filler chevron '<'.
  toChevron: { K: "<", L: "<", C: "<", I: "<", "1": "<", "|": "<", "\\": "<" },
};

function applySubstitution(str, index, replacement) {
  return str.slice(0, index) + replacement + str.slice(index + 1);
}

function scoreParse(parsed) {
  if (!parsed) return -1;
  let score = (parsed.valid ? 1000 : 0) + (parsed.checksPassed || 0);
  // Slight preference for a canonical name-field layout: exactly one '<<'
  // separator (surname / given names), with single '<' between given names.
  // This lets structural chevron repair win over an otherwise-valid parse that
  // has a doubled '<<' between given names.
  if (parsed.valid && parsed.mrz) {
    const line1 = parsed.mrz.split("\n")[0] || "";
    const chevronPairs = (line1.match(/<</g) || []).length;
    if (chevronPairs === 1) score += 0.5;
  }
  return score;
}

// Greedy single-character repair using field-specific confusion maps. We only
// try a substitution inside the field whose check digit failed (or the
// nationality/sex fields if they look wrong), so we do not corrupt a valid
// name or passport number while fixing a neighbouring misread.
function repairOcrConfusions(line1, line2, nowYearLast2) {
  let best = parseTd3(line1, line2, nowYearLast2);
  if (!best) return null;
  if (best.valid) return best;

  const c = best.checks;
  const line2CheckPositions = new Set([9, 19, 27, 42, 43]);

  // Build a position → map for line 2. Default: no substitutions.
  const line2Maps = new Array(44).fill(null);

  // Passport number: alphanumeric, common digit↔letter swaps.
  if (!c.passportNumber) {
    for (let i = 0; i <= 8; i++) {
      line2Maps[i] = { ...OCR_CONFUSIONS.toDigit, ...OCR_CONFUSIONS.toAlpha };
    }
  }

  // Nationality: letters only.
  if (line2.slice(10, 13).match(/\d/)) {
    for (let i = 10; i <= 12; i++) line2Maps[i] = OCR_CONFUSIONS.toAlpha;
  }

  // DOB / expiry: digits only.
  if (!c.dateOfBirth) {
    for (let i = 13; i <= 18; i++) line2Maps[i] = OCR_CONFUSIONS.toDigit;
  }
  if (!c.dateOfExpiry) {
    for (let i = 21; i <= 26; i++) line2Maps[i] = OCR_CONFUSIONS.toDigit;
  }

  // Optional data (positions 28-41): almost always '<' fillers.
  for (let i = 28; i <= 41; i++) {
    line2Maps[i] = { ...(line2Maps[i] || {}), ...OCR_CONFUSIONS.toChevron };
  }

  // Line 1: the constant '<' at position 1 and the trailing name fillers.
  const line1Maps = new Array(44).fill(null);
  line1Maps[1] = OCR_CONFUSIONS.toChevron;
  for (let i = 5; i <= 43; i++) {
    line1Maps[i] = { ...OCR_CONFUSIONS.toChevron, ...OCR_CONFUSIONS.toDigit, ...OCR_CONFUSIONS.toAlpha };
  }

  let improved = true;
  while (improved) {
    improved = false;

    for (let i = 0; i < line1.length; i++) {
      const map = line1Maps[i];
      if (!map) continue;
      const replacement = map[line1[i]];
      if (!replacement) continue;
      const candidate = applySubstitution(line1, i, replacement);
      const parsed = parseTd3(candidate, line2, nowYearLast2);
      if (scoreParse(parsed) > scoreParse(best)) {
        best = parsed;
        line1 = candidate;
        improved = true;
      }
    }

    for (let i = 0; i < line2.length; i++) {
      if (line2CheckPositions.has(i)) continue;
      const map = line2Maps[i];
      if (!map) continue;
      const replacement = map[line2[i]];
      if (!replacement) continue;
      const candidate = applySubstitution(line2, i, replacement);
      const parsed = parseTd3(line1, candidate, nowYearLast2);
      if (scoreParse(parsed) > scoreParse(best)) {
        best = parsed;
        line2 = candidate;
        improved = true;
      }
    }
  }

  return best;
}

// Structural repair for the MRZ filler chevrons ('<'). OCR very often reads
// '<' as K/L/C/I/1 etc. We use the known TD3 layout to rebuild the filler
// regions without guessing inside the data fields.
function repairChevronFillers(line1, line2, nowYearLast2) {
  let l1 = line1;
  let l2 = line2;

  // Line 1: position 1 is the constant '<' between document type and issuer.
  if (/[KLC1I|\\]/.test(l1[1])) {
    l1 = applySubstitution(l1, 1, "<");
  }

  // Line 1 name field (positions 5-43): split on existing '<' runs and rebuild
  // with the canonical separators. The first separator between surname and the
  // first given name is '<<'; separators between remaining given names are
  // single '<'. This fixes cases like 'SHAMSI<<MAJID<<AL' (OCR inserted an
  // extra chevron) → 'SHAMSI<<MAJID<AL' without touching letters inside tokens.
  const nameField = l1.slice(5);
  const nameTokens = nameField.split(/<+/).filter(Boolean);
  if (nameTokens.length >= 1) {
    const reconstructedName = (nameTokens[0] + "<<" + nameTokens.slice(1).join("<")).padEnd(39, "<");
    l1 = l1.slice(0, 5) + reconstructedName;
  }

  const parsed = parseTd3(l1, l2, nowYearLast2);
  return parsed;
}

// Top-level entry: take raw OCR text, locate the MRZ, parse it.
// Returns null when no plausible MRZ line pair can be found.
function parseMrz(text, opts = {}) {
  const pair = findMrzLines(text);
  if (!pair) return null;
  const chevronFixed = repairChevronFillers(pair.line1, pair.line2, opts.nowYearLast2);
  const confusionFixed = repairOcrConfusions(pair.line1, pair.line2, opts.nowYearLast2);
  const best = scoreParse(chevronFixed) >= scoreParse(confusionFixed) ? chevronFixed : confusionFixed;

  // If the ICAO check digits don't validate, try the non-ICAO full-date layout
  // used by some passports (e.g. UAE). It has no check digits but a fixed
  // positional layout, so it is still reliable when detected confidently.
  if (!best?.valid) {
    const fullDate = parseTd3FullDate(pair.line1, pair.line2, opts.nowYearLast2);
    if (fullDate) return fullDate;
  }

  return best;
}

module.exports = {
  parseMrz,
  parseTd3,
  parseTd3FullDate,
  parseFullDate,
  findMrzLines,
  computeCheckDigit,
  checkField,
  parseMrzDate,
  normalizeLine,
  repairOcrConfusions,
  repairChevronFillers,
};
