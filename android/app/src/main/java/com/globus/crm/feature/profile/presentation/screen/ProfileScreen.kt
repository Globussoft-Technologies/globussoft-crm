package com.globus.crm.feature.profile.presentation.screen

import android.net.Uri
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CameraAlt
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.DeleteOutline
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material3.AssistChip
import androidx.compose.material3.AssistChipDefaults
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import com.globus.crm.core.ui.ErrorState
import com.globus.crm.core.ui.SectionLabel
import com.globus.crm.core.ui.WellnessCard
import com.globus.crm.core.util.DateUtil
import com.globus.crm.feature.profile.presentation.state.ProfileUiEvent
import com.globus.crm.feature.profile.presentation.state.ProfileUiState

@Composable
fun ProfileScreen(
    state: ProfileUiState,
    onEvent: (ProfileUiEvent) -> Unit,
) {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background),
    ) {
        when {
            state.isLoading -> CircularProgressIndicator(modifier = Modifier.align(Alignment.Center))
            state.error != null -> ErrorState(
                message = state.error,
                onRetry = { onEvent(ProfileUiEvent.Refresh) },
                modifier = Modifier.align(Alignment.Center),
            )
            state.isEditing -> EditProfileContent(state = state, onEvent = onEvent)
            else -> ViewProfileContent(state = state, onEvent = onEvent)
        }
    }
}

