const PDFDocument = require('pdfkit');

function cleanText(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text || fallback;
}

function slugifyPacketName(value) {
  const raw = cleanText(value, 'packet').toLowerCase();
  const slug = raw.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'packet';
}

function uniqueTextList(values) {
  const seen = new Set();
  const out = [];
  for (const value of values || []) {
    const text = cleanText(value);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function pad2(num) {
  return String(num).padStart(2, '0');
}

function formatDate(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return `${pad2(date.getDate())}/${pad2(date.getMonth() + 1)}/${date.getFullYear()}`;
}

function formatDateRange(start, end) {
  const left = formatDate(start);
  const right = formatDate(end);
  if (left && right) return `${left} to ${right}`;
  return left || right || '';
}

function guardianNames(context) {
  const names = uniqueTextList([
    context.guardianOneName,
    context.guardianTwoName,
    context.contactName,
    context.participantParentName,
  ]);
  return names.length ? names : ['Parent / Guardian'];
}

function guardianDisplay(context) {
  const names = guardianNames(context);
  if (names.length >= 2) return `${names[0]} and ${names[1]}`;
  return names[0];
}

function schoolName(context) {
  return cleanText(
    context.schoolName || context.schoolContactName || context.schoolContactCompany || context.tripName || 'the school',
  );
}

function destinationName(context) {
  return cleanText(context.destinationCountry || context.tripDestination || 'the destination');
}

function childName(context) {
  return cleanText(context.participantName || context.applicantName || context.contactName || 'the child');
}

function passportNumber(context) {
  return cleanText(context.passportNumber || 'N/A');
}

function contactLine(context) {
  const parts = [];
  if (context.contactPhone) parts.push(context.contactPhone);
  if (context.contactEmail) parts.push(context.contactEmail);
  return parts.join(' or ');
}

function startPdfBuffer(draw) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    try {
      draw(doc);
      doc.end();
    } catch (err) {
      reject(err);
      try {
        doc.end();
      } catch (_e) {
        /* ignore */
      }
    }
  });
}

function writeHeader(doc, context, subject) {
  doc.font('Helvetica').fontSize(11).fillColor('#111111').text(`Date: ${context.issueDate}`, { align: 'right' });
  doc.moveDown(0.7);
  doc.font('Helvetica-Bold').fontSize(11).text('To');
  doc.font('Helvetica').text('The Visa Officer');
  doc.text(context.consulateLine);
  doc.moveDown(0.35);
  doc.font('Helvetica-Bold').fontSize(12).text(`Subject: ${subject}`);
  doc.moveDown(0.75);
}

function writeParagraph(doc, text) {
  doc.font('Helvetica').fontSize(11).fillColor('#111111').text(text, { width: 495, lineGap: 4 });
  doc.moveDown(0.35);
}

function writeBullets(doc, items) {
  for (const item of items || []) {
    doc.font('Helvetica').fontSize(11).fillColor('#111111').text(`- ${item}`, { width: 495, lineGap: 4 });
    doc.moveDown(0.1);
  }
  doc.moveDown(0.3);
}

function writeSignatureBlock(doc, context, labels) {
  const names = guardianNames(context);
  doc.moveDown(0.8);
  doc.font('Helvetica-Bold').fontSize(11).text('Yours faithfully,');
  doc.moveDown(0.6);

  const finalLabels = Array.isArray(labels) && labels.length ? labels : names.map(() => 'Signature');
  names.forEach((name, index) => {
    const label = finalLabels[index] || 'Signature';
    doc.font('Helvetica').fontSize(11).text(name);
    doc.text(label);
    if (index < names.length - 1) doc.moveDown(0.2);
  });
}

