const prisma = require('../lib/prisma');

/**
 * Backfill the reusable Generic CRM pipeline-stage relationship.
 *
 * This is intentionally limited to legacy PipelineStage.pipelineId rows on
 * Generic tenants. Tenant-wide stages with a null pipelineId are not assigned
 * to every pipeline because they do not identify a pipeline membership.
 * Existing stage IDs and positions are preserved.
 */
async function ensureGenericPipelineStageAssignments() {
  // Allows older generated clients to boot without affecting other CRM
  // functionality until the local Prisma client is regenerated.
  if (!prisma.pipelineStageAssignment) return null;

  const pipelines = await prisma.pipeline.findMany({
    where: { tenant: { vertical: 'generic' } },
    select: { id: true },
  });
  if (pipelines.length === 0) return { pipelines: 0, assignmentsCreated: 0, legacyRowsCleared: 0 };

  const pipelineIds = pipelines.map((pipeline) => pipeline.id);
  const legacyStages = await prisma.pipelineStage.findMany({
    where: { pipelineId: { in: pipelineIds } },
    select: { id: true, pipelineId: true, position: true },
  });

  if (legacyStages.length === 0) return { pipelines: pipelines.length, assignmentsCreated: 0, legacyRowsCleared: 0 };

  const existingAssignments = await prisma.pipelineStageAssignment.findMany({
    where: { pipelineId: { in: pipelineIds }, stageId: { in: legacyStages.map((stage) => stage.id) } },
    select: { pipelineId: true, stageId: true },
  });
  const existingKeys = new Set(existingAssignments.map((assignment) => `${assignment.pipelineId}:${assignment.stageId}`));
  const missingAssignments = legacyStages
    .filter((stage) => stage.pipelineId != null && !existingKeys.has(`${stage.pipelineId}:${stage.id}`))
    .map((stage) => ({ pipelineId: stage.pipelineId, stageId: stage.id, position: stage.position }));

  if (missingAssignments.length > 0) {
    await prisma.pipelineStageAssignment.createMany({ data: missingAssignments, skipDuplicates: true });
  }

  // Once the assignment exists, remove only the Generic legacy ownership so
  // deleting a pipeline cannot cascade-delete a shared stage entity.
  const cleared = await prisma.pipelineStage.updateMany({
    where: { pipelineId: { in: pipelineIds } },
    data: { pipelineId: null },
  });

  return {
    pipelines: pipelines.length,
    assignmentsCreated: missingAssignments.length,
    legacyRowsCleared: cleared.count,
  };
}

module.exports = { ensureGenericPipelineStageAssignments };