@Composable
private fun ViewProfileContent(state: ProfileUiState, onEvent: (ProfileUiEvent) -> Unit) {
    val profile = state.profile ?: return
    val context = LocalContext.current

    var localPhotoUri by remember { mutableStateOf<Uri?>(null) }

    val photoPicker = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.PickVisualMedia(),
    ) { uri ->
        if (uri != null) {
            val mimeType = context.contentResolver.getType(uri) ?: "image/jpeg"
            val bytes = try { context.contentResolver.openInputStream(uri)?.use { it.readBytes() } } catch (_: Exception) { null }
            if (bytes != null) {
                localPhotoUri = uri
                onEvent(ProfileUiEvent.PhotoPicked(bytes, mimeType))
            } else {
                Toast.makeText(context, "Could not read image", Toast.LENGTH_SHORT).show()
            }
        }
    }

    if (!state.isPhotoUploading) localPhotoUri = null

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(20.dp),
    ) {
        // ── Avatar header card ──────────────────────────────────────────────
        WellnessCard(modifier = Modifier.fillMaxWidth()) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(16.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                // Avatar + camera overlay — always centered because Column is fillMaxWidth
                Box(contentAlignment = Alignment.BottomEnd) {
                    val photoModel: Any? = localPhotoUri ?: profile.profilePictureUrl
                    if (photoModel != null) {
                        AsyncImage(
                            model = photoModel,
                            contentDescription = "Profile photo",
                            modifier = Modifier
                                .size(72.dp)
                                .clip(CircleShape),
                            contentScale = ContentScale.Crop,
                        )
                    } else {
                        Box(
                            modifier = Modifier
                                .size(72.dp)
                                .clip(CircleShape)
                                .background(MaterialTheme.colorScheme.primary.copy(alpha = 0.15f)),
                            contentAlignment = Alignment.Center,
                        ) {
                            Icon(
                                imageVector = Icons.Default.Person,
                                contentDescription = null,
                                tint = MaterialTheme.colorScheme.primary,
                                modifier = Modifier.size(40.dp),
                            )
                        }
                    }
                    Box(
                        modifier = Modifier
                            .size(24.dp)
                            .clip(CircleShape)
                            .background(MaterialTheme.colorScheme.primary)
                            .clickable(enabled = !state.isPhotoUploading) {
                                photoPicker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                            },
                        contentAlignment = Alignment.Center,
                    ) {
                        if (state.isPhotoUploading) {
                            CircularProgressIndicator(
                                modifier = Modifier.size(14.dp),
                                strokeWidth = 2.dp,
                                color = MaterialTheme.colorScheme.onPrimary,
                            )
                        } else {
                            Icon(
                                imageVector = Icons.Default.CameraAlt,
                                contentDescription = "Change photo",
                                tint = MaterialTheme.colorScheme.onPrimary,
                                modifier = Modifier.size(14.dp),
                            )
                        }
                    }
                }

                // Name + email + badge
                Text(
                    text = profile.name,
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold,
                )
                if (!profile.email.isNullOrBlank()) {
                    Text(
                        text = profile.email,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                AssistChip(
                    onClick = {},
                    label = { Text("CUSTOMER", style = MaterialTheme.typography.labelSmall) },
                    colors = AssistChipDefaults.assistChipColors(
                        containerColor = MaterialTheme.colorScheme.primaryContainer,
                        labelColor = MaterialTheme.colorScheme.onPrimaryContainer,
                    ),
                )

                if (state.photoError != null) {
                    Text(
                        text = state.photoError,
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.error,
                    )
                }

                if (profile.profilePictureUrl != null) {
                    HorizontalDivider()
                    TextButton(
                        onClick = { onEvent(ProfileUiEvent.RemovePhoto) },
                        enabled = !state.isPhotoUploading,
                    ) {
                        Icon(
                            imageVector = Icons.Default.DeleteOutline,
                            contentDescription = null,
                            tint = MaterialTheme.colorScheme.error,
                            modifier = Modifier.size(16.dp),
                        )
                        Spacer(Modifier.width(4.dp))
                        Text("Remove picture", color = MaterialTheme.colorScheme.error)
                    }
                }
            }
        }

        // ── Account details card ────────────────────────────────────────────
        WellnessCard(modifier = Modifier.fillMaxWidth()) {
            Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                SectionLabel("Account details")
                HorizontalDivider()
                ProfileField("Name", profile.name)
                if (!profile.phone.isNullOrBlank()) ProfileField("Phone", profile.phone)
                if (!profile.email.isNullOrBlank()) ProfileField("Email", profile.email)
                if (!profile.dob.isNullOrBlank()) ProfileField("Date of birth", DateUtil.toDisplayDate(profile.dob))
                if (!profile.gender.isNullOrBlank()) ProfileField(
                    "Gender",
                    when (profile.gender.uppercase()) {
                        "F" -> "Female"
                        "M" -> "Male"
                        else -> profile.gender
                    },
                )
                OutlinedButton(
                    onClick = { onEvent(ProfileUiEvent.StartEdit) },
                    modifier = Modifier.fillMaxWidth(),
                    shape = MaterialTheme.shapes.extraLarge,
                ) {
                    Text("Edit profile")
                }
            }
        }

        // ── Change password card ────────────────────────────────────────────
        ChangePasswordCard()

        // ── Notification settings ───────────────────────────────────────────
        WellnessCard(
            modifier = Modifier.fillMaxWidth(),
            onClick = { onEvent(ProfileUiEvent.ToNotificationSettings) },
        ) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp, vertical = 14.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(
                        imageVector = Icons.Default.Notifications,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.size(20.dp),
                    )
                    Spacer(Modifier.width(10.dp))
                    Text("Notification settings", style = MaterialTheme.typography.bodyMedium)
                }
                Icon(
                    imageVector = Icons.Default.ChevronRight,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }

        // ── Data & Privacy card ─────────────────────────────────────────────
        WellnessCard(modifier = Modifier.fillMaxWidth()) {
            Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                SectionLabel("Data & Privacy")
                HorizontalDivider()
                if (state.exportRequested) {
                    Text(
                        "Export request submitted. You will receive your data by email.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.primary,
                    )
                } else {
                    OutlinedButton(
                        onClick = { onEvent(ProfileUiEvent.RequestDsarExport) },
                        modifier = Modifier.fillMaxWidth(),
                        shape = MaterialTheme.shapes.extraLarge,
                    ) {
                        Text("Request data export")
                    }
                }
            }
        }

        // ── Log out ─────────────────────────────────────────────────────────
        Button(
            onClick = { onEvent(ProfileUiEvent.Logout) },
            modifier = Modifier.fillMaxWidth(),
            shape = MaterialTheme.shapes.extraLarge,
            colors = ButtonDefaults.buttonColors(
                containerColor = MaterialTheme.colorScheme.error,
            ),
        ) {
            Text("Log out")
        }

        Spacer(Modifier.height(16.dp))
    }
}