function buildConsentLetter(context) {
  const names = guardianDisplay(context);
  const student = childName(context);
  const tripDates = formatDateRange(context.tripStartDate, context.tripReturnDate) || 'the trip dates';
  const paragraphs = [
    `We, ${names}, being the lawful parents/legal guardians of ${student}, holder of Indian Passport Number ${passportNumber(context)}, hereby provide our unconditional consent for our child to travel to ${destinationName(context)} with the school group from ${tripDates}.`,
    'We authorize the school authorities and accompanying teachers to supervise our child throughout the visit.',
    'We further confirm that our child shall return to India immediately after completion of the tour.',
  ];
  if (contactLine(context)) {
    paragraphs.push(`For further clarification please contact us on ${contactLine(context)}.`);
  }
  return {
    title: 'PARENTAL CONSENT LETTER',
    subject: 'PARENTAL CONSENT LETTER',
    paragraphs,
    signoffLabels: guardianNames(context).map(() => 'Signature'),
  };
}

function buildCoverLetter(context) {
  const names = guardianDisplay(context);
  const student = childName(context);
  const tripDates = formatDateRange(context.tripStartDate, context.tripReturnDate) || 'the trip dates';
  return {
    title: 'Cover Letter for Student Visa Application (Tourism / Educational Tour)',
    subject: 'Cover Letter for Student Visa Application (Tourism / Educational Tour)',
    paragraphs: [
      `We, ${names}, parents of ${student}, holder of Indian Passport No. ${passportNumber(context)}, respectfully submit this letter in support of our child's Temporary Visitor Visa application for ${destinationName(context)}.`,
      `Our child is traveling to ${destinationName(context)} on a trip organized by ${schoolName(context)} from ${tripDates}.`,
      'The visit aims to provide students with international exposure through educational, cultural, and sightseeing activities conducted under the supervision of the school\'s teachers and coordinators.',
      'We confirm that we fully support our child\'s participation in this educational tour and have no objection to the travel.',
      'All expenses relating to the visit, including airfare, accommodation, meals, transportation, travel insurance, visa fees and other incidental expenses, will be borne by us.',
      'Our child will return to India immediately after completion of the tour and continue his or her education.',
      'Kindly consider the visa application favorably.',
    ],
    signoffLabels: guardianNames(context).map(() => 'Signature'),
  };
}

function buildNoObjectionLetter(context) {
  const names = guardianDisplay(context);
  const student = childName(context);
  const tripDates = formatDateRange(context.tripStartDate, context.tripReturnDate) || 'the trip dates';
  const signers = guardianNames(context);
  return {
    title: 'No Objection Certificate',
    subject: 'No Objection Certificate',
    paragraphs: [
      `We, ${names}, parents of ${student}, holder of Indian Passport No. ${passportNumber(context)}, hereby confirm that we have no objection to our child travelling to ${destinationName(context)} with the official school group from ${tripDates}.`,
      `We authorize our child to participate in the educational tour organized by ${schoolName(context)} under the supervision of the designated teachers and coordinators.`,
      `We further authorize the Consulate General of ${destinationName(context)} to process our child's visa application.`,
    ],
    signoffLabels: signers.length >= 2 ? ['Father\'s Signature', 'Mother\'s Signature'] : ['Signature'],
  };
}

function buildSponsorshipLetter(context) {
  const names = guardianDisplay(context);
  const student = childName(context);
  const tripDates = formatDateRange(context.tripStartDate, context.tripReturnDate) || 'the trip dates';
  const signers = guardianNames(context);
  return {
    title: 'Sponsorship Letter',
    subject: 'Sponsorship Letter',
    paragraphsBeforeBullets: [
      `We, ${names}, parents of ${student}, holder of Indian Passport No. ${passportNumber(context)}, hereby confirm that we shall sponsor our child's educational visit to ${destinationName(context)} from ${tripDates}.`,
      'We undertake full financial responsibility for the trip, including:',
    ],
    bulletItems: [
      'Return airfare',
      'Accommodation',
      'Meals',
      'Local transportation',
      'Travel insurance',
      'Visa fees',
      'Personal expenses',
      'Any unforeseen expenses during the visit',
    ],
    paragraphsAfterBullets: [
      'Supporting financial documents including our bank statements, Income Tax Returns and employment/business documents are enclosed.',
      'We respectfully request you to grant our child a Temporary Visitor Visa.',
    ],
    signoffLabels: signers.length >= 2 ? ['Father\'s Signature', 'Mother\'s Signature'] : ['Signature'],
  };
}

