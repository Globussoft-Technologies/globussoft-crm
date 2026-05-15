package com.globussoft.wellness.feature.crm.presentation.pipeline

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.globussoft.wellness.core.common.result.WResult
import com.globussoft.wellness.feature.crm.domain.repository.CrmRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

@HiltViewModel
class PipelineViewModel @Inject constructor(
    private val repo: CrmRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(PipelineUiState())
    val state: StateFlow<PipelineUiState> = _state.asStateFlow()

    init {
        loadPipelines()
    }

    fun refresh() {
        loadPipelines()
    }

    fun selectStage(stage: String?) {
        _state.update { it.copy(selectedStage = stage) }
        loadDeals()
    }

    private fun loadPipelines() {
        viewModelScope.launch {
            _state.update { it.copy(isLoading = true, error = null) }
            when (val result = repo.getPipelines()) {
                is WResult.Success -> {
                    val pipelines = result.data
                    val firstId = pipelines.firstOrNull()?.id
                    _state.update { it.copy(
                        isLoading = false,
                        pipelines = pipelines,
                        selectedPipelineId = firstId ?: it.selectedPipelineId,
                    ) }
                    loadDeals()
                }
                is WResult.Error -> {
                    _state.update { it.copy(
                        isLoading = false,
                        error = result.message ?: result.exception.message,
                    ) }
                }
                WResult.Loading -> Unit
            }
        }
    }

    private fun loadDeals() {
        viewModelScope.launch {
            _state.update { it.copy(dealsLoading = true) }
            when (val result = repo.getDeals(stage = _state.value.selectedStage)) {
                is WResult.Success -> {
                    _state.update { it.copy(dealsLoading = false, deals = result.data) }
                }
                is WResult.Error -> {
                    _state.update { it.copy(
                        dealsLoading = false,
                        error = result.message ?: result.exception.message,
                    ) }
                }
                WResult.Loading -> Unit
            }
        }
    }
}
