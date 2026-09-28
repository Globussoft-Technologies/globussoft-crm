const prisma = require('../lib/prisma');

/**
 * Backfill the reusable Generic CRM pipeline-stage relationship after
 * `prisma db push` deployments, which do not execute SQL migration data steps.
 *
 * Before this feature, stages were tenant-wide. A Generic pipeline with no
 * assignments is therefore a legacy pipeline and receives the tenant's stage
 * library once. Pipelines that already have assignments are left untouched,
 * so intentionally selected stage subsets remain stable on later restarts.
 * Wellness and Travel pipelines are excluded by the tenant.vertical filter.
 */
async function ensureGenericPipelineStageAssignments() {
  // Allows older generated clients to boot without affecting other CRM
  // functionality until the local Prisma client is regenerated.
  if (!prisma.pipelineStageAssignment) return null;

  const pipelines = await prisma.pipeline.findMany({
    where: { tenant: { vertical: 'generic' } },
    select: { id: true, tenantId: true },
  });
  if (pipelines.length === 0) return { pipelines: 0, assignmentsCreated: 0 };

  const pipelineIds = pipelines.map((pipeline) => pipeline.id);
  const existingAssignments = await prisma.pipelineStageAssignment.findMany({
    where: { pipelineId: { in: pipelineIds } },
    select: { pipelineId: true },
  });
  const assignedPipelineIds = new Set(existingAssignments.map((assignment) => assignment.pipelineId));
  const legacyPipelines = pipelines.filter((pipeline) => !assignedPipelineIds.has(pipeline.id));
  if (legacyPipelines.length === 0) return { pipelines: pipelines.length, assignmentsCreated: 0 };

  const tenantIds = [...new Set(legacyPipelines.map((pipeline) => pipeline.tenantId))];
  const stages = await prisma.pipelineStage.findMany({
    where: { tenantId: { in: tenantIds } },
    select: { id: true, tenantId: true, position: true },
  });
  const stagesByTenant = new Map();
  for (const stage of stages) {
    const tenantStages = stagesByTenant.get(stage.tenantId) || [];
    tenantStages.push(stage);
    stagesByTenant.set(stage.tenantId, tenantStages);
  }
  const missingAssignments = legacyPipelines.flatMap((pipeline) =>
    (stagesByTenant.get(pipeline.tenantId) || []).map((stage) => ({
      pipelineId: pipeline.id,
      stageId: stage.id,
      tenantId: pipeline.tenantId,
      position: stage.position,
    })),
  );

  if (missingAssignments.length > 0) {
    await prisma.pipelineStageAssignment.createMany({ data: missingAssignments, skipDuplicates: true });
  }

  return {
    pipelines: pipelines.length,
    assignmentsCreated: missingAssignments.length,
  };
}

module.exports = { ensureGenericPipelineStageAssignments };
