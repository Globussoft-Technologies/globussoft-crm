package com.globussoft.wellness.feature.finance.presentation.giftcards

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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CardGiftcard
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Divider
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.globussoft.wellness.core.designsystem.components.EmptyState
import com.globussoft.wellness.core.designsystem.components.ErrorState
import com.globussoft.wellness.core.designsystem.components.StatusBadge
import com.globussoft.wellness.core.designsystem.components.WellnessButton
import com.globussoft.wellness.core.designsystem.components.WellnessCard
import com.globussoft.wellness.core.designsystem.components.WellnessTextField
import com.globussoft.wellness.core.designsystem.theme.Dimens
import com.globussoft.wellness.core.designsystem.theme.WellnessAccent
import com.globussoft.wellness.core.designsystem.theme.WellnessPrimary
import com.globussoft.wellness.feature.finance.domain.model.GiftCard
import kotlinx.coroutines.launch
import java.text.NumberFormat
import java.util.Locale

// ─── Public composable ────────────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GiftCardsScreen(
    viewModel: GiftCardsViewModel = hiltViewModel(),
) {
    val state        by viewModel.state.collectAsStateWithLifecycle()
    val snackbarHost = remember { SnackbarHostState() }
    val clipboard    = LocalClipboardManager.current
    val scope        = rememberCoroutineScope()

    LaunchedEffect(Unit) {
        viewModel.effects.collect { effect ->
            when (effect) {
                is GiftCardsEffect.ShowSnackbar    -> scope.launch { snackbarHost.showSnackbar(effect.message) }
                is GiftCardsEffect.CopyToClipboard -> clipboard.setText(AnnotatedString(effect.text))
            }
        }
    }

    Scaffold(
        snackbarHost = { SnackbarHost(snackbarHost) },
        topBar = {
            TopAppBar(
                title = {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Default.CardGiftcard, contentDescription = null, tint = WellnessPrimary, modifier = Modifier.size(22.dp))
                        Spacer(Modifier.width(Dimens.SpacingSm))
                        Text("Gift Cards", fontWeight = FontWeight.SemiBold)
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.surface),
                actions = {
                    WellnessButton(
                        text     = "Issue Gift Card",
                        onClick  = { viewModel.onEvent(GiftCardsEvent.ShowIssueDialog) },
                        icon     = Icons.Default.CardGiftcard,
                        modifier = Modifier.padding(end = Dimens.SpacingMd),
                    )
                },
            )
        },
        containerColor = MaterialTheme.colorScheme.background,
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(Dimens.SpacingLg),
            verticalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
        ) {
            // Newly issued card — one-time display
            val newlyIssuedCard = state.newlyIssuedCard
            if (newlyIssuedCard != null) {
                NewCardBanner(
                    card    = newlyIssuedCard,
                    onCopy  = { code ->
                        clipboard.setText(AnnotatedString(code))
                        scope.launch { snackbarHost.showSnackbar("Code copied to clipboard") }
                    },
                    onDone  = { viewModel.onEvent(GiftCardsEvent.DismissNewCard) },
                )
            }

            // Status filter chips
            LazyRow(horizontalArrangement = Arrangement.spacedBy(Dimens.SpacingXs)) {
                val filters = listOf(null to "All", "ACTIVE" to "Active", "REDEEMED" to "Redeemed",
                    "EXPIRED" to "Expired", "CANCELLED" to "Cancelled")
                items(filters) { (value, label) ->
                    FilterChip(
                        selected = state.statusFilter == value,
                        onClick  = { viewModel.onEvent(GiftCardsEvent.FilterChanged(value)) },
                        label    = { Text(label) },
                        colors   = FilterChipDefaults.filterChipColors(
                            selectedContainerColor = WellnessPrimary,
                            selectedLabelColor     = Color.White,
                        ),
                    )
                }
            }

            when {
                state.isLoading -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(color = WellnessPrimary, strokeWidth = 2.dp)
                }
                state.error != null && state.giftCards.isEmpty() -> {
                    val errorMsg = state.error ?: ""
                    ErrorState(
                        message  = errorMsg,
                        onRetry  = { viewModel.onEvent(GiftCardsEvent.Refresh) },
                        modifier = Modifier.fillMaxSize(),
                    )
                }
                state.filteredCards.isEmpty() -> EmptyState(
                    message     = "No gift cards found.",
                    icon        = Icons.Default.CardGiftcard,
                    actionLabel = "Issue Gift Card",
                    onAction    = { viewModel.onEvent(GiftCardsEvent.ShowIssueDialog) },
                    modifier    = Modifier.fillMaxSize(),
                )
                else -> WellnessCard {
                    LazyColumn {
                        items(state.filteredCards, key = { it.id }) { card ->
                            GiftCardRow(card = card)
                            Divider(thickness = 0.5.dp)
                        }
                    }
                }
            }
        }
    }

    // Issue dialog
    if (state.showIssueDialog) {
        IssueGiftCardDialog(
            amount    = state.issueAmount,
            isLoading = state.isIssuing,
            onAmountChange = { viewModel.onEvent(GiftCardsEvent.IssuAmountChanged(it)) },
            onConfirm = { viewModel.onEvent(GiftCardsEvent.ConfirmIssue) },
            onDismiss = { viewModel.onEvent(GiftCardsEvent.DismissIssueDialog) },
        )
    }
}

