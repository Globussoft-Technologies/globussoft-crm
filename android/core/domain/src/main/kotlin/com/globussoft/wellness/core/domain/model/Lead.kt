package com.globussoft.wellness.core.domain.model

/**
 * A sales lead / prospect record.
 *
 * [leadScore]    — AI-computed score 0-100; higher = warmer.
 * [nextFollowUp] — ISO-8601 datetime for the scheduled follow-up call;
 *                  null if no follow-up is scheduled.
 * [status]       — free-text pipeline stage label (e.g. "New", "Contacted",
 *                  "Qualified", "Lost").
 */
data class Lead(
    val id: String,
    val contactName: String,
    val phone: String,
    val leadScore: Int,
    val source: String?,
    val createdAt: String,
    val nextFollowUp: String?,
    val status: String?,
)
