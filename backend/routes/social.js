const express = require("express");
const router = express.Router();
const prisma = require("../lib/prisma");

// ──────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────

const SUPPORTED_PLATFORMS = ["linkedin", "twitter", "facebook"];

function tenantId(req) {
  return req.user?.tenantId || 1;
}

function normalizePlatform(p) {
  return (p || "").toString().toLowerCase().trim();
}

async function getIntegration(tenantId, provider) {
  try {
    return await prisma.integration.findFirst({
      where: { tenantId, provider, isActive: true },
    });
  } catch (e) {
    return null;
  }
}

function parseSettings(settings) {
  if (!settings) return {};
  try {
    return JSON.parse(settings);
  } catch (e) {
    return {};
  }
}

// ──────────────────────────────────────────────────────────────────
// Platform publish stubs (lazy / safe)
// ──────────────────────────────────────────────────────────────────

async function publishToLinkedIn(integration, post) {
  if (!integration || !integration.token) {
    return { success: false, error: "LinkedIn credentials not configured" };
  }
  try {
    const settings = parseSettings(integration.settings);
    const authorUrn = settings.authorUrn || settings.personUrn || "urn:li:person:me";
    const body = {
      author: authorUrn,
      lifecycleState: "PUBLISHED",
      specificContent: {
        "com.linkedin.ugc.ShareContent": {
          shareCommentary: { text: post.content || "" },
          shareMediaCategory: post.mediaUrl ? "IMAGE" : "NONE",
          ...(post.mediaUrl
            ? {
                media: [
                  {
                    status: "READY",
                    originalUrl: post.mediaUrl,
                  },
                ],
              }
            : {}),
        },
      },
      visibility: { "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC" },
    };

    const fetchFn = global.fetch || require("node-fetch");
    const resp = await fetchFn("https://api.linkedin.com/v2/ugcPosts", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${integration.token}`,
        "Content-Type": "application/json",
        "X-Restli-Protocol-Version": "2.0.0",
      },
      body: JSON.stringify(body),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return { success: false, error: data.message || `LinkedIn API error (${resp.status})` };
    }
    return { success: true, externalId: data.id || data.activity || null };
  } catch (err) {
    return { success: false, error: err.message || "LinkedIn publish failed" };
  }
}

async function publishToTwitter(integration, post) {
  if (!integration || !integration.token) {
    return { success: false, error: "Twitter credentials not configured" };
  }
  try {
    const fetchFn = global.fetch || require("node-fetch");
    const resp = await fetchFn("https://api.twitter.com/2/tweets", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${integration.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: post.content || "" }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return { success: false, error: data.title || data.detail || `Twitter API error (${resp.status})` };
    }
    return { success: true, externalId: data?.data?.id || null };
  } catch (err) {
    return { success: false, error: err.message || "Twitter publish failed" };
  }
}

async function publishToFacebook(integration, post) {
  if (!integration || !integration.token) {
    return { success: false, error: "Facebook credentials not configured" };
  }
  try {
    const settings = parseSettings(integration.settings);
    const pageId = settings.pageId || "me";
    const fetchFn = global.fetch || require("node-fetch");
    const params = new URLSearchParams();
    params.append("message", post.content || "");
    if (post.mediaUrl) params.append("link", post.mediaUrl);
    params.append("access_token", integration.token);

    const resp = await fetchFn(`https://graph.facebook.com/v18.0/${pageId}/feed`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return { success: false, error: data?.error?.message || `Facebook API error (${resp.status})` };
    }
    return { success: true, externalId: data.id || null };
  } catch (err) {
    return { success: false, error: err.message || "Facebook publish failed" };
  }
}

async function publishToPlatform(platform, integration, post) {
  switch (platform) {
    case "linkedin":
      return publishToLinkedIn(integration, post);
    case "twitter":
      return publishToTwitter(integration, post);
    case "facebook":
      return publishToFacebook(integration, post);
    default:
      return { success: false, error: `Unsupported platform: ${platform}` };
  }
}

// ──────────────────────────────────────────────────────────────────
// POSTS
// ──────────────────────────────────────────────────────────────────

// GET /api/social/posts — list posts
router.get("/posts", async (req, res) => {
  try {
    const where = { tenantId: tenantId(req) };
    if (req.query.platform) where.platform = normalizePlatform(req.query.platform);
    if (req.query.status) where.status = req.query.status;

    const posts = await prisma.socialPost.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    res.json(posts);
  } catch (err) {
    console.error("[social] list posts error:", err);
    res.status(500).json({ error: "Failed to list posts" });
  }
});

