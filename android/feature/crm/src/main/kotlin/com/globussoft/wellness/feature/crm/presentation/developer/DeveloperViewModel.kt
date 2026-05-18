package com.globussoft.wellness.feature.crm.presentation.developer

import androidx.lifecycle.ViewModel
import com.globussoft.wellness.feature.crm.domain.repository.CrmRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import javax.inject.Inject

@HiltViewModel
class DeveloperViewModel @Inject constructor(
    @Suppress("UNUSED_PARAMETER") repo: CrmRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(DeveloperUiState())
    val state: StateFlow<DeveloperUiState> = _state.asStateFlow()
}
