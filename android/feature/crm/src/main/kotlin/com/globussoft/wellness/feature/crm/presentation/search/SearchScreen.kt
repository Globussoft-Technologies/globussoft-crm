package com.globussoft.wellness.feature.crm.presentation.search

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Clear
import androidx.compose.material.icons.filled.Contacts
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.Lightbulb
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.SupportAgent
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.globussoft.wellness.core.designsystem.theme.GenericPrimary

/**
 * Global search screen for Generic CRM.
 *
 * Navigated to via the search icon in the sidebar header.
 * Results are grouped by type: Contacts, Deals, Tickets.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SearchScreen(
    onBack: () -> Unit,
    onContactClick: (String) -> Unit = {},
    onDealClick: (String) -> Unit    = {},
    onTicketClick: (String) -> Unit  = {},
    viewModel: SearchViewModel       = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    // Auto-focus search field on screen entry
    val focusRequester = remember { FocusRequester() }
    LaunchedEffect(Unit) { focusRequester.requestFocus() }

    // Which result sections are expanded (all expanded by default)
    val expandedSections = remember {
        mutableStateMapOf("Contacts" to true, "Deals" to true, "Tickets" to true)
    }

    Column(modifier = Modifier.fillMaxSize()) {
        // ── Top bar with search field ─────────────────────────────────────────
        TopAppBar(
            title = {
                OutlinedTextField(
                    value              = state.query,
                    onValueChange      = viewModel::onQueryChange,
                    modifier           = Modifier
                        .fillMaxWidth()
                        .focusRequester(focusRequester),
                    placeholder        = { Text("Search contacts, deals, tickets…") },
                    singleLine         = true,
                    leadingIcon        = {
                        Icon(Icons.Default.Search, contentDescription = null)
                    },
                    trailingIcon       = {
                        if (state.query.isNotEmpty()) {
                            IconButton(onClick = { viewModel.onQueryChange("") }) {
                                Icon(Icons.Default.Clear, contentDescription = "Clear search")
                            }
                        }
                    },
                    keyboardOptions    = KeyboardOptions(imeAction = ImeAction.Search),
                    keyboardActions    = KeyboardActions(onSearch = {}),
                )
            },
            navigationIcon = {
                IconButton(onClick = onBack) {
                    Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                }
            },
        )

        HorizontalDivider()

        // ── Results / loading / empty states ──────────────────────────────────
        Box(modifier = Modifier.fillMaxSize()) {
            when {
                state.query.length < 2 -> {
                    Box(
                        modifier         = Modifier.fillMaxSize().padding(48.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            text  = "Type at least 2 characters to search…",
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            style = MaterialTheme.typography.bodyMedium,
                        )
                    }
                }
                state.isSearching -> {
                    Box(
                        modifier         = Modifier.fillMaxSize(),
                        contentAlignment = Alignment.Center,
                    ) {
                        CircularProgressIndicator(color = GenericPrimary)
                    }
                }
                state.error != null -> {
                    Box(
                        modifier         = Modifier.fillMaxSize().padding(48.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            text  = state.error ?: "Search failed",
                            color = MaterialTheme.colorScheme.error,
                            style = MaterialTheme.typography.bodyMedium,
                        )
                    }
                }
                else -> {
                    val hasResults = state.contacts.isNotEmpty() ||
                        state.deals.isNotEmpty() ||
                        state.tickets.isNotEmpty()

                    if (!hasResults) {
                        Box(
                            modifier         = Modifier.fillMaxSize().padding(48.dp),
                            contentAlignment = Alignment.Center,
                        ) {
                            Text(
                                text  = "No results for \"${state.query}\"",
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                style = MaterialTheme.typography.bodyMedium,
                            )
                        }
                    } else {
                        LazyColumn(modifier = Modifier.fillMaxSize()) {
                            // ── Contacts section ─────────────────────────────
                            if (state.contacts.isNotEmpty()) {
                                item(key = "header_contacts") {
                                    SearchSectionHeader(
                                        title    = "Contacts",
                                        count    = state.contacts.size,
                                        expanded = expandedSections["Contacts"] != false,
                                        onToggle = {
                                            expandedSections["Contacts"] =
                                                !(expandedSections["Contacts"] ?: true)
                                        },
                                    )
                                }
                                if (expandedSections["Contacts"] != false) {
                                    items(
                                        items = state.contacts,
                                        key   = { "c_${it["id"]}" },
                                    ) { contact ->
                                        val contactId = contact["id"]?.toString() ?: ""
                                        ListItem(
                                            headlineContent   = {
                                                Text(
                                                    text       = contact["name"] as? String ?: "—",
                                                    fontWeight = FontWeight.Medium,
                                                )
                                            },
                                            supportingContent = {
                                                Text(
                                                    text  = contact["email"] as? String ?: "",
                                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                                )
                                            },
                                            leadingContent    = {
                                                Icon(
                                                    Icons.Default.Contacts,
                                                    contentDescription = null,
                                                    tint               = GenericPrimary,
                                                    modifier           = Modifier.size(20.dp),
                                                )
                                            },
                                            modifier          = Modifier.padding(horizontal = 4.dp),
                                        )
                                        HorizontalDivider()
                                    }
                                }
                            }

                            // ── Deals section ────────────────────────────────
                            if (state.deals.isNotEmpty()) {
                                item(key = "header_deals") {
                                    SearchSectionHeader(
                                        title    = "Deals",
                                        count    = state.deals.size,
                                        expanded = expandedSections["Deals"] != false,
                                        onToggle = {
                                            expandedSections["Deals"] =
                                                !(expandedSections["Deals"] ?: true)
                                        },
                                    )
                                }
                                if (expandedSections["Deals"] != false) {
                                    items(
                                        items = state.deals,
                                        key   = { "d_${it["id"]}" },
                                    ) { deal ->
                                        val dealId = deal["id"]?.toString() ?: ""
                                        ListItem(
                                            headlineContent   = {
                                                Text(
                                                    text       = deal["title"] as? String ?: "—",
                                                    fontWeight = FontWeight.Medium,
                                                )
                                            },
                                            supportingContent = {
                                                val stage = deal["stage"] as? String ?: ""
                                                if (stage.isNotBlank()) Text(
                                                    text  = stage,
                                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                                )
                                            },
                                            leadingContent    = {
                                                Icon(
                                                    Icons.Default.Lightbulb,
                                                    contentDescription = null,
                                                    tint               = GenericPrimary,
                                                    modifier           = Modifier.size(20.dp),
                                                )
                                            },
                                            modifier          = Modifier.padding(horizontal = 4.dp),
                                        )
                                        HorizontalDivider()
                                    }
                                }
                            }

                            // ── Tickets section ──────────────────────────────
                            if (state.tickets.isNotEmpty()) {
                                item(key = "header_tickets") {
                                    SearchSectionHeader(
                                        title    = "Tickets",
                                        count    = state.tickets.size,
                                        expanded = expandedSections["Tickets"] != false,
                                        onToggle = {
                                            expandedSections["Tickets"] =
                                                !(expandedSections["Tickets"] ?: true)
                                        },
                                    )
                                }
                                if (expandedSections["Tickets"] != false) {
                                    items(
                                        items = state.tickets,
                                        key   = { "t_${it["id"]}" },
                                    ) { ticket ->
                                        ListItem(
                                            headlineContent   = {
                                                Text(
                                                    text       = ticket["subject"] as? String ?: "—",
                                                    fontWeight = FontWeight.Medium,
                                                )
                                            },
                                            supportingContent = {
                                                val status = ticket["status"] as? String ?: ""
                                                if (status.isNotBlank()) Text(
                                                    text  = status,
                                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                                )
                                            },
                                            leadingContent    = {
                                                Icon(
                                                    Icons.Default.SupportAgent,
                                                    contentDescription = null,
                                                    tint               = GenericPrimary,
                                                    modifier           = Modifier.size(20.dp),
                                                )
                                            },
                                            modifier          = Modifier.padding(horizontal = 4.dp),
                                        )
                                        HorizontalDivider()
                                    }
                                }
                            }

                            item { Spacer(Modifier.height(24.dp)) }
                        }
                    }
                }
            }
        }
    }
}

// ─── Section header composable ────────────────────────────────────────────────

@Composable
private fun SearchSectionHeader(
    title: String,
    count: Int,
    expanded: Boolean,
    onToggle: () -> Unit,
) {
    Row(
        modifier          = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text       = "$title ($count)",
            style      = MaterialTheme.typography.labelLarge,
            fontWeight = FontWeight.SemiBold,
            color      = GenericPrimary,
            modifier   = Modifier.weight(1f),
        )
        TextButton(onClick = onToggle) {
            Icon(
                imageVector        = if (expanded) Icons.Default.KeyboardArrowUp
                                     else Icons.Default.KeyboardArrowDown,
                contentDescription = if (expanded) "Collapse" else "Expand",
                modifier           = Modifier.size(18.dp),
            )
        }
    }
    HorizontalDivider()
}
