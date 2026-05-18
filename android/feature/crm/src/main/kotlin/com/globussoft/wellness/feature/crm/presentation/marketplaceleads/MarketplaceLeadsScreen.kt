package com.globussoft.wellness.feature.crm.presentation.marketplaceleads

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
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
import com.globussoft.wellness.core.designsystem.theme.GenericPrimary

private fun sourceColor(source: String): Color = when (source.uppercase()) {
    "INDIAMART"  -> Color(0xFF1B5E20)
    "JUSTDIAL"   -> Color(0xFF0D47A1)
    "TRADEINDIA" -> Color(0xFFE65100)
    "SULEKHA"    -> Color(0xFF6A1B9A)
    else         -> Color(0xFF424242)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MarketplaceLeadsScreen(
    viewModel: MarketplaceLeadsViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    Scaffold(
        topBar = {
            TopAppBar(
                title  = { Text("Marketplace Leads") },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.surface,
                ),
            )
        },
        containerColor = MaterialTheme.colorScheme.background,
    ) { contentPadding ->
        PullToRefreshBox(
            isRefreshing = state.isLoading && state.leads.isNotEmpty(),
            onRefresh    = { viewModel.refresh() },
            modifier     = Modifier.fillMaxSize().padding(contentPadding),
        ) {
            when {
                state.isLoading && state.leads.isEmpty() ->
                    ShimmerList(itemCount = 5, modifier = Modifier.fillMaxSize())
                state.error != null && state.leads.isEmpty() ->
                    ErrorState(message = state.error!!, onRetry = { viewModel.refresh() }, modifier = Modifier.fillMaxSize())
                state.leads.isEmpty() ->
                    EmptyState(message = "No marketplace leads yet.", modifier = Modifier.fillMaxSize())
                else ->
                    LazyColumn(
                        contentPadding      = PaddingValues(horizontal = Dimens.SpacingLg, vertical = Dimens.SpacingSm),
                        verticalArrangement = Arrangement.spacedBy(Dimens.SpacingSm),
                    ) {
                        items(state.leads) { lead ->
                            MarketplaceLeadCard(lead = lead)
                        }
                    }
            }
        }
    }
}

@Composable
private fun MarketplaceLeadCard(lead: Map<String, Any>) {
    val name   = lead["name"] as? String
        ?: lead["contactName"] as? String
        ?: lead["leadName"] as? String
        ?: "Unknown Lead"
    val phone  = lead["phone"] as? String
        ?: lead["mobile"] as? String
        ?: "—"
    val source = lead["provider"] as? String
        ?: lead["source"] as? String
        ?: "Unknown"
    val status = lead["status"] as? String ?: "NEW"
    val srcColor = sourceColor(source)

    WellnessCard(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.fillMaxWidth().padding(Dimens.SpacingMd)) {
            Row(
                modifier              = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment     = Alignment.CenterVertically,
            ) {
                Text(name, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                Box(
                    modifier = Modifier
                        .clip(RoundedCornerShape(4.dp))
                        .background(srcColor.copy(alpha = 0.15f))
                        .padding(horizontal = 8.dp, vertical = 3.dp),
                ) {
                    Text(source, style = MaterialTheme.typography.labelSmall, color = srcColor, fontWeight = FontWeight.Bold)
                }
            }
            Spacer(Modifier.padding(top = 2.dp))
            Text(
                text  = phone,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text(
                text  = "Status: $status",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.padding(top = 8.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(
                    onClick  = { /* Qualify — non-functional UI */ },
                    colors   = ButtonDefaults.buttonColors(containerColor = GenericPrimary),
                    modifier = Modifier.weight(1f),
                    contentPadding = PaddingValues(vertical = 6.dp),
                ) {
                    Text("Qualify", style = MaterialTheme.typography.labelMedium)
                }
                OutlinedButton(
                    onClick  = { /* Convert — non-functional UI */ },
                    modifier = Modifier.weight(1f),
                    contentPadding = PaddingValues(vertical = 6.dp),
                ) {
                    Text("Convert", style = MaterialTheme.typography.labelMedium)
                }
            }
        }
    }
}
