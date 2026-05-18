package com.globussoft.wellness.feature.crm.presentation.deals

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.globussoft.wellness.core.common.result.WResult
import com.globussoft.wellness.feature.crm.domain.repository.CrmRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch
import javax.inject.Inject

@HiltViewModel
class DealDetailViewModel @Inject constructor(
    private val repo: CrmRepository,
    savedStateHandle: SavedStateHandle,
) : ViewModel() {

    private val dealId: String = savedStateHandle.get<String>("dealId") ?: ""

    private val _state = MutableStateFlow(DealDetailUiState())
    val state: StateFlow<DealDetailUiState> = _state.asStateFlow()

    init { load() }

    fun showStageSheet() = _state.update { it.copy(showStageSheet = true) }
    fun dismissStageSheet() = _state.update { it.copy(showStageSheet = false) }

    fun showEditForm() = _state.update { it.copy(showEditForm = true, formError = null) }
    fun dismissEditForm() = _state.update { it.copy(showEditForm = false, formError = null) }

    fun showLogActivity() = _state.update { it.copy(showLogActivity = true) }
    fun dismissLogActivity() = _state.update { it.copy(showLogActivity = false) }

    fun logActivity(type: String, subject: String, body: String?) {
        viewModelScope.launch {
            _state.update { it.copy(isLoggingActivity = true) }
            val result = repo.logActivity(type, subject, body, null, dealId)
            _state.update { current ->
                when (result) {
                    is WResult.Success -> current.copy(
                        isLoggingActivity = false,
                        showLogActivity = false,
                        activities = listOf(result.data) + current.activities,
                    )
                    is WResult.Error   -> current.copy(isLoggingActivity = false)
                    WResult.Loading    -> current
                }
            }
        }
    }

    fun changeStage(newStage: String) {
        viewModelScope.launch {
            _state.update { it.copy(isUpdating = true) }
            val result = repo.updateDeal(dealId, mapOf("stage" to newStage))
            _state.update { current ->
                when (result) {
                    is WResult.Success -> current.copy(isUpdating = false, showStageSheet = false, deal = result.data)
                    is WResult.Error   -> current.copy(isUpdating = false, showStageSheet = false)
                    WResult.Loading    -> current
                }
            }
        }
    }

    fun markWon() {
        viewModelScope.launch {
            _state.update { it.copy(isUpdating = true) }
            val result = repo.updateDeal(dealId, mapOf("status" to "WON"))
            _state.update { current ->
                when (result) {
                    is WResult.Success -> current.copy(isUpdating = false, deal = result.data)
                    is WResult.Error   -> current.copy(isUpdating = false)
                    WResult.Loading    -> current
                }
            }
        }
    }

    fun markLost() {
        viewModelScope.launch {
            _state.update { it.copy(isUpdating = true) }
            val result = repo.updateDeal(dealId, mapOf("status" to "LOST"))
            _state.update { current ->
                when (result) {
                    is WResult.Success -> current.copy(isUpdating = false, deal = result.data)
                    is WResult.Error   -> current.copy(isUpdating = false)
                    WResult.Loading    -> current
                }
            }
        }
    }

    fun saveDeal(title: String, amount: String, probability: String) {
        viewModelScope.launch {
            _state.update { it.copy(isUpdating = true, formError = null) }
            val params = buildMap<String, Any> {
                put("title", title)
                amount.toDoubleOrNull()?.let { put("amount", it) }
                probability.toIntOrNull()?.let { put("probability", it) }
            }
            val result = repo.updateDeal(dealId, params)
            _state.update { current ->
                when (result) {
                    is WResult.Success -> current.copy(isUpdating = false, showEditForm = false, deal = result.data)
                    is WResult.Error   -> current.copy(isUpdating = false, formError = result.message ?: result.exception.message)
                    WResult.Loading    -> current
                }
            }
        }
    }

    private fun load() {
        viewModelScope.launch {
            _state.update { it.copy(isLoading = true, error = null) }
            launch {
                when (val r = repo.getDeal(dealId)) {
                    is WResult.Success -> _state.update { it.copy(isLoading = false, deal = r.data) }
                    is WResult.Error   -> _state.update { it.copy(isLoading = false, error = r.message ?: r.exception.message) }
                    WResult.Loading    -> Unit
                }
            }
            launch {
                when (val r = repo.getPipelines()) {
                    is WResult.Success -> _state.update { it.copy(pipelines = r.data) }
                    else -> Unit
                }
            }
            launch {
                when (val r = repo.getActivities(dealId = dealId)) {
                    is WResult.Success -> _state.update { it.copy(activities = r.data) }
                    else -> Unit
                }
            }
        }
    }
}
