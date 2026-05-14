package com.globussoft.wellness.feature.patients.presentation.detail.tabs

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
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AccountBalanceWallet
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Remove
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import com.globussoft.wellness.core.designsystem.components.EmptyState
import com.globussoft.wellness.core.designsystem.components.WellnessButton
import com.globussoft.wellness.core.designsystem.components.WellnessCard
import com.globussoft.wellness.core.designsystem.components.WellnessTextField
import com.globussoft.wellness.core.designsystem.theme.Dimens
import com.globussoft.wellness.core.designsystem.theme.WellnessDanger
import com.globussoft.wellness.core.designsystem.theme.WellnessPrimary
import com.globussoft.wellness.core.designsystem.theme.WellnessSuccess
import com.globussoft.wellness.core.designsystem.theme.WellnessTextSecondary
import com.globussoft.wellness.core.domain.model.Patient

/**
 * Tab 8 — Wallet.
 *
 * Shows the patient's pre-paid wallet balance in a prominent card, followed
 * by a scrollable ledger of credit / debit transactions.
 *
 * Wallet data will be loaded from the future
 * `GET /wellness/patients/{id}/wallet` endpoint. The tab renders a realistic
 * UI skeleton with placeholder transactions proportional to the patient's
 * visit count so the layout is exercised during development.
 */
@Composable
fun WalletTab(
    patient: Patient,
    isRedeeming: Boolean = false,
    onRedeemGiftCard: (String) -> Unit = {},
) {
    // Derive a synthetic balance from visit count for demo purposes.
    // In production, balance comes from the wallet API endpoint.
    val balance = patient.visitsCount * 500.0

    var giftCardCode by remember { mutableStateOf("") }

    if (patient.visitsCount == 0) {
        EmptyState(
            message  = "No wallet activity yet.\nPre-paid credits and deductions will appear here.",
            icon     = Icons.Default.AccountBalanceWallet,
            modifier = Modifier.fillMaxSize(),
        )
        return
    }

    LazyColumn(
        contentPadding  = PaddingValues(Dimens.SpacingLg),
        verticalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
        modifier = Modifier.fillMaxSize(),
    ) {
        item {
            WalletBalanceCard(balance = balance)
        }

        item {
            WellnessCard(modifier = Modifier.fillMaxWidth()) {
                Column(
                    modifier = Modifier.padding(Dimens.SpacingLg),
                    verticalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
                ) {
                    Text(
                        text = "Redeem Gift Card",
                        style = MaterialTheme.typography.titleSmall,
                        fontWeight = FontWeight.SemiBold,
                    )
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        WellnessTextField(
                            value = giftCardCode,
                            onValueChange = { giftCardCode = it },
                            label = "Gift Card Code",
                            modifier = Modifier.weight(1f),
                            imeAction = ImeAction.Done,
                        )
                        WellnessButton(
                            text = "Redeem",
                            onClick = {
                                onRedeemGiftCard(giftCardCode)
                                giftCardCode = ""
                            },
                            isLoading = isRedeeming,
                        )
                    }
                }
            }
        }

        item {
            Text(
                text  = "Transaction Ledger",
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold,
                color = WellnessTextSecondary,
                modifier = Modifier.padding(top = Dimens.SpacingXs),
            )
        }

        items(count = minOf(patient.visitsCount, 10)) { index ->
            val isCredit  = index % 3 == 0
            val amount    = if (isCredit) 1000.0 else 500.0
            val running   = balance - (index * 500.0)
            WalletTransactionRow(
                type           = if (isCredit) "Top-up" else "Visit Charge",
                amount         = amount,
                isCredit       = isCredit,
                date           = "2026-0${5 - (index / 3)}-${10 + (index % 10)}",
                runningBalance = running.coerceAtLeast(0.0),
            )
        }
    }
}

@Composable
private fun WalletBalanceCard(balance: Double) {
    WellnessCard(modifier = Modifier.fillMaxWidth()) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .background(WellnessPrimary)
                .padding(Dimens.SpacingXl),
            contentAlignment = Alignment.Center,
        ) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Icon(
                    imageVector        = Icons.Default.AccountBalanceWallet,
                    contentDescription = null,
                    tint               = Color.White.copy(alpha = 0.7f),
                    modifier           = Modifier.size(32.dp),
                )
                Spacer(Modifier.height(Dimens.SpacingSm))
                Text(
                    text  = "₹${"%.0f".format(balance)}",
                    style = MaterialTheme.typography.displaySmall,
                    fontWeight = FontWeight.Bold,
                    color = Color.White,
                )
                Text(
                    text  = "Wallet Balance",
                    style = MaterialTheme.typography.labelMedium,
                    color = Color.White.copy(alpha = 0.7f),
                )
            }
        }
    }
}

@Composable
private fun WalletTransactionRow(
    type: String,
    amount: Double,
    isCredit: Boolean,
    date: String,
    runningBalance: Double,
) {
    WellnessCard(modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier            = Modifier
                .fillMaxWidth()
                .padding(Dimens.SpacingMd),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment   = Alignment.CenterVertically,
        ) {
            Row(
                verticalAlignment     = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(Dimens.SpacingSm),
            ) {
                Box(
                    modifier = Modifier
                        .size(32.dp)
                        .background(
                            color = if (isCredit) WellnessSuccess.copy(0.12f) else WellnessDanger.copy(0.12f),
                            shape = MaterialTheme.shapes.small,
                        ),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        imageVector        = if (isCredit) Icons.Default.Add else Icons.Default.Remove,
                        contentDescription = null,
                        tint               = if (isCredit) WellnessSuccess else WellnessDanger,
                        modifier           = Modifier.size(16.dp),
                    )
                }
                Column {
                    Text(
                        text  = type,
                        style = MaterialTheme.typography.titleSmall,
                        fontWeight = FontWeight.Medium,
                    )
                    Text(
                        text  = date,
                        style = MaterialTheme.typography.bodySmall,
                        color = WellnessTextSecondary,
                    )
                }
            }
            Column(horizontalAlignment = Alignment.End) {
                Text(
                    text  = "${if (isCredit) "+" else "-"}₹${"%.0f".format(amount)}",
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                    color = if (isCredit) WellnessSuccess else WellnessDanger,
                )
                Text(
                    text  = "Bal: ₹${"%.0f".format(runningBalance)}",
                    style = MaterialTheme.typography.bodySmall,
                    color = WellnessTextSecondary,
                )
            }
        }
    }
}
