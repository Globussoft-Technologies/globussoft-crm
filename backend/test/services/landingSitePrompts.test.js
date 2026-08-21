import { describe, it, expect } from 'vitest';
import {
  SECTORS,
  buildGenericLandingSitePrompt,
  buildWellnessLandingSitePrompt,
  buildWellnessRegistrationBlocks,
  isWellnessSector,
  normalizeSectorKey,
} from '../../services/landingSitePrompts.js';

describe('landingSitePrompts wellness sector', () => {
  it('treats wellness as a real sector key', () => {
    expect(SECTORS.wellness.label).toBe('Wellness');
    expect(normalizeSectorKey('wellness')).toBe('wellness');
    expect(isWellnessSector('wellness')).toBe(true);
  });

  it('buildGenericLandingSitePrompt keeps wellness mode and labels', () => {
    const prompt = buildGenericLandingSitePrompt({
      sectorKey: 'wellness',
      campaignName: 'Rooted Wellness Camp',
      campaignGoal: 'collect registrations',
      businessName: 'Rooted Wellness',
      audience: 'members',
      location: 'Pune',
      eventDate: '12 August 2026',
      eventTime: '10:00 AM',
      eventLocation: 'Main clinic',
      ctaText: 'Register Now',
    });

    expect(prompt.sectorKey).toBe('wellness');
    expect(prompt.sectorLabel).toBe('Wellness');
    expect(prompt.wellnessMode).toBe(true);
    expect(prompt.user).toContain('Sector: Wellness');
    expect(prompt.user).toContain('Event date: 12 August 2026');
    expect(prompt.system).toContain('editable structure');
    expect(prompt.system).toContain('Do not write vague filler');
  });


  it('buildWellnessLandingSitePrompt keeps the modal inputs in sync', () => {
    const prompt = buildWellnessLandingSitePrompt({
      sectorKey: 'wellness',
      campaignName: 'Hair Treatment Consultation',
      campaignGoal: 'collect enquiries',
      businessName: 'Glow Studio',
      audience: 'people exploring hair treatment options',
      location: 'Koramangala',
      eventDate: '12 August 2026',
      eventTime: '10:00 AM - 4:00 PM',
      eventLocation: 'Main clinic branch',
      tone: 'calm and professional',
      ctaText: 'Get Started',
      imageMode: 'auto',
    });

    expect(prompt.system).toContain('blood donation');
    expect(prompt.system).toContain('editable landing page');
    expect(prompt.user).toContain('Campaign name: Hair Treatment Consultation');
    expect(prompt.user).toContain('Hair Treatment Consultation');
    expect(prompt.user).toContain('Event date: 12 August 2026');
    expect(prompt.user).toContain('Event location: Main clinic branch');
    expect(prompt.user).toContain('Generate the wellness landing page content now.');

  });
  it('buildWellnessRegistrationBlocks stays campaign-specific and avoids donor-only copy', () => {
    const blocks = buildWellnessRegistrationBlocks({
      sectorKey: 'wellness',
      campaignName: 'Hair Treatment Consultation',
      businessName: 'Glow Studio',
      audience: 'people looking for hair treatments',
      eventLocation: 'Koramangala',
    });

    const body = JSON.stringify(blocks);
    expect(body).toContain('Hair Treatment Consultation');
    expect(body).toContain('Glow Studio');
    expect(body).toContain('people looking for hair treatments');
    expect(body).not.toContain('Blood Donation');
    expect(body).not.toContain('Donate Blood');
  });
});
