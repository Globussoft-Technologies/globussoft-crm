/**
 * One-shot script to set a tenant's logo for PDF rendering.
 *
 * Usage (PowerShell):
 *   node backend/scripts/set-tenant-logo.js "C:\path\to\logo.png" "Enhanced Wellness"
 *
 * Args:
 *   1) absolute path to the source image file (png/jpg/webp/svg)
 *   2) tenant name OR slug to match (case-insensitive, exact match)
 *
 * What it does:
 *   - Copies the file to backend/uploads/branding/tenant-<id>/logo.<ext>
 *   - Updates tenant.logoUrl to /uploads/branding/tenant-<id>/logo.<ext>
 *   - The next /api/wellness/patients/:id/summary.pdf call picks it up.
 *     (PM2 restart only needed if the module-level logo cache already
 *     served the previous file in the same process.)
 */

const fs = require("fs");
const path = require("path");
const { PrismaClient } = require("@prisma/client");

async function main() {
  const [srcPath, tenantQuery] = process.argv.slice(2);
  if (!srcPath || !tenantQuery) {
    console.error("Usage: node set-tenant-logo.js <image-path> <tenant-name-or-slug>");
    process.exit(1);
  }
  if (!fs.existsSync(srcPath)) {
    console.error(`Source file not found: ${srcPath}`);
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    const tenant = await prisma.tenant.findFirst({
      where: {
        OR: [
          { name: { equals: tenantQuery } },
          { slug: { equals: tenantQuery } },
        ],
      },
      select: { id: true, name: true, slug: true, logoUrl: true },
    });
    if (!tenant) {
      console.error(`No tenant matched "${tenantQuery}". Try the exact tenant name or slug.`);
      process.exit(1);
    }

    const ext = (path.extname(srcPath) || ".png").toLowerCase();
    const destDir = path.join(__dirname, "..", "uploads", "branding", `tenant-${tenant.id}`);
    fs.mkdirSync(destDir, { recursive: true });
    const destPath = path.join(destDir, `logo${ext}`);
    fs.copyFileSync(srcPath, destPath);

    const logoUrl = `/uploads/branding/tenant-${tenant.id}/logo${ext}`;
    await prisma.tenant.update({
      where: { id: tenant.id },
      data: { logoUrl },
    });

    console.log(`OK — tenant ${tenant.id} (${tenant.name}) logoUrl set to ${logoUrl}`);
    console.log(`File copied to ${destPath}`);
    console.log("Restart the backend (pm2 restart globussoft-crm-backend) to invalidate the logo cache, then re-download the PDF.");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
