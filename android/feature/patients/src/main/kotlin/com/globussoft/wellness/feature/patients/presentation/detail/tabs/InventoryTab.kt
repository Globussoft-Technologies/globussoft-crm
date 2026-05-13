package com.globussoft.wellness.feature.patients.presentation.detail.tabs

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
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Inventory
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import com.globussoft.wellness.core.designsystem.components.EmptyState
import com.globussoft.wellness.core.designsystem.components.WellnessCard
import com.globussoft.wellness.core.designsystem.theme.Dimens
import com.globussoft.wellness.core.designsystem.theme.WellnessPrimary
import com.globussoft.wellness.core.designsystem.theme.WellnessTextSecondary
import com.globussoft.wellness.core.domain.model.Visit

/**
 * Tab 6 — Inventory.
 *
 * Shows a list of inventory items consumed during the patient's visits.
 * Items are derived from the visit list (each completed visit may consume
 * products/supplies). A summary of total items consumed is shown at the top.
 *
 * In the current architecture, per-visit inventory consumption detail comes
 * from the future `GET /wellness/patients/{id}/inventory` endpoint. The tab
 * shows a representative list from the visits list for now, with one synthetic
 * item per completed visit to demonstrate the layout.
 */
@Composable
fun InventoryTab(visits: List<Visit>) {
    val completedVisits = visits.filter { it.status.name == "COMPLETED" }
    val totalItems = completedVisits.size  // 1 product record per completed visit (placeholder)

    if (completedVisits.isEmpty()) {
        EmptyState(
            message  = "No inventory consumed yet.\nCompleted visits will show product usage here.",
            icon     = Icons.Default.Inventory,
            modifier = Modifier.fillMaxSize(),
        )
        return
    }

    LazyColumn(
        contentPadding  = PaddingValues(Dimens.SpacingLg),
        verticalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
        modifier = Modifier.fillMaxSize(),
    ) {
        // Summary header
        item {
            WellnessCard(modifier = Modifier.fillMaxWidth()) {
                Row(
                    modifier            = Modifier
                        .fillMaxWidth()
                        .padding(Dimens.SpacingLg),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment   = Alignment.CenterVertically,
                ) {
                    Text(
                        text  = "Total Items Consumed",
                        style = MaterialTheme.typography.titleSmall,
                        fontWeight = FontWeight.Medium,
                    )
                    Text(
                        text  = totalItems.toString(),
                        style = MaterialTheme.typography.titleLarge,
                        fontWeight = FontWeight.Bold,
                        color = WellnessPrimary,
                    )
                }
            }
        }

        itemsIndexed(items = completedVisits) { index, visit ->
            InventoryItemCard(
                productName = visit.serviceName ?: "Consumable #${index + 1}",
                quantity    = 1,
                date        = visit.visitDate.take(10),
                visitRef    = visit.id.take(8),
            )
        }
    }
}

@Composable
private fun InventoryItemCard(
    productName: String,
    quantity: Int,
    date: String,
    visitRef: String,
) {
    WellnessCard(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(Dimens.SpacingMd)) {
            Row(
                modifier              = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment     = Alignment.CenterVertically,
            ) {
                Text(
                    text  = productName,
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.Medium,
                    modifier = Modifier.weight(1f),
                )
                Text(
                    text  = "Qty: $quantity",
                    style = MaterialTheme.typography.labelMedium,
                    fontWeight = FontWeight.SemiBold,
                    color = WellnessPrimary,
                )
            }
            Spacer(Modifier.height(Dimens.SpacingXs))
            Row(horizontalArrangement = Arrangement.spacedBy(Dimens.SpacingMd)) {
                Text(
                    text  = "Date: $date",
                    style = MaterialTheme.typography.bodySmall,
                    color = WellnessTextSecondary,
                )
                Text(
                    text  = "Visit: #$visitRef",
                    style = MaterialTheme.typography.bodySmall,
                    color = WellnessTextSecondary,
                )
            }
        }
    }
}
