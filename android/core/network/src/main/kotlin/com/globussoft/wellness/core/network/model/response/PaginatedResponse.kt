package com.globussoft.wellness.core.network.model.response

/**
 * Generic paginated wrapper used by list endpoints that support server-side
 * pagination (e.g. /api/wellness/patients, /api/wellness/visits).
 *
 * [data]  — the current page of records.
 * [total] — total number of matching records across all pages; used to
 *            determine whether more pages exist.
 */
data class PaginatedResponse<T>(
    val data: List<T>,
    val total: Int,
)
