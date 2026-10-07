const NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}\s.'’&()/_-]*$/u;
const PERSON_NAME_PATTERN = /^[\p{L}][\p{L}\s.'’-]*$/u;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VEHICLE_NUMBER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 -]*$/;

function valueLength(value) {
  return value === null || value === undefined ? 0 : String(value).trim().length;
}

function validateRequiredText(value, label, { min = 1, max = 500 } = {}) {
  const length = valueLength(value);
  if (!length) return `${label} is required.`;
  if (length < min) return `${label} must be at least ${min} characters.`;
  if (length > max) return `${label} must be ${max} characters or fewer.`;
  return null;
}

function validateOptionalText(value, label, max) {
  return valueLength(value) > max ? `${label} must be ${max} characters or fewer.` : null;
}

function validateName(value, label = "Name") {
  const baseError = validateRequiredText(value, label, { min: 2, max: 150 });
  if (baseError) return baseError;
  return NAME_PATTERN.test(String(value).trim())
    ? null
    : `${label} contains unsupported characters.`;
}

function validatePersonName(value, label = "Name") {
  const baseError = validateRequiredText(value, label, { min: 2, max: 150 });
  if (baseError) return baseError;
  return PERSON_NAME_PATTERN.test(String(value).trim())
    ? null
    : `${label} can contain only letters, spaces, apostrophes, periods, and hyphens.`;
}

function validatePhone(value, label = "Phone", { required = true } = {}) {
  const phone = value === null || value === undefined ? "" : String(value).trim();
  if (!phone) return required ? `${label} is required.` : null;
  if (!/^\+?[0-9(][0-9\s()-]*$/.test(phone)) return `${label} contains invalid characters.`;
  const digitCount = (phone.match(/\d/g) || []).length;
  if (digitCount < 7 || digitCount > 15) return `${label} must contain 7 to 15 digits.`;
  return phone.length <= 25 ? null : `${label} must be 25 characters or fewer.`;
}

function validateEmail(value) {
  const email = value === null || value === undefined ? "" : String(value).trim();
  if (!email) return null;
  if (email.length > 320 || !EMAIL_PATTERN.test(email)) return "Enter a valid email address.";
  return null;
}

function validateVehicleNumber(value) {
  const number = value === null || value === undefined ? "" : String(value).trim();
  if (!number) return null;
  if (number.length < 3 || number.length > 30) return "Vehicle number must be 3 to 30 characters.";
  return VEHICLE_NUMBER_PATTERN.test(number) ? null : "Vehicle number can contain only letters, numbers, spaces, and hyphens.";
}

function validateMoney(value, label = "Price") {
  if (value === "" || value === null || value === undefined) return null;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) return `${label} must be a non-negative number.`;
  if (amount > 9999999999999.99) return `${label} is too large.`;
  return null;
}

module.exports = {
  validateEmail,
  validateMoney,
  validateName,
  validateOptionalText,
  validatePersonName,
  validatePhone,
  validateRequiredText,
  validateVehicleNumber,
};
