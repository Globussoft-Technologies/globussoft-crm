package com.globus.crm.feature.notifications.presentation.screen

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.globus.crm.core.ui.SectionLabel
import com.globus.crm.feature.notifications.presentation.state.NotificationCategory
import com.globus.crm.feature.notifications.presentation.state.NotificationChannel
import com.globus.crm.feature.notifications.presentation.state.NotificationSettingsUiEvent
import com.globus.crm.feature.notifications.presentation.state.NotificationSettingsUiState
import com.globus.crm.feature.notifications.presentation.viewmodel.NotificationSettingsViewModel

@Composable
fun NotificationSettingsScreen(
    onBack: () -> Unit,
    viewModel: NotificationSettingsViewModel = hiltViewModel(),
) {
    val state by viewModel.uiState.collectAsStateWithLifecycle()
    NotificationSettingsContent(
        state = state,
        onEvent = viewModel::onEvent,
    )
}

@Composable
private fun NotificationSettingsContent(
    state: NotificationSettingsUiState,
    onEvent: (NotificationSettingsUiEvent) -> Unit,
) {
    Box(modifier = Modifier.fillMaxSize()) {
        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .padding(bottom = 80.dp),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            item { SectionLabel("Notification Categories") }

            items(state.categories.size) { index ->
                val cat = state.categories[index]
                ToggleRow(
                    label = cat.label,
                    enabled = cat.enabled,
                    onToggle = { onEvent(NotificationSettingsUiEvent.ToggleCategory(cat.key, it)) },
                )
            }

            item {
                Spacer(modifier = Modifier.height(8.dp))
                HorizontalDivider()
                Spacer(modifier = Modifier.height(8.dp))
                SectionLabel("Delivery Channels")
            }

            items(state.channels.size) { index ->
                val ch = state.channels[index]
                ToggleRow(
                    label = ch.label,
                    enabled = ch.enabled,
                    onToggle = { onEvent(NotificationSettingsUiEvent.ToggleChannel(ch.key, it)) },
                )
            }

            item {
                Spacer(modifier = Modifier.height(8.dp))
                HorizontalDivider()
                Spacer(modifier = Modifier.height(8.dp))
                SectionLabel("Quiet Hours")
            }

            item {
                QuietHoursRow(
                    label = "Start time",
                    value = state.quietStart,
                    onEdit = { onEvent(NotificationSettingsUiEvent.SetQuietStart(it)) },
                )
            }

            item {
                QuietHoursRow(
                    label = "End time",
                    value = state.quietEnd,
                    onEdit = { onEvent(NotificationSettingsUiEvent.SetQuietEnd(it)) },
                )
            }

            if (state.saveSuccess) {
                item {
                    Text(
                        "Settings saved.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.padding(top = 8.dp),
                    )
                }
            }
        }

        Button(
            onClick = { onEvent(NotificationSettingsUiEvent.Save) },
            enabled = !state.isSaving,
            modifier = Modifier
                .fillMaxWidth()
                .align(Alignment.BottomCenter)
                .padding(horizontal = 16.dp, vertical = 12.dp),
            shape = MaterialTheme.shapes.extraLarge,
        ) {
            if (state.isSaving) {
                CircularProgressIndicator(modifier = Modifier.padding(4.dp))
            } else {
                Text("Save settings")
            }
        }
    }
}

@Composable
private fun ToggleRow(label: String, enabled: Boolean, onToggle: (Boolean) -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.weight(1f),
        )
        Switch(checked = enabled, onCheckedChange = onToggle)
    }
}

@Composable
private fun QuietHoursRow(label: String, value: String, onEdit: (String) -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.weight(1f),
        )
        Text(
            text = value.ifBlank { "Not set" },
            style = MaterialTheme.typography.bodyMedium,
            fontWeight = FontWeight.Medium,
            color = MaterialTheme.colorScheme.primary,
        )
    }
}
