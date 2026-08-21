import { describe, test, expect, vi } from 'vitest';
import zlib from 'node:zlib';
import prisma from '../../lib/prisma.js';
import visaLetterService from '../../lib/visaLetterService.js';

const { DEFAULT_LETTER_TEMPLATES, loadActiveTemplates, renderVisaLetterPdf } = visaLetterService;

function extractPdfText(buf) {
  const str = buf.toString('latin1');
  let allOps = '';
  const lenRe = /\/Length\s+(\d+)\b[^>]*>>\s*stream\r?\n/g;
  let m;
  while ((m = lenRe.exec(str)) !== null) {
    const len = parseInt(m[1], 10);
    const start = lenRe.lastIndex;
    const raw = buf.subarray(start, start + len);
    try {
      allOps += zlib.inflateSync(raw).toString('latin1');
    } catch {
      allOps += raw.toString('latin1');
    }
  }
  if (!allOps) {
    const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
    let s;
    while ((s = streamRe.exec(str)) !== null) {
      const raw = Buffer.from(s[1], 'latin1');
      try {
        allOps += zlib.inflateSync(raw).toString('latin1');
      } catch {
        allOps += raw.toString('latin1');
      }
    }
  }
  let out = '';
  const tjArrayRe = /\[([^\]]*)\]\s*TJ/g;
  let s;
  while ((s = tjArrayRe.exec(allOps)) !== null) {
    const inner = s[1];
    const hexRe = /<([0-9a-fA-F\s]+)>/g;
    let h;
    while ((h = hexRe.exec(inner)) !== null) {
      const hex = h[1].replace(/\s+/g, '');
      for (let i = 0; i + 1 < hex.length; i += 2) {
        out += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
      }
    }
    out += ' ';
  }
  const tjLiteralRe = /\(((?:[^()\\]|\\.)*)\)\s*Tj/g;
  while ((s = tjLiteralRe.exec(allOps)) !== null) {
    out += s[1].replace(/\\(.)/g, '$1') + ' ';
  }
  return out;
}

const sampleData = {
  today_date: '10/08/2026',
  consulate_name: 'Consulate General of Vietnam',
  consulate_city: 'Bengaluru, India',
  father_name: 'Konica',
  mother_name: '..............................',
  child_name: 'Monica',
  passport_no: 'Z1234567',
  destination_country: 'Vietnam',
  travel_start_date: '01/11/2026',
  travel_end_date: '07/11/2026',
  guardian_phone: '+91 8795462130',
  guardian_email: 'konica@getairmail.com',
  organizer_name: 'DPS',
};

function expectFormalLetter(text, snippets) {
  for (const snippet of snippets) {
    expect(text).toContain(snippet);
  }
}

