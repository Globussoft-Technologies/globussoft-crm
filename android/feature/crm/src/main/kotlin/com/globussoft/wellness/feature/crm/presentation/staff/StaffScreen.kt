package com.globussoft.wellness.feature.crm.presentation.staff

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.PersonOff
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SuggestionChip
import androidx.compose.material3.SuggestionChipDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.globussoft.wellness.core.designsystem.components.EmptyState
import com.globussoft.wellness.core.designsystem.components.ErrorState
import com.globussoft.wellness.core.designsystem.components.ShimmerList
import com.globussoft.wellness.core.designsystem.components.WellnessCard
import com.globussoft.wellness.core.designsystem.components.WellnessSearchBar
import com.globussoft.wellness.core.designsystem.theme.Dimens
import com.globussoft.wellness.core.designsystem.theme.GenericAccent
import com.globussoft.wellness.core.designsystem.theme.GenericPrimary

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun StaffScreen(
    viewModel: StaffViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    val filteredStaff = if (state.search.isBlank()) state.staff
    else state.staff.filter { member ->
        val name  = member["name"]?.toString() ?: ""
        val email = member["email"]?.toString() ?: ""
        val role  = member["role"]?.toString() ?: ""
        name.contains(state.search, ignoreCase = true) ||
            email.contains(state.search, ignoreCase = true) ||
            role.contains(state.search, ignoreCase = true)
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title  = { Text("Staff Management") },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.surface),
            )
        },
        floatingActionButton = {
            FloatingActionButton(onClick = { viewModel.showCreate() }, containerColor = GenericPrimary) {
                Icon(Icons.Default.Add, "Add Staff", tint = Color.White)
            }
        },
    ) { paddingValues ->
        PullToRefreshBox(
            isRefreshing = state.isLoading,
            onRefresh    = { viewModel.refresh() },
            modifier     = Modifier
                .fillMaxSize()
                .padding(paddingValues),
        ) {
            Column(modifier = Modifier.fillMaxSize()) {
                WellnessSearchBar(
                    query         = state.search,
                    onQueryChange = { viewModel.setSearch(it) },
                    placeholder   = "Search staff…",
                    modifier      = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = Dimens.SpacingLg, vertical = Dimens.SpacingSm),
                    onClear       = { viewModel.setSearch("") },
                )
                when {
                    state.isLoading && filteredStaff.isEmpty() -> ShimmerList(
                        itemCount = 5,
                        modifier  = Modifier.padding(Dimens.SpacingLg),
                    )
                    state.error != null -> ErrorState(
                        message  = state.error!!,
                        onRetry  = { viewModel.refresh() },
                        modifier = Modifier.fillMaxSize(),
                    )
                    filteredStaff.isEmpty() -> EmptyState(
                        message  = "No staff members found",
                        modifier = Modifier.fillMaxSize(),
                    )
                    else -> LazyColumn(
                        modifier            = Modifier.fillMaxSize(),
                        verticalArrangement = Arrangement.spacedBy(Dimens.SpacingSm),
                        contentPadding      = PaddingValues(
                            horizontal = Dimens.SpacingLg,
                            vertical   = Dimens.SpacingSm,
                        ),
                    ) {
                        items(filteredStaff, key = { it["id"]?.toString() ?: it.hashCode().toString() }) { member ->
                            val memberId = member["id"]?.toString() ?: ""
                            val isActive = member["isActive"]?.let {
                                when (it) {
                                    is Boolean -> it
                                    is String  -> it.equals("true", ignoreCase = true)
                                    else       -> false
                                }
                            } ?: false
                            StaffCard(
                                member       = member,
                                onEdit       = { viewModel.showEdit(member) },
                                onDeactivate = if (isActive) ({ viewModel.deactivateMember(memberId) }) else null,
                            )
                        }
                    }
                }
            }
        }

        if (state.showForm) {
            val editingMember = if (state.editingId != null) {
                state.staff.find { it["id"]?.toString() == state.editingId }
            } else null
            StaffFormSheet(
                editing      = editingMember,
                isSubmitting = state.isSubmitting,
                formError    = state.formError,
                onDismiss    = { viewModel.dismissForm() },
                onSave       = { name, email, role -> viewModel.saveMember(name, email, role) },
            )
        }
    }
}

