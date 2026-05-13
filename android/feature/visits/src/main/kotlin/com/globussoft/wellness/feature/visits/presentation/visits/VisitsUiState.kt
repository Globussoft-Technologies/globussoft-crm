package com.globussoft.wellness.feature.visits.presentation.visits

import com.globussoft.wellness.core.domain.model.Visit

/**
 * Immutable UI state for the Visits log screen.
 *
 * Pagination follows the same append-on-scroll pattern used by the patients
 * list: [visits] accumulates pages, [totalCount] is the server total, and
 * [hasReachedEnd] gates the "Load more" button.
 */
data class VisitsUiState(
    val isLoading: Boolean = false,
    val visits: List<Visit> = emptyList(),
    val totalCount: Int = 0,
    val currentPage: Int = 0,
    /** ISO-8601 date string for the "from" filter; empty = no lower bound. */
    val fromDate: String = "",
    /** ISO-8601 date string for the "to" filter; empty = no upper bound. */
    val toDate: String = "",
    val error: String? = null,
) {
    companion object {
        const val PAGE_SIZE = 25
    }

    /** True when all pages have been fetched. */
    val hasReachedEnd: Boolean
        get() = visits.size >= totalCount && totalCount > 0
}

// ─── Events ───────────────────────────────────────────────────────────────────

sealed class VisitsEvent {
    data class FromDateChanged(val date: String) : VisitsEvent()
    data class ToDateChanged(val date: String) : VisitsEvent()
    data object ApplyFilter : VisitsEvent()
    data object ClearFilter : VisitsEvent()
    data object LoadNextPage : VisitsEvent()
    data object Refresh : VisitsEvent()
    data class VisitClicked(val patientId: String) : VisitsEvent()
}

// ─── Effects ──────────────────────────────────────────────────────────────────

sealed class VisitsEffect {
    data class NavigateToPatient(val patientId: String) : VisitsEffect()
    data class ShowSnackbar(val message: String) : VisitsEffect()
}
