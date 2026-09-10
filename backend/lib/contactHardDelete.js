/**
 * Permanently remove a Contact and the records that are owned by that
 * Contact. The Contact table has accumulated a mixture of real Prisma
 * relations and legacy scalar contactId links, so relying on a single
 * prisma.contact.delete() would leave portal/travel/CRM detail rows behind
 * (and would fail on the intentional Restrict relations such as Invoice and
 * TravelQuote).
 *
 * AuditLog is deliberately not deleted here. It is a generic entity log with
 * no Contact foreign key and must remain available for operator/security
 * auditing without retaining the deleted contact's profile fields.
 */

const CONTACT_ID_CHILDREN = [
  ["leadCustomFieldValue", "contactId"],
  ["webFormSubmission", "contactId"],
  ["savedContactViewMember", "contactId"],
  ["activity", "contactId"],
  ["deal", "contactId"],
  ["workflowExecution", "contactId"],
  ["emailMessage", "contactId"],
  ["callLog", "contactId"],
  ["invoice", "contactId"],
  ["sequenceEnrollment", "contactId"],
  ["task", "contactId"],
  ["expense", "contactId"],
  ["contract", "contactId"],
  ["estimate", "contactId"],
  ["project", "contactId"],
  ["marketplaceLead", "contactId"],
  ["smsMessage", "contactId"],
  ["whatsAppMessage", "contactId"],
  ["whatsAppThread", "contactId"],
  ["pushSubscription", "contactId"],
  ["contactAttachment", "contactId"],
  ["calendarEvent", "contactId"],
  ["consentRecord", "contactId"],
  ["dataExportRequest", "contactId"],
  ["voiceSession", "contactId"],
  ["touchpoint", "contactId"],
  ["webVisitor", "contactId"],
  ["chatbotConversation", "contactId"],
  ["surveyResponse", "contactId"],
  ["surveyAnswer", "contactId"],
  ["booking", "contactId"],
  ["scheduledEmail", "contactId"],
  ["payment", "contactId"],
  ["socialMention", "contactId"],
  ["patient", "contactId"],
  ["travelDiagnostic", "contactId"],
  ["itinerary", "contactId"],
  ["customerTraveller", "contactId"],
  ["digilockerSession", "contactId"],
  ["webCheckin", "contactId"],
  ["travelTripReview", "contactId"],
  ["travelPortalNotification", "contactId"],
  ["visaApplication", "contactId"],
  ["travelInvoice", "contactId"],
  ["travelQuote", "contactId"],
  ["rfuLeadProfile", "contactId"],
];

function isMissingSchemaError(error) {
  return error?.code === "P2021" || error?.code === "P2022";
}

async function optionalDeleteMany(operation) {
  try {
    return await operation();
  } catch (error) {
    // Keep deletion usable during a rolling deployment where an optional
    // travel/TMC table or column has not reached the database yet. The final
    // Contact delete is still transactional and all available child tables
    // are removed; unrelated database errors still abort the transaction.
    if (isMissingSchemaError(error)) return { count: 0 };
    throw error;
  }
}

async function deleteContactDependents(tx, contactId) {
  // TMC parent links have two required Contact foreign keys, so they need a
  // compound OR rather than the simple contactId loop below.
  await optionalDeleteMany(() => tx.tmcParentTrip.deleteMany({
    where: {
      OR: [{ parentContactId: contactId }, { teacherContactId: contactId }],
    },
  }));

  // TMC trips are operational records owned by the travel team, not by the
  // teacher account. Detach the teacher instead of deleting the trip.
  await optionalDeleteMany(() => tx.tmcTrip.updateMany({
    where: { teacherContactId: contactId },
    data: { teacherContactId: null },
  }));

  // TravelInvoice must be removed before TravelQuote so its quote relation
  // and all invoice-owned line/schedule rows are gone first.
  const ordered = [
    ["travelInvoice", "contactId"],
    ...CONTACT_ID_CHILDREN.filter(([model]) => model !== "travelInvoice"),
  ];
  for (const [model, field] of ordered) {
    await optionalDeleteMany(() => tx[model].deleteMany({ where: { [field]: contactId } }));
  }
}

async function hardDeleteContacts(db, contactIds) {
  const ids = [...new Set((contactIds || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  if (ids.length === 0) return 0;

  let deletedCount = 0;
  await db.$transaction(async (tx) => {
    for (const contactId of ids) {
      await deleteContactDependents(tx, contactId);
      // deleteMany returns only a count and therefore does not ask Prisma to
      // select every Contact column after the delete. That keeps this cleanup
      // compatible with deployments where newer nullable Contact columns are
      // still waiting for their normal schema rollout.
      const result = await tx.contact.deleteMany({ where: { id: contactId } });
      deletedCount += result.count;
    }
  });

  return deletedCount;
}

async function hardDeleteContact(db, contactId) {
  return hardDeleteContacts(db, [contactId]);
}

module.exports = {
  CONTACT_ID_CHILDREN,
  deleteContactDependents,
  hardDeleteContact,
  hardDeleteContacts,
};
