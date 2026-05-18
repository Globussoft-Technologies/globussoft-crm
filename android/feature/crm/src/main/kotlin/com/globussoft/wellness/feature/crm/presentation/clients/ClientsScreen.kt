package com.globussoft.wellness.feature.crm.presentation.clients

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.globussoft.wellness.core.designsystem.components.EmptyState
import com.globussoft.wellness.core.designsystem.components.ErrorState
import com.globussoft.wellness.core.designsystem.components.ShimmerList
import com.globussoft.wellness.core.designsystem.components.WellnessCard
import com.globussoft.wellness.core.designsystem.theme.Dimens
import com.globussoft.wellness.core.designsystem.theme.GenericPrimary
import com.globussoft.wellness.core.domain.model.Contact

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ClientsScreen(
    viewModel: ClientsViewModel = hiltViewModel(),
    onClientClick: (String) -> Unit = {},
) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Clients") },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.surface,
                ),
            )
        },
        containerColor = MaterialTheme.colorScheme.background,
    ) { contentPadding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(contentPadding),
        ) {
            OutlinedTextField(
                value         = state.searchQuery,
                onValueChange = { viewModel.setSearch(it) },
                placeholder   = { Text("Search clients…") },
                leadingIcon   = { Icon(Icons.Default.Search, contentDescription = null) },
                modifier      = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = Dimens.SpacingLg, vertical = Dimens.SpacingSm),
                singleLine    = true,
            )

            PullToRefreshBox(
                isRefreshing = state.isLoading && state.clients.isNotEmpty(),
                onRefresh    = { viewModel.refresh() },
                modifier     = Modifier.fillMaxSize(),
            ) {
                when {
                    state.isLoading && state.clients.isEmpty() ->
                        ShimmerList(itemCount = 6, modifier = Modifier.fillMaxSize())
                    state.error != null && state.clients.isEmpty() ->
                        ErrorState(message = state.error!!, onRetry = { viewModel.refresh() }, modifier = Modifier.fillMaxSize())
                    state.clients.isEmpty() ->
                        EmptyState(message = "No clients found.", modifier = Modifier.fillMaxSize())
                    else ->
                        LazyColumn(
                            contentPadding      = PaddingValues(horizontal = Dimens.SpacingLg, vertical = Dimens.SpacingSm),
                            verticalArrangement = Arrangement.spacedBy(Dimens.SpacingSm),
                        ) {
                            items(state.clients, key = { it.id }) { client ->
                                ClientCard(client = client, onClick = { onClientClick(client.id) })
                            }
                        }
                }
            }
        }
    }
}

@Composable
private fun ClientCard(client: Contact, onClick: () -> Unit) {
    WellnessCard(
        modifier = Modifier.fillMaxWidth(),
        onClick  = onClick,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(Dimens.SpacingMd),
        ) {
            Text(
                text       = client.name,
                style      = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold,
            )
            client.company?.takeIf { it.isNotBlank() }?.let {
                Spacer(Modifier.height(2.dp))
                Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Row(
                modifier              = Modifier.padding(top = 4.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                client.email?.takeIf { it.isNotBlank() }?.let {
                    Text(it, style = MaterialTheme.typography.labelSmall, color = GenericPrimary)
                }
                client.phone?.takeIf { it.isNotBlank() }?.let {
                    Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
    }
}
