package com.globus.crm.feature.catalog.presentation.state

import com.globus.crm.feature.catalog.domain.model.Service
import com.globus.crm.feature.catalog.domain.model.ServiceCategory

data class CatalogUiState(
    val isLoading: Boolean = false,
    val error: String? = null,
    val services: List<Service> = emptyList(),
    val categories: List<ServiceCategory> = emptyList(),
    val searchQuery: String = "",
    val selectedCategoryId: Int? = null,
    val selectedService: Service? = null,    // shown in bottom sheet
    val showServiceDetail: Boolean = false,
)

sealed class CatalogUiEvent {
    object LoadServices : CatalogUiEvent()
    object LoadCategories : CatalogUiEvent()
    data class UpdateSearch(val query: String) : CatalogUiEvent()
    data class SelectCategory(val categoryId: Int?) : CatalogUiEvent()
    object ClearCategoryFilter : CatalogUiEvent()
    data class ShowServiceDetail(val service: Service) : CatalogUiEvent()
    object DismissServiceDetail : CatalogUiEvent()
    data class BookService(val serviceId: Int) : CatalogUiEvent()
}
