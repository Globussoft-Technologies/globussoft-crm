import { beforeEach, describe, expect, test, vi } from 'vitest';
import { createRequire } from 'node:module';

import prisma from '../../lib/prisma.js';

prisma.pipeline = prisma.pipeline || {};
prisma.pipeline.findMany = vi.fn();
prisma.pipelineStage = prisma.pipelineStage || {};
prisma.pipelineStage.findMany = vi.fn();
prisma.pipelineStageAssignment = prisma.pipelineStageAssignment || {};
prisma.pipelineStageAssignment.findMany = vi.fn();
prisma.pipelineStageAssignment.createMany = vi.fn();

const requireCJS = createRequire(import.meta.url);
const { ensureGenericPipelineStageAssignments } = requireCJS('../../scripts/ensureGenericPipelineStageAssignments');

beforeEach(() => {
  prisma.pipeline.findMany.mockReset();
  prisma.pipelineStage.findMany.mockReset();
  prisma.pipelineStageAssignment.findMany.mockReset();
  prisma.pipelineStageAssignment.createMany.mockReset().mockResolvedValue({ count: 0 });
});

describe('ensureGenericPipelineStageAssignments', () => {
  test('queries Generic pipelines only', async () => {
    prisma.pipeline.findMany.mockResolvedValue([]);

    await expect(ensureGenericPipelineStageAssignments()).resolves.toEqual({
      pipelines: 0,
      assignmentsCreated: 0,
    });
    expect(prisma.pipeline.findMany).toHaveBeenCalledWith({
      where: { tenant: { vertical: 'generic' } },
      select: { id: true, tenantId: true },
    });
    expect(prisma.pipelineStage.findMany).not.toHaveBeenCalled();
  });

  test('backfills each unassigned legacy pipeline from only its own tenant stage library', async () => {
    prisma.pipeline.findMany.mockResolvedValue([
      { id: 11, tenantId: 1 },
      { id: 12, tenantId: 1 },
      { id: 21, tenantId: 2 },
    ]);
    // Pipeline 12 already has an explicit stage subset and must stay intact.
    prisma.pipelineStageAssignment.findMany.mockResolvedValue([{ pipelineId: 12 }]);
    prisma.pipelineStage.findMany.mockResolvedValue([
      { id: 101, tenantId: 1, position: 0 },
      { id: 102, tenantId: 1, position: 1 },
      { id: 201, tenantId: 2, position: 3 },
    ]);
    prisma.pipelineStageAssignment.createMany.mockResolvedValue({ count: 3 });

    await expect(ensureGenericPipelineStageAssignments()).resolves.toEqual({
      pipelines: 3,
      assignmentsCreated: 3,
    });
    expect(prisma.pipelineStage.findMany).toHaveBeenCalledWith({
      where: { tenantId: { in: [1, 2] } },
      select: { id: true, tenantId: true, position: true },
    });
    expect(prisma.pipelineStageAssignment.createMany).toHaveBeenCalledWith({
      data: [
        { pipelineId: 11, stageId: 101, tenantId: 1, position: 0 },
        { pipelineId: 11, stageId: 102, tenantId: 1, position: 1 },
        { pipelineId: 21, stageId: 201, tenantId: 2, position: 3 },
      ],
      skipDuplicates: true,
    });
  });

  test('does not modify pipelines that already have assignments', async () => {
    prisma.pipeline.findMany.mockResolvedValue([
      { id: 11, tenantId: 1 },
      { id: 12, tenantId: 1 },
    ]);
    prisma.pipelineStageAssignment.findMany.mockResolvedValue([
      { pipelineId: 11 },
      { pipelineId: 12 },
    ]);

    await expect(ensureGenericPipelineStageAssignments()).resolves.toEqual({
      pipelines: 2,
      assignmentsCreated: 0,
    });
    expect(prisma.pipelineStage.findMany).not.toHaveBeenCalled();
    expect(prisma.pipelineStageAssignment.createMany).not.toHaveBeenCalled();
  });
});
