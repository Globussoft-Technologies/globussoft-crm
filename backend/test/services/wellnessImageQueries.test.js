import { describe, expect, test } from 'vitest';
import { createRequire } from 'node:module';

const requireCjs = createRequire(import.meta.url);
const queries = requireCjs('../../services/wellnessImageQueries.js');

describe('wellness image query planning', () => {
  test('prioritizes the actual hair-loss treatment subject', () => {
    const plan = queries.buildWellnessImagePlan({
      campaignName: 'Hair Treatment Consultation',
      campaignGoal: 'book consultations',
      audience: 'people exploring hair loss options',
      sectorLabel: 'Wellness',
    });

    expect(plan.subject).toBe('hair loss scalp treatment');
    expect(plan.queries.hero).toContain('hair loss scalp treatment');
    expect(plan.relevanceTerms).toEqual(expect.arrayContaining(['hair', 'scalp']));
  });

  test('uses a different clinical subject for an eye campaign', () => {
    const plan = queries.buildWellnessImagePlan({
      campaignName: 'Community Eye Checkup',
      audience: 'people with vision concerns',
    });

    expect(plan.subject).toBe('eye examination vision screening');
    expect(plan.queries['gallery-image-2']).toContain('eye examination vision screening');
  });

  test('maps image slots to distinct campaign-specific search intent', () => {
    const plan = queries.buildWellnessImagePlan({ campaignName: 'Acne Skin Consultation' });

    expect(queries.queryForWellnessImageSlot(plan, 'hero-image')).toContain('skin care dermatology');
    expect(queries.queryForWellnessImageSlot(plan, 'gallery-image-1')).toContain('symptoms concerns');
    expect(queries.queryForWellnessImageSlot(plan, 'cta-image')).toContain('personalized care');
  });
});
