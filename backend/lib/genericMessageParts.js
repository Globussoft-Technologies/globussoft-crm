const GENERIC_SMS_MESSAGE_LIMIT = 150;
const GENERIC_WHATSAPP_MESSAGE_LIMIT = 250;

function splitGenericMessage(value, limit) {
  const text = String(value || '');
  if (!text) return [];
  if (!Number.isInteger(limit) || limit <= 0) throw new TypeError('Message limit must be a positive integer');

  const parts = [];
  for (let offset = 0; offset < text.length; offset += limit) {
    parts.push(text.slice(offset, offset + limit));
  }
  return parts;
}

module.exports = {
  GENERIC_SMS_MESSAGE_LIMIT,
  GENERIC_WHATSAPP_MESSAGE_LIMIT,
  splitGenericMessage,
};
