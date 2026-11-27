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

export function validateGenericCrmInlinePhone(value) {
  const phone = String(value || "").trim();
  if (!phone) return "";
  const invalidCharacter = Array.from(phone).find(
    (character, index) =>
      !/\d/.test(character) && !(character === "+" && index === 0),
  );
  if (invalidCharacter) {
    if (invalidCharacter === "+") {
      return "The + symbol is allowed only at the beginning of a phone number.";
    }
    const characterNames = {
      ".": "The dot (.)",
      "#": "The hash symbol (#)",
      ",": "A comma (,)",
      "-": "A hyphen (-)",
      " ": "A space",
    };
    const characterName = characterNames[invalidCharacter]
      || (/\s/.test(invalidCharacter)
        ? "Whitespace"
        : /[a-z]/i.test(invalidCharacter)
          ? `The letter "${invalidCharacter}"`
          : `The character "${invalidCharacter}"`);
    return `${characterName} is not allowed in phone numbers. Enter digits only, with an optional + at the beginning.`;
  }
  const digitCount = phone.startsWith("+") ? phone.length - 1 : phone.length;
  if (digitCount < 7 || digitCount > 15) {
    return "Phone number must contain 7 to 15 digits.";
  }
  return "";
}
