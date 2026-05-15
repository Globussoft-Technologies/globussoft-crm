package com.globussoft.wellness.feature.crm.presentation.tickets

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.globussoft.wellness.core.common.result.WResult
import com.globussoft.wellness.feature.crm.domain.repository.CrmRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch
import java.util.UUID
import javax.inject.Inject

@HiltViewModel
class TicketDetailViewModel @Inject constructor(
    private val repo: CrmRepository,
    savedStateHandle: SavedStateHandle,
) : ViewModel() {

    private val ticketId: String = savedStateHandle.get<String>("ticketId") ?: ""

    private val _state = MutableStateFlow(TicketDetailUiState())
    val state: StateFlow<TicketDetailUiState> = _state.asStateFlow()

    init { load() }

    fun setReplyText(text: String) = _state.update { it.copy(replyText = text) }

    fun showStatusSheet() = _state.update { it.copy(showStatusSheet = true) }
    fun dismissStatusSheet() = _state.update { it.copy(showStatusSheet = false) }

    fun sendReply() {
        val text = _state.value.replyText.trim()
        if (text.isBlank()) return
        viewModelScope.launch {
            _state.update { it.copy(isSendingReply = true) }
            // Optimistically add the comment to the local list
            val newComment = TicketComment(
                id = UUID.randomUUID().toString(),
                author = "You",
                body = text,
                createdAt = java.time.Instant.now().toString().take(19).replace("T", " "),
            )
            _state.update {
                it.copy(
                    comments = it.comments + newComment,
                    replyText = "",
                    isSendingReply = false,
                )
            }
        }
    }

    fun changeStatus(newStatus: String) {
        viewModelScope.launch {
            _state.update { it.copy(isUpdating = true) }
            val result = repo.updateTicket(ticketId, mapOf("status" to newStatus))
            _state.update { current ->
                when (result) {
                    is WResult.Success -> current.copy(isUpdating = false, showStatusSheet = false, ticket = result.data)
                    is WResult.Error   -> current.copy(isUpdating = false, showStatusSheet = false)
                    WResult.Loading    -> current
                }
            }
        }
    }

    private fun load() {
        viewModelScope.launch {
            _state.update { it.copy(isLoading = true, error = null) }
            when (val r = repo.getTicket(ticketId)) {
                is WResult.Success -> _state.update { it.copy(isLoading = false, ticket = r.data) }
                is WResult.Error   -> _state.update { it.copy(isLoading = false, error = r.message ?: r.exception.message) }
                WResult.Loading    -> Unit
            }
        }
    }
}
