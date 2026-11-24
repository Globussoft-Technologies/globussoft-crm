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
  ["tmcParentDocument", "parentContactId"],
  ["digilockerSession", "contactId"],
  ["webCheckin", "contactId"],
  ["travelTripReview", "contactId"],
  ["travelPortalNotification", "contactId"],
  ["visaApplication", "contactId"],
  ["travelInvoice", "contactId"],
  ["travelQuote", "contactId"],
  ["rfuLeadProfile", "contactId"],
];

// Bulk deletion removes rows from many dependent tables for every Contact.
// Prisma's default interactive-transaction timeout is 5 seconds, which is
// too short for a normal Leads page selection of 500 contacts.
const CONTACT_HARD_DELETE_TRANSACTION_OPTIONS = {
  maxWait: 15_000,
  timeout: 120_000,
};

function isMissingSchemaError(error) {
  return error?.code === "P2021" || error?.code === "P2022";
}

function isMissingOptionalFieldError(error, field) {
  return Boolean(
    field &&
      error?.name === "PrismaClientValidationError" &&
      String(error.message || "").includes(`Unknown argument \`${field}\``),
  );
}

async function optionalDeleteMany(operation, missingField = null) {
  try {
    return await operation();
  } catch (error) {
    // Keep deletion usable during a rolling deployment where an optional
    // travel/TMC table or column has not reached the database yet. The final
    // Contact delete is still transactional and all available child tables
    // are removed; unrelated database errors still abort the transaction.
    if (
      isMissingSchemaError(error) ||
      isMissingOptionalFieldError(error, missingField)
    ) return { count: 0 };
    throw error;
  }
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function jsonOrNull(value) {
  const empty = Array.isArray(value) ? value.length === 0 : Object.keys(value).length === 0;
  return empty ? null : JSON.stringify(value);
}

async function removeContactsFromAssignmentProfiles(tx, ids) {
  const removed = new Set(ids);
  const profiles = [
    { model: "transportPerson", statusField: "assignmentStatusJson" },
    { model: "plotBroker", statusField: "workflowStatusJson" },
    { model: "billingPerson", statusField: null },
  ];
  for (const { model, statusField } of profiles) {
    const delegate = tx[model];
    if (!delegate?.findMany || !delegate?.update) continue;
    try {
      const select = { id: true, customerIdsJson: true, assignmentPairsJson: true };
      if (statusField) select[statusField] = true;
      const rows = await delegate.findMany({
        where: { OR: ids.map((id) => ({ customerIdsJson: { contains: String(id) } })) },
        select,
      });
      for (const row of rows) {
        const previousIds = parseJson(row.customerIdsJson, []);
        const customerIds = previousIds.filter((id) => !removed.has(Number(id)));
        // The substring prefilter can also match part of a different ID.
        if (customerIds.length === previousIds.length) continue;
        const assignmentPairs = parseJson(row.assignmentPairsJson, [])
          .filter((pair) => !removed.has(Number(pair?.customerId)));
        const data = {
          customerIdsJson: jsonOrNull(customerIds),
          assignmentPairsJson: jsonOrNull(assignmentPairs),
        };
        if (statusField) {
          const statuses = parseJson(row[statusField], {});
          for (const key of Object.keys(statuses)) {
            const match = /^customer-(\d+)(?:$|-plot-)/.exec(key);
            if (match && removed.has(Number(match[1]))) {
              delete statuses[key];
            }
          }
          data[statusField] = jsonOrNull(statuses);
        }
        await delegate.update({ where: { id: row.id }, data });
      }
    } catch (error) {
      // These assignment fields are additive and may be absent briefly during
      // a rolling schema deployment. Keep Contact deletion available there.
      if (isMissingSchemaError(error) || isMissingOptionalFieldError(error, "assignmentPairsJson")) continue;
      throw error;
    }
  }
}

async function deleteContactsDependents(tx, ids) {
  const contactId = ids.length === 1 ? ids[0] : { in: ids };
  await removeContactsFromAssignmentProfiles(tx, ids);

  // Generic Web Form submissions are historical snapshots owned by the
  // form, not disposable Contact details. Detach them so the Generic CRM
  // form-leads popup can retain the submitted values and mark the row red
  // after its Lead is deleted. Other verticals retain the existing cleanup
  // policy. The schema relation is nullable/onDelete:SetNull; doing this
  // explicitly keeps the behavior deterministic before Contact deletion.
  if (tx.webFormSubmission?.updateMany && tx.webFormSubmission?.deleteMany) {
    await optionalDeleteMany(() => tx.webFormSubmission.updateMany({
      where: { contactId, scope: "generic" },
      data: { contactId: null },
    }));
    await optionalDeleteMany(() => tx.webFormSubmission.deleteMany({
      where: { contactId, scope: { not: "generic" } },
    }));
  }

  // TMC parent links have two required Contact foreign keys, so they need a
  // compound OR rather than the simple contactId loop below.
  // These delegates/fields may not exist yet when the app is running with a
  // Prisma client generated immediately before the optional TMC relations
  // were added. Skip only that unavailable cleanup; scalar schoolContactId
  // is not a Contact FK, so it does not block the final Contact delete.
  if (tx.tmcParentTrip?.deleteMany) {
    await optionalDeleteMany(() => tx.tmcParentTrip.deleteMany({
      where: {
        OR: [{ parentContactId: contactId }, { teacherContactId: contactId }],
      },
    }));
  }

  // TMC trips are operational records owned by the travel team, not by the
  // teacher account. Detach the teacher instead of deleting the trip.
  if (tx.tmcTrip?.updateMany) {
    await optionalDeleteMany(() => tx.tmcTrip.updateMany({
      where: { teacherContactId: contactId },
      data: { teacherContactId: null },
    }), "teacherContactId");
  }

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

  return db.$transaction(async (tx) => {
    await deleteContactsDependents(tx, ids);
    // Only return the count so older schemas can still delete during rollout.
    const { count } = await tx.contact.deleteMany({ where: { id: ids.length === 1 ? ids[0] : { in: ids } } });
    return count;
  }, CONTACT_HARD_DELETE_TRANSACTION_OPTIONS);
}

async function deleteContactDependents(tx, contactId) {
  await deleteContactsDependents(tx, [Number(contactId)]);
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
