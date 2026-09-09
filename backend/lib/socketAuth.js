const jwt = require("jsonwebtoken");
const prisma = require("./prisma");
const { JWT_SECRET } = require("../config/secrets");
const { TOKEN_COOKIE } = require("./authCookies");
const { tenantRoom, userRoom, chatRoom } = require("./socketRooms");

function cookieValue(header, name) {
  if (!header) return null;
  for (const part of String(header).split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    if (key !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch (_err) {
      return part.slice(separator + 1).trim();
    }
  }
  return null;
}

function handshakeToken(socket) {
  const authToken = socket?.handshake?.auth?.token;
  if (typeof authToken === "string" && authToken.trim()) return authToken.trim();

  const header = socket?.handshake?.headers?.authorization;
  if (typeof header === "string" && /^Bearer\s+/i.test(header)) {
    return header.replace(/^Bearer\s+/i, "").trim();
  }

  return cookieValue(socket?.handshake?.headers?.cookie, TOKEN_COOKIE);
}

async function authenticateSocket(socket, next) {
  try {
    const token = handshakeToken(socket);
    if (!token) return next(new Error("Authentication required"));

    const verified = jwt.verify(token, JWT_SECRET);
    if (!verified?.userId || verified.patientId || verified.awaiting2FA === true) {
      return next(new Error("Invalid staff token"));
    }

    const liveUser = await prisma.user.findUnique({
      where: { id: verified.userId },
      select: {
        id: true,
        name: true,
        email: true,
        tenantId: true,
        deactivatedAt: true,
        sessionVersion: true,
      },
    });
    if (!liveUser || liveUser.deactivatedAt) {
      return next(new Error("Authentication required"));
    }

    const tokenTenantId = verified.tenantId == null ? 1 : Number(verified.tenantId);
    if (tokenTenantId !== liveUser.tenantId) {
      return next(new Error("Invalid tenant session"));
    }
    if (
      verified.sessionVersion != null &&
      Number(verified.sessionVersion) !== Number(liveUser.sessionVersion || 0)
    ) {
      return next(new Error("Session expired"));
    }

    if (verified.jti) {
      const revoked = await prisma.revokedToken.findUnique({
        where: { jti: verified.jti },
        select: { id: true },
      });
      if (revoked) return next(new Error("Session revoked"));
    }

    socket.data.user = {
      ...verified,
      userId: liveUser.id,
      tenantId: liveUser.tenantId,
      name: liveUser.name || liveUser.email || "User",
    };
    return next();
  } catch (_err) {
    return next(new Error("Invalid authentication token"));
  }
}

function attachAuthenticatedSocket(socket) {
  const user = socket.data.user;
  const presenceColors = ["#ef4444", "#3b82f6", "#10b981", "#f59e0b", "#8b5cf6", "#ec4899"];
  socket.join(tenantRoom(user.tenantId));
  socket.join(userRoom(user.tenantId, user.userId));

  socket.on("join_presence", () => {
    socket.userData = {
      id: socket.id,
      userId: user.userId,
      name: user.name,
      color: presenceColors[user.userId % presenceColors.length],
    };
  });

  socket.on("mouse_move", (data = {}) => {
    if (!socket.userData) return;
    const rx = Number(data.rx);
    const ry = Number(data.ry);
    if (!Number.isFinite(rx) || !Number.isFinite(ry)) return;
    socket.to(tenantRoom(user.tenantId)).emit("cursor_update", {
      ...socket.userData,
      rx: Math.max(0, Math.min(1, rx)),
      ry: Math.max(0, Math.min(1, ry)),
    });
  });

  socket.on("join_chat", async (sessionId, acknowledge) => {
    const id = Number(sessionId);
    if (!Number.isInteger(id) || id < 1) {
      if (typeof acknowledge === "function") acknowledge({ ok: false });
      return;
    }
    const session = await prisma.liveChatSession.findFirst({
      where: { id, tenantId: user.tenantId },
      select: { id: true },
    }).catch(() => null);
    if (!session) {
      if (typeof acknowledge === "function") acknowledge({ ok: false });
      return;
    }
    socket.join(chatRoom(session.id));
    if (typeof acknowledge === "function") acknowledge({ ok: true });
  });

  socket.on("disconnect", () => {
    socket.to(tenantRoom(user.tenantId)).emit("user_left", socket.id);
  });
}

module.exports = {
  authenticateSocket,
  attachAuthenticatedSocket,
  handshakeToken,
};
