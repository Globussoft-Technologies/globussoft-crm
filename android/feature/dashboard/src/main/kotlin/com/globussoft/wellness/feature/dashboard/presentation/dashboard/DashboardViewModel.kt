package com.globussoft.wellness.feature.dashboard.presentation.dashboard

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.globussoft.wellness.core.common.result.WResult
import com.globussoft.wellness.core.data.mapper.toDomain
import com.globussoft.wellness.core.network.api.WellnessApi
import com.globussoft.wellness.core.network.util.safeApiCall
import com.globussoft.wellness.feature.dashboard.domain.repository.DashboardRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * ViewModel for the Owner Dashboard screen.
 *
 * On initialisation, loads dashboard KPIs and the location list in parallel.
 * Subsequent [DashboardEvent.Refresh] and [DashboardEvent.SelectLocation] events
 * trigger a scoped reload.
 *
 * Location data is fetched via [WellnessApi] directly (not through
 * [DashboardRepository]) because locations are needed only to populate the
 * filter chip; the dashboard repository stays focused on KPI aggregates.
 */
@HiltViewModel
class DashboardViewModel @Inject constructor(
    private val dashboardRepository: DashboardRepository,
    private val api: WellnessApi,
) : ViewModel() {

    private val _state = MutableStateFlow(DashboardUiState())
    val state: StateFlow<DashboardUiState> = _state.asStateFlow()

    private val _effects = Channel<DashboardEffect>(Channel.BUFFERED)
    val effects: Flow<DashboardEffect> = _effects.receiveAsFlow()

    init {
        loadAll()
    }

    // -------------------------------------------------------------------------
    // Public event handler
    // -------------------------------------------------------------------------

    fun onEvent(event: DashboardEvent) {
        when (event) {
            is DashboardEvent.Refresh         -> loadAll()
            is DashboardEvent.SelectLocation  -> onLocationSelected(event.locationId)
        }
    }

    // -------------------------------------------------------------------------
    // Private handlers
    // -------------------------------------------------------------------------

    private fun loadAll() {
        viewModelScope.launch {
            _state.update { it.copy(isLoading = true, error = null) }

            // Fetch dashboard KPIs and locations in parallel.
            val dashboardDeferred  = async {
                dashboardRepository.getDashboardData(_state.value.selectedLocationId)
            }
            val locationsDeferred = async {
                safeApiCall { api.getLocations() }
            }

            val dashboardResult  = dashboardDeferred.await()
            val locationsResult  = locationsDeferred.await()

            val locations = when (locationsResult) {
                is WResult.Success -> locationsResult.data.map { it.toDomain() }
                else               -> _state.value.locations // retain previous if fetch fails
            }

            when (dashboardResult) {
                is WResult.Success -> {
                    _state.update { current ->
                        current.copy(
                            isLoading = false,
                            data      = dashboardResult.data,
                            locations = locations,
                            error     = null,
                        )
                    }
                }
                is WResult.Error -> {
                    val message = dashboardResult.message
                        ?: dashboardResult.exception.message
                        ?: "Failed to load dashboard"
                    _state.update { it.copy(isLoading = false, error = message, locations = locations) }
                }
                WResult.Loading -> {
                    // safeApiCall never emits Loading; guard for completeness.
                }
            }
        }
    }

    private fun onLocationSelected(locationId: String?) {
        _state.update { it.copy(selectedLocationId = locationId) }
        loadDashboard(locationId)
    }

    private fun loadDashboard(locationId: String?) {
        viewModelScope.launch {
            _state.update { it.copy(isLoading = true, error = null) }

            when (val result = dashboardRepository.getDashboardData(locationId)) {
                is WResult.Success -> {
                    _state.update { it.copy(isLoading = false, data = result.data, error = null) }
                }
                is WResult.Error -> {
                    val message = result.message ?: result.exception.message ?: "Failed to load dashboard"
                    _state.update { it.copy(isLoading = false, error = message) }
                    _effects.send(DashboardEffect.ShowError(message))
                }
                WResult.Loading -> Unit
            }
        }
    }
}
