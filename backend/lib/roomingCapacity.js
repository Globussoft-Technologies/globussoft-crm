const LEGACY_ROOM_CAPACITY = Object.freeze({
  single: 1,
  twin: 2,
  triple: 3,
  quad: 4,
});

const LEGACY_ROOM_TYPE = Object.freeze({
  1: "single",
  2: "twin",
  3: "triple",
  4: "quad",
});
const MAX_SHARING_CAPACITY = 2_147_483_647;

function parseSharingCapacity(value) {
  const numeric = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
      ? Number(value)
      : NaN;
  return Number.isSafeInteger(numeric) && numeric > 0 && numeric <= MAX_SHARING_CAPACITY
    ? numeric
    : null;
}

function resolveSharingCapacity(room) {
  const stored = parseSharingCapacity(room?.sharingCapacity);
  if (stored !== null) return stored;
  return LEGACY_ROOM_CAPACITY[String(room?.roomType || "").toLowerCase()] || null;
}

function legacyRoomTypeForCapacity(value) {
  const capacity = parseSharingCapacity(value);
  return capacity === null ? null : LEGACY_ROOM_TYPE[capacity] || "custom";
}

function serializeRoomCapacity(room) {
  return { ...room, sharingCapacity: resolveSharingCapacity(room) };
}

module.exports = {
  parseSharingCapacity,
  resolveSharingCapacity,
  legacyRoomTypeForCapacity,
  serializeRoomCapacity,
};
