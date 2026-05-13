package com.globussoft.wellness.feature.dashboard.presentation.recommendations

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.globussoft.wellness.core.common.result.WResult
import com.globussoft.wellness.core.domain.model.Recommendation
import com.globussoft.wellness.feature.dashboard.domain.repository.DashboardRepository
import com.globussoft.wellness.feature.dashboard.presentation.recommendations.RecommendationsUiState.Companion.FILTER_ALL
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * ViewModel for the AI Recommendations screen.
 *
 * On init the "pending" filter is active and the list is loaded.  The filter is
 * passed to the API as the [status] query parameter; "all" maps to null (no
 * server-side filter) so the server returns every status.
 *
 * Approve / Reject / RunOrchestrator actions go through a two-step
 * Request → Confirm flow to prevent accidental mutations.  The confirmation
 * dialog data lives in [RecommendationsUiState.confirmingAction].
 */
@HiltViewModel
class RecommendationsViewModel @Inject constructor(
    private val repository: DashboardRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(RecommendationsUiState())
    val state: StateFlow<RecommendationsUiState> = _state.asStateFlow()

    init {
        loadRecommendations()
    }

    // -------------------------------------------------------------------------
    // Public event handler
    // -------------------------------------------------------------------------

    fun onEvent(event: RecommendationsEvent) {
        when (event) {
            is RecommendationsEvent.FilterChanged          -> onFilterChanged(event.status)
            is RecommendationsEvent.ApproveRequested       -> onApproveRequested(event.id)
            is RecommendationsEvent.RejectRequested        -> onRejectRequested(event.id)
            is RecommendationsEvent.ConfirmAction          -> onConfirmAction(event.action)
            is RecommendationsEvent.DismissConfirm         -> onDismissConfirm()
            is RecommendationsEvent.RunOrchestratorRequested -> onRunOrchestratorRequested()
            is RecommendationsEvent.Refresh                -> loadRecommendations()
        }
    }

    // -------------------------------------------------------------------------
    // Private handlers
    // -------------------------------------------------------------------------

    private fun onFilterChanged(status: String) {
        _state.update { it.copy(activeFilter = status) }
        loadRecommendations(statusOverride = status)
    }

    private fun onApproveRequested(id: String) {
        val rec = _state.value.recommendations.firstOrNull { it.id == id } ?: return
        _state.update {
            it.copy(
                confirmingAction = RecommendationAction(
                    id      = id,
                    type    = ActionType.APPROVE,
                    title   = "Approve Recommendation",
                    message = "Approve \"${rec.title}\"? This will mark it as approved and log the action.",
                ),
            )
        }
    }

    private fun onRejectRequested(id: String) {
        val rec = _state.value.recommendations.firstOrNull { it.id == id } ?: return
        _state.update {
            it.copy(
                confirmingAction = RecommendationAction(
                    id      = id,
                    type    = ActionType.REJECT,
                    title   = "Reject Recommendation",
                    message = "Reject \"${rec.title}\"? This will dismiss the suggestion.",
                ),
            )
        }
    }

    private fun onRunOrchestratorRequested() {
        _state.update {
            it.copy(
                confirmingAction = RecommendationAction(
                    id      = "",
                    type    = ActionType.RUN_ORCHESTRATOR,
                    title   = "Run AI Orchestrator",
                    message = "This will trigger a fresh AI analysis for your practice and generate new recommendations. The process takes a few seconds.",
                ),
            )
        }
    }

    private fun onDismissConfirm() {
        _state.update { it.copy(confirmingAction = null) }
    }

    private fun onConfirmAction(action: RecommendationAction) {
        _state.update { it.copy(confirmingAction = null) }
        when (action.type) {
            ActionType.APPROVE         -> executeApprove(action.id)
            ActionType.REJECT          -> executeReject(action.id)
            ActionType.RUN_ORCHESTRATOR -> executeRunOrchestrator()
        }
    }

    // -------------------------------------------------------------------------
    // Repository calls
    // -------------------------------------------------------------------------

    private fun loadRecommendations(statusOverride: String? = null) {
        val filter = statusOverride ?: _state.value.activeFilter
        val apiStatus = if (filter == FILTER_ALL) null else filter

        viewModelScope.launch {
            _state.update { it.copy(isLoading = true, error = null) }

            when (val result = repository.getRecommendations(status = apiStatus)) {
                is WResult.Success -> _state.update {
                    it.copy(isLoading = false, recommendations = result.data)
                }
                is WResult.Error -> {
                    val message = result.message ?: result.exception.message
                        ?: "Failed to load recommendations"
                    _state.update { it.copy(isLoading = false, error = message) }
                }
                WResult.Loading -> Unit
            }
        }
    }

    private fun executeApprove(id: String) {
        viewModelScope.launch {
            when (val result = repository.approveRecommendation(id)) {
                is WResult.Success -> replaceInList(result.data)
                is WResult.Error   -> {
                    _state.update {
                        it.copy(error = result.message ?: result.exception.message)
                    }
                }
                WResult.Loading -> Unit
            }
        }
    }

    private fun executeReject(id: String) {
        viewModelScope.launch {
            when (val result = repository.rejectRecommendation(id)) {
                is WResult.Success -> replaceInList(result.data)
                is WResult.Error   -> {
                    _state.update {
                        it.copy(error = result.message ?: result.exception.message)
                    }
                }
                WResult.Loading -> Unit
            }
        }
    }

    private fun executeRunOrchestrator() {
        viewModelScope.launch {
            _state.update { it.copy(isLoading = true) }

            when (val result = repository.runOrchestrator()) {
                is WResult.Success -> {
                    // Reload the list so freshly-generated recommendations appear.
                    loadRecommendations()
                }
                is WResult.Error -> {
                    val message = result.message ?: result.exception.message
                        ?: "Failed to run orchestrator"
                    _state.update { it.copy(isLoading = false, error = message) }
                }
                WResult.Loading -> Unit
            }
        }
    }

    /**
     * Replaces the matching recommendation in the current list with [updated].
     *
     * If the current filter would exclude the updated status, the item is
     * removed from the displayed list (the server already persisted the change).
     */
    private fun replaceInList(updated: Recommendation) {
        _state.update { current ->
            val filter    = current.activeFilter
            val apiStatus = if (filter == FILTER_ALL) null else filter
            val newList   = if (apiStatus == null || updated.status == apiStatus) {
                current.recommendations.map { if (it.id == updated.id) updated else it }
            } else {
                current.recommendations.filter { it.id != updated.id }
            }
            current.copy(recommendations = newList)
        }
    }
}
