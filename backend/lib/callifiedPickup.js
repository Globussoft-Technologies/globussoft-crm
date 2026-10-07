function cleanPickupAddress(value) {
  let address = String(value || '').replace(/\s+/g, ' ').trim();
  if (!address) return null;
  address = address.split(/(?<=[.!?])\s+(?=[A-Z])/)[0];
  address = address
    .replace(/\s+(?:for\s+(?:today|tomorrow|the\s+visit|your\s+visit)|we\s+look\s+forward|the\s+(?:appointment|visit)\s+is).*$/i, '')
    .replace(/^[\s,:-]+|[\s,;.-]+$/g, '')
    .trim();
  return address.length >= 5 && address.length <= 2000 ? address : null;
}

function pickupFromText(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const patterns = [
    /(?:confirmed\s+)?pickup\s+(?:location|address|point)\s+(?:is|as|will be|would be|:)\s+(.+)/i,
    /(?:recorded|noted|have)\s+(?:that\s+)?(?:your\s+)?pickup\s+(?:location|address)\s+(?:is|as)\s+(.+)/i,
    /pick\s+(?:me|us|the customer)\s+up\s+(?:at|from)\s+(.+)/i,
  ];
  const match = patterns.map((pattern) => text.match(pattern)).find(Boolean);
  const pickupAddress = cleanPickupAddress(match?.[1]);
  return pickupAddress ? { pickupAddress, sourceExcerpt: text } : null;
}

/**
 * Extract a confirmed pickup address from Callified's latest transcript and
 * review. Review summaries are checked first because they normally contain a
 * clean, sentence-level version of an address that may be split across turns.
 */
function extractPickupLocationFromCallifiedDetails(details) {
  const transcripts = Array.isArray(details?.transcripts) ? details.transcripts : [];
  const reviews = Array.isArray(details?.reviews) ? details.reviews : [];
  const orderedTranscripts = [...transcripts].sort(
    (a, b) => new Date(b?.created_at || 0).getTime() - new Date(a?.created_at || 0).getTime(),
  );

  for (const transcript of orderedTranscripts) {
    const review = reviews.find((row) => row && !row.error && row.transcript_id === transcript?.id);
    for (const reviewText of [review?.summary, review?.coaching_insight, review?.what_went_well]) {
      const match = pickupFromText(reviewText);
      if (match) return { ...match, sourceTranscriptId: String(transcript.id || '') };
    }
    const messages = Array.isArray(transcript?.transcript) ? transcript.transcript : [];
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const match = pickupFromText(messages[index]?.text);
      if (match) return { ...match, sourceTranscriptId: String(transcript.id || '') };
    }
  }
  return null;
}

module.exports = { cleanPickupAddress, extractPickupLocationFromCallifiedDetails, pickupFromText };
