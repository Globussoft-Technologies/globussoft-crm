package com.globussoft.wellness.feature.reports.presentation

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.globussoft.wellness.core.common.result.WResult
import com.globussoft.wellness.core.common.utils.millisToIsoDate
import com.globussoft.wellness.core.common.utils.todayIsoDate
import com.globussoft.wellness.feature.reports.domain.repository.ReportsRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * ViewModel for the Reports screen.
 *
 * ### Initialization
 * On first creation, default dates are set to the last 30 days and the active
 * tab's data is loaded immediately.
 *
 * ### Date-change debounce
 * When the user adjusts either date picker the ViewModel waits 350 ms before
 * firing the network call.  Rapid picker changes (e.g. month scrolling) are
 * collapsed so only the final selection triggers a fetch.
 *
 * ### Tab switching
 * Each tab's data is lazily loaded the first time the tab becomes active.
 * Switching to a tab that already has data does NOT re-fetch unless [Refresh]
 * is explicitly requested.
 *
 * ### CSV export
 * The backend does not expose a mobile CSV download endpoint; the export button
 * shows a snackbar directing the user to the web browser.
 */
@HiltViewModel
class ReportsViewModel @Inject constructor(
    private val repository: ReportsRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(ReportsUiState())
    val state: StateFlow<ReportsUiState> = _state.asStateFlow()

    private val _effects = Channel<ReportsEffect>(Channel.BUFFERED)
    val effects: Flow<ReportsEffect> = _effects.receiveAsFlow()

    /** Pending debounce job for date-range changes. */
    private var dateDebounceJob: Job? = null

    init {
        // Default: 30 days ago → today.
        val today      = todayIsoDate()
        val thirtyAgo  = millisToIsoDate(System.currentTimeMillis() - 30L * 86_400_000L)
        _state.update { it.copy(fromDate = thirtyAgo, toDate = today) }
        loadCurrentTab()
    }

    // -------------------------------------------------------------------------
    // Public event handler
    // -------------------------------------------------------------------------

    fun onEvent(event: ReportsEvent) {
        when (event) {
            is ReportsEvent.TabSelected     -> onTabSelected(event.index)
            is ReportsEvent.FromDateChanged -> onDateChanged(from = event.date, to = null)
            is ReportsEvent.ToDateChanged   -> onDateChanged(from = null, to = event.date)
            is ReportsEvent.ExportCsv       -> onExportCsv()
            is ReportsEvent.Refresh         -> loadCurrentTab(force = true)
        }
    }

    // -------------------------------------------------------------------------
    // Private handlers
    // -------------------------------------------------------------------------

    private fun onTabSelected(index: Int) {
        _state.update { it.copy(selectedTabIndex = index, error = null) }
        // Load only if the selected tab has no data yet.
        val current = _state.value
        val needsLoad = when (index) {
            0 -> current.pnlData.isEmpty()
            1 -> current.perProData.isEmpty()
            2 -> current.perLocationData.isEmpty()
            3 -> current.attributionData.isEmpty()
            else -> false
        }
        if (needsLoad) loadCurrentTab()
    }

    private fun onDateChanged(from: String?, to: String?) {
        // Apply the change immediately to state so the UI reflects the new picker value.
        if (from != null) _state.update { it.copy(fromDate = from) }
        if (to != null)   _state.update { it.copy(toDate = to) }

        // Cancel any pending debounce and start a fresh 350 ms window.
        dateDebounceJob?.cancel()
        dateDebounceJob = viewModelScope.launch {
            delay(350L)
            loadCurrentTab(force = true)
        }
    }

    private fun onExportCsv() {
        viewModelScope.launch {
            _effects.send(
                ReportsEffect.ShowSnackbar(
                    "CSV export is available via the web browser at crm.globusdemos.com",
                ),
            )
        }
    }

    /**
     * Loads data for the currently-selected tab.
     *
     * @param force When true, always fetches even if the tab already has data
     *              (used for pull-to-refresh and date changes).
     */
    private fun loadCurrentTab(force: Boolean = false) {
        val s = _state.value
        val from = s.fromDate
        val to   = s.toDate
        if (from.isEmpty() || to.isEmpty()) return

        viewModelScope.launch {
            _state.update { it.copy(isLoading = true, error = null) }
            when (s.selectedTabIndex) {
                0 -> loadPnl(from, to)
                1 -> loadPerPro(from, to)
                2 -> loadPerLocation(from, to)
                3 -> loadAttribution(from, to)
            }
        }
    }

    private suspend fun loadPnl(from: String, to: String) {
        when (val result = repository.getPnlByService(from, to)) {
            is WResult.Success -> _state.update { it.copy(isLoading = false, pnlData = result.data, error = null) }
            is WResult.Error   -> handleError(result)
            WResult.Loading    -> Unit
        }
    }

    private suspend fun loadPerPro(from: String, to: String) {
        when (val result = repository.getPerProfessional(from, to)) {
            is WResult.Success -> _state.update { it.copy(isLoading = false, perProData = result.data, error = null) }
            is WResult.Error   -> handleError(result)
            WResult.Loading    -> Unit
        }
    }

    private suspend fun loadPerLocation(from: String, to: String) {
        when (val result = repository.getPerLocation(from, to)) {
            is WResult.Success -> _state.update { it.copy(isLoading = false, perLocationData = result.data, error = null) }
            is WResult.Error   -> handleError(result)
            WResult.Loading    -> Unit
        }
    }

    private suspend fun loadAttribution(from: String, to: String) {
        when (val result = repository.getAttribution(from, to)) {
            is WResult.Success -> _state.update { it.copy(isLoading = false, attributionData = result.data, error = null) }
            is WResult.Error   -> handleError(result)
            WResult.Loading    -> Unit
        }
    }

    private suspend fun handleError(result: WResult.Error) {
        val message = result.message ?: result.exception.message ?: "Failed to load report"
        _state.update { it.copy(isLoading = false, error = message) }
        _effects.send(ReportsEffect.ShowSnackbar(message))
    }
}
