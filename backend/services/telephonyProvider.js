/**
 * Normalize Indian phone number: strip non-digits, prepend 91 if 10 digits.
 */
function normalizePhone(phone) {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 10) return "91" + digits;
  return digits;
}

/**
 * Initiate a click-to-call via Indian telephony provider.
 * @param {Object} opts
 * @param {string} opts.from - Agent/virtual number
 * @param {string} opts.to - Destination number
 * @param {string} opts.provider - "myoperator" or "knowlarity"
 * @param {string} opts.apiKey
 * @param {string} opts.apiSecret
 * @param {string} opts.virtualNumber
 * @returns {Promise<{success: boolean, callId?: string, error?: string}>}
 */
async function initiateCall({ from, to, provider, apiKey, apiSecret, virtualNumber }) {
  const normalizedTo = normalizePhone(to);
  const normalizedFrom = normalizePhone(from);

  try {
    if (provider === "myoperator") {
      const response = await fetch("https://api.myoperator.com/obd/make-call", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Api-Key": apiKey,
          Authorization: `Bearer ${apiSecret}`,
        },
        body: JSON.stringify({
          company_id: apiKey,
          secret_token: apiSecret,
          type: "obd",
          public_ivr_id: virtualNumber,
          agent_number: normalizedFrom,
          customer_number: normalizedTo,
        }),
      });

      const data = await response.json();

      if (response.ok && data.status === "success") {
        return { success: true, callId: data.call_id || data.id || null };
      }
      return { success: false, error: data.message || "MyOperator call failed" };
    }

    if (provider === "knowlarity") {
      const response = await fetch("https://kpi.knowlarity.com/Basic/v1/account/call/makecall", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-]api-key": apiKey,
          Authorization: apiSecret,
        },
        body: JSON.stringify({
          k_number: virtualNumber,
          agent_number: `+${normalizedFrom}`,
          customer_number: `+${normalizedTo}`,
        }),
      });

      const data = await response.json();

      if (response.ok && (data.success || data.call_id)) {
        return { success: true, callId: data.call_id || data.uuid || null };
      }
      return { success: false, error: data.message || data.error || "Knowlarity call failed" };
    }

    return { success: false, error: `Unsupported provider: ${provider}` };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Lookup a Contact by phone number.
 * @param {string} phone - Raw phone number
 * @param {import("@prisma/client").PrismaClient} prisma
 * @returns {Promise<Object|null>}
 */
async function lookupContact(phone, prisma) {
  const normalized = normalizePhone(phone);

  // Try exact match on normalized number, then partial match
  const contact = await prisma.contact.findFirst({
    where: {
      OR: [
        { phone: normalized },
        { phone: `+${normalized}` },
        { phone: phone },
        { phone: { endsWith: normalized.slice(-10) } },
      ],
    },
  });

  return contact || null;
}

module.exports = { initiateCall, lookupContact, normalizePhone };
