function cleanPickupAddress(value) {
  let address = String(value || '').replace(/\s+/g, ' ').trim();
  if (!address) return null;
  address = address
    .replace(/[.!?]\s+(?:thank\s+you|please\s+call|i\s+am\s+available|can\s+you|could\s+you|would\s+you|the\s+visit|we\s+look\s+forward)\b.*$/i, '')
    .replace(/[;,]?\s*(?:could|can|would)\s+you\s+(?:please\s+)?(?:provide|confirm|share|tell)\b.*$/i, '')
    .replace(/[;,]?\s*(?:is|was)\s+(?:that|this)\s+(?:correct|right)\??.*$/i, '')
    .replace(/[;,]?\s*(?:did\s+i\s+get\s+that|does\s+that\s+sound)\s+(?:correct|right)\??.*$/i, '')
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
    /(?:your\s+)?pickup\s+(?:location\s+)?(?:will\s+be|is)\s+from\s+(.+)/i,
    /pick\s+(?:me|us|the customer)\s+up\s+(?:at|from)\s+(.+)/i,
  ];
  const match = patterns.map((pattern) => text.match(pattern)).find(Boolean);
  const pickupAddress = cleanPickupAddress(match?.[1]);
  return pickupAddress ? { pickupAddress, sourceExcerpt: text } : null;
}

