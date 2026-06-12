package com.globus.crm.feature.membership.presentation.state

import com.globus.crm.feature.membership.domain.model.Membership
import com.globus.crm.feature.membership.domain.model.MembershipPlan

data class MembershipsUiState(
    val isLoading: Boolean = true,
    val error: String? = null,
    val memberships: List<Membership> = emptyList(),
    val plans: List<MembershipPlan> = emptyList(),
    val selectedMembership: Membership? = null,
    val selectedPlan: MembershipPlan? = null,
    val showJoinConfirm: Boolean = false,
    val showPlans: Boolean = false,
)

sealed class MembershipsUiEvent {
    object Refresh : MembershipsUiEvent()
    data class SelectMembership(val membership: Membership) : MembershipsUiEvent()
    object DismissDetail : MembershipsUiEvent()
    object TogglePlans : MembershipsUiEvent()
    object NavigateBack : MembershipsUiEvent()
    data class SelectPlan(val plan: MembershipPlan) : MembershipsUiEvent()
    object DismissPlanDetail : MembershipsUiEvent()
    data class JoinPlan(val planId: Int) : MembershipsUiEvent()
    object ConfirmJoin : MembershipsUiEvent()
    object DismissJoinConfirm : MembershipsUiEvent()
}
