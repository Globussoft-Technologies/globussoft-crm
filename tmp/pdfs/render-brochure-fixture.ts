import path from 'node:path';
import { buildBrochureHtml, getTemplate } from '../../agentic-orchcrm/packages/tools/src/brochure/index.ts';
import { auditPrintLayout, renderHtmlToArtifact } from '../../agentic-orchcrm/packages/tools/src/render.ts';

function art(label: string, a: string, b: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="1200" height="900" fill="url(#g)"/><circle cx="920" cy="170" r="120" fill="white" opacity=".2"/><path d="M0 720 Q260 470 510 690 T1200 540 V900 H0Z" fill="white" opacity=".22"/><text x="70" y="790" fill="white" font-size="74" font-family="Arial" font-weight="700">${label}</text></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

const photos = [
  art('GOA COAST', '#063B5C', '#18A6B8'), art('HERITAGE', '#8B3F2B', '#E29A43'),
  art('DISCOVERY', '#1A6B62', '#7CC29A'), art('LEARNING', '#243B6B', '#657FC2'),
  art('DAY 1-2', '#154C79', '#43A4C2'), art('DAY 3-4', '#80452C', '#E5A34E'),
  art('DAY 5-6', '#285C42', '#79AE66'), art('DAY 7-8', '#553A78', '#B17BC1'),
  art('TRAVEL READY', '#164E63', '#4CB7A5'), art('INCLUDED', '#1D4E89', '#62A8D8'),
  art('YOUR JOURNEY', '#7A302B', '#F08B4C'), art('MEMORIES', '#3E477A', '#8F91C8'),
];
const tmcLogo = art('TMC', '#08A8D4', '#0E7FA6');
const schoolLogo = art('SCHOOL', '#C62828', '#FF8A65');

const content: any = {
  title: 'Goa: Coast, Culture & Conservation',
  subtitle: 'An eight-day educational experience beyond the classroom',
  tagline: 'TRAVEL. EXPERIENCE. LEARN.',
  heroQuery: 'Goa coast India',
  intro: { heading: 'Why this journey', body: 'A carefully designed learning journey connecting coastal ecology, heritage, local enterprise and responsible travel through guided field experiences.' },
  highlights: { cards: [
    { label: 'Coastal ecology', caption: 'Field-led discovery' }, { label: 'Heritage trails', caption: 'History in context' },
    { label: 'Local enterprise', caption: 'People and place' }, { label: 'Reflective learning', caption: 'Daily takeaways' },
  ] },
  route: { heading: 'The Goa Learning Circuit', cities: [] },
  inclusions: { items: ['Accommodation in selected hotels', 'Daily breakfast and dinner', 'Airport and intercity transfers', 'Guided educational visits', 'Travel insurance', 'Entrance fees listed in the itinerary'] },
  exclusions: { items: ['Personal expenses', 'Optional activities', 'Meals not listed', 'Costs caused by personal schedule changes'] },
  footer: { cta: 'Reserve your place and begin the learning journey.' },
  tmc: {
    schoolName: 'Anonymous Lead School', tripTitle: 'Goa: Coast, Culture & Conservation',
    educationalSubtitle: 'Learning through ecology, heritage and responsible travel',
    tripDates: '25 August - 1 September 2026', duration: '8 days / 7 nights', targetGrades: 'Grades 9-12',
    tripSummary: 'An immersive educational journey through Goa.',
    educationalPurpose: 'Connect classroom learning with coastal ecosystems, cultural heritage and responsible tourism.',
    learningOutcomes: ['Observe coastal ecosystems', 'Interpret built heritage', 'Practise responsible travel', 'Strengthen collaboration'],
    routeCities: '', themeMode: 'manual', manualHexPalette: { primary: '#E9343F', secondary: '#122647', accent: '#19AFD9', background: '#FFF9F3', text: '#172033' },
    days: Array.from({ length: 8 }, (_, i) => ({ dayNumber: i + 1, date: `2026-08-${String(25 + i).padStart(2, '0')}`, route: i < 7 ? 'Goa learning circuit' : 'Goa - Airport', activities: i < 7 ? 'Guided field visit, facilitated observation and a structured reflection session.' : 'Closing reflection, programme review and airport transfer.', meals: { breakfast: true, lunch: i % 2 === 0, dinner: true }, overnightCity: i < 7 ? 'Goa' : 'Departure', learningTakeaway: 'Apply observation and teamwork in a real setting.' })),
    flights: { status: 'included', details: 'Return flights and airport transfers included.' },
    transport: 'Airport transfer to hotel in Goa. Airport transfer to hotel. Transfer to Goa airport. Return transfer to airport. Transfer back to the airport for departure. Transfer to hotel in South Goa. Transfer to hotel in North Goa.',
    hotels: [
      { name: 'Stay at a beachfront hotel', city: 'Goa, India', category: '', nights: 1 },
      { name: 'Check-out and transfer to South Goa', city: 'Goa, India', category: '', nights: 1 },
      { name: 'Stay at a beach resort in South Goa', city: 'Goa, India', category: '', nights: 1 },
      { name: 'Stay at beach resort in South Goa', city: 'Goa, India', category: '', nights: 2 },
      { name: 'Check-out from beach resort', city: 'Goa, India', category: '', nights: 1 },
      { name: 'Check-in at beach resort in South Goa', city: 'Goa, India', category: '', nights: 1 },
      { name: 'Check-in at beachfront hotel in North Goa', city: 'Goa, India', category: '', nights: 2 },
    ],
    roomSharing: 'Not specified', meals: 'Daily breakfast and dinner.', dietarySupport: 'Not specified',
    safety: ['Named tour manager', 'Verified transport partners', 'Emergency escalation protocol', 'Daily attendance checks'],
    documents: ['School consent form', 'Medical declaration', 'Government photo ID'],
    costStatus: [
      { label: 'Return airfare', status: 'included' }, { label: 'GST', status: 'included' },
      { label: 'Travel insurance', status: 'included' }, { label: 'Entrance fees', status: 'included' },
    ],
    price: { currency: 'INR', perPerson: 19299, basis: 'twin sharing', taxesIncluded: 'GST included', minGroup: 20 },
    deposit: { amount: 5000, dueDate: '30 June 2026' }, bookingDeadline: '30 June 2026', finalPaymentDate: '30 July 2026',
    cancellation: 'Cancellation terms apply according to the approved programme terms shared with the school.',
    contacts: { phone: '+91 90000 00000', email: 'travel@example.test', website: 'https://example.test' },
  },
};

async function main() {
  process.env.GENERATED_DIR = path.resolve('output/pdf');
  const html = await buildBrochureHtml(content, getTemplate('tmc-school'), {
    brand: { name: 'The Modern Classroom', logoUrl: tmcLogo, schoolLogoUrl: schoolLogo, schoolName: 'Anonymous Lead School', imagePool: photos, colors: { accent: '#E9343F' } },
  });
  const audit = await auditPrintLayout(html, { protectedLogoUrls: [tmcLogo, schoolLogo], minPages: 7, maxPages: 14 });
  if (!audit.ok) throw new Error(`Fixture preflight failed: ${audit.issues.join(', ')}`);
  console.log(JSON.stringify(audit));
  const badPages = Array.from({ length: 7 }, (_, index) =>
    `<section class="page"><h1>Page ${index + 1}</h1><p>This deliberately invalid page contains enough text for the sparse-page check.</p>${index === 0 ? `<img src="${schoolLogo}"><div style="height:1400px">Overflow</div>` : ''}</section>`,
  ).join('');
  const badHtml = `<!doctype html><html><head><style>@page{size:A4;margin:0}.page{width:210mm;height:297mm;overflow:hidden;break-after:page}.page img{width:500px;height:400px}</style></head><body>${badPages}</body></html>`;
  const badAudit = await auditPrintLayout(badHtml, { protectedLogoUrls: [schoolLogo], minPages: 7, maxPages: 14 });
  if (badAudit.ok || !badAudit.issues.some((issue) => issue.includes('clips_or_overflows')) || !badAudit.issues.includes('logo_used_as_hero_artwork')) {
    throw new Error(`Negative preflight fixture was not rejected correctly: ${badAudit.issues.join(', ')}`);
  }
  console.log(JSON.stringify({ negativeAuditIssues: badAudit.issues }));
  const result = await renderHtmlToArtifact(html, 'quality-qa', { basePrefix: 'travel-brochure', title: 'Travel brochure quality QA' });
  console.log(JSON.stringify(result));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
