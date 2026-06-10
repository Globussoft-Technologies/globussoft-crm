package com.globus.crm.feature.notifications.presentation.screen

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.globus.crm.core.ui.EmptyState
import com.globus.crm.core.util.DateUtil
import com.globus.crm.feature.notifications.domain.model.Notification
import com.globus.crm.feature.notifications.presentation.state.NotificationsUiEvent
import com.globus.crm.feature.notifications.presentation.state.NotificationsUiState

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NotificationInboxScreen(
    state: NotificationsUiState,
    onEvent: (NotificationsUiEvent) -> Unit,
) {
    var isRefreshing by remember { mutableStateOf(false) }
    LaunchedEffect(state.isLoading) { if (!state.isLoading) isRefreshing = false }

    PullToRefreshBox(
        isRefreshing = isRefreshing,
        onRefresh = { isRefreshing = true; onEvent(NotificationsUiEvent.Refresh) },
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background),
    ) {
        when {
            state.isLoading -> CircularProgressIndicator(modifier = Modifier.align(Alignment.Center))
            state.notifications.isEmpty() -> EmptyState(
                message = "No notifications yet",
                icon = Icons.Default.Notifications,
                modifier = Modifier.align(Alignment.Center),
            )
            else -> LazyColumn(contentPadding = PaddingValues(vertical = 8.dp)) {
                items(state.notifications, key = { it.id }) { notification ->
                    NotificationRow(
                        notification = notification,
                        onClick = { onEvent(NotificationsUiEvent.TapNotification(notification)) },
                    )
                }
            }
        }
    }
}

@Composable
private fun NotificationRow(notification: Notification, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(
                if (!notification.isRead) MaterialTheme.colorScheme.secondaryContainer.copy(alpha = 0.25f)
                else MaterialTheme.colorScheme.surface,
            )
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.Top,
    ) {
        if (!notification.isRead) {
            Box(
                modifier = Modifier
                    .size(8.dp)
                    .offset(y = 6.dp)
                    .background(MaterialTheme.colorScheme.primary, shape = MaterialTheme.shapes.extraSmall),
            )
        } else {
            Spacer(modifier = Modifier.size(8.dp))
        }
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = notification.title,
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = if (!notification.isRead) FontWeight.SemiBold else FontWeight.Normal,
            )
            Text(
                text = notification.body,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text(
                text = DateUtil.toDisplayDateTime(notification.receivedAt),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
    HorizontalDivider(modifier = Modifier.padding(horizontal = 16.dp))
}
