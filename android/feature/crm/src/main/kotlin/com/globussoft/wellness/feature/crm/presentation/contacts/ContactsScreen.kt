package com.globussoft.wellness.feature.crm.presentation.contacts

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import android.content.Intent
import android.net.Uri
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SuggestionChip
import androidx.compose.material3.SuggestionChipDefaults
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.material3.rememberSwipeToDismissBoxState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.globussoft.wellness.core.designsystem.components.EmptyState
import com.globussoft.wellness.core.designsystem.components.ErrorState
import com.globussoft.wellness.core.designsystem.components.ShimmerList
import com.globussoft.wellness.core.designsystem.components.WellnessCard
import com.globussoft.wellness.core.designsystem.theme.Dimens
import com.globussoft.wellness.core.designsystem.theme.GenericAccent
import com.globussoft.wellness.core.designsystem.theme.GenericPrimary
import com.globussoft.wellness.core.domain.model.Contact

// ─── Status filter options ────────────────────────────────────────────────────

private val STATUS_FILTERS = listOf(
    null         to "All",
    "Lead"       to "Lead",
    "Prospect"   to "Prospect",
    "Contact"    to "Contact",
    "Client"     to "Client",
    "Customer"   to "Customer",
    "Churned"    to "Churned",
    "Junk"       to "Junk",
)

// ─── Public composable ────────────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ContactsScreen(
    viewModel: ContactsViewModel = hiltViewModel(),
    onContactClick: (String) -> Unit = {},
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    var menuExpanded by remember { mutableStateOf(false) }

    fun exportCsv() {
        val header = "Name,Email,Phone,Company,Status,Source,AI Score,Assignee"
        val rows = state.contacts.joinToString("\n") { c ->
            listOf(c.name, c.email ?: "", c.phone ?: "", c.company ?: "",
                   c.status ?: "", c.source ?: "", c.aiScore.toString(), c.assigneeName ?: "")
                .joinToString(",") { field -> "\"${field.replace("\"", "\"\"")}\"" }
        }
        val csv = "$header\n$rows"
        val intent = Intent(Intent.ACTION_SEND).apply {
            type = "text/csv"
            putExtra(Intent.EXTRA_TEXT, csv)
            putExtra(Intent.EXTRA_SUBJECT, "Contacts Export")
        }
        context.startActivity(Intent.createChooser(intent, "Export Contacts"))
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text("Contacts")
                        if (state.contacts.isNotEmpty()) {
                            Text(
                                text  = "${state.contacts.size} contacts",
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                },
                actions = {
                    IconButton(onClick = { menuExpanded = true }) {
                        Icon(Icons.Default.MoreVert, contentDescription = "More options")
                    }
                    DropdownMenu(
                        expanded         = menuExpanded,
                        onDismissRequest = { menuExpanded = false },
                    ) {
                        DropdownMenuItem(
                            text    = { Text("Export CSV") },
                            onClick = { menuExpanded = false; exportCsv() },
                        )
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.surface,
                ),
            )
        },
        floatingActionButton = {
            FloatingActionButton(
                onClick        = { viewModel.showAdd() },
                containerColor = GenericPrimary,
                contentColor   = Color.White,
            ) {
                Icon(Icons.Default.Add, contentDescription = "Add Contact")
            }
        },
        containerColor = MaterialTheme.colorScheme.background,
    ) { contentPadding ->
        PullToRefreshBox(
            isRefreshing = state.isLoading && state.contacts.isNotEmpty(),
            onRefresh    = { viewModel.refresh() },
            modifier     = Modifier
                .fillMaxSize()
                .padding(contentPadding),
        ) {
            Column(modifier = Modifier.fillMaxSize()) {
                // Search bar
                OutlinedTextField(
                    value         = state.search,
                    onValueChange = { viewModel.setSearch(it) },
                    placeholder   = { Text("Search contacts…") },
                    leadingIcon   = {
                        Icon(Icons.Default.Search, contentDescription = null)
                    },
                    singleLine    = true,
                    modifier      = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = Dimens.SpacingLg, vertical = Dimens.SpacingSm),
                    shape         = RoundedCornerShape(12.dp),
                )

                // Status filter chips
                LazyRow(
                    contentPadding        = PaddingValues(horizontal = Dimens.SpacingLg),
                    horizontalArrangement = Arrangement.spacedBy(Dimens.SpacingSm),
                    modifier              = Modifier.padding(bottom = Dimens.SpacingSm),
                ) {
                    items(STATUS_FILTERS) { (value, label) ->
                        FilterChip(
                            selected = state.selectedStatus == value,
                            onClick  = { viewModel.setStatus(value) },
                            label    = { Text(label) },
                            colors   = FilterChipDefaults.filterChipColors(
                                selectedContainerColor = GenericPrimary,
                                selectedLabelColor     = Color.White,
                            ),
                        )
                    }
                }

                // Contact list
                when {
                    state.isLoading && state.contacts.isEmpty() -> {
                        ShimmerList(
                            itemCount = 6,
                            modifier  = Modifier.fillMaxSize(),
                        )
                    }
                    state.error != null && state.contacts.isEmpty() -> {
                        ErrorState(
                            message  = state.error ?: "Failed to load contacts",
                            onRetry  = { viewModel.refresh() },
                            modifier = Modifier.fillMaxSize(),
                        )
                    }
                    state.contacts.isEmpty() -> {
                        EmptyState(
                            message  = "No contacts found. Try adjusting your filters.",
                            modifier = Modifier.fillMaxSize(),
                        )
                    }
                    else -> {
                        LazyColumn(
                            contentPadding      = PaddingValues(
                                horizontal = Dimens.SpacingLg,
                                vertical   = Dimens.SpacingSm,
                            ),
                            verticalArrangement = Arrangement.spacedBy(Dimens.SpacingSm),
                        ) {
                            items(state.contacts, key = { it.id }) { contact ->
                                SwipeToDeleteContactItem(
                                    contact        = contact,
                                    onContactClick = onContactClick,
                                    onLongPress    = { viewModel.showEdit(contact) },
                                    onDelete       = { viewModel.confirmDelete(contact.id) },
                                )
                            }
                        }
                    }
                }
            }
        }

        // Delete confirmation dialog
        state.deleteConfirmId?.let { deleteId ->
            AlertDialog(
                onDismissRequest = { viewModel.cancelDelete() },
                title            = { Text("Delete Contact") },
                text             = { Text("This contact will be permanently deleted.") },
                confirmButton    = {
                    TextButton(onClick = { viewModel.deleteContact(deleteId) }) {
                        Text("Delete", color = MaterialTheme.colorScheme.error)
                    }
                },
                dismissButton    = {
                    TextButton(onClick = { viewModel.cancelDelete() }) { Text("Cancel") }
                },
            )
        }

        // Add / Edit ModalBottomSheet
        if (state.showAddForm) {
            ContactFormSheet(state = state, viewModel = viewModel)
        }
    }
}

