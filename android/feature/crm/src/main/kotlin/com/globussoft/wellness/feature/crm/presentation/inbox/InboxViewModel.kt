package com.globussoft.wellness.feature.crm.presentation.inbox

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
class InboxViewModel @Inject constructor(
    private val repo: CrmRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(InboxUiState())
    val state: StateFlow<InboxUiState> = _state.asStateFlow()

    init {
        loadEmail()
        loadSms()
        loadWhatsApp()
        loadNotifications()
    }

    fun selectTab(index: Int) = _state.update { it.copy(selectedTab = index) }

    fun refreshEmail()         = loadEmail()
    fun refreshSms()           = loadSms()
    fun refreshWhatsApp()      = loadWhatsApp()
    fun refreshNotifications() = loadNotifications()

    private fun loadEmail() {
        viewModelScope.launch {
            _state.update { it.copy(isLoadingEmail = true, errorEmail = null) }
            val result = repo.getEmailInbox()
            _state.update { current ->
                when (result) {
                    is WResult.Success -> current.copy(isLoadingEmail = false, emails = result.data)
                    is WResult.Error   -> current.copy(isLoadingEmail = false, errorEmail = result.message ?: result.exception.message)
                    WResult.Loading    -> current.copy(isLoadingEmail = true)
                }
            }
        }
    }

    private fun loadSms() {
        viewModelScope.launch {
            _state.update { it.copy(isLoadingSms = true, errorSms = null) }
            val result = repo.getSmsMessages()
            _state.update { current ->
                when (result) {
                    is WResult.Success -> current.copy(isLoadingSms = false, smsMessages = result.data)
                    is WResult.Error   -> current.copy(isLoadingSms = false, errorSms = result.message ?: result.exception.message)
                    WResult.Loading    -> current.copy(isLoadingSms = true)
                }
            }
        }
    }

    private fun loadWhatsApp() {
        viewModelScope.launch {
            _state.update { it.copy(isLoadingWhatsapp = true, errorWhatsapp = null) }
            val result = repo.getWhatsAppInbox()
            _state.update { current ->
                when (result) {
                    is WResult.Success -> current.copy(isLoadingWhatsapp = false, whatsapp = result.data)
                    is WResult.Error   -> current.copy(isLoadingWhatsapp = false, errorWhatsapp = result.message ?: result.exception.message)
                    WResult.Loading    -> current.copy(isLoadingWhatsapp = true)
                }
            }
        }
    }

    private fun loadNotifications() {
        viewModelScope.launch {
            _state.update { it.copy(isLoadingNotifications = true, errorNotifications = null) }
            val result = repo.getNotificationsFeed()
            _state.update { current ->
                when (result) {
                    is WResult.Success -> current.copy(isLoadingNotifications = false, notifications = result.data)
                    is WResult.Error   -> current.copy(isLoadingNotifications = false, errorNotifications = result.message ?: result.exception.message)
                    WResult.Loading    -> current.copy(isLoadingNotifications = true)
                }
            }
        }
    }
}
