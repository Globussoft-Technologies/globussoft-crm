package com.globussoft.wellness.feature.crm.presentation.leads

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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.PersonAdd
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.AlertDialog
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
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
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

private val SOURCE_FILTERS = listOf(
    null          to "All",
    "Organic"     to "Organic",
    "LinkedIn"    to "LinkedIn",
    "Cold Call"   to "Cold Call",
    "Referral"    to "Referral",
    "Website"     to "Website",
    "Event"       to "Event",
    "Marketplace" to "Marketplace",
    "Other"       to "Other",
)

@OptIn(ExperimentalMaterial3Api::class, ExperimentalFoundationApi::class)
@Composable
fun LeadsScreen(
    viewModel: LeadsViewModel = hiltViewModel(),
    onLeadClick: (String) -> Unit = {},
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)

    // Delete confirmation dialog
    state.deleteConfirmId?.let { idToDelete ->
        AlertDialog(
            onDismissRequest = { viewModel.cancelDelete() },
            title            = { Text("Delete Lead") },
            text             = { Text("Are you sure you want to delete this lead?") },
            confirmButton    = {
                Button(
                    onClick = { viewModel.deleteLead(idToDelete) },
                    colors  = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error),
                ) { Text("Delete") }
            },
            dismissButton    = {
                TextButton(onClick = { viewModel.cancelDelete() }) { Text("Cancel") }
            },
        )
    }

    // Add/Edit bottom sheet
    if (state.showAddForm) {
        val editing = state.editingLead
        var name    by remember(editing?.id ?: "new") { mutableStateOf(editing?.name ?: "") }
        var email   by remember(editing?.id ?: "new") { mutableStateOf(editing?.email ?: "") }
        var phone   by remember(editing?.id ?: "new") { mutableStateOf(editing?.phone ?: "") }
        var company by remember(editing?.id ?: "new") { mutableStateOf(editing?.company ?: "") }
        var source  by remember(editing?.id ?: "new") { mutableStateOf(editing?.source ?: "") }

        ModalBottomSheet(
            onDismissRequest = { viewModel.dismissForm() },
            sheetState       = sheetState,
        ) {
            Column(
                modifier              = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = Dimens.SpacingLg, vertical = Dimens.SpacingMd)
                    .navigationBarsPadding(),
                verticalArrangement   = Arrangement.spacedBy(Dimens.SpacingMd),
            ) {
                Text(
                    text  = if (editing != null) "Edit Lead" else "New Lead",
                    style = MaterialTheme.typography.titleLarge,
                )

                OutlinedTextField(
                    value         = name,
                    onValueChange = { name = it },
                    label         = { Text("Name *") },
                    singleLine    = true,
                    modifier      = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value         = email,
                    onValueChange = { email = it },
                    label         = { Text("Email") },
                    singleLine    = true,
                    modifier      = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value         = phone,
                    onValueChange = { phone = it },
                    label         = { Text("Phone") },
                    singleLine    = true,
                    modifier      = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value         = company,
                    onValueChange = { company = it },
                    label         = { Text("Company") },
                    singleLine    = true,
                    modifier      = Modifier.fillMaxWidth(),
                )

                Text("Source", style = MaterialTheme.typography.labelLarge)
                LazyRow(horizontalArrangement = Arrangement.spacedBy(Dimens.SpacingSm)) {
                    items(SOURCE_FILTERS.mapNotNull { (value, label) -> if (value != null) value to label else null }) { (value, label) ->
                        FilterChip(
                            selected = source == value,
                            onClick  = { source = value },
                            label    = { Text(label) },
                            colors   = FilterChipDefaults.filterChipColors(
                                selectedContainerColor = GenericPrimary,
                                selectedLabelColor     = Color.White,
                            ),
                        )
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
                    onClick  = { viewModel.saveLead(name, email, phone, company, source) },
                    enabled  = name.isNotBlank() && !state.isCreating,
                    modifier = Modifier.fillMaxWidth(),
                    colors   = ButtonDefaults.buttonColors(containerColor = GenericPrimary),
                ) {
                    if (state.isCreating) {
                        CircularProgressIndicator(color = Color.White, modifier = Modifier.height(18.dp).width(18.dp))
                    } else {
                        Text(if (editing != null) "Update" else "Create")
                    }
                }

                Spacer(Modifier.height(Dimens.SpacingSm))
            }
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text("Leads")
                        if (state.leads.isNotEmpty()) {
                            Text(
                                text  = "${state.leads.size} leads",
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
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
                Icon(Icons.Default.Add, contentDescription = "Add Lead")
            }
        },
        containerColor = MaterialTheme.colorScheme.background,
    ) { contentPadding ->
        PullToRefreshBox(
            isRefreshing = state.isLoading && state.leads.isNotEmpty(),
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
                    placeholder   = { Text("Search leads…") },
                    leadingIcon   = {
                        Icon(Icons.Default.Search, contentDescription = null)
                    },
                    singleLine    = true,
                    modifier      = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = Dimens.SpacingLg, vertical = Dimens.SpacingSm),
                    shape         = RoundedCornerShape(12.dp),
                )

                // Source filter chips
                LazyRow(
                    contentPadding        = PaddingValues(horizontal = Dimens.SpacingLg),
                    horizontalArrangement = Arrangement.spacedBy(Dimens.SpacingSm),
                    modifier              = Modifier.padding(bottom = Dimens.SpacingSm),
                ) {
                    items(SOURCE_FILTERS) { (value, label) ->
                        FilterChip(
                            selected = state.selectedSource == value,
                            onClick  = { viewModel.setSource(value) },
                            label    = { Text(label) },
                            colors   = FilterChipDefaults.filterChipColors(
                                selectedContainerColor = GenericPrimary,
                                selectedLabelColor     = Color.White,
                            ),
                        )
                    }
                }

                // Leads list
                when {
                    state.isLoading && state.leads.isEmpty() -> {
                        ShimmerList(
                            itemCount = 6,
                            modifier  = Modifier.fillMaxSize(),
                        )
                    }
                    state.error != null && state.leads.isEmpty() -> {
                        ErrorState(
                            message  = state.error ?: "Failed to load leads",
                            onRetry  = { viewModel.refresh() },
                            modifier = Modifier.fillMaxSize(),
                        )
                    }
                    state.leads.isEmpty() -> {
                        EmptyState(
                            message  = "No leads found. Try adjusting your filters.",
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
                            items(state.leads, key = { it.id }) { lead ->
                                val dismissState = rememberSwipeToDismissBoxState(
                                    confirmValueChange = { value ->
                                        if (value == SwipeToDismissBoxValue.EndToStart) {
                                            viewModel.confirmDelete(lead.id)
                                        }
                                        false
                                    }
                                )
                                SwipeToDismissBox(
                                    state             = dismissState,
                                    enableDismissFromStartToEnd = false,
                                    backgroundContent = {
                                        Box(
                                            modifier         = Modifier
                                                .fillMaxSize()
                                                .background(
                                                    color  = MaterialTheme.colorScheme.error,
                                                    shape  = RoundedCornerShape(12.dp),
                                                )
                                                .padding(end = Dimens.SpacingLg),
                                            contentAlignment = Alignment.CenterEnd,
                                        ) {
                                            Icon(
                                                imageVector        = Icons.Default.Delete,
                                                contentDescription = "Delete",
                                                tint               = Color.White,
                                            )
                                        }
                                    },
                                ) {
                                    LeadCard(
                                        lead           = lead,
                                        onLeadClick    = onLeadClick,
                                        onLongPress    = { viewModel.showEdit(lead) },
                                        onConvert      = { viewModel.convertToContact(lead.id) },
                                        isConverting   = state.convertingId == lead.id,
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun LeadCard(
    lead:        Contact,
    onLeadClick: (String) -> Unit,
    onLongPress: () -> Unit = {},
    onConvert:   () -> Unit = {},
    isConverting: Boolean   = false,
) {
    WellnessCard(
        modifier = Modifier
            .fillMaxWidth()
            .combinedClickable(
                onClick     = { onLeadClick(lead.id) },
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
                    text       = lead.name.take(1).uppercase(),
                    style      = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold,
                    color      = GenericPrimary,
                )
            }

            Spacer(modifier = Modifier.width(Dimens.SpacingMd))

            Column(modifier = Modifier.weight(1f)) {
                Row(
                    modifier              = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment     = Alignment.CenterVertically,
                ) {
                    Text(
                        text       = lead.name,
                        style      = MaterialTheme.typography.titleSmall,
                        fontWeight = FontWeight.SemiBold,
                        modifier   = Modifier.weight(1f),
                    )
                    Spacer(modifier = Modifier.width(4.dp))
                    AiScoreBadge(score = lead.aiScore)
                }

                lead.company?.let { company ->
                    Text(
                        text  = company,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                lead.email?.let { email ->
                    Text(
                        text  = email,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                lead.phone?.let { phone ->
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
                    lead.source?.let { source ->
                        SourceChip(source = source)
                    }
                    lead.assigneeName?.let { assignee ->
                        Text(
                            text  = assignee,
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }

            // Convert to Contact button (only for Lead status)
            if (lead.status == null || lead.status == "Lead") {
                if (isConverting) {
                    CircularProgressIndicator(
                        modifier = Modifier
                            .size(24.dp)
                            .padding(start = Dimens.SpacingXs),
                        strokeWidth = 2.dp,
                        color       = GenericPrimary,
                    )
                } else {
                    IconButton(onClick = onConvert) {
                        Icon(
                            imageVector        = Icons.Default.PersonAdd,
                            contentDescription = "Convert to Contact",
                            tint               = GenericPrimary,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun SourceChip(source: String) {
    SuggestionChip(
        onClick = {},
        label   = {
            Text(
                text  = source,
                style = MaterialTheme.typography.labelSmall,
            )
        },
        colors = SuggestionChipDefaults.suggestionChipColors(
            containerColor = GenericPrimary.copy(alpha = 0.12f),
            labelColor     = GenericPrimary,
        ),
        border = SuggestionChipDefaults.suggestionChipBorder(
            enabled     = true,
            borderColor = GenericPrimary.copy(alpha = 0.4f),
            borderWidth = 1.dp,
        ),
    )
}

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
