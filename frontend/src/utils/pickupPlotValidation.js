const NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}\s.'’&()/_-]*$/u;
const PERSON_NAME_PATTERN = /^[\p{L}][\p{L}\s.'’-]*$/u;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function clean(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function requiredText(value, label, min, max) {
  const text = clean(value);
  if (!text) return `${label} is required.`;
  if (text.length < min) return `${label} must be at least ${min} characters.`;
  if (text.length > max) return `${label} must be ${max} characters or fewer.`;
  return null;
}

function optionalText(value, label, max) {
  return clean(value).length > max ? `${label} must be ${max} characters or fewer.` : null;
}

function name(value, label = 'Name') {
  const error = requiredText(value, label, 2, 150);
  if (error) return error;
  return NAME_PATTERN.test(clean(value)) ? null : `${label} contains unsupported characters.`;
}

function phone(value, label = 'Phone', required = true) {
  const input = clean(value);
  if (!input) return required ? `${label} is required.` : null;
  if (!/^\+?[0-9(][0-9\s()-]*$/.test(input)) return `${label} contains invalid characters.`;
  const digits = (input.match(/\d/g) || []).length;
  if (digits < 7 || digits > 15) return `${label} must contain 7 to 15 digits.`;
  return input.length <= 25 ? null : `${label} must be 25 characters or fewer.`;
}

export function validatePersonName(value, label = 'Name') {
  const error = requiredText(value, label, 2, 150);
  if (error) return error;
  return PERSON_NAME_PATTERN.test(clean(value))
    ? null
    : `${label} can contain only letters, spaces, apostrophes, periods, and hyphens.`;
}

export function validatePhoneNumber(value, label = 'Phone', required = true) {
  return phone(value, label, required);
}

function money(value, label, max = 9999999999999.99) {
  if (value === '' || value === null || value === undefined) return null;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) return `${label} must be a non-negative number.`;
  return amount <= max ? null : `${label} is too large.`;
}

function googleMapsLink(value) {
  const input = clean(value);
  if (!input) return null;
  if (input.length > 2000) return 'Google Maps link must be 2000 characters or fewer.';
  try {
    const url = new URL(input);
    const host = url.hostname.toLowerCase();
    const isGoogle = host === 'maps.app.goo.gl'
      || (host === 'goo.gl' && url.pathname.startsWith('/maps'))
      || /^maps\.google\.[a-z.]+$/.test(host)
      || (/^(www\.)?google\.[a-z.]+$/.test(host) && url.pathname.startsWith('/maps'));
    return url.protocol === 'https:' && isGoogle ? null : 'Enter a valid HTTPS Google Maps link.';
  } catch {
    return 'Enter a valid HTTPS Google Maps link.';
  }
}

function vehicleNumber(value) {
  const input = clean(value);
  if (!input) return null;
  if (input.length < 3 || input.length > 30) return 'Vehicle number must be 3 to 30 characters.';
  return /^[A-Za-z0-9][A-Za-z0-9 -]*$/.test(input)
    ? null
    : 'Vehicle number can contain only letters, numbers, spaces, and hyphens.';
}

function first(...errors) {
  return errors.find(Boolean) || null;
}

export function validateLocationForm(form) {
  return first(
    name(form.name, 'Location name'),
    requiredText(form.address, 'Address', 5, 2000),
    googleMapsLink(form.googleMapsLink),
    optionalText(form.notes, 'Notes', 4000),
  );
}

export function validatePlotForm(form) {
  return first(
    name(form.name, 'Plot or site name'),
    optionalText(form.plotNumber, 'Plot number', 100),
    optionalText(form.block, 'Block', 100),
    clean(form.address) ? requiredText(form.address, 'Address', 5, 2000) : null,
    optionalText(form.area, 'Area or size', 100),
    ['SQ_FT', 'KATHA'].includes(form.areaUnit || 'SQ_FT') ? null : 'Select a valid area unit.',
    optionalText(form.roadWidth, 'Road width', 100),
    !form.facing || ['NORTH', 'SOUTH', 'EAST', 'WEST', 'NORTH_EAST', 'NORTH_WEST', 'SOUTH_EAST', 'SOUTH_WEST'].includes(form.facing) ? null : 'Select a valid facing.',
    !form.propertyType || ['RESIDENTIAL', 'COMMERCIAL'].includes(form.propertyType) ? null : 'Select a valid property type.',
    money(form.price, 'Price'),
    ['AVAILABLE', 'HOLD', 'BOOKED', 'REGISTERED', 'RESERVED', 'SOLD'].includes(form.availability) ? null : 'Select a valid availability.',
    optionalText(form.notes, 'Notes', 4000),
  );
}

export function validateTransportPersonForm(form) {
  const serviceAreaError = (form.serviceAreas || []).reduce((error, row) => {
    if (error || (!clean(row?.area) && !clean(row?.state) && !clean(row?.pincode))) return error;
    if (!clean(row?.area)) return 'Area could not be resolved from the selected plot address.';
    if (clean(row.pincode) && !/^\d{6}$/.test(clean(row.pincode))) return 'PIN code must contain exactly 6 digits.';
    return null;
  }, null);
  return first(
    validatePersonName(form.name),
    validatePhoneNumber(form.phone),
    phone(form.alternatePhone, 'Alternate phone', false),
    optionalText(form.vehicleType, 'Vehicle type', 100),
    vehicleNumber(form.vehicleNumber),
    serviceAreaError,
    optionalText(form.notes, 'Notes', 4000),
  );
}

export function validateBrokerForm(form) {
  const email = clean(form.email);
  return first(
    validatePersonName(form.name),
    validatePhoneNumber(form.phone),
    email && (email.length > 320 || !EMAIL_PATTERN.test(email)) ? 'Enter a valid email address.' : null,
    optionalText(form.agency, 'Agency', 150),
    money(form.commissionPercent, 'Commission', 100),
    optionalText(form.notes, 'Notes', 4000),
  );
}
