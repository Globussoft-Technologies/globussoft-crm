package com.globussoft.wellness.feature.crm.presentation.knowledgebase

data class KnowledgeBaseUiState(
    val isLoading: Boolean = false,
    val articles: List<Map<String, Any>> = emptyList(),
    val error: String? = null,
    val search: String = "",
    val showCreateForm: Boolean = false,
    val isCreating: Boolean = false,
    val formError: String? = null,
)
