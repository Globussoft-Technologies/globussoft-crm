package com.globus.crm.feature.profile.presentation.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.globus.crm.core.util.Result
import com.globus.crm.feature.auth.domain.usecase.LogoutUseCase
import com.globus.crm.feature.profile.domain.usecase.DeleteAccountUseCase
import com.globus.crm.feature.profile.domain.usecase.GetProfileUseCase
import com.globus.crm.feature.profile.domain.usecase.RemoveProfilePictureUseCase
import com.globus.crm.feature.profile.domain.usecase.RequestDsarExportUseCase
import com.globus.crm.feature.profile.domain.usecase.UpdateProfileUseCase
import com.globus.crm.feature.profile.domain.usecase.UploadProfilePictureUseCase
import com.globus.crm.feature.profile.presentation.state.ProfileUiEvent
import com.globus.crm.feature.profile.presentation.state.ProfileUiState
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

sealed class ProfileNavEvent {
    object Back : ProfileNavEvent()
    object ToLogin : ProfileNavEvent()
    object ToNotificationSettings : ProfileNavEvent()
}

@HiltViewModel
class ProfileViewModel @Inject constructor(
    private val getProfile: GetProfileUseCase,
    private val updateProfile: UpdateProfileUseCase,
    private val uploadProfilePicture: UploadProfilePictureUseCase,
    private val removeProfilePicture: RemoveProfilePictureUseCase,
    private val requestDsarExport: RequestDsarExportUseCase,
    private val deleteAccount: DeleteAccountUseCase,
    private val logout: LogoutUseCase,
) : ViewModel() {

    private val _uiState = MutableStateFlow(ProfileUiState())
    val uiState: StateFlow<ProfileUiState> = _uiState.asStateFlow()

    private val _navEvent = Channel<ProfileNavEvent>(Channel.BUFFERED)
    val navEvent = _navEvent.receiveAsFlow()

    init {
        load()
    }

    fun onEvent(event: ProfileUiEvent) {
        when (event) {
            ProfileUiEvent.Refresh -> load()
            ProfileUiEvent.StartEdit -> {
                val p = _uiState.value.profile ?: return
                _uiState.value = _uiState.value.copy(
                    isEditing = true,
                    editName = p.name,
                    editEmail = p.email ?: "",
                    currentPassword = "",
                    newPassword = "",
                    saveError = null,
                )
            }
            ProfileUiEvent.CancelEdit -> _uiState.value = _uiState.value.copy(isEditing = false, saveError = null)
            is ProfileUiEvent.EditName -> _uiState.value = _uiState.value.copy(editName = event.name)
            is ProfileUiEvent.EditEmail -> _uiState.value = _uiState.value.copy(editEmail = event.email)
            is ProfileUiEvent.EditCurrentPassword -> _uiState.value = _uiState.value.copy(currentPassword = event.password)
            is ProfileUiEvent.EditNewPassword -> _uiState.value = _uiState.value.copy(newPassword = event.password)
            ProfileUiEvent.SaveChanges -> save()
            is ProfileUiEvent.PhotoPicked -> uploadPhoto(event.bytes, event.mimeType)
            ProfileUiEvent.RemovePhoto -> doRemovePhoto()
            ProfileUiEvent.RequestDsarExport -> requestExport()
            ProfileUiEvent.Logout -> doLogout()
            ProfileUiEvent.ShowDeleteAccountDialog -> _uiState.value = _uiState.value.copy(
                showDeleteAccountDialog = true, deleteAccountError = null,
            )
            ProfileUiEvent.DismissDeleteAccountDialog -> _uiState.value = _uiState.value.copy(
                showDeleteAccountDialog = false, deleteAccountError = null,
            )
            ProfileUiEvent.ConfirmDeleteAccount -> doDeleteAccount()
            ProfileUiEvent.NavigateBack -> viewModelScope.launch { _navEvent.send(ProfileNavEvent.Back) }
            ProfileUiEvent.ToNotificationSettings -> viewModelScope.launch { _navEvent.send(ProfileNavEvent.ToNotificationSettings) }
        }
    }

    private fun load() {
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(isLoading = true, error = null)
            when (val result = getProfile()) {
                is Result.Success -> _uiState.value = ProfileUiState(isLoading = false, profile = result.data)
                is Result.Error -> _uiState.value = ProfileUiState(isLoading = false, error = result.message)
                Result.Loading -> Unit
            }
        }
    }

    private fun save() {
        val s = _uiState.value
        viewModelScope.launch {
            _uiState.value = s.copy(isSaving = true, saveError = null)
            val result = updateProfile(
                name = s.editName.takeIf { it.isNotBlank() },
                email = s.editEmail.takeIf { it.isNotBlank() },
                currentPassword = s.currentPassword.takeIf { it.isNotBlank() },
                newPassword = s.newPassword.takeIf { it.isNotBlank() },
            )
            when (result) {
                is Result.Success -> _uiState.value = _uiState.value.copy(
                    isSaving = false, isEditing = false, saveSuccess = true, profile = result.data,
                )
                is Result.Error -> _uiState.value = _uiState.value.copy(isSaving = false, saveError = result.message)
                Result.Loading -> Unit
            }
        }
    }

    private fun uploadPhoto(bytes: ByteArray, mimeType: String) {
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(isPhotoUploading = true, photoError = null)
            when (val result = uploadProfilePicture(bytes, mimeType)) {
                is Result.Success -> _uiState.value = _uiState.value.copy(
                    isPhotoUploading = false,
                    profile = result.data,
                )
                is Result.Error -> _uiState.value = _uiState.value.copy(
                    isPhotoUploading = false,
                    photoError = result.message,
                )
                Result.Loading -> Unit
            }
        }
    }

    private fun doRemovePhoto() {
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(isPhotoUploading = true, photoError = null)
            when (val result = removeProfilePicture()) {
                is Result.Success -> _uiState.value = _uiState.value.copy(
                    isPhotoUploading = false,
                    profile = result.data,
                )
                is Result.Error -> _uiState.value = _uiState.value.copy(
                    isPhotoUploading = false,
                    photoError = result.message,
                )
                Result.Loading -> Unit
            }
        }
    }

    private fun requestExport() {
        viewModelScope.launch {
            requestDsarExport()
            _uiState.value = _uiState.value.copy(exportRequested = true)
        }
    }

    private fun doDeleteAccount() {
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(isDeletingAccount = true, deleteAccountError = null)
            when (val result = deleteAccount()) {
                is Result.Success -> _navEvent.send(ProfileNavEvent.ToLogin)
                is Result.Error -> _uiState.value = _uiState.value.copy(
                    isDeletingAccount = false,
                    deleteAccountError = result.message,
                )
                Result.Loading -> Unit
            }
        }
    }

    private fun doLogout() {
        viewModelScope.launch {
            logout()
            _navEvent.send(ProfileNavEvent.ToLogin)
        }
    }
}
