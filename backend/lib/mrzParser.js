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
// presence of filler '<', and (for line 2) a leading run of doc-number-ish
// chars. Higher = more MRZ-like.
function mrzLineScore(line) {
  if (!line || line.length < 28) return 0;
  const fillers = (line.match(/</g) || []).length;
  const lenScore = 1 - Math.min(Math.abs(line.length - MRZ_LINE_LEN), 20) / 20;
  const fillerScore = fillers > 0 ? Math.min(fillers / 10, 1) : 0;
  return lenScore * 0.7 + fillerScore * 0.3;
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
  return digits >= 8;
}

// Find the TD3 line pair in OCR text. Identifies the name line vs the data
// line by STRUCTURE (not source order), so a data line that OCRs above the
// name line — or a name line that isn't followed by another candidate — is
// still mapped correctly. Returns { line1, line2 } (44 chars each) or null.
function findMrzLines(text) {
  const lines = String(text || "").split(/\r?\n/).map(normalizeLine).filter(Boolean);
  const candidates = lines
    .map((l, idx) => ({ l, idx, s: mrzLineScore(l) }))
    .filter((c) => c.s > 0.4);

  if (candidates.length >= 2) {
    const names = candidates.filter((c) => looksLikeNameLine(c.l)).sort((a, b) => b.s - a.s);
    const datas = candidates.filter((c) => looksLikeDataLine(c.l)).sort((a, b) => b.s - a.s);
    const name = names[0];
    // The data line must be a different line than the chosen name line.
    const data = datas.find((c) => !name || c.idx !== name.idx);
    if (name && data) return { line1: toFixedLen(name.l), line2: toFixedLen(data.l) };
    // Couldn't classify both → fall back to the two best, in source order.
    const top2 = candidates.slice().sort((a, b) => b.s - a.s).slice(0, 2).sort((a, b) => a.idx - b.idx);
    return { line1: toFixedLen(top2[0].l), line2: toFixedLen(top2[1].l) };
  }

  // Sparse OCR: anchor on a P< line and take the following line as data.
  const i = lines.findIndex((l) => /^P[A-Z<]/.test(l) && l.includes("<"));
  if (i >= 0 && lines[i + 1]) return { line1: toFixedLen(lines[i]), line2: toFixedLen(lines[i + 1]) };
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

// Top-level entry: take raw OCR text, locate the MRZ, parse it.
// Returns null when no plausible MRZ line pair can be found.
function parseMrz(text, opts = {}) {
  const pair = findMrzLines(text);
  if (!pair) return null;
  return parseTd3(pair.line1, pair.line2, opts.nowYearLast2);
}

module.exports = {
  parseMrz,
  parseTd3,
  findMrzLines,
  computeCheckDigit,
  checkField,
  parseMrzDate,
  normalizeLine,
};
