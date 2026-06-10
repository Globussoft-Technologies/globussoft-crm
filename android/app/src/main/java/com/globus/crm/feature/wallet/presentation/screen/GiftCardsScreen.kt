package com.globus.crm.feature.wallet.presentation.screen

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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CardGiftcard
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.AssistChipDefaults
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.globus.crm.core.ui.EmptyState
import com.globus.crm.core.ui.ErrorState
import com.globus.crm.core.util.CurrencyUtil
import com.globus.crm.feature.wallet.domain.model.GiftCard
import com.globus.crm.feature.wallet.presentation.state.GiftCardsUiEvent
import com.globus.crm.feature.wallet.presentation.state.GiftCardsUiState

private val CARD_COLORS = listOf(
    Color(0xFF265855),
    Color(0xFF7B5B0D),
    Color(0xFF1B2E4B),
    Color(0xFF4A3470),
    Color(0xFF8B1A2C),
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GiftCardsScreen(
    state: GiftCardsUiState,
    onEvent: (GiftCardsUiEvent) -> Unit,
) {
    var showWebDialog by remember { mutableStateOf(false) }

    PullToRefreshBox(
        isRefreshing = state.isLoading,
        onRefresh = { onEvent(GiftCardsUiEvent.Refresh) },
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background),
    ) {
        Column(modifier = Modifier.fillMaxSize()) {
            Column(modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp)) {
                Text(
                    text = "Dr. Haror's Wellness Gift Cards",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold,
                )
                Spacer(Modifier.height(2.dp))
                Text(
                    text = "Give the gift of wellness — redeemable for any service or session.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            when {
                state.error != null -> Box(
                    modifier = Modifier.fillMaxSize(),
                    contentAlignment = Alignment.Center,
                ) {
                    ErrorState(message = state.error, onRetry = { onEvent(GiftCardsUiEvent.Refresh) })
                }

                !state.isLoading && state.giftCards.isEmpty() -> Box(
                    modifier = Modifier.fillMaxSize(),
                    contentAlignment = Alignment.Center,
                ) {
                    EmptyState(message = "No gift cards available right now.")
                }

                else -> LazyVerticalGrid(
                    columns = GridCells.Adaptive(minSize = 160.dp),
                    contentPadding = PaddingValues(horizontal = 12.dp, vertical = 4.dp),
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                    modifier = Modifier.fillMaxSize(),
                ) {
                    items(state.giftCards) { card ->
                        GiftCardTile(
                            card = card,
                            color = cardColor(card),
                            onBuy = { showWebDialog = true },
                        )
                    }
                }
            }
        }
    }

    if (showWebDialog) {
        AlertDialog(
            onDismissRequest = { showWebDialog = false },
            icon = { Icon(Icons.Default.CardGiftcard, contentDescription = null) },
            title = { Text("Purchase on Web") },
            text = { Text("Gift card purchases are completed on our website. Please visit the web portal to buy a gift card.") },
            confirmButton = {
                TextButton(onClick = { showWebDialog = false }) { Text("Got it") }
            },
        )
    }
}

@Composable
private fun GiftCardTile(card: GiftCard, color: Color, onBuy: () -> Unit) {
    Surface(
        shape = MaterialTheme.shapes.large,
        color = color,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = card.name,
                    style = MaterialTheme.typography.labelSmall,
                    color = Color.White.copy(alpha = 0.85f),
                    lineHeight = 14.sp,
                    modifier = Modifier.weight(1f),
                )
                AssistChip(
                    onClick = {},
                    label = { Text("e-Gift", style = MaterialTheme.typography.labelSmall, color = Color.White) },
                    colors = AssistChipDefaults.assistChipColors(containerColor = Color.White.copy(alpha = 0.18f)),
                    border = null,
                    leadingIcon = {
                        Icon(
                            Icons.Default.CardGiftcard,
                            contentDescription = null,
                            tint = Color.White,
                        )
                    },
                )
            }

            Spacer(Modifier.height(4.dp))

            Text(
                text = CurrencyUtil.formatRupees(card.amount.toDouble()),
                style = MaterialTheme.typography.headlineSmall,
                fontWeight = FontWeight.ExtraBold,
                color = Color.White,
            )

            Text(
                text = "Valid ${card.validityDays} days",
                style = MaterialTheme.typography.labelSmall,
                color = Color.White.copy(alpha = 0.70f),
            )

            Spacer(Modifier.height(4.dp))

            Button(
                onClick = onBuy,
                modifier = Modifier.fillMaxWidth(),
                shape = MaterialTheme.shapes.extraLarge,
                colors = androidx.compose.material3.ButtonDefaults.buttonColors(
                    containerColor = Color.White,
                    contentColor = color,
                ),
            ) {
                Text("Buy", fontWeight = FontWeight.Bold, fontSize = 13.sp)
            }
        }
    }
}

private fun cardColor(card: GiftCard): Color {
    if (!card.color.isNullOrBlank()) {
        runCatching { Color(android.graphics.Color.parseColor(card.color)) }.getOrNull()
            ?.let { return it }
    }
    return CARD_COLORS[card.id % CARD_COLORS.size]
}
