package com.globussoft.wellness.core.network.model.response

/**
 * Telecaller queue response as returned by GET /api/wellness/telecaller/queue.
 *
 * [leads] — list of leads currently in the telecaller queue.
 * [count] — total count of leads in the queue.
 */
data class TelecallerQueueResponse(
    val leads: List<LeadResponse>,
    val count: Int,
)