describe('renderVisaLetterPdf', () => {
  test('renders a formal parental consent letter with a blank second parent name when only one parent exists', async () => {
    const template = DEFAULT_LETTER_TEMPLATES.find((row) => row.code === 'parental-consent-letter');
    const buf = await renderVisaLetterPdf({ template, data: sampleData });
    const text = extractPdfText(buf).replace(/\s+/g, ' ').trim();

    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.slice(0, 4).toString()).toBe('%PDF');
    expectFormalLetter(text, [
      'PARENTAL CONSENT LETTER',
      'Date: 10/08/2026',
      'To, The Visa Officer Consulate General of Vietnam Bengaluru, India',
      'Subject: Consent for travel of Monica',
      'Dear Sir/Madam,',
      'We, Konica and .............................., parents or legal guardians of Monica, holder of passport number Z1234567, give our consent for the child to travel to Vietnam from 01/11/2026 to 07/11/2026.',
      'We kindly request you to consider this consent letter in support of the visa application.',
      'Thank you for your time and consideration.',
      'Sincerely,',
      'Konica',
      'Parent / Legal Guardian',
      '+91 8795462130',
      'konica@getairmail.com',
    ]);
  });

  test('renders a formal cover letter with the same letterhead and footer treatment', async () => {
    const template = DEFAULT_LETTER_TEMPLATES.find((row) => row.code === 'cover-letter');
    const buf = await renderVisaLetterPdf({ template, data: sampleData });
    const text = extractPdfText(buf).replace(/\s+/g, ' ').trim();

    expectFormalLetter(text, [
      'COVER LETTER',
      'Subject: Visa application for Monica',
      'Dear Sir/Madam,',
      'This letter supports the visa application of Monica, passport number Z1234567, for travel to Vietnam from 01/11/2026 to 07/11/2026.',
      'The trip is coordinated by DPS. The applicant will return after the scheduled travel period and will comply with all visa conditions.',
      'Kindly consider the application and supporting documents.',
      'Thank you for your time and consideration.',
      'Sincerely,',
      'Authorized Signatory',
    ]);
  });

  test('renders a formal no objection certificate with the same layout', async () => {
    const template = DEFAULT_LETTER_TEMPLATES.find((row) => row.code === 'no-objection-certificate');
    const buf = await renderVisaLetterPdf({ template, data: sampleData });
    const text = extractPdfText(buf).replace(/\s+/g, ' ').trim();

    expectFormalLetter(text, [
      'NO OBJECTION CERTIFICATE',
      'Subject: No objection for travel of Monica',
      'Dear Sir/Madam,',
      'This is to certify that Monica, passport number Z1234567, is associated with DPS and has no objection from the institution or organizer to travel to Vietnam from 01/11/2026 to 07/11/2026.',
      'The applicant is expected to return after completion of the trip and resume regular commitments.',
      'We kindly request you to consider this certificate in support of the visa application.',
      'Thank you for your time and consideration.',
      'Sincerely,',
      'Designation and seal',
    ]);
  });

  test('renders a formal sponsorship letter with the same styling language', async () => {
    const template = DEFAULT_LETTER_TEMPLATES.find((row) => row.code === 'sponsorship-letter');
    const buf = await renderVisaLetterPdf({ template, data: sampleData });
    const text = extractPdfText(buf).replace(/\s+/g, ' ').trim();

    expectFormalLetter(text, [
      'SPONSORSHIP LETTER',
      'Subject: Sponsorship for travel of Monica',
      'Dear Sir/Madam,',
      'I, Konica, confirm that I will sponsor Monica, passport number Z1234567, for travel to Vietnam from 01/11/2026 to 07/11/2026.',
      'I undertake responsibility for the applicant\'s travel, accommodation, meals, insurance, local transport, and any other reasonable expenses during the trip.',
      'We kindly request you to consider this sponsorship letter in support of the visa application.',
      'Thank you for your time and consideration.',
      'Sincerely,',
      'Sponsor',
      '+91 8795462130',
      'konica@getairmail.com',
    ]);
  });
});

describe('loadActiveTemplates', () => {
  test('creates the newer default template version when the tenant still has the older seeded rows', async () => {
    const oldRows = DEFAULT_LETTER_TEMPLATES.map((template, index) => ({
      id: index + 1,
      tenantId: 1,
      code: template.code,
      name: template.name,
      documentType: template.documentType,
      version: 1,
      contentHtml: '<h1>Legacy</h1>',
      requiredFieldsJson: '[]',
      isActive: true,
    }));
    const newRows = DEFAULT_LETTER_TEMPLATES.map((template, index) => ({
      id: index + 11,
      tenantId: 1,
      code: template.code,
      name: template.name,
      documentType: template.documentType,
      version: 2,
      contentHtml: template.contentHtml,
      requiredFieldsJson: JSON.stringify(template.requiredFields),
      isActive: true,
    }));

    prisma.visaLetterTemplate = prisma.visaLetterTemplate || {};
    prisma.visaLetterTemplate.findMany = vi
      .fn()
      .mockResolvedValueOnce(oldRows)
      .mockResolvedValueOnce(newRows);
    prisma.visaLetterTemplate.create = vi.fn().mockResolvedValue(null);

    const templates = await loadActiveTemplates(prisma, 1, 99);

    expect(prisma.visaLetterTemplate.create).toHaveBeenCalledTimes(4);
    expect(prisma.visaLetterTemplate.create.mock.calls.map((call) => call[0].data.version)).toEqual([2, 2, 2, 2]);
    expect(templates).toHaveLength(4);
    expect(templates.every((template) => template.version === 2)).toBe(true);
    expect(templates.map((template) => template.code)).toEqual([
      'parental-consent-letter',
      'cover-letter',
      'no-objection-certificate',
      'sponsorship-letter',
    ]);
  });
});