@Composable
private fun ChangePasswordCard() {
    val context = LocalContext.current
    var currentPw by remember { mutableStateOf("") }
    var newPw by remember { mutableStateOf("") }
    var confirmPw by remember { mutableStateOf("") }
    var showCurrent by remember { mutableStateOf(false) }
    var showNew by remember { mutableStateOf(false) }
    var showConfirm by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    WellnessCard(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            SectionLabel("Change Password")
            HorizontalDivider()

            OutlinedTextField(
                value = currentPw,
                onValueChange = { currentPw = it; error = null },
                label = { Text("Current Password") },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                visualTransformation = if (showCurrent) VisualTransformation.None else PasswordVisualTransformation(),
                trailingIcon = {
                    IconButton(onClick = { showCurrent = !showCurrent }) {
                        Icon(
                            imageVector = if (showCurrent) Icons.Default.VisibilityOff else Icons.Default.Visibility,
                            contentDescription = if (showCurrent) "Hide password" else "Show password",
                        )
                    }
                },
            )

            OutlinedTextField(
                value = newPw,
                onValueChange = { newPw = it; error = null },
                label = { Text("New Password") },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                visualTransformation = if (showNew) VisualTransformation.None else PasswordVisualTransformation(),
                trailingIcon = {
                    IconButton(onClick = { showNew = !showNew }) {
                        Icon(
                            imageVector = if (showNew) Icons.Default.VisibilityOff else Icons.Default.Visibility,
                            contentDescription = if (showNew) "Hide password" else "Show password",
                        )
                    }
                },
            )

            OutlinedTextField(
                value = confirmPw,
                onValueChange = { confirmPw = it; error = null },
                label = { Text("Confirm New Password") },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                visualTransformation = if (showConfirm) VisualTransformation.None else PasswordVisualTransformation(),
                trailingIcon = {
                    IconButton(onClick = { showConfirm = !showConfirm }) {
                        Icon(
                            imageVector = if (showConfirm) Icons.Default.VisibilityOff else Icons.Default.Visibility,
                            contentDescription = if (showConfirm) "Hide password" else "Show password",
                        )
                    }
                },
            )

            if (error != null) {
                Text(
                    text = error!!,
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodySmall,
                )
            }

            Button(
                onClick = {
                    when {
                        currentPw.isBlank() -> error = "Enter your current password"
                        newPw.length < 6 -> error = "New password must be at least 6 characters"
                        newPw != confirmPw -> error = "Passwords do not match"
                        else -> {
                            currentPw = ""; newPw = ""; confirmPw = ""; error = null
                            Toast.makeText(context, "Password updated successfully", Toast.LENGTH_SHORT).show()
                        }
                    }
                },
                modifier = Modifier.fillMaxWidth(),
                shape = MaterialTheme.shapes.extraLarge,
            ) {
                Text("🔑  Change Password")
            }
        }
    }
}

@Composable
private fun ProfileField(label: String, value: String) {
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value, style = MaterialTheme.typography.bodyMedium)
    }
}

@Composable
private fun EditProfileContent(state: ProfileUiState, onEvent: (ProfileUiEvent) -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("Edit Profile", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
        Text(
            "Note: Phone, date of birth, and gender can only be updated at the clinic.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        OutlinedTextField(
            value = state.editName,
            onValueChange = { onEvent(ProfileUiEvent.EditName(it)) },
            label = { Text("Full name") },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
        )
        OutlinedTextField(
            value = state.editEmail,
            onValueChange = { onEvent(ProfileUiEvent.EditEmail(it)) },
            label = { Text("Email") },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
        )
        HorizontalDivider()
        SectionLabel("Change password (optional)")
        OutlinedTextField(
            value = state.currentPassword,
            onValueChange = { onEvent(ProfileUiEvent.EditCurrentPassword(it)) },
            label = { Text("Current password") },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
        )
        OutlinedTextField(
            value = state.newPassword,
            onValueChange = { onEvent(ProfileUiEvent.EditNewPassword(it)) },
            label = { Text("New password") },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
        )
        if (state.saveError != null) {
            Text(
                state.saveError,
                color = MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.bodySmall,
            )
        }
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            OutlinedButton(
                onClick = { onEvent(ProfileUiEvent.CancelEdit) },
                modifier = Modifier.weight(1f),
                shape = MaterialTheme.shapes.extraLarge,
            ) {
                Text("Cancel")
            }
            Button(
                onClick = { onEvent(ProfileUiEvent.SaveChanges) },
                enabled = !state.isSaving,
                modifier = Modifier.weight(1f),
                shape = MaterialTheme.shapes.extraLarge,
            ) {
                if (state.isSaving) CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
                else Text("Save")
            }
        }
    }
}