function buildContext({ application, contact, trip, participant, schoolContact, passportIdentity }) {
  const contactName = cleanText(contact && contact.name);
  const contactEmail = cleanText(contact && contact.email);
  const contactPhone = cleanText(contact && contact.phone);
  const participantName = cleanText(participant && participant.fullName);
  const participantParentName = cleanText(participant && participant.parentName);
  const participantParentEmail = cleanText(participant && participant.parentEmail);
  const participantParentPhone = cleanText(participant && participant.parentPhone);
  const schoolContactName = cleanText(schoolContact && schoolContact.name);
  const schoolContactCompany = cleanText(schoolContact && schoolContact.company);

  return {
    issueDate: formatDate(new Date()),
    consulateLine: `Consulate General of ${destinationName({ destinationCountry: application && application.destinationCountry })} Bengaluru, India`,
    contactName,
    contactEmail,
    contactPhone,
    guardianOneName: contactName || participantParentName,
    guardianTwoName: participantParentName && participantParentName !== contactName ? participantParentName : '',
    participantName,
    participantParentName,
    participantParentEmail,
    participantParentPhone,
    applicantName: contactName,
    destinationCountry: application && application.destinationCountry,
    tripName: trip && trip.tripCode,
    tripDestination: trip && trip.destination,
    tripStartDate: trip && trip.departDate,
    tripReturnDate: trip && trip.returnDate,
    schoolName: schoolContactCompany || schoolContactName,
    schoolContactName,
    schoolContactCompany,
    passportNumber: cleanText(
      (participant && participant.passportNumber) ||
        (passportIdentity && passportIdentity.passportNumber) ||
        '',
    ),
  };
}

function buildPacketSpecs(context) {
  const slug = slugifyPacketName(context.tripName || context.destinationCountry);
  return [
    {
      docType: 'Consent Letter',
      fileName: `consent-letter-${slug}.pdf`,
      template: buildConsentLetter(context),
    },
    {
      docType: 'Cover Letter',
      fileName: `cover-letter-${slug}.pdf`,
      template: buildCoverLetter(context),
    },
    {
      docType: 'No Objection Certificate',
      fileName: `noc-${slug}.pdf`,
      template: buildNoObjectionLetter(context),
    },
    {
      docType: 'Sponsorship Letter',
      fileName: `sponsorship-letter-${slug}.pdf`,
      template: buildSponsorshipLetter(context),
    },
  ];
}

function renderTemplate(doc, context, template) {
  writeHeader(doc, context, template.title);

  for (const paragraph of template.paragraphs || []) {
    writeParagraph(doc, paragraph);
  }

  if (Array.isArray(template.paragraphsBeforeBullets)) {
    for (const paragraph of template.paragraphsBeforeBullets) {
      writeParagraph(doc, paragraph);
    }
  }

  if (Array.isArray(template.bulletItems) && template.bulletItems.length) {
    writeBullets(doc, template.bulletItems);
  }

  if (Array.isArray(template.paragraphsAfterBullets)) {
    for (const paragraph of template.paragraphsAfterBullets) {
      writeParagraph(doc, paragraph);
    }
  }

  writeSignatureBlock(doc, context, template.signoffLabels);
}

async function buildVisaLetterPackets(input) {
  const context = buildContext(input);
  const packets = [];
  for (const spec of buildPacketSpecs(context)) {
    const buffer = await startPdfBuffer((doc) => {
      renderTemplate(doc, context, spec.template);
    });
    packets.push({
      docType: spec.docType,
      fileName: spec.fileName,
      buffer,
      context,
    });
  }
  return packets;
}

module.exports = {
  buildVisaLetterPackets,
  buildContext,
  formatDate,
  formatDateRange,
  cleanText,
};
