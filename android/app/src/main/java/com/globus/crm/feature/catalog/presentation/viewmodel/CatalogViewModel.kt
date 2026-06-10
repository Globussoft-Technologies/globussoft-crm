package com.globus.crm.feature.catalog.presentation.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.globus.crm.core.util.Result
import com.globus.crm.feature.catalog.domain.usecase.GetCategoriesUseCase
import com.globus.crm.feature.catalog.domain.usecase.GetServicesUseCase
import com.globus.crm.feature.catalog.presentation.state.CatalogUiEvent
import com.globus.crm.feature.catalog.presentation.state.CatalogUiState
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

sealed class CatalogNavEvent {
    data class ToBooking(val serviceId: Int) : CatalogNavEvent()
}

@HiltViewModel
class CatalogViewModel @Inject constructor(
    private val getServicesUseCase: GetServicesUseCase,
    private val getCategoriesUseCase: GetCategoriesUseCase,
) : ViewModel() {

    private val _uiState = MutableStateFlow(CatalogUiState())
    val uiState: StateFlow<CatalogUiState> = _uiState.asStateFlow()

    private val _navEvent = Channel<CatalogNavEvent>(Channel.BUFFERED)
    val navEvent = _navEvent.receiveAsFlow()

    init {
        loadServices()
        loadCategories()
    }

    fun onEvent(event: CatalogUiEvent) {
        when (event) {
            CatalogUiEvent.LoadServices -> loadServices()
            CatalogUiEvent.LoadCategories -> loadCategories()
            is CatalogUiEvent.UpdateSearch ->
                _uiState.value = _uiState.value.copy(searchQuery = event.query)
            is CatalogUiEvent.SelectCategory ->
                _uiState.value = _uiState.value.copy(selectedCategoryId = event.categoryId)
            CatalogUiEvent.ClearCategoryFilter ->
                _uiState.value = _uiState.value.copy(selectedCategoryId = null)
            is CatalogUiEvent.ShowServiceDetail ->
                _uiState.value = _uiState.value.copy(
                    selectedService = event.service,
                    showServiceDetail = true,
                )
            CatalogUiEvent.DismissServiceDetail ->
                _uiState.value = _uiState.value.copy(
                    showServiceDetail = false,
                    selectedService = null,
                )
            is CatalogUiEvent.BookService ->
                viewModelScope.launch { _navEvent.send(CatalogNavEvent.ToBooking(event.serviceId)) }
        }
    }

    private fun loadServices() {
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(isLoading = true, error = null)
            when (val r = getServicesUseCase()) {
                is Result.Success -> _uiState.value = _uiState.value.copy(
                    isLoading = false,
                    services = r.data,
                )
                is Result.Error -> _uiState.value = _uiState.value.copy(
                    isLoading = false,
                    error = r.message,
                )
                Result.Loading -> Unit
            }
        }
    }

    private fun loadCategories() {
        viewModelScope.launch {
            when (val r = getCategoriesUseCase()) {
                is Result.Success -> _uiState.value = _uiState.value.copy(categories = r.data)
                is Result.Error -> Unit  // non-fatal; categories are optional filters
                Result.Loading -> Unit
            }
        }
    }
}
