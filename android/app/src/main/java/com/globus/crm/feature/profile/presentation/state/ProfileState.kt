package com.globus.crm.feature.profile.presentation.state

import com.globus.crm.feature.profile.domain.model.Profile

data class ProfileUiState(
    val isLoading: Boolean = true,
    val error: String? = null,
    val profile: Profile? = null,
    val isEditing: Boolean = false,
    val editName: String = "",
    val editEmail: String = "",
    val currentPassword: String = "",
    val newPassword: String = "",
    val isSaving: Boolean = false,
    val saveError: String? = null,
    val saveSuccess: Boolean = false,
    val exportRequested: Boolean = false,
    val isPhotoUploading: Boolean = false,
    val photoError: String? = null,
    val showDeleteAccountDialog: Boolean = false,
    val isDeletingAccount: Boolean = false,
    val deleteAccountError: String? = null,
)

sealed class ProfileUiEvent {
    object Refresh : ProfileUiEvent()
    object StartEdit : ProfileUiEvent()
    object CancelEdit : ProfileUiEvent()
    data class EditName(val name: String) : ProfileUiEvent()
    data class EditEmail(val email: String) : ProfileUiEvent()
    data class EditCurrentPassword(val password: String) : ProfileUiEvent()
    data class EditNewPassword(val password: String) : ProfileUiEvent()
    object SaveChanges : ProfileUiEvent()
    data class PhotoPicked(val bytes: ByteArray, val mimeType: String) : ProfileUiEvent()
    object RemovePhoto : ProfileUiEvent()
    object RequestDsarExport : ProfileUiEvent()
    object Logout : ProfileUiEvent()
    object ShowDeleteAccountDialog : ProfileUiEvent()
    object DismissDeleteAccountDialog : ProfileUiEvent()
    object ConfirmDeleteAccount : ProfileUiEvent()
    object NavigateBack : ProfileUiEvent()
    object ToNotificationSettings : ProfileUiEvent()
}