// ─── Swipe-to-delete wrapper ──────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class, ExperimentalFoundationApi::class)
@Composable
private fun SwipeToDeleteContactItem(
    contact: Contact,
    onContactClick: (String) -> Unit,
    onLongPress: () -> Unit,
    onDelete: () -> Unit,
) {
    val dismissState = rememberSwipeToDismissBoxState(
        confirmValueChange = { value ->
            if (value == SwipeToDismissBoxValue.EndToStart) {
                onDelete()
                true
            } else {
                false
            }
        },
    )

    SwipeToDismissBox(
        state             = dismissState,
        backgroundContent = {
            Box(
                modifier         = Modifier
                    .fillMaxSize()
                    .background(MaterialTheme.colorScheme.error)
                    .padding(end = 16.dp),
                contentAlignment = Alignment.CenterEnd,
            ) {
                Icon(Icons.Default.Delete, contentDescription = "Delete", tint = Color.White)
            }
        },
        enableDismissFromStartToEnd = false,
    ) {
        ContactCard(
            contact        = contact,
            onContactClick = onContactClick,
            onLongPress    = onLongPress,
        )
    }
}

// ─── Add / Edit bottom sheet ──────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ContactFormSheet(
    state: ContactsUiState,
    viewModel: ContactsViewModel,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val formKey    = state.editingContact?.id ?: "new"

    var name    by rememberSaveable(formKey) { mutableStateOf(state.editingContact?.name    ?: "") }
    var email   by rememberSaveable(formKey) { mutableStateOf(state.editingContact?.email   ?: "") }
    var phone   by rememberSaveable(formKey) { mutableStateOf(state.editingContact?.phone   ?: "") }
    var company by rememberSaveable(formKey) { mutableStateOf(state.editingContact?.company ?: "") }
    var status  by rememberSaveable(formKey) { mutableStateOf(state.editingContact?.status  ?: "Lead") }

    ModalBottomSheet(
        onDismissRequest = { viewModel.dismissForm() },
        sheetState       = sheetState,
    ) {
        Column(
            modifier            = Modifier
                .fillMaxWidth()
                .padding(horizontal = 24.dp, vertical = 16.dp)
                .navigationBarsPadding(),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(
                text  = if (state.editingContact != null) "Edit Contact" else "New Contact",
                style = MaterialTheme.typography.titleMedium,
            )

            OutlinedTextField(
                value         = name,
                onValueChange = { name = it },
                label         = { Text("Name *") },
                singleLine    = true,
                modifier      = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value           = email,
                onValueChange   = { email = it },
                label           = { Text("Email") },
                singleLine      = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
                modifier        = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value           = phone,
                onValueChange   = { phone = it },
                label           = { Text("Phone") },
                singleLine      = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone),
                modifier        = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value         = company,
                onValueChange = { company = it },
                label         = { Text("Company") },
                singleLine    = true,
                modifier      = Modifier.fillMaxWidth(),
            )

            // Status picker
            run {
                val statuses = listOf("Lead", "Prospect", "Contact", "Client", "Customer", "Churned", "Junk")
                Text("Status", style = MaterialTheme.typography.labelLarge)
                LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    items(statuses) { s ->
                        FilterChip(
                            selected = status == s,
                            onClick  = { status = s },
                            label    = { Text(s) },
                            colors   = FilterChipDefaults.filterChipColors(
                                selectedContainerColor = GenericPrimary,
                                selectedLabelColor     = Color.White,
                            ),
                        )
                    }
                }
            }

            state.formError?.let { err ->
                Text(
                    text  = err,
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodySmall,
                )
            }

            Button(
                onClick  = {
                    if (name.isNotBlank()) {
                        viewModel.saveContact(name, email, phone, company, status)
                    }
                },
                enabled  = name.isNotBlank() && !state.isCreating,
                modifier = Modifier.fillMaxWidth(),
                colors   = ButtonDefaults.buttonColors(containerColor = GenericPrimary),
            ) {
                if (state.isCreating) {
                    CircularProgressIndicator(
                        modifier    = Modifier.size(18.dp),
                        strokeWidth = 2.dp,
                        color       = Color.White,
                    )
                } else {
                    Text(if (state.editingContact != null) "Update" else "Create")
                }
            }

            Spacer(Modifier.height(8.dp))
        }
    }
}

