/**
 * Unit tests for services/waTransportDTO.js — the pure transport↔backend DTO
 * normalizers. No Prisma/session/media; every function is a pure shaping helper,
 * so these lock the wire contract used by both the in-process path and the
 * WhatsApp Gateway. See docs/WHATSAPP_GATEWAY_EXTRACTION.md §2.
 */
import { describe, test, expect } from "vitest";
import dto from "../../services/waTransportDTO.js";

describe("messageIdOf", () => {
  test("returns the serialized id or null", () => {
    expect(dto.messageIdOf({ id: { _serialized: "wamid-1" } })).toBe("wamid-1");
    expect(dto.messageIdOf({ id: {} })).toBe(null);
    expect(dto.messageIdOf({})).toBe(null);
    expect(dto.messageIdOf(null)).toBe(null);
  });
});

describe("toAckDTO", () => {
  test("normalizes a wweb ack event into {providerMsgId, ack}", () => {
    expect(dto.toAckDTO({ id: { _serialized: "wamid-1" } }, 3)).toEqual({ providerMsgId: "wamid-1", ack: 3 });
  });
  test("coerces ack to a number and tolerates a missing id", () => {
    expect(dto.toAckDTO({}, "2")).toEqual({ providerMsgId: null, ack: 2 });
  });
});

describe("toInboundContentDTO", () => {
  test("extracts flat content fields; empty body → null", () => {
    const out = dto.toInboundContentDTO({
      id: { _serialized: "wamid-9" },
      from: "919812345678@c.us",
      fromMe: false,
      type: "chat",
      body: "hi",
      hasMedia: false,
      timestamp: 1700000000,
      _data: { notifyName: "Asha" },
    });
    expect(out).toEqual({
      providerMsgId: "wamid-9",
      from: "919812345678@c.us",
      fromMe: false,
      isGroup: undefined, // caller fills isGroup after classification
      type: "chat",
      body: "hi",
      notifyName: "Asha",
      hasMedia: false,
      timestamp: 1700000000,
    });
  });

  test("lowercases type, empty string body → null, missing fields safe", () => {
    const out = dto.toInboundContentDTO({ from: "x@g.us", type: "IMAGE", body: "", hasMedia: true });
    expect(out.type).toBe("image");
    expect(out.body).toBe(null);
    expect(out.hasMedia).toBe(true);
    expect(out.providerMsgId).toBe(null);
    expect(out.timestamp).toBe(null);
  });

  test("null message → null", () => {
    expect(dto.toInboundContentDTO(null)).toBe(null);
  });
});

describe("toHistoryMessageDTO", () => {
  test("carries direction (fromMe→outbound) + ack for status mapping", () => {
    const out = dto.toHistoryMessageDTO({
      id: { _serialized: "h-1" }, fromMe: true, type: "chat", body: " hello ", hasMedia: false, timestamp: 123, ack: 2,
    });
    expect(out).toEqual({
      providerMsgId: "h-1", outbound: true, type: "chat", body: " hello ",
      hasMedia: false, timestamp: 123, ack: 2, notifyName: null,
    });
  });
  test("whitespace-only body → null", () => {
    expect(dto.toHistoryMessageDTO({ body: "   ", type: "chat" }).body).toBe(null);
  });
});

describe("toStateDTO", () => {
  test("fills defaults for a JSON-safe state shape", () => {
    expect(dto.toStateDTO()).toEqual({ state: "DISCONNECTED", connected: false, phone: null, qr: null, lastError: null });
  });
  test("passes through a connected state", () => {
    expect(dto.toStateDTO({ state: "CONNECTED", connected: true, phone: "9198…", qr: null, lastError: null }))
      .toEqual({ state: "CONNECTED", connected: true, phone: "9198…", qr: null, lastError: null });
  });
});
