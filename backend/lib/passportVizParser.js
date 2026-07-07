// Passport Visual Inspection Zone (VIZ) parser — label-based.
//
// The VIZ is the human-readable printed area of a passport ("Date of Birth
// 27/07/1987", "Passport No P90S12345", "Nationality United Arab Emirates",
// ...). It complements the MRZ parser (lib/mrzParser.js): the MRZ is precise
// when conformant, but some documents carry a malformed / non-ICAO MRZ, and
// even a clean MRZ omits issue date / place fields. The VIZ has the correct
// values under stable labels, so we read it as a fallback + gap-filler.
//
// PURE: takes already-OCR'd full-page text (mixed case, with labels) and
// returns whatever labeled fields it can find — every field may be null.
// OCR of the VIZ is noisier than the MRZ, so matching is deliberately fuzzy
// (partial labels, several date formats) and each field is isolated in its
// own try so one bad line can't sink the rest.

// Common country / nationality names → ISO 3166-1 alpha-3, so the parsed
// nationality matches the MRZ's 3-letter form. Unmapped values fall back to
// the raw (upper-cased, trimmed) text.
const COUNTRY_ISO3 = {
  "UNITED ARAB EMIRATES": "ARE",
  "EMIRATI": "ARE",
  "UAE": "ARE",
  "INDIA": "IND",
  "INDIAN": "IND",
  "UNITED STATES": "USA",
  "UNITED STATES OF AMERICA": "USA",
  "AMERICAN": "USA",
  "UNITED KINGDOM": "GBR",
  "BRITISH": "GBR",
  "GREAT BRITAIN": "GBR",
  "SAUDI ARABIA": "SAU",
  "SAUDI": "SAU",
  "PAKISTAN": "PAK",
  "PAKISTANI": "PAK",
  "BANGLADESH": "BGD",
  "CANADA": "CAN",
  "AUSTRALIA": "AUS",
  "PHILIPPINES": "PHL",
  "FILIPINO": "PHL",
  "EGYPT": "EGY",
  "EGYPTIAN": "EGY",
  "NEPAL": "NPL",
  "SRI LANKA": "LKA",
  "INDONESIA": "IDN",
  "JORDAN": "JOR",
  "LEBANON": "LBN",
  "SUDAN": "SDN",
  "SUDANESE": "SDN",
};

const MONTHS = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};

function daysInMonth(year, mm) {
  const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return [31, isLeap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mm - 1];
}

