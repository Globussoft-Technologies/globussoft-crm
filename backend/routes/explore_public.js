const express = require("express");
const prisma = require("../lib/prisma");
const pexelsProvider = require("../services/imageProviders/pexelsProvider");

const router = express.Router();

// Public, read-only data contract used only by the /explore marketing page.
router.get("/", async (_req, res) => {
  try {
    const tenant = await prisma.tenant.findFirst({ where: { vertical: "travel", isActive: true }, orderBy: { id: "asc" }, select: { id: true, slug: true } });
    if (!tenant) return res.json({ trips: [], catalogue: [] });
    const [tripRows, catalogue, files, explorePage] = await Promise.all([
      prisma.landingPage.findMany({
        where: { tenantId: tenant.id, status: "PUBLISHED", tripId: { not: null } },
        orderBy: { publishedAt: "desc" },
        take: 12,
        select: { id: true, title: true, content: true, trip: { select: { id: true, destination: true, tripCode: true, departDate: true, returnDate: true, status: true } } },
      }),
      prisma.tmcTripCatalogue.findMany({
        where: { tenantId: tenant.id, status: "active" },
        orderBy: { updatedAt: "desc" },
        take: 12,
        select: { id: true, tripId: true, title: true, tagline: true, tier: true, region: true, durationDays: true, imageUrl: true },
      }),
      prisma.travelKnowledgeBaseFile.findMany({ where: { tenantId: tenant.id, status: "active", mimeType: { contains: "pdf" } }, orderBy: { indexedAt: "desc" }, take: 48, select: { id: true, driveFileId: true, fileName: true, driveViewLink: true, folderPath: true, fileSize: true, indexedAt: true } }),
      prisma.landingPage.findFirst({
        where: {
          tenantId: tenant.id,
          tripId: null,
          OR: [
            { title: { contains: "Explore" } },
            { title: { contains: "Pre-Trip Marketing" } },
          ],
        },
        orderBy: { updatedAt: "desc" },
        select: { content: true },
      }),
    ]);
    const trips = tripRows.map((trip) => {
      let content = trip.content;
      if (typeof content === "string") { try { content = JSON.parse(content); } catch (_error) { content = {}; } }
      const imageUrl = content?.hero?.image?.src || content?.hero?.imageUrl || content?.hero?.image || content?.destinationHero?.image?.src || null;
      return { id: trip.trip?.id || trip.id, publicPageId: trip.id, name: trip.title || trip.trip?.destination || trip.trip?.tripCode, destination: trip.trip?.destination, departDate: trip.trip?.departDate, returnDate: trip.trip?.returnDate, status: trip.trip?.status, imageUrl };
    });
    const usedImageUrls = new Set();
    const filesWithImages = [];
    for (const file of files) {
      const query = file.fileName.replace(/\.pdf$/i, "").replace(/[_()0-9-]+/g, " ").replace(/\s+/g, " ").trim();
      const lowerQuery = query.toLowerCase();
      const context = /betta|durga|skandagiri|nagarhole|coorg/.test(lowerQuery)
        ? "Karnataka India trekking hill trail landscape"
        : /pondicherry|pondicherry|mamallapuram/.test(lowerQuery)
          ? "India coastal beach heritage travel"
          : "India landmark travel destination";
      const images = await pexelsProvider.search(`${query} ${context}`, { perPage: 5 });
      const image = images.find((candidate) => candidate.url && !usedImageUrls.has(candidate.url)) || images[0];
      if (image?.url) usedImageUrls.add(image.url);
      filesWithImages.push({ ...file, imageUrl: image?.url || null, thumbnailUrl: image?.thumbUrl || null });
    }
    let exploreConfig = null;
    if (explorePage?.content) {
      try {
        const content = typeof explorePage.content === "string" ? JSON.parse(explorePage.content) : explorePage.content;
        exploreConfig = content?.exploreConfig || null;
      } catch (_error) {
        exploreConfig = null;
      }
    }
    return res.json({ trips, catalogue, files: filesWithImages, tenantSlug: tenant.slug, exploreConfig });
  } catch (error) {
    console.error("[ExplorePublic] failed to load marketing data:", error);
    return res.status(500).json({ error: "Explore data is temporarily unavailable", code: "EXPLORE_DATA_UNAVAILABLE" });
  }
});

module.exports = router;
