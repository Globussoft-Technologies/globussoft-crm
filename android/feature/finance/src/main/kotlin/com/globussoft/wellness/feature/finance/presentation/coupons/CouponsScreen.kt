package com.globussoft.wellness.feature.finance.presentation.coupons

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
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.LocalOffer
import androidx.compose.material.icons.filled.Preview
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Divider
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
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
import com.globussoft.wellness.core.designsystem.components.WellnessDropdown
import com.globussoft.wellness.core.designsystem.components.WellnessOutlinedButton
import com.globussoft.wellness.core.designsystem.components.WellnessTextField
import com.globussoft.wellness.core.designsystem.theme.Dimens
import com.globussoft.wellness.core.designsystem.theme.WellnessDanger
import com.globussoft.wellness.core.designsystem.theme.WellnessPrimary
import com.globussoft.wellness.feature.finance.domain.model.Coupon
import com.globussoft.wellness.feature.finance.domain.model.CouponPreview
import kotlinx.coroutines.launch
import java.text.NumberFormat
import java.util.Locale

// ─── Public composable ────────────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CouponsScreen(
    viewModel: CouponsViewModel = hiltViewModel(),
) {
    val state        by viewModel.state.collectAsStateWithLifecycle()
    val snackbarHost = remember { SnackbarHostState() }
    val scope        = rememberCoroutineScope()

    LaunchedEffect(Unit) {
        viewModel.effects.collect { effect ->
            when (effect) {
                is CouponsEffect.ShowSnackbar -> scope.launch { snackbarHost.showSnackbar(effect.message) }
            }
        }
    }

    Scaffold(
        snackbarHost = { SnackbarHost(snackbarHost) },
        topBar = {
            TopAppBar(
                title = {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Default.LocalOffer, contentDescription = null,
                            tint = WellnessPrimary, modifier = Modifier.size(22.dp))
                        Spacer(Modifier.width(Dimens.SpacingSm))
                        Text("Coupons", fontWeight = FontWeight.SemiBold)
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.surface),
                actions = {
                    WellnessOutlinedButton(
                        text    = "Preview Code",
                        onClick = { viewModel.onEvent(CouponsEvent.ShowPreviewDialog) },
                        icon    = Icons.Default.Preview,
                        modifier = Modifier.padding(end = Dimens.SpacingSm),
                    )
                    WellnessButton(
                        text    = "New Coupon",
                        onClick = { viewModel.onEvent(CouponsEvent.ShowNewForm) },
                        icon    = Icons.Default.Add,
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
        ) {
            when {
                state.isLoading -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(color = WellnessPrimary, strokeWidth = 2.dp)
                }
                state.error != null && state.coupons.isEmpty() -> {
                    val errorMsg = state.error ?: ""
                    ErrorState(
                        message  = errorMsg,
                        onRetry  = { viewModel.onEvent(CouponsEvent.Refresh) },
                        modifier = Modifier.fillMaxSize(),
                    )
                }
                state.coupons.isEmpty() -> EmptyState(
                    message     = "No coupons created yet.",
                    icon        = Icons.Default.LocalOffer,
                    actionLabel = "New Coupon",
                    onAction    = { viewModel.onEvent(CouponsEvent.ShowNewForm) },
                    modifier    = Modifier.fillMaxSize(),
                )
                else -> WellnessCard {
                    // Table header
                    CouponTableHeader()
                    Divider()
                    LazyColumn {
                        items(state.coupons, key = { it.id }) { coupon ->
                            CouponTableRow(
                                coupon   = coupon,
                                onEdit   = { viewModel.onEvent(CouponsEvent.ShowEditForm(coupon)) },
                                onDelete = { viewModel.onEvent(CouponsEvent.RequestDelete(coupon.id)) },
                            )
                            Divider(thickness = 0.5.dp)
                        }
                    }
                }
            }
        }
    }

    // Add / Edit sheet
    if (state.showFormSheet) {
        CouponFormSheet(
            state   = state,
            onEvent = viewModel::onEvent,
        )
    }

    // Preview dialog
    if (state.showPreviewDialog) {
        CouponPreviewDialog(
            state   = state,
            onEvent = viewModel::onEvent,
        )
    }

    // Delete confirmation
    if (state.deleteTargetId != null) {
        AlertDialog(
            onDismissRequest = { viewModel.onEvent(CouponsEvent.DismissDelete) },
            title            = { Text("Delete Coupon?") },
            text             = { Text("This action cannot be undone.") },
            confirmButton    = {
                WellnessButton(
                    text      = "Delete",
                    onClick   = { viewModel.onEvent(CouponsEvent.ConfirmDelete) },
                    isLoading = state.isDeleting,
                )
            },
            dismissButton    = {
                TextButton(onClick = { viewModel.onEvent(CouponsEvent.DismissDelete) }) { Text("Cancel") }
            },
        )
    }
}

// ─── Table header ─────────────────────────────────────────────────────────────

@Composable
private fun CouponTableHeader() {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = Dimens.SpacingMd, vertical = Dimens.SpacingSm),
    ) {
        Text("Code",         style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1.5f))
        Text("Discount",     style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
        Text("Uses",         style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Bold, modifier = Modifier.weight(0.6f))
        Text("Expiry",       style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
        Text("Active",       style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Bold, modifier = Modifier.weight(0.6f))
        Spacer(Modifier.width(72.dp)) // edit + delete buttons
    }
}

