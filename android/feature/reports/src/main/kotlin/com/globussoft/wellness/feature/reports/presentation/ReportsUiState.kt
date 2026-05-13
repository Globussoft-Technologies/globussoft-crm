package com.globussoft.wellness.feature.reports.presentation

import com.globussoft.wellness.core.domain.model.AttributionData
import com.globussoft.wellness.core.domain.model.PerLocation
import com.globussoft.wellness.core.domain.model.PerProfessional
import com.globussoft.wellness.core.domain.model.PnlByService

/**
 * Immutable UI state for the Reports screen.
 *
 * [selectedTabIndex] drives which [HorizontalPager] page is visible.
 * Each tab has its own data list; a null list means that tab's data has never
 * been successfully loaded (distinct from an empty-successfully-loaded list).
 *
 * [isLoading] is true when the currently-selected tab's data is being fetched.
 * [isExporting] is true while the CSV export action is in progress.
 */
data class ReportsUiState(
    val isLoading: Boolean = false,
    val selectedTabIndex: Int = 0,
    val fromDate: String = "",
    val toDate: String = "",
    val pnlData: List<PnlByService> = emptyList(),
    val perProData: List<PerProfessional> = emptyList(),
    val perLocationData: List<PerLocation> = emptyList(),
    val attributionData: List<AttributionData> = emptyList(),
    val error: String? = null,
    val isExporting: Boolean = false,
    val exportError: String? = null,
)

/**
 * User intents for the Reports screen.
 */
sealed class ReportsEvent {
    /** The user tapped a different tab in the tab strip. */
    data class TabSelected(val index: Int) : ReportsEvent()

    /** The user changed the "from" date via the date picker. */
    data class FromDateChanged(val date: String) : ReportsEvent()

    /** The user changed the "to" date via the date picker. */
    data class ToDateChanged(val date: String) : ReportsEvent()

    /** The user tapped the Export CSV button. */
    data object ExportCsv : ReportsEvent()

    /** Pull-to-refresh or retry after error. */
    data object Refresh : ReportsEvent()
}

/**
 * One-time side effects emitted by [ReportsViewModel].
 */
sealed class ReportsEffect {
    /** Show a transient Snackbar message. */
    data class ShowSnackbar(val message: String) : ReportsEffect()
}
