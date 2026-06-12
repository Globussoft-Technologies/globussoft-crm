package com.globus.crm.feature.booking.presentation.screen

import java.text.SimpleDateFormat
import java.util.Locale
import androidx.compose.foundation.background
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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.globus.crm.core.ui.EmptyState
import com.globus.crm.core.ui.ErrorState
import com.globus.crm.core.ui.StatusChip
import com.globus.crm.core.ui.WellnessCard
import com.globus.crm.feature.booking.domain.model.WaitlistEntry
import com.globus.crm.feature.booking.presentation.state.WaitlistUiEvent
import com.globus.crm.feature.booking.presentation.state.WaitlistUiState

private fun formatWaitlistDate(iso: String): String = try {
    val parser = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.getDefault()).apply { isLenient = true }
    val date = parser.parse(iso.take(19)) ?: return iso
    SimpleDateFormat("d MMM yyyy, h:mm a", Locale.getDefault()).format(date)
} catch (e: Exception) { iso }

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun WaitlistScreen(
    state: WaitlistUiState,
    onEvent: (WaitlistUiEvent) -> Unit,
) {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background),
    ) {
        when {
            state.isLoading -> {
                CircularProgressIndicator(modifier = Modifier.align(Alignment.Center))
            }

            state.error != null && state.entries.isEmpty() -> {
                ErrorState(
                    message = state.error,
                    onRetry = { onEvent(WaitlistUiEvent.Load) },
                    modifier = Modifier.align(Alignment.Center),
                )
            }

            else -> {
                if (state.entries.isEmpty()) {
                    EmptyState(
                        message = "You are not on any waitlist yet.\nTap + to add yourself.",
                        modifier = Modifier
                            .align(Alignment.Center)
                            .padding(horizontal = 32.dp),
                    )
                } else {
                    LazyColumn(
                        contentPadding = PaddingValues(
                            start = 16.dp,
                            end = 16.dp,
                            top = 16.dp,
                            bottom = 88.dp, // leave space for FAB
                        ),
                        verticalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        items(state.entries, key = { it.id }) { entry ->
                            WaitlistEntryCard(entry = entry)
                        }
                    }
                }
            }
        }

        FloatingActionButton(
            onClick = { onEvent(WaitlistUiEvent.ShowAddSheet) },
            modifier = Modifier
                .align(Alignment.BottomEnd)
                .padding(end = 16.dp, bottom = 16.dp)
                .navigationBarsPadding(),
            containerColor = MaterialTheme.colorScheme.primary,
            contentColor = MaterialTheme.colorScheme.onPrimary,
        ) {
            Icon(imageVector = Icons.Default.Add, contentDescription = "Add to waitlist")
        }

        if (state.showAddSheet) {
            AddWaitlistSheet(
                state = state,
                onEvent = onEvent,
            )
        }
    }
}

@Composable
private fun WaitlistEntryCard(entry: WaitlistEntry) {
    WellnessCard(
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = entry.serviceName ?: "Service #${entry.serviceId}",
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                    color = MaterialTheme.colorScheme.onSurface,
                    modifier = Modifier.weight(1f),
                )
                StatusChip(status = entry.status)
            }
            if (!entry.notes.isNullOrBlank()) {
                Text(
                    text = entry.notes,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            if (entry.createdAt.isNotEmpty()) {
                Text(
                    text = "Added: ${formatWaitlistDate(entry.createdAt)}",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.outline,
                )
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AddWaitlistSheet(
    state: WaitlistUiState,
    onEvent: (WaitlistUiEvent) -> Unit,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    var dropdownExpanded by remember { mutableStateOf(false) }

    val selectedServiceName = state.services
        .firstOrNull { it.id == state.selectedServiceId }
        ?.name
        ?: ""

    ModalBottomSheet(
        onDismissRequest = { onEvent(WaitlistUiEvent.DismissAddSheet) },
        sheetState = sheetState,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .navigationBarsPadding()
                .padding(horizontal = 20.dp)
                .padding(bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text(
                text = "Add to Waitlist",
                style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.SemiBold,
                color = MaterialTheme.colorScheme.onSurface,
            )

            ExposedDropdownMenuBox(
                expanded = dropdownExpanded,
                onExpandedChange = { dropdownExpanded = it },
            ) {
                OutlinedTextField(
                    value = selectedServiceName,
                    onValueChange = {},
                    readOnly = true,
                    label = { Text("Select Service") },
                    trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = dropdownExpanded) },
                    modifier = Modifier
                        .fillMaxWidth()
                        .menuAnchor(),
                    colors = ExposedDropdownMenuDefaults.outlinedTextFieldColors(),
                )
                ExposedDropdownMenu(
                    expanded = dropdownExpanded,
                    onDismissRequest = { dropdownExpanded = false },
                ) {
                    state.services.forEach { service ->
                        DropdownMenuItem(
                            text = { Text(service.name) },
                            onClick = {
                                onEvent(WaitlistUiEvent.SelectService(service.id))
                                dropdownExpanded = false
                            },
                        )
                    }
                }
            }

            OutlinedTextField(
                value = state.formNotes,
                onValueChange = { onEvent(WaitlistUiEvent.UpdateNotes(it)) },
                label = { Text("Notes (optional)") },
                placeholder = { Text("Any preferences or details…") },
                minLines = 3,
                modifier = Modifier.fillMaxWidth(),
            )

            if (state.formError != null) {
                Text(
                    text = state.formError,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }

            Button(
                onClick = { onEvent(WaitlistUiEvent.SubmitWaitlist) },
                enabled = state.selectedServiceId != null && !state.isSubmitting,
                modifier = Modifier.fillMaxWidth(),
                shape = MaterialTheme.shapes.extraLarge,
            ) {
                if (state.isSubmitting) {
                    CircularProgressIndicator(
                        modifier = Modifier
                            .size(18.dp)
                            .padding(end = 8.dp),
                        strokeWidth = 2.dp,
                        color = MaterialTheme.colorScheme.onPrimary,
                    )
                }
                Text("Add to Waitlist")
            }

            Spacer(modifier = Modifier.height(8.dp))
        }
    }
}