// ─── Table row ────────────────────────────────────────────────────────────────

@Composable
private fun CouponTableRow(
    coupon: Coupon,
    onEdit: () -> Unit,
    onDelete: () -> Unit,
) {
    val fmt = NumberFormat.getCurrencyInstance(Locale("en", "IN"))
    val discountLabel = when (coupon.discountType.uppercase()) {
        "PERCENT" -> "${coupon.amount.toInt()}%"
        else      -> fmt.format(coupon.amount)
    }

    Row(
        modifier          = Modifier
            .fillMaxWidth()
            .padding(horizontal = Dimens.SpacingMd, vertical = Dimens.SpacingMd),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(coupon.code, style = MaterialTheme.typography.bodySmall,
            fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Medium,
            modifier = Modifier.weight(1.5f))
        Column(modifier = Modifier.weight(1f)) {
            Text(discountLabel, style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.SemiBold)
            if (coupon.minOrderAmount != null) {
                Text("Min: ${fmt.format(coupon.minOrderAmount)}", style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        Text(
            text     = "${coupon.redemptionCount}" + (if (coupon.maxRedemptions != null) "/${coupon.maxRedemptions}" else ""),
            style    = MaterialTheme.typography.bodySmall,
            modifier = Modifier.weight(0.6f),
        )
        Text(
            text     = coupon.expiryDate?.substring(0, 10) ?: "No expiry",
            style    = MaterialTheme.typography.bodySmall,
            modifier = Modifier.weight(1f),
        )
        StatusBadge(
            status   = if (coupon.isActive) "ACTIVE" else "INACTIVE",
            modifier = Modifier.weight(0.6f),
        )
        Row {
            IconButton(onClick = onEdit, modifier = Modifier.size(32.dp)) {
                Icon(Icons.Default.Edit, contentDescription = "Edit", tint = WellnessPrimary, modifier = Modifier.size(16.dp))
            }
            IconButton(onClick = onDelete, modifier = Modifier.size(32.dp)) {
                Icon(Icons.Default.Delete, contentDescription = "Delete", tint = WellnessDanger, modifier = Modifier.size(16.dp))
            }
        }
    }
}

// ─── Add / Edit bottom sheet ──────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun CouponFormSheet(
    state: CouponsUiState,
    onEvent: (CouponsEvent) -> Unit,
) {
    val sheetState = rememberModalBottomSheetState()
    val isEditing  = state.editingCoupon != null
    val form       = state.formState

    val discountTypeOptions = listOf("PERCENT" to "Percent (%)", "FLAT" to "Flat Amount (INR)")

    ModalBottomSheet(
        onDismissRequest = { onEvent(CouponsEvent.DismissForm) },
        sheetState       = sheetState,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = Dimens.SpacingLg)
                .padding(bottom = Dimens.SpacingHuge),
            verticalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
        ) {
            Text(
                text       = if (isEditing) "Edit Coupon" else "New Coupon",
                style      = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.SemiBold,
            )

            WellnessTextField(
                value         = form.code,
                onValueChange = { onEvent(CouponsEvent.FormFieldChanged("code", it.uppercase())) },
                label         = "Coupon Code *",
                isError       = form.codeError != null,
                errorMessage  = form.codeError,
                imeAction     = ImeAction.Next,
            )

            WellnessDropdown(
                value         = form.discountType,
                onValueChange = { onEvent(CouponsEvent.FormFieldChanged("discountType", it)) },
                label         = "Discount Type",
                options       = discountTypeOptions,
            )

            WellnessTextField(
                value         = form.amount,
                onValueChange = { onEvent(CouponsEvent.FormFieldChanged("amount", it)) },
                label         = if (form.discountType == "PERCENT") "Discount % *" else "Flat Discount Amount *",
                isError       = form.amountError != null,
                errorMessage  = form.amountError,
                keyboardType  = KeyboardType.Decimal,
                imeAction     = ImeAction.Next,
            )

            WellnessTextField(
                value         = form.minOrderAmount,
                onValueChange = { onEvent(CouponsEvent.FormFieldChanged("minOrderAmount", it)) },
                label         = "Min Order Amount (optional)",
                keyboardType  = KeyboardType.Decimal,
                imeAction     = ImeAction.Next,
            )

            WellnessTextField(
                value         = form.maxRedemptions,
                onValueChange = { onEvent(CouponsEvent.FormFieldChanged("maxRedemptions", it)) },
                label         = "Max Redemptions (optional)",
                keyboardType  = KeyboardType.Number,
                imeAction     = ImeAction.Next,
            )

            WellnessTextField(
                value         = form.expiryDate,
                onValueChange = { onEvent(CouponsEvent.FormFieldChanged("expiryDate", it)) },
                label         = "Expiry Date (YYYY-MM-DD, optional)",
                placeholder   = "2026-12-31",
                imeAction     = ImeAction.Done,
            )

            Row(
                verticalAlignment     = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
                modifier              = Modifier.fillMaxWidth(),
            ) {
                Text("Active", style = MaterialTheme.typography.bodyMedium)
                Switch(
                    checked         = form.isActive,
                    onCheckedChange = { onEvent(CouponsEvent.ActiveToggled(it)) },
                    colors          = SwitchDefaults.colors(
                        checkedThumbColor  = Color.White,
                        checkedTrackColor  = WellnessPrimary,
                    ),
                )
            }

            Spacer(Modifier.height(Dimens.SpacingSm))
            WellnessButton(
                text      = if (isEditing) "Save Changes" else "Create Coupon",
                onClick   = { onEvent(CouponsEvent.SubmitForm) },
                isLoading = state.isSaving,
                modifier  = Modifier.fillMaxWidth(),
            )
        }
    }
}