function pickupFromConversation(messages) {
  let collectingPickup = false;
  let pickupAddress = null;
  let sourceMessages = [];

  for (const message of messages) {
    const text = String(message?.text || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;

    const role = String(message?.role || '').toLowerCase();
    const isCustomer = /^(?:user|customer|lead|human)$/.test(role);
    const mentionsPickup = /\bpick\s*up\b/i.test(text);
    const asksForPickup = mentionsPickup && (
      /\b(?:provide|share|tell|confirm|which|where|address|location|landmark|city|pin\s*code)\b/i.test(text)
      || text.includes('?')
    );
    const asksForMissingAddressPart = /\b(?:city|pin\s*code|landmark|complete\s+address)\b/i.test(text)
      && /\b(?:provide|share|tell|confirm|what|which|please|could|can|would)\b/i.test(text);

    const directMatch = pickupFromText(text);
    if (directMatch && isCustomer) {
      pickupAddress = directMatch.pickupAddress;
      sourceMessages = [text];
      collectingPickup = false;
      continue;
    }
    if (directMatch && !isCustomer) {
      // An AI confirmation is only a fallback. Never replace an address that
      // the customer already supplied with the AI's paraphrased sentence.
      if (!pickupAddress) pickupAddress = directMatch.pickupAddress;
      collectingPickup = asksForPickup || asksForMissingAddressPart;
      continue;
    }

    if (!isCustomer && (asksForPickup || (pickupAddress && asksForMissingAddressPart))) {
      collectingPickup = true;
      continue;
    }

    if (
      !isCustomer
      && pickupAddress
      && /(?:\bvisit\b|\bbooking\b|\bdetails\b).*(?:\bconfirmed\b|\bscheduled\b)/i.test(text)
    ) {
      collectingPickup = false;
      continue;
    }

    if (collectingPickup && isCustomer) {
      const normalizedReply = text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      const isShortConfirmation = /^(?:(?:yes|yeah|yep)(?: it is)?(?: correct| right)?|correct|right|no|nope|okay|ok|sure|thanks|thank you)$/.test(normalizedReply);
      if (isShortConfirmation) {
        collectingPickup = false;
      } else if (text.length >= 5) {
        const addressPart = cleanPickupAddress(text);
        if (addressPart) {
          pickupAddress = pickupAddress
            ? cleanPickupAddress(`${pickupAddress}, ${addressPart}`)
            : addressPart;
          sourceMessages.push(text);
        }
      }
    }
  }

  return pickupAddress
    ? { pickupAddress, sourceExcerpt: sourceMessages.join(' | ') }
    : null;
}

function cleanInterestedPlotArea(value) {
  let area = String(value || '').replace(/\s+/g, ' ').trim();
  area = area
    .replace(/\b(?:and\s+)?i\s+am\s+interested\b.*$/i, '')
    .replace(/\b(?:i\s+am\s+interested|i'd\s+like|i\s+would\s+like)\b.*$/i, '')
    .replace(/\s+(?:and\s+)?(?:my|the)\s+(?:budget|plot\s+size|preferred\s+size)\b.*$/i, '')
    .replace(/^[\s,:;-]+|[\s,;.!?-]+$/g, '')
    .trim();
  return area.length >= 2 && area.length <= 191 ? area : null;
}

function customerDeclinesInterestedArea(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return false;
  return (
    /\b(?:no|not|don'?t|do\s+not|haven'?t|have\s+not)\b.*\b(?:specific|preferred|preference|recommendation|area|plot|site|location)\b/i.test(text)
    || /\b(?:can|could|would)\s+you\s+(?:please\s+)?recommend\b/i.test(text)
    || /\b(?:anything|anywhere|whatever)\s+(?:is\s+)?(?:fine|available|works)\b/i.test(text)
  );
}

function interestedAreaFromCustomerText(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  if (customerDeclinesInterestedArea(text)) return null;
  const patterns = [
    /\b(?:specific|preferred)\s+(?:plot|site|location|area)\s+(?:is|would\s+be|:)\s+(.+)/i,
    /\b(?:the\s+)?plot\s+(?:is|will\s+be|should\s+be)\s+(?:in|at|near|around)\s+(.+)/i,
    /\binterested\s+in\s+(?:visiting\s+)?(?:a\s+|the\s+)?plots?\s+(?:in|at|near|around)\s+(.+)/i,
    /\b(?:my\s+)?preferred\s+(?:plot\s+)?(?:area|locality|location)\s+(?:is|would\s+be)\s+(.+)/i,
    /\b(?:i\s+prefer|i\s+would\s+prefer|i\s+am\s+looking\s+for)\s+(.+?)(?:\s+(?:area|locality|for\s+a\s+plot))?$/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const area = cleanInterestedPlotArea(match?.[1]);
    if (area) return area;
  }
  return null;
}

function extractInterestedPlotAreaFromMessages(messages) {
  let awaitingAreaAnswer = false;
  let interestedPlotArea = null;

  for (const message of messages) {
    const text = String(message?.text || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const role = String(message?.role || '').toLowerCase();
    const isCustomer = /^(?:user|customer|lead|human)$/.test(role);

    if (!isCustomer) {
      if (
        /\b(?:which|what|preferred|prefer|specific|suggestions?|localit(?:y|ies)|zone|area)\b/i.test(text)
        && /\b(?:plot|site|area|localit(?:y|ies)|zone|location|suggestions?)\b/i.test(text)
        && !/\b(?:pickup|pick\s+(?:\w+\s+)?up|transport|time|visit\s+(?:date|time)|how\s+many\s+square|budget)\b/i.test(text)
      ) {
        awaitingAreaAnswer = true;
      }
      continue;
    }

    const explicitArea = interestedAreaFromCustomerText(text);
    if (explicitArea) {
      interestedPlotArea = explicitArea;
      awaitingAreaAnswer = false;
      continue;
    }

    if (awaitingAreaAnswer) {
      const normalized = text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      const hasNoAreaPreference = customerDeclinesInterestedArea(text);
      if (!hasNoAreaPreference && !/^(?:yes|yeah|yep|si|s|haan|ha|no|nope|correct|okay|ok|sure|thanks|thank you)$/.test(normalized)) {
        const area = cleanInterestedPlotArea(text);
        if (!interestedPlotArea && area && area.length <= 100) interestedPlotArea = area;
      }
      awaitingAreaAnswer = false;
    }
  }

  return interestedPlotArea;
}

function hasExplicitNoInterestedPlotArea(details) {
  const transcripts = Array.isArray(details?.transcripts) ? details.transcripts : [];
  const ordered = [...transcripts].sort(
    (a, b) => new Date(a?.created_at || 0).getTime() - new Date(b?.created_at || 0).getTime(),
  );
  let explicitlyBlank = false;

  for (const transcript of ordered) {
    const messages = Array.isArray(transcript?.transcript) ? transcript.transcript : [];
    for (const message of messages) {
      const role = String(message?.role || '').toLowerCase();
      if (!/^(?:user|customer|lead|human)$/.test(role)) continue;
      if (interestedAreaFromCustomerText(message?.text)) explicitlyBlank = false;
      else if (customerDeclinesInterestedArea(message?.text)) explicitlyBlank = true;
    }
  }

  return explicitlyBlank;
}

function extractInterestedPlotAreaFromCallifiedDetails(details) {
  const transcripts = Array.isArray(details?.transcripts) ? details.transcripts : [];
  const ordered = [...transcripts].sort(
    (a, b) => new Date(a?.created_at || 0).getTime() - new Date(b?.created_at || 0).getTime(),
  );
  let interestedPlotArea = null;
  for (const transcript of ordered) {
    const area = extractInterestedPlotAreaFromMessages(
      Array.isArray(transcript?.transcript) ? transcript.transcript : [],
    );
    if (area) interestedPlotArea = area;
  }
  // Review summaries are generated text and may contain recommendations or
  // inferred locations. Only a customer's own transcript words can populate
  // the interested-area field.
  return interestedPlotArea;
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
    const review = reviews.find((row) => (
      row && !row.error && String(row.transcript_id) === String(transcript?.id)
    ));
    const messages = Array.isArray(transcript?.transcript) ? transcript.transcript : [];
    const conversationMatch = pickupFromConversation(messages);
    if (conversationMatch) {
      return { ...conversationMatch, sourceTranscriptId: String(transcript.id || '') };
    }
    for (const reviewText of [review?.summary, review?.coaching_insight, review?.what_went_well]) {
      const match = pickupFromText(reviewText);
      if (match) return { ...match, sourceTranscriptId: String(transcript.id || '') };
    }
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const match = pickupFromText(messages[index]?.text);
      if (match) return { ...match, sourceTranscriptId: String(transcript.id || '') };
    }
  }
  return null;
}

module.exports = {
  cleanPickupAddress,
  extractInterestedPlotAreaFromCallifiedDetails,
  extractPickupLocationFromCallifiedDetails,
  hasExplicitNoInterestedPlotArea,
  interestedAreaFromCustomerText,
  pickupFromConversation,
  pickupFromText,
};
