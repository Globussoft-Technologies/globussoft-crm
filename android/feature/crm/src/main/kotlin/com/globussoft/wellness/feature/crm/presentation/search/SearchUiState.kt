package com.globussoft.wellness.feature.crm.presentation.search

data class SearchUiState(
    val query: String = "",
    val isSearching: Boolean = false,
    val contacts: List<Map<String, Any>> = emptyList(),
    val deals: List<Map<String, Any>> = emptyList(),
    val tickets: List<Map<String, Any>> = emptyList(),
    val error: String? = null,
)