// ─── Contact Card ─────────────────────────────────────────────────────────────

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ContactCard(
    contact: Contact,
    onContactClick: (String) -> Unit,
    onLongPress: () -> Unit,
) {
    WellnessCard(
        modifier = Modifier
            .fillMaxWidth()
            .combinedClickable(
                onClick    = { onContactClick(contact.id) },
                onLongClick = onLongPress,
            ),
    ) {
        Row(
            modifier          = Modifier
                .fillMaxWidth()
                .padding(Dimens.SpacingMd),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            // Avatar circle
            Box(
                modifier         = Modifier
                    .size(44.dp)
                    .clip(CircleShape)
                    .background(GenericPrimary.copy(alpha = 0.15f)),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text       = contact.name.take(1).uppercase(),
                    style      = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold,
                    color      = GenericPrimary,
                )
            }

            Spacer(modifier = Modifier.width(Dimens.SpacingMd))

            // Details column
            Column(modifier = Modifier.weight(1f)) {
                Row(
                    modifier              = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment     = Alignment.CenterVertically,
                ) {
                    Text(
                        text       = contact.name,
                        style      = MaterialTheme.typography.titleSmall,
                        fontWeight = FontWeight.SemiBold,
                        modifier   = Modifier.weight(1f),
                    )
                    Spacer(modifier = Modifier.width(4.dp))
                    AiScoreBadge(score = contact.aiScore)
                }

                contact.email?.let { email ->
                    Text(
                        text  = email,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                contact.phone?.let { phone ->
                    Text(
                        text  = phone,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }

                Spacer(modifier = Modifier.height(4.dp))

                Row(
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    verticalAlignment     = Alignment.CenterVertically,
                ) {
                    contact.status?.let { status ->
                        StatusChip(status = status)
                    }
                    contact.company?.let { company ->
                        Text(
                            text  = company,
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
        }
    }
}

// ─── Status Chip ──────────────────────────────────────────────────────────────

@Composable
private fun StatusChip(status: String) {
    val color = statusColor(status)
    SuggestionChip(
        onClick = {},
        label   = {
            Text(
                text  = status,
                style = MaterialTheme.typography.labelSmall,
            )
        },
        colors = SuggestionChipDefaults.suggestionChipColors(
            containerColor = color.copy(alpha = 0.15f),
            labelColor     = color,
        ),
        border = SuggestionChipDefaults.suggestionChipBorder(
            enabled     = true,
            borderColor = color.copy(alpha = 0.4f),
            borderWidth = 1.dp,
        ),
    )
}

private fun statusColor(status: String): Color = when (status.lowercase()) {
    "lead"     -> Color(0xFF8B5CF6)
    "prospect" -> Color(0xFF6366F1)
    "contact"  -> Color(0xFF3B82F6)
    "client",
    "customer" -> GenericAccent
    "churned"  -> Color(0xFFF59E0B)
    "junk"     -> Color(0xFF6B7280)
    else       -> Color(0xFF6B7280)
}

// ─── AI Score Badge ───────────────────────────────────────────────────────────

@Composable
private fun AiScoreBadge(score: Int) {
    val color = when {
        score >= 70 -> GenericAccent
        score >= 40 -> Color(0xFFF59E0B)
        else        -> Color(0xFFEF4444)
    }
    Box(
        modifier         = Modifier
            .clip(RoundedCornerShape(4.dp))
            .background(color.copy(alpha = 0.15f))
            .padding(horizontal = 6.dp, vertical = 2.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text       = "$score",
            style      = MaterialTheme.typography.labelSmall,
            fontWeight = FontWeight.Bold,
            color      = color,
        )
    }
}
