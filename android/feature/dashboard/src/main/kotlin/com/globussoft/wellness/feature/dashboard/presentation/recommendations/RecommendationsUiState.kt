package com.globussoft.wellness.feature.dashboard.presentation.recommendations

import com.globussoft.wellness.core.domain.model.Recommendation

/**
 * Immutable UI state for the AI Recommendations screen.
 *
 * [confirmingAction] is non-null when an Approve/Reject/RunOrchestrator action
 * has been requested but not yet confirmed.  The [ConfirmDialog] is shown
 * while this is non-null; dismissing the dialog sets it back to null.
 */
data class RecommendationsUiState(
    val isLoading: Boolean = false,
    val recommendations: List<Recommendation> = emptyList(),
    val activeFilter: String = FILTER_PENDING,
    val error: String? = null,
    val confirmingAction: RecommendationAction? = null,
) {
    companion object {
        const val FILTER_PENDING  = "pending"
        const val FILTER_APPROVED = "approved"
        const val FILTER_REJECTED = "rejected"
        const val FILTER_ALL      = "all"

        /** All available status filter options in display order. */
        val ALL_FILTERS = listOf(FILTER_PENDING, FILTER_APPROVED, FILTER_REJECTED, FILTER_ALL)
    }
}

/**
 * Represents a pending destructive action that requires user confirmation.
 *
 * Shown inside [com.globussoft.wellness.core.designsystem.components.ConfirmDialog].
 *
 * @param id      The recommendation UUID this action targets (empty for orchestrator).
 * @param type    The action type.
 * @param title   Dialog heading.
 * @param message Dialog body text.
 */
data class RecommendationAction(
    val id: String,
    val type: ActionType,
    val title: String,
    val message: String,
)

/** Discriminates the three confirm-gated actions available on the screen. */
enum class ActionType { APPROVE, REJECT, RUN_ORCHESTRATOR }

/**
 * User intents for the AI Recommendations screen.
 */
sealed class RecommendationsEvent {
    /** The user tapped a filter chip. */
    data class FilterChanged(val status: String) : RecommendationsEvent()

    /** The user tapped the Approve button on a recommendation. */
    data class ApproveRequested(val id: String) : RecommendationsEvent()

    /** The user tapped the Reject button on a recommendation. */
    data class RejectRequested(val id: String) : RecommendationsEvent()

    /**
     * The user confirmed the action shown in the dialog.
     *
     * Triggers the actual API call for [RecommendationAction.type].
     */
    data class ConfirmAction(val action: RecommendationAction) : RecommendationsEvent()

    /** The user dismissed the confirmation dialog without acting. */
    data object DismissConfirm : RecommendationsEvent()

    /** The user tapped "Run Now" to trigger the AI orchestrator manually. */
    data object RunOrchestratorRequested : RecommendationsEvent()

    /** Pull-to-refresh or retry. */
    data object Refresh : RecommendationsEvent()
}
