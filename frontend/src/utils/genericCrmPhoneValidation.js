const GENERIC_PHONE_FORMAT_RE = /^\+?[0-9][0-9\s().-]*$/;

export function sanitizeGenericCrmPhoneInput(value) {
  const raw = String(value || "");
  const startsWithPlus = raw.trimStart().startsWith("+");
  const cleaned = raw.replace(/[^0-9().\s+-]/g, "").replace(/\+/g, "");
  return startsWithPlus ? `+${cleaned}` : cleaned;
}

export function validateGenericCrmPhone(value, label) {
  const phone = String(value || "").trim();
  if (!phone) return "";
  if (!GENERIC_PHONE_FORMAT_RE.test(phone)) {
    return `Enter a valid ${label} (digits, +, spaces, hyphens, parentheses, and periods only).`;
  }
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) {
    return `Enter a valid ${label} (7-15 digits).`;
  }
  return "";
}
