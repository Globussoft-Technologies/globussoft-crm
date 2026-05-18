package com.globussoft.wellness.navigation

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.globussoft.wellness.core.designsystem.theme.GenericPrimary

/**
 * Notifications panel content shown inside a [ModalBottomSheet].
 *
 * The caller is responsible for wrapping this in a ModalBottomSheet; this
 * composable only provides the header + list content.
 */
@Composable
fun NotificationsDrawer(
    onDismiss: () -> Unit,
    viewModel: NotificationsViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 200.dp),
    ) {
        // ── Header ────────────────────────────────────────────────────────────
        Row(
            modifier              = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 12.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment     = Alignment.CenterVertically,
        ) {
            Text(
                text       = "Notifications",
                style      = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
            )
            IconButton(onClick = onDismiss) {
                Icon(
                    imageVector        = Icons.Default.Close,
                    contentDescription = "Close notifications",
                )
            }
        }

        HorizontalDivider()

        // ── Content ───────────────────────────────────────────────────────────
        if (state.notifications.isEmpty()) {
            Box(
                modifier         = Modifier
                    .fillMaxWidth()
                    .padding(32.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text  = "No notifications",
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
        } else {
            LazyColumn(
                contentPadding = PaddingValues(vertical = 8.dp),
                modifier       = Modifier.fillMaxWidth(),
            ) {
                items(
                    items = state.notifications,
                    key   = { it["id"]?.toString() ?: it.hashCode().toString() },
                ) { notif ->
                    val title  = notif["title"] as? String ?: "Notification"
                    val body   = notif["body"] as? String
                        ?: notif["message"] as? String
                        ?: ""
                    val isRead = (notif["read"] as? Boolean) ?: true

                    ListItem(
                        headlineContent = {
                            Text(
                                text       = title,
                                fontWeight = if (!isRead) FontWeight.Bold else FontWeight.Normal,
                            )
                        },
                        supportingContent = {
                            if (body.isNotBlank()) {
                                Text(
                                    text     = body,
                                    maxLines = 2,
                                    color    = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        },
                        leadingContent = {
                            Icon(
                                imageVector        = Icons.Default.Notifications,
                                contentDescription = null,
                                tint               = if (!isRead) GenericPrimary
                                                     else MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        },
                    )
                    HorizontalDivider()
                }
            }
        }
    }
}
