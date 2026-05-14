package com.globussoft.wellness.feature.admin.presentation.loyalty

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.globussoft.wellness.core.common.result.WResult
import com.globussoft.wellness.feature.admin.domain.repository.AdminRepository
import com.globussoft.wellness.feature.admin.domain.repository.LeaderboardEntry
import com.globussoft.wellness.feature.admin.domain.repository.ReferralItem
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

data class LoyaltyUiState(
    val isLoading: Boolean = false,
    val leaderboard: List<LeaderboardEntry> = emptyList(),
    val referrals: List<ReferralItem> = emptyList(),
    val selectedTab: Int = 0,
    val error: String? = null,
)

@HiltViewModel
class LoyaltyViewModel @Inject constructor(
    private val repository: AdminRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(LoyaltyUiState())
    val state: StateFlow<LoyaltyUiState> = _state.asStateFlow()

    init { load() }

    fun refresh() = load()

    fun selectTab(index: Int) = _state.update { it.copy(selectedTab = index) }

    private fun load() {
        viewModelScope.launch {
            _state.update { it.copy(isLoading = true, error = null) }
            val lbResult  = repository.getLoyaltyLeaderboard()
            val refResult = repository.getReferrals()
            val lb  = if (lbResult  is WResult.Success) lbResult.data  else emptyList()
            val ref = if (refResult is WResult.Success) refResult.data else emptyList()
            val err = when {
                lbResult  is WResult.Error -> lbResult.message ?: lbResult.exception.message
                refResult is WResult.Error -> refResult.message ?: refResult.exception.message
                else -> null
            }
            _state.update { it.copy(isLoading = false, leaderboard = lb, referrals = ref, error = if (lb.isEmpty() && ref.isEmpty()) err else null) }
        }
    }
}