// ─── Preview dialog ───────────────────────────────────────────────────────────

@Composable
private fun CouponPreviewDialog(
    state: CouponsUiState,
    onEvent: (CouponsEvent) -> Unit,
) {
    val fmt = NumberFormat.getCurrencyInstance(Locale("en", "IN"))

    AlertDialog(
        onDismissRequest = { onEvent(CouponsEvent.DismissPreviewDialog) },
        icon    = { Icon(Icons.Default.LocalOffer, contentDescription = null, tint = WellnessPrimary) },
        title   = { Text("Preview Coupon") },
        text    = {
            Column(verticalArrangement = Arrangement.spacedBy(Dimens.SpacingMd)) {
                WellnessTextField(
                    value         = state.previewCode,
                    onValueChange = { onEvent(CouponsEvent.PreviewFieldChanged("code", it.uppercase())) },
                    label         = "Coupon Code",
                    imeAction     = ImeAction.Next,
                )
                WellnessTextField(
                    value         = state.previewAmount,
                    onValueChange = { onEvent(CouponsEvent.PreviewFieldChanged("amount", it)) },
                    label         = "Test Order Amount (INR)",
                    keyboardType  = KeyboardType.Decimal,
                    imeAction     = ImeAction.Done,
                )
                if (state.previewResult != null) {
                    val preview = state.previewResult
                    Spacer(Modifier.height(Dimens.SpacingXs))
                    Divider()
                    PreviewResultRow("Original Amount", fmt.format(preview.originalAmount))
                    PreviewResultRow("Discount",        "- ${fmt.format(preview.discountAmount)}", WellnessDanger)
                    PreviewResultRow("Final Amount",    fmt.format(preview.finalAmount), WellnessPrimary, bold = true)
                }
            }
        },
        confirmButton = {
            WellnessButton(
                text      = "Calculate",
                onClick   = { onEvent(CouponsEvent.SubmitPreview) },
                isLoading = state.isPreviewing,
            )
        },
        dismissButton = {
            TextButton(onClick = { onEvent(CouponsEvent.DismissPreviewDialog) }) { Text("Close") }
        },
    )
}

@Composable
private fun PreviewResultRow(
    label: String,
    value: String,
    valueColor: androidx.compose.ui.graphics.Color = MaterialTheme.colorScheme.onSurface,
    bold: Boolean = false,
) {
    Row(
        modifier              = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(label, style = MaterialTheme.typography.bodySmall)
        Text(
            text       = value,
            style      = MaterialTheme.typography.bodySmall,
            fontWeight = if (bold) FontWeight.Bold else FontWeight.Normal,
            color      = valueColor,
        )
    }
}