// POST /api/social/posts — create draft / scheduled
router.post("/posts", async (req, res) => {
  try {
    const { platform, content, mediaUrl, scheduledFor } = req.body || {};
    const p = normalizePlatform(platform);
    if (!p || !SUPPORTED_PLATFORMS.includes(p)) {
      return res.status(400).json({ error: "platform must be linkedin, twitter, or facebook" });
    }
    if (!content || !content.trim()) {
      return res.status(400).json({ error: "content is required" });
    }

    const scheduled = scheduledFor ? new Date(scheduledFor) : null;
    const status = scheduled ? "SCHEDULED" : "DRAFT";

    const post = await prisma.socialPost.create({
      data: {
        platform: p,
        content,
        mediaUrl: mediaUrl || null,
        scheduledFor: scheduled,
        status,
        tenantId: tenantId(req),
      },
    });
    res.json(post);
  } catch (err) {
    console.error("[social] create post error:", err);
    res.status(500).json({ error: "Failed to create post" });
  }
});

// POST /api/social/posts/:id/publish — manually publish
router.post("/posts/:id/publish", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const post = await prisma.socialPost.findFirst({
      where: { id, tenantId: tenantId(req) },
    });
    if (!post) return res.status(404).json({ error: "Post not found" });

    const integration = await getIntegration(tenantId(req), post.platform);
    const result = await publishToPlatform(post.platform, integration, post);

    if (!result.success) {
      await prisma.socialPost.update({
        where: { id },
        data: { status: "FAILED" },
      });
      return res.json({ success: false, error: result.error });
    }

    const updated = await prisma.socialPost.update({
      where: { id },
      data: {
        status: "PUBLISHED",
        publishedAt: new Date(),
        externalId: result.externalId || null,
      },
    });
    res.json({ success: true, post: updated });
  } catch (err) {
    console.error("[social] publish post error:", err);
    res.status(500).json({ success: false, error: "Failed to publish post" });
  }
});

// DELETE /api/social/posts/:id
router.delete("/posts/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = await prisma.socialPost.findFirst({
      where: { id, tenantId: tenantId(req) },
    });
    if (!existing) return res.status(404).json({ error: "Post not found" });

    await prisma.socialPost.delete({ where: { id } });
    res.json({ success: true });
  } catch (err) {
    console.error("[social] delete post error:", err);
    res.status(500).json({ error: "Failed to delete post" });
  }
});

// ──────────────────────────────────────────────────────────────────
// MENTIONS
// ──────────────────────────────────────────────────────────────────

// GET /api/social/mentions
router.get("/mentions", async (req, res) => {
  try {
    const where = { tenantId: tenantId(req) };
    if (req.query.platform) where.platform = normalizePlatform(req.query.platform);
    if (req.query.contactId) where.contactId = parseInt(req.query.contactId, 10);
    if (req.query.sentiment) where.sentiment = req.query.sentiment;

    const mentions = await prisma.socialMention.findMany({
      where,
      orderBy: { fetchedAt: "desc" },
      take: 200,
    });
    res.json(mentions);
  } catch (err) {
    console.error("[social] list mentions error:", err);
    res.status(500).json({ error: "Failed to list mentions" });
  }
});

// POST /api/social/mentions/fetch/:platform — STUB: returns mock mentions
router.post("/mentions/fetch/:platform", async (req, res) => {
  try {
    const platform = normalizePlatform(req.params.platform);
    if (!SUPPORTED_PLATFORMS.includes(platform)) {
      return res.status(400).json({ error: "Unsupported platform" });
    }
    const keywords = Array.isArray(req.body?.keywords) && req.body.keywords.length
      ? req.body.keywords
      : ["globussoft"];

    console.log(`[social] mention fetch (stub) platform=${platform} keywords=${JSON.stringify(keywords)}`);

    // Mocked sample mentions — production would call platform search APIs
    const sentiments = ["positive", "neutral", "negative"];
    const samples = keywords.slice(0, 3).map((kw, i) => ({
      platform,
      authorName: `Demo User ${i + 1}`,
      authorHandle: `@demo_user_${i + 1}`,
      content: `Just tried ${kw} — really impressed with the experience!`,
      url: `https://${platform}.com/demo_user_${i + 1}/status/${Date.now() + i}`,
      sentiment: sentiments[i % sentiments.length],
      tenantId: tenantId(req),
    }));

    const created = [];
    for (const sample of samples) {
      const m = await prisma.socialMention.create({ data: sample });
      created.push(m);
    }

    res.json({ success: true, fetched: created.length, mentions: created, stub: true });
  } catch (err) {
    console.error("[social] fetch mentions error:", err);
    res.status(500).json({ error: "Failed to fetch mentions" });
  }
});