@Composable
private fun StaffCard(
    member:       Map<String, Any>,
    onEdit:       () -> Unit,
    onDeactivate: (() -> Unit)?,
    modifier:     Modifier = Modifier,
) {
    val name     = member["name"]?.toString() ?: "Unknown"
    val email    = member["email"]?.toString() ?: ""
    val role     = member["role"]?.toString() ?: "USER"
    val isActive = member["isActive"]?.let {
        when (it) {
            is Boolean -> it
            is String  -> it.equals("true", ignoreCase = true)
            else       -> false
        }
    } ?: false
    var showDeactivateDialog by remember { mutableStateOf(false) }

    if (showDeactivateDialog) {
        AlertDialog(
            onDismissRequest = { showDeactivateDialog = false },
            title   = { Text("Deactivate $name?") },
            text    = { Text("The user will lose access to the system.") },
            confirmButton = {
                Button(
                    onClick = { showDeactivateDialog = false; onDeactivate?.invoke() },
                    colors  = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error),
                ) { Text("Deactivate") }
            },
            dismissButton = {
                TextButton(onClick = { showDeactivateDialog = false }) { Text("Cancel") }
            },
        )
    }

    WellnessCard(modifier = modifier.fillMaxWidth()) {
        Row(
            modifier          = Modifier
                .fillMaxWidth()
                .padding(Dimens.SpacingLg),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(text = name, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                if (email.isNotBlank()) {
                    Text(
                        text  = email,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            Spacer(Modifier.width(Dimens.SpacingXs))
            RoleChip(role = role)
            Spacer(Modifier.width(Dimens.SpacingXs))
            ActiveBadge(isActive = isActive)
            if (onDeactivate != null) {
                IconButton(
                    onClick = { showDeactivateDialog = true },
                    colors  = IconButtonDefaults.iconButtonColors(contentColor = MaterialTheme.colorScheme.error),
                ) {
                    Icon(Icons.Default.PersonOff, contentDescription = "Deactivate", Modifier.width(18.dp))
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun StaffFormSheet(
    editing: Map<String, Any>?,
    isSubmitting: Boolean,
    formError: String?,
    onDismiss: () -> Unit,
    onSave: (String, String, String) -> Unit,
) {
    var name  by remember(editing?.get("id")) { mutableStateOf(editing?.get("name")?.toString() ?: "") }
    var email by remember(editing?.get("id")) { mutableStateOf(editing?.get("email")?.toString() ?: "") }
    var role  by remember(editing?.get("id")) { mutableStateOf(editing?.get("role")?.toString() ?: "USER") }
    val roles = listOf("ADMIN", "MANAGER", "USER")

    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(
            modifier = Modifier
                .padding(horizontal = 24.dp, vertical = 8.dp)
                .padding(bottom = 32.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(
                text  = if (editing != null) "Edit Staff Member" else "Add Staff Member",
                style = MaterialTheme.typography.titleMedium,
            )
            OutlinedTextField(
                value         = name,
                onValueChange = { name = it },
                label         = { Text("Name *") },
                modifier      = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value         = email,
                onValueChange = { email = it },
                label         = { Text("Email *") },
                modifier      = Modifier.fillMaxWidth(),
            )
            Text("Role", style = MaterialTheme.typography.labelMedium)
            LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                items(roles) { r ->
                    FilterChip(
                        selected = role == r,
                        onClick  = { role = r },
                        label    = { Text(r) },
                        colors   = FilterChipDefaults.filterChipColors(
                            selectedContainerColor = GenericPrimary,
                            selectedLabelColor     = Color.White,
                        ),
                    )
                }
            }
            formError?.let {
                Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
            }
            Button(
                onClick  = { onSave(name, email, role) },
                enabled  = name.isNotBlank() && email.isNotBlank() && !isSubmitting,
                modifier = Modifier.fillMaxWidth(),
                colors   = ButtonDefaults.buttonColors(containerColor = GenericPrimary),
            ) {
                Text(if (isSubmitting) "Saving…" else if (editing != null) "Save Changes" else "Add Member")
            }
        }
    }
}

@Composable
private fun RoleChip(role: String) {
    val (label, containerColor) = when (role.uppercase()) {
        "ADMIN"   -> "Admin"   to GenericPrimary
        "MANAGER" -> "Manager" to GenericAccent
        else      -> "User"    to Color(0xFF6B7280)
    }
    SuggestionChip(
        onClick = {},
        label   = {
            Text(
                text  = label,
                style = MaterialTheme.typography.labelSmall,
                color = Color.White,
            )
        },
        colors  = SuggestionChipDefaults.suggestionChipColors(containerColor = containerColor),
        border  = null,
    )
}

@Composable
private fun ActiveBadge(isActive: Boolean) {
    val (label, containerColor) = if (isActive) "Active" to GenericAccent else "Inactive" to Color(0xFF9CA3AF)
    SuggestionChip(
        onClick = {},
        label   = {
            Text(
                text  = label,
                style = MaterialTheme.typography.labelSmall,
                color = Color.White,
            )
        },
        colors  = SuggestionChipDefaults.suggestionChipColors(containerColor = containerColor),
        border  = null,
    )
}
