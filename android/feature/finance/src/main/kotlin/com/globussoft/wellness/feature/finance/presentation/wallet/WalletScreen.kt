package com.globussoft.wellness.feature.finance.presentation.wallet

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.material.icons.filled.AccountBalanceWallet
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Divider
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.globussoft.wellness.core.designsystem.components.EmptyState
import com.globussoft.wellness.core.designsystem.components.ErrorState
import com.globussoft.wellness.core.designsystem.components.WellnessCard
import com.globussoft.wellness.core.designsystem.components.WellnessTextField
import com.globussoft.wellness.core.designsystem.theme.Dimens
import com.globussoft.wellness.core.designsystem.theme.WellnessDanger
import com.globussoft.wellness.core.designsystem.theme.WellnessPrimary
import com.globussoft.wellness.core.designsystem.theme.WellnessSuccess
import com.globussoft.wellness.feature.finance.domain.model.WalletTransaction
import kotlinx.coroutines.launch
import java.text.NumberFormat
import java.util.Locale

// ─── Public composable ────────────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun WalletScreen(
    viewModel: WalletViewModel = hiltViewModel(),
) {
    val state        by viewModel.state.collectAsStateWithLifecycle()
    val snackbarHost = remember { SnackbarHostState() }
    val scope        = rememberCoroutineScope()

    LaunchedEffect(Unit) {
        viewModel.effects.collect { effect ->
            when (effect) {
                is WalletEffect.ShowSnackbar -> scope.launch { snackbarHost.showSnackbar(effect.message) }
            }
        }
    }

    Scaffold(
        snackbarHost = { SnackbarHost(snackbarHost) },
        topBar = {
            TopAppBar(
                title = {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(
                            imageVector        = Icons.Default.AccountBalanceWallet,
                            contentDescription = null,
                            tint               = WellnessPrimary,
                            modifier           = Modifier.size(22.dp),
                        )
                        Spacer(Modifier.padding(start = Dimens.SpacingSm))
                        Text("Patient Wallet", fontWeight = FontWeight.SemiBold)
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.surface,
                ),
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
            // Patient search
            Box {
                WellnessTextField(
                    value         = state.searchQuery,
                    onValueChange = { viewModel.onEvent(WalletEvent.SearchChanged(it)) },
                    label         = "Search patient by name or phone",
                    leadingIcon   = {
                        Icon(
                            imageVector        = Icons.Default.Search,
                            contentDescription = null,
                            modifier           = Modifier.size(18.dp),
                        )
                    },
                    imeAction = ImeAction.Search,
                )
                DropdownMenu(
                    expanded        = state.showSearchDropdown,
                    onDismissRequest = { viewModel.onEvent(WalletEvent.DismissDropdown) },
                ) {
                    state.searchResults.forEach { result ->
                        DropdownMenuItem(
                            text    = { Text("${result.name} — ${result.phone}") },
                            onClick = { viewModel.onEvent(WalletEvent.PatientSelected(result.id, result.name)) },
                        )
                    }
                }
            }

            when {
                state.isLoading -> {
                    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator(color = WellnessPrimary, strokeWidth = 2.dp)
                    }
                }
                state.error != null -> {
                    ErrorState(
                        message = state.error,
                        onRetry = {
                            viewModel.onEvent(
                                WalletEvent.PatientSelected(state.selectedPatientId, state.selectedPatientName)
                            )
                        },
                        modifier = Modifier.fillMaxSize(),
                    )
                }
                state.walletData != null -> {
                    WalletBalanceCard(balance = state.walletData.balance)
                    Text(
                        text       = "Transaction History",
                        style      = MaterialTheme.typography.titleSmall,
                        fontWeight = FontWeight.SemiBold,
                    )
                    if (state.walletData.transactions.isEmpty()) {
                        EmptyState(
                            message  = "No transactions yet.",
                            modifier = Modifier.fillMaxWidth().height(120.dp),
                        )
                    } else {
                        WellnessCard {
                            LazyColumn {
                                items(state.walletData.transactions, key = { it.id }) { tx ->
                                    TransactionRow(tx = tx)
                                    Divider(thickness = 0.5.dp)
                                }
                            }
                        }
                    }
                }
                state.selectedPatientId.isBlank() -> {
                    EmptyState(
                        message  = "Search for a patient to view their wallet.",
                        icon     = Icons.Default.AccountBalanceWallet,
                        modifier = Modifier.fillMaxSize(),
                    )
                }
            }
        }
    }
}

// ─── Wallet balance card ──────────────────────────────────────────────────────

@Composable
private fun WalletBalanceCard(balance: Double) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .background(WellnessPrimary, shape = RoundedCornerShape(Dimens.CornerLarge))
            .padding(Dimens.SpacingXl),
        contentAlignment = Alignment.Center,
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(
                text  = "Current Balance",
                style = MaterialTheme.typography.labelLarge,
                color = Color.White.copy(alpha = 0.8f),
            )
            Spacer(Modifier.height(Dimens.SpacingXs))
            Text(
                text       = NumberFormat.getCurrencyInstance(Locale("en", "IN")).format(balance),
                style      = MaterialTheme.typography.displaySmall,
                fontWeight = FontWeight.Bold,
                color      = Color.White,
            )
        }
    }
}

// ─── Transaction row ──────────────────────────────────────────────────────────

@Composable
private fun TransactionRow(tx: WalletTransaction) {
    val isCredit = tx.type.uppercase() == "CREDIT"
    val amountColor = if (isCredit) WellnessSuccess else WellnessDanger
    val sign        = if (isCredit) "+" else "-"

    Row(
        modifier          = Modifier
            .fillMaxWidth()
            .padding(horizontal = Dimens.SpacingMd, vertical = Dimens.SpacingMd),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // Type badge
        Box(
            modifier = Modifier
                .background(
                    color  = amountColor.copy(alpha = 0.12f),
                    shape  = RoundedCornerShape(6.dp),
                )
                .padding(horizontal = 8.dp, vertical = 4.dp),
        ) {
            Text(
                text  = tx.type,
                style = MaterialTheme.typography.labelSmall,
                color = amountColor,
                fontWeight = FontWeight.SemiBold,
            )
        }
        Spacer(Modifier.padding(start = Dimens.SpacingMd))
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text  = tx.notes ?: tx.type.lowercase().replaceFirstChar { it.uppercase() },
                style = MaterialTheme.typography.bodySmall,
                fontWeight = FontWeight.Medium,
            )
            Text(
                text  = formatDate(tx.createdAt),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Column(horizontalAlignment = Alignment.End) {
            Text(
                text       = "$sign${NumberFormat.getCurrencyInstance(Locale("en", "IN")).format(tx.amount)}",
                style      = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.SemiBold,
                color      = amountColor,
            )
            Text(
                text  = "Bal: ${NumberFormat.getCurrencyInstance(Locale("en", "IN")).format(tx.balanceAfter)}",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

private fun formatDate(iso: String): String = try { iso.substring(0, 10) } catch (_: Exception) { iso }
