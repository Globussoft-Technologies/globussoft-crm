const GENERIC_SMS_MESSAGE_LIMIT = 150;
const GENERIC_WHATSAPP_MESSAGE_LIMIT = 250;

function splitGenericMessage(value, limit) {
  const text = String(value || '');
  if (!text) return [];
  if (!Number.isInteger(limit) || limit <= 0) throw new TypeError('Message limit must be a positive integer');

  const parts = [];
  let current = '';
  const flush = () => { if (current) parts.push(current); current = ''; };
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  // Treat links as indivisible tokens, even when adjacent to other text.
  const tokens = text.match(/https?:\/\/[^\s]+|\s+|(?:(?!https?:\/\/)[^\s])+/gu) || [];
  for (const token of tokens) {
    const isUrl = /^https?:\/\//u.test(token);
    if (isUrl && token.length > limit) {
      // Signed CRM links can exceed the preferred size. Send them intact as
      // a standalone message rather than corrupting the token or dropping it.
      flush();
      parts.push(token);
      continue;
    }
    if (token.length <= limit) {
      if (current.length + token.length > limit) flush();
      current += token;
      continue;
    }
    for (const { segment } of segmenter.segment(token)) {
      if (segment.length > limit) throw new RangeError('A message character exceeds the part limit');
      if (current.length + segment.length > limit) flush();
      current += segment;
    }
  }
  flush();
  return parts;
}

module.exports = {
  GENERIC_SMS_MESSAGE_LIMIT,
  GENERIC_WHATSAPP_MESSAGE_LIMIT,
  splitGenericMessage,
};
