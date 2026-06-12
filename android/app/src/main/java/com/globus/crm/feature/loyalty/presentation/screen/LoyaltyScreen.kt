package com.globus.crm.feature.loyalty.presentation.screen

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.RemoveCircle
import androidx.compose.material.icons.filled.Star
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.globus.crm.core.theme.WellnessGold
import com.globus.crm.core.ui.GradientHeroCard
import com.globus.crm.core.util.DateUtil
import com.globus.crm.feature.loyalty.domain.model.LoyaltyData
import com.globus.crm.feature.loyalty.domain.model.LoyaltyTransaction
import com.globus.crm.feature.loyalty.presentation.state.LoyaltyUiEvent
import com.globus.crm.feature.loyalty.presentation.state.LoyaltyUiState

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LoyaltyScreen(
    state: LoyaltyUiState,
    onEvent: (LoyaltyUiEvent) -> Unit,
) {
    var isRefreshing by remember { mutableStateOf(false) }
    LaunchedEffect(state.isLoading) { if (!state.isLoading) isRefreshing = false }

    PullToRefreshBox(
        isRefreshing = isRefreshing,
        onRefresh = { isRefreshing = true; onEvent(LoyaltyUiEvent.Refresh) },
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background),
    ) {
        when {
            state.isLoading -> CircularProgressIndicator(modifier = Modifier.align(Alignment.Center))
            state.error != null -> Column(
                modifier = Modifier.align(Alignment.Center),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text(state.error, color = MaterialTheme.colorScheme.error)
                Spacer(Modifier.height(12.dp))
                Button(onClick = { onEvent(LoyaltyUiEvent.Refresh) }, shape = MaterialTheme.shapes.extraLarge) { Text("Retry") }
            }
            state.loyaltyData != null -> LoyaltyContent(state.loyaltyData)
        }
    }
}

@Composable
private fun LoyaltyContent(data: LoyaltyData) {
    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = 16.dp),
        verticalArrangement = Arrangement.spacedBy(0.dp),
    ) {
        item {
            Spacer(Modifier.height(8.dp))
            LoyaltyBalanceCard(balance = data.balance, earnedThisMonth = data.earnedThisMonth)
            Spacer(Modifier.height(20.dp))
            Text(
                text = "Transaction History",
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
            )
            Spacer(Modifier.height(8.dp))
        }

        if (data.transactions.isEmpty()) {
            item {
                Text(
                    text = "No transactions yet",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(vertical = 16.dp),
                )
            }
        } else {
            items(data.transactions, key = { it.id }) { txn ->
                LoyaltyTransactionRow(txn)
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            }
        }

        item { Spacer(Modifier.height(16.dp)) }
    }
}

@Composable
private fun LoyaltyBalanceCard(balance: Int, earnedThisMonth: Int) {
    GradientHeroCard(modifier = Modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier.fillMaxWidth(),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(
                text = "$balance",
                fontSize = 56.sp,
                fontWeight = FontWeight.Bold,
                color = WellnessGold,
            )
            Text(
                text = "points",
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onPrimaryContainer.copy(alpha = 0.8f),
            )
            Spacer(Modifier.height(12.dp))
            Surface(
                color = Color.White.copy(alpha = 0.15f),
                shape = RoundedCornerShape(50.dp),
            ) {
                Text(
                    text = "Earned this month: $earnedThisMonth pts",
                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
                    style = MaterialTheme.typography.labelMedium,
                    color = Color.White,
                )
            }
        }
    }
}

@Composable
private fun LoyaltyTransactionRow(txn: LoyaltyTransaction) {
    val isEarned = txn.type.lowercase() != "redeemed"
    val pointsColor = if (isEarned) MaterialTheme.colorScheme.secondary
                      else MaterialTheme.colorScheme.error
    val pointsText = if (isEarned) "+${txn.points} pts" else "-${txn.points} pts"

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(40.dp)
                .clip(RoundedCornerShape(50.dp))
                .background(
                    if (isEarned) MaterialTheme.colorScheme.secondaryContainer
                    else MaterialTheme.colorScheme.errorContainer
                ),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                imageVector = if (isEarned) Icons.Default.Star else Icons.Default.RemoveCircle,
                contentDescription = null,
                tint = pointsColor,
                modifier = Modifier.size(20.dp),
            )
        }
        Spacer(Modifier.size(12.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = txn.reason,
                style = MaterialTheme.typography.bodyMedium,
            )
            Text(
                text = DateUtil.toDisplayDate(txn.createdAt),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Text(
            text = pointsText,
            style = MaterialTheme.typography.labelLarge,
            fontWeight = FontWeight.SemiBold,
            color = pointsColor,
        )
    }
}