// ─── Newly issued card banner ─────────────────────────────────────────────────

@Composable
private fun NewCardBanner(
    card: GiftCard,
    onCopy: (String) -> Unit,
    onDone: () -> Unit,
) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .background(WellnessPrimary.copy(alpha = 0.08f), shape = RoundedCornerShape(Dimens.CornerLarge))
            .padding(Dimens.SpacingMd),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(Dimens.SpacingXs)) {
            Text("Gift card issued!", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold, color = WellnessPrimary)
            Text("Share this code with the recipient. It will only be shown once.",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Row(
                verticalAlignment     = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(Dimens.SpacingSm),
            ) {
                Box(
                    modifier = Modifier
                        .background(WellnessAccent.copy(alpha = 0.15f), RoundedCornerShape(6.dp))
                        .padding(horizontal = Dimens.SpacingMd, vertical = Dimens.SpacingSm),
                ) {
                    Text(card.code, style = MaterialTheme.typography.titleMedium,
                        fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold, color = WellnessPrimary)
                }
                IconButton(onClick = { onCopy(card.code) }) {
                    Icon(Icons.Default.ContentCopy, contentDescription = "Copy code",
                        tint = WellnessPrimary, modifier = Modifier.size(18.dp))
                }
                Spacer(Modifier.weight(1f))
                Text(
                    text = NumberFormat.getCurrencyInstance(Locale("en", "IN")).format(card.amount),
                    style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold, color = WellnessPrimary,
                )
            }
            TextButton(onClick = onDone) { Text("Done") }
        }
    }
}

// ─── Gift card row ────────────────────────────────────────────────────────────

@Composable
private fun GiftCardRow(card: GiftCard) {
    Row(
        modifier          = Modifier
            .fillMaxWidth()
            .padding(horizontal = Dimens.SpacingMd, vertical = Dimens.SpacingMd),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(card.code, style = MaterialTheme.typography.bodyMedium,
                fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Medium)
            Text(
                text  = "Issued: ${formatDate(card.createdAt)}" +
                    if (card.redeemedAt != null) "  •  Redeemed: ${formatDate(card.redeemedAt)}" else "",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Text(
            text       = NumberFormat.getCurrencyInstance(Locale("en", "IN")).format(card.amount),
            style      = MaterialTheme.typography.bodyMedium,
            fontWeight = FontWeight.SemiBold,
            modifier   = Modifier.padding(horizontal = Dimens.SpacingMd),
        )
        StatusBadge(status = card.status)
    }
}

// ─── Issue dialog ─────────────────────────────────────────────────────────────

@Composable
private fun IssueGiftCardDialog(
    amount: String,
    isLoading: Boolean,
    onAmountChange: (String) -> Unit,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        icon    = { Icon(Icons.Default.CardGiftcard, contentDescription = null, tint = WellnessPrimary) },
        title   = { Text("Issue Gift Card") },
        text    = {
            Column(verticalArrangement = Arrangement.spacedBy(Dimens.SpacingMd)) {
                Text("Enter the face value for the new gift card.")
                WellnessTextField(
                    value         = amount,
                    onValueChange = onAmountChange,
                    label         = "Amount (INR)",
                    keyboardType  = KeyboardType.Decimal,
                    imeAction     = ImeAction.Done,
                )
            }
        },
        confirmButton = {
            WellnessButton(text = "Issue", onClick = onConfirm, isLoading = isLoading)
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("Cancel") }
        },
    )
}

private fun formatDate(iso: String): String = try { iso.substring(0, 10) } catch (_: Exception) { iso }
