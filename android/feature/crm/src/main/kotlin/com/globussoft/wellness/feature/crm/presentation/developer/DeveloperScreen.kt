package com.globussoft.wellness.feature.crm.presentation.developer

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.globussoft.wellness.core.designsystem.components.EmptyState
import com.globussoft.wellness.core.designsystem.components.WellnessCard
import com.globussoft.wellness.core.designsystem.theme.Dimens

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DeveloperScreen() {
    Scaffold(
        topBar = {
            TopAppBar(
                title  = { Text("Developer") },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.surface),
            )
        },
        containerColor = MaterialTheme.colorScheme.background,
    ) { contentPadding ->
        LazyColumn(
            modifier       = Modifier
                .fillMaxSize()
                .padding(contentPadding),
            contentPadding = PaddingValues(horizontal = Dimens.SpacingLg, vertical = Dimens.SpacingSm),
            verticalArrangement = Arrangement.spacedBy(Dimens.SpacingSm),
        ) {
            item {
                Text(
                    text  = "API Keys",
                    style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.padding(vertical = 8.dp),
                )
            }
            item {
                WellnessCard(modifier = Modifier.fillMaxWidth()) {
                    EmptyState(
                        message  = "Configure API keys via the web app.\nManage key permissions and rotation at crm.globusdemos.com/developer",
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(Dimens.SpacingLg),
                    )
                }
            }
            item {
                HorizontalDivider(modifier = Modifier.padding(vertical = 8.dp))
                Text(
                    text  = "Webhooks",
                    style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.padding(vertical = 8.dp),
                )
            }
            item {
                WebhookInfoCard(
                    url    = "https://crm.globusdemos.com/api/webhooks",
                    events = "contacts.created, deals.updated, tickets.closed",
                )
            }
            item {
                HorizontalDivider(modifier = Modifier.padding(vertical = 8.dp))
                Text(
                    text  = "API Documentation",
                    style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.padding(vertical = 8.dp),
                )
            }
            item {
                WellnessCard(modifier = Modifier.fillMaxWidth()) {
                    Column(modifier = Modifier.padding(Dimens.SpacingLg)) {
                        Text(
                            text  = "Swagger UI",
                            style = MaterialTheme.typography.titleSmall,
                        )
                        Text(
                            text  = "Full API docs available at\ncrm.globusdemos.com/api-docs",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun WebhookInfoCard(
    url: String,
    events: String,
    modifier: Modifier = Modifier,
) {
    WellnessCard(modifier = modifier.fillMaxWidth()) {
        Row(
            modifier          = Modifier
                .fillMaxWidth()
                .padding(Dimens.SpacingLg),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(text = "Webhook Endpoint", style = MaterialTheme.typography.titleSmall)
                Text(
                    text  = url,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.primary,
                )
                Text(
                    text  = "Events: $events",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            IconButton(onClick = { /* copy placeholder */ }) {
                Icon(
                    imageVector        = Icons.Default.ContentCopy,
                    contentDescription = "Copy URL",
                    tint               = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}
