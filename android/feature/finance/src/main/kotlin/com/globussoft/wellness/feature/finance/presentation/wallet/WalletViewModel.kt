package com.globussoft.wellness.feature.finance.presentation.wallet

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.globussoft.wellness.core.common.result.WResult
import com.globussoft.wellness.core.network.api.WellnessApi
import com.globussoft.wellness.core.network.util.safeApiCall
import com.globussoft.wellness.feature.finance.domain.repository.FinanceRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * ViewModel for the Wallet screen.
 *
 * Patient search is debounced (300 ms) through a dedicated [_searchQuery] flow
 * before querying the patients endpoint.  On selection the wallet is fetched
 * immediately.
 */
@OptIn(FlowPreview::class)
@HiltViewModel
class WalletViewModel @Inject constructor(
    private val repository: FinanceRepository,
    private val api: WellnessApi,
) : ViewModel() {

    private val _state   = MutableStateFlow(WalletUiState())
    val state: StateFlow<WalletUiState> = _state.asStateFlow()

    private val _effects = Channel<WalletEffect>(Channel.BUFFERED)
    val effects: Flow<WalletEffect> = _effects.receiveAsFlow()

    private val _searchQuery = MutableStateFlow("")

    init {
        observeSearch()
    }

    fun onEvent(event: WalletEvent) {
        when (event) {
            is WalletEvent.SearchChanged    -> onSearchChanged(event.query)
            is WalletEvent.PatientSelected  -> onPatientSelected(event.id, event.name)
            is WalletEvent.DismissDropdown  -> _state.update { it.copy(showSearchDropdown = false) }
        }
    }

    // ─── Private handlers ─────────────────────────────────────────────────────

    private fun observeSearch() {
        _searchQuery
            .debounce(300L)
            .distinctUntilChanged()
            .onEach { query -> if (query.length >= 2) searchPatients(query) }
            .launchIn(viewModelScope)
    }

    private fun onSearchChanged(query: String) {
        _state.update { it.copy(searchQuery = query, showSearchDropdown = false) }
        _searchQuery.value = query
    }

    private fun searchPatients(query: String) {
        viewModelScope.launch {
            val result = safeApiCall { api.getPatients(search = query, limit = 10) }
            when (result) {
                is WResult.Success -> {
                    val results = result.data.data.map { p ->
                        PatientSearchResult(
                            id    = p.id,
                            name  = p.name,
                            phone = p.phone,
                        )
                    }
                    _state.update { it.copy(searchResults = results, showSearchDropdown = results.isNotEmpty()) }
                }
                else -> Unit
            }
        }
    }

    private fun onPatientSelected(id: String, name: String) {
        _state.update { it.copy(
            selectedPatientId   = id,
            selectedPatientName = name,
            searchQuery         = name,
            showSearchDropdown  = false,
            walletData          = null,
            isLoading           = true,
            error               = null,
        )}
        viewModelScope.launch {
            when (val result = repository.getWallet(id)) {
                is WResult.Success -> _state.update { it.copy(isLoading = false, walletData = result.data) }
                is WResult.Error -> {
                    val msg = result.message ?: result.exception.message ?: "Failed to load wallet"
                    _state.update { it.copy(isLoading = false, error = msg) }
                    _effects.send(WalletEffect.ShowSnackbar(msg))
                }
                WResult.Loading -> Unit
            }
        }
    }
}