// Parse a human-printed passport date → ISO YYYY-MM-DD, or null.
// Handles DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY, DD MM YYYY and DD MON YYYY.
// Passports overwhelmingly print day-first (DD/MM/YYYY); we assume that.
function parseHumanDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();

  // DD <sep> (MM | MON) <sep> YYYY
  const m = s.match(/\b(\d{1,2})\s*[/\-.\s]\s*([A-Za-z]{3,}|\d{1,2})\s*[/\-.\s]\s*(\d{2,4})\b/);
  if (!m) return null;
  const dd = parseInt(m[1], 10);
  let mm;
  if (/^\d+$/.test(m[2])) {
    mm = parseInt(m[2], 10);
  } else {
    mm = MONTHS[m[2].slice(0, 3).toUpperCase()];
  }
  let year = parseInt(m[3], 10);
  if (m[3].length === 2) year = year < 70 ? 2000 + year : 1900 + year;

  if (!mm || mm < 1 || mm > 12) return null;
  if (!dd || dd < 1 || dd > daysInMonth(year, mm)) return null;
  if (year < 1900 || year > 2100) return null;

  return `${year}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}

// Find the first line matching `labelRe`; return everything AFTER the label on
// that line, plus the next `lookahead` lines (some passports print the value on
// the next line). Slicing AFTER the matched label — rather than blanking the
// label in place — keeps a neighbouring field's value (e.g. "Date of Issue" on
// the same line as "Date of Expiry") from bleeding into this field.
function valueAfterLabel(lines, labelRe, lookahead = 1) {
  for (let i = 0; i < lines.length; i++) {
    const m = labelRe.exec(lines[i]);
    if (m) {
      const after = lines[i].slice(m.index + m[0].length);
      const window = [after, ...lines.slice(i + 1, i + 1 + lookahead)].join(" ");
      return window.trim();
    }
  }
  return null;
}

function findDate(lines, labelRe) {
  const window = valueAfterLabel(lines, labelRe, 1);
  if (!window) return null;
  return parseHumanDate(window);
}

function normalizeNationality(raw) {
  if (!raw) return null;
  const cleaned = raw.replace(/[^A-Za-z ]/g, " ").replace(/\s+/g, " ").trim().toUpperCase();
  if (!cleaned) return null;
  if (COUNTRY_ISO3[cleaned]) return COUNTRY_ISO3[cleaned];
  // Try the longest known country name contained in the value.
  for (const name of Object.keys(COUNTRY_ISO3)) {
    if (cleaned.includes(name)) return COUNTRY_ISO3[name];
  }
  // Unknown → keep the first token(s), capped, as a best-effort label.
  return cleaned.slice(0, 30);
}

/**
 * Parse the visual zone from full-page OCR text.
 * Returns { passportNumber, dateOfBirth, dateOfExpiry, dateOfIssue,
 *           nationality, sex, surname, givenNames, fullName } — any may be null.
 */
function parseViz(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (!lines.length) return null;

  const out = {
    passportNumber: null,
    dateOfBirth: null,
    dateOfExpiry: null,
    dateOfIssue: null,
    nationality: null,
    sex: null,
    surname: null,
    givenNames: null,
    fullName: null,
  };

  try {
    const window = valueAfterLabel(lines, /passport\s*n[o0.]*\b/i, 0);
    if (window) {
      const m = window.match(/\b([A-Z0-9]{6,9})\b/);
      if (m) out.passportNumber = m[1];
    }
  } catch (_e) { /* ignore */ }

  try { out.dateOfBirth = findDate(lines, /date of bi?rth|d\.?o\.?b\.?/i); } catch (_e) { /* ignore */ }
  try { out.dateOfExpiry = findDate(lines, /date of (expiry|expiration|exp)/i); } catch (_e) { /* ignore */ }
  try { out.dateOfIssue = findDate(lines, /date of issue/i); } catch (_e) { /* ignore */ }

  try {
    const window = valueAfterLabel(lines, /nationality/i, 1);
    out.nationality = normalizeNationality(window);
  } catch (_e) { /* ignore */ }

  try {
    const window = valueAfterLabel(lines, /\bsex\b/i, 0);
    if (window) {
      const m = window.match(/\b([MF])\b/);
      if (m) out.sex = m[1];
    }
  } catch (_e) { /* ignore */ }

  try {
    // "Names" / "Name" / "Given Names" / "Surname" — capture the uppercase
    // name tokens on the same line (or the next), excluding obvious labels.
    const window = valueAfterLabel(lines, /\b(surname|given names?|names?)\b/i, 1);
    if (window) {
      const name = window
        .replace(/\b(surname|given|names?|holder|signature)\b/gi, " ")
        .match(/[A-Z][A-Z'-]+(?:\s+[A-Z][A-Z'-]+)*/);
      if (name) {
        out.fullName = name[0].replace(/\s+/g, " ").trim();
        // Split into surname (last token) and given names (everything before).
        // This is a Western/Arabic-name heuristic; the MRZ is authoritative when
        // available, but the VIZ split lets us populate both fields when only
        // the printed page is readable.
        const tokens = out.fullName.split(/\s+/);
        if (tokens.length >= 2) {
          out.surname = tokens[tokens.length - 1];
          out.givenNames = tokens.slice(0, -1).join(" ");
        } else {
          out.givenNames = out.fullName;
        }
      }
    }
  } catch (_e) { /* ignore */ }

  // Nothing useful found at all → signal "no VIZ".
  const any = Object.values(out).some((v) => v != null);
  return any ? out : null;
}

module.exports = { parseViz, parseHumanDate, normalizeNationality };