// POST /api/social/mentions/:id/link-contact
router.post("/mentions/:id/link-contact", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { contactId } = req.body || {};
    if (!contactId) return res.status(400).json({ error: "contactId is required" });

    const mention = await prisma.socialMention.findFirst({
      where: { id, tenantId: tenantId(req) },
    });
    if (!mention) return res.status(404).json({ error: "Mention not found" });

    const contact = await prisma.contact.findFirst({
      where: { id: parseInt(contactId, 10), tenantId: tenantId(req) },
    });
    if (!contact) return res.status(404).json({ error: "Contact not found" });

    const updated = await prisma.socialMention.update({
      where: { id },
      data: { contactId: contact.id },
    });
    res.json(updated);
  } catch (err) {
    console.error("[social] link-contact error:", err);
    res.status(500).json({ error: "Failed to link contact" });
  }
});

// ──────────────────────────────────────────────────────────────────
// ACCOUNTS (Integrations)
// ──────────────────────────────────────────────────────────────────

// GET /api/social/accounts
router.get("/accounts", async (req, res) => {
  try {
    const integrations = await prisma.integration.findMany({
      where: { tenantId: tenantId(req), provider: { in: SUPPORTED_PLATFORMS } },
    });
    const map = Object.fromEntries(integrations.map((i) => [i.provider, i]));
    const accounts = SUPPORTED_PLATFORMS.map((p) => ({
      platform: p,
      connected: !!(map[p] && map[p].isActive && map[p].token),
      updatedAt: map[p]?.updatedAt || null,
    }));
    res.json(accounts);
  } catch (err) {
    console.error("[social] list accounts error:", err);
    res.status(500).json({ error: "Failed to list accounts" });
  }
});

// POST /api/social/accounts/:platform/connect
router.post("/accounts/:platform/connect", async (req, res) => {
  try {
    const platform = normalizePlatform(req.params.platform);
    if (!SUPPORTED_PLATFORMS.includes(platform)) {
      return res.status(400).json({ error: "Unsupported platform" });
    }
    const { accessToken, accessSecret, ...rest } = req.body || {};
    if (!accessToken) return res.status(400).json({ error: "accessToken is required" });

    const settings = JSON.stringify({
      ...(accessSecret ? { accessSecret } : {}),
      ...rest,
    });

    const tid = tenantId(req);
    const existing = await prisma.integration.findFirst({
      where: { tenantId: tid, provider: platform },
    });

    let integration;
    if (existing) {
      integration = await prisma.integration.update({
        where: { id: existing.id },
        data: { token: accessToken, isActive: true, settings },
      });
    } else {
      integration = await prisma.integration.create({
        data: {
          provider: platform,
          token: accessToken,
          isActive: true,
          settings,
          tenantId: tid,
        },
      });
    }
    res.json({ success: true, platform, connected: true, id: integration.id });
  } catch (err) {
    console.error("[social] connect account error:", err);
    res.status(500).json({ error: "Failed to connect account" });
  }
});

// DELETE /api/social/accounts/:platform
router.delete("/accounts/:platform", async (req, res) => {
  try {
    const platform = normalizePlatform(req.params.platform);
    if (!SUPPORTED_PLATFORMS.includes(platform)) {
      return res.status(400).json({ error: "Unsupported platform" });
    }
    const existing = await prisma.integration.findFirst({
      where: { tenantId: tenantId(req), provider: platform },
    });
    if (!existing) return res.json({ success: true, platform, connected: false });

    await prisma.integration.update({
      where: { id: existing.id },
      data: { isActive: false, token: null },
    });
    res.json({ success: true, platform, connected: false });
  } catch (err) {
    console.error("[social] disconnect account error:", err);
    res.status(500).json({ error: "Failed to disconnect account" });
  }
});

module.exports = router;
