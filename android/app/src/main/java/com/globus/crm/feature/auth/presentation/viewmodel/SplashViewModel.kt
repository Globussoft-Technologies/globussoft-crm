package com.globus.crm.feature.auth.presentation.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.globus.crm.BuildConfig
import com.globus.crm.core.storage.DataStoreManager
import com.globus.crm.core.util.Result
import com.globus.crm.feature.auth.domain.usecase.CheckAuthStatusUseCase
import com.globus.crm.feature.auth.domain.usecase.GetTenantBrandingUseCase
import com.globus.crm.feature.auth.presentation.state.SplashUiState
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

sealed class SplashNavEvent {
    object NavigateToDashboard : SplashNavEvent()
    object NavigateToLogin : SplashNavEvent()
}

@HiltViewModel
class SplashViewModel @Inject constructor(
    private val getTenantBranding: GetTenantBrandingUseCase,
    private val checkAuthStatus: CheckAuthStatusUseCase,
    private val dataStore: DataStoreManager,
) : ViewModel() {

    private val _uiState = MutableStateFlow(SplashUiState())
    val uiState: StateFlow<SplashUiState> = _uiState.asStateFlow()

    private val _navEvent = Channel<SplashNavEvent>(Channel.BUFFERED)
    val navEvent = _navEvent.receiveAsFlow()

    init {
        loadAndNavigate()
    }

    private fun loadAndNavigate() {
        viewModelScope.launch {
            val brandingResult = getTenantBranding(BuildConfig.TENANT_SLUG)
            if (brandingResult is Result.Success) {
                val branding = brandingResult.data
                dataStore.saveTenantBranding(
                    brandColor = branding.brandColor ?: "#265855",
                    clinicName = branding.name,
                    logoUrl = branding.logoUrl,
                )
                dataStore.saveTenantId(branding.id)
                _uiState.update { it.copy(tenantBranding = branding) }
            } else if (brandingResult is Result.Error) {
                _uiState.update { it.copy(error = brandingResult.message) }
            }

            val authResult = checkAuthStatus()
            _uiState.update { it.copy(isLoading = false) }

            if (authResult is Result.Success && authResult.data) {
                _navEvent.send(SplashNavEvent.NavigateToDashboard)
            } else {
                _navEvent.send(SplashNavEvent.NavigateToLogin)
            }
        }
    }
}
