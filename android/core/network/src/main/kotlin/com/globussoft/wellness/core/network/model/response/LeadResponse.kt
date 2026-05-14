package com.globussoft.wellness.core.network.model.response

/**
 * Lead / prospect record as returned by GET /api/wellness/telecaller/queue.
 *
 * The backend Contact model stores the name in different fields depending on
 * how the contact was captured; both [contactName] (CRM contact field) and
 * [name] (generic contact field) are surfaced here and the mapper resolves
 * the correct value.
 *
 * [leadScore]        — AI-computed relevance score 0–100.
 * [nextFollowUp]     — ISO-8601 datetime for the next scheduled follow-up; null if
 *                      no follow-up is pending.
 * [status]           — pipeline stage label (e.g. "New", "Contacted", "Qualified").
 * [firstResponseAt]  — ISO-8601 timestamp of the first agent response; when non-null
 *                      the SLA is satisfied regardless of lead age.
 */
data class LeadResponse(
    val id: String,
    val contactName: String?,
    val name: String?,
    val phone: String,
    val leadScore: Int,
    val source: String?,
    val createdAt: String,
    val nextFollowUp: String?,
    val status: String?,
    val firstResponseAt: String? = null,
)
