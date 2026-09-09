function positiveId(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function tenantRoom(tenantId) {
  const id = positiveId(tenantId);
  if (!id) throw new TypeError("tenantId must be a positive integer");
  return `tenant:${id}`;
}

function userRoom(tenantId, userId) {
  const tenant = positiveId(tenantId);
  const user = positiveId(userId);
  if (!tenant) throw new TypeError("tenantId must be a positive integer");
  if (!user) throw new TypeError("userId must be a positive integer");
  return `tenant:${tenant}:user:${user}`;
}

function chatRoom(sessionId) {
  const id = positiveId(sessionId);
  if (!id) throw new TypeError("sessionId must be a positive integer");
  return `chat:${id}`;
}

function emitToTenant(io, tenantId, event, payload) {
  if (!io) return false;
  io.to(tenantRoom(tenantId)).emit(event, payload);
  return true;
}

function emitToUser(io, tenantId, userId, event, payload) {
  if (!io) return false;
  io.to(userRoom(tenantId, userId)).emit(event, payload);
  return true;
}

module.exports = {
  tenantRoom,
  userRoom,
  chatRoom,
  emitToTenant,
  emitToUser,
};
