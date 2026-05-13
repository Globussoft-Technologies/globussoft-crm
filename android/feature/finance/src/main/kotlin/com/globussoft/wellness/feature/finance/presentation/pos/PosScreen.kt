package com.globussoft.wellness.feature.finance.presentation.pos

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.PointOfSale
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
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.globussoft.wellness.core.designsystem.components.EmptyState
import com.globussoft.wellness.core.designsystem.components.StatusBadge
import com.globussoft.wellness.core.designsystem.components.WellnessButton
import com.globussoft.wellness.core.designsystem.components.WellnessCard
import com.globussoft.wellness.core.designsystem.components.WellnessDangerButton
import com.globussoft.wellness.core.designsystem.components.WellnessDropdown
import com.globussoft.wellness.core.designsystem.components.WellnessTextField
import com.globussoft.wellness.core.designsystem.theme.Dimens
import com.globussoft.wellness.core.designsystem.theme.WellnessPrimary
import com.globussoft.wellness.core.designsystem.theme.WellnessSuccess
import com.globussoft.wellness.feature.finance.domain.model.PosLineItem
import com.globussoft.wellness.feature.finance.domain.model.PosReceiptData
import kotlinx.coroutines.launch
import java.text.NumberFormat
import java.util.Locale

// ─── Public composable ────────────────────────────────────────────────────────

/**
 * Point-of-Sale screen.
 *
 * When no shift is open it renders a centred "Open Shift" card.
 * When a shift is open it renders a two-column tablet layout:
 * - **Left (55%):** patient / line-item entry.
 * - **Right (45%):** running totals, payment method, and submit button.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PosScreen(
    viewModel: PosViewModel = hiltViewModel(),
) {
    val state           by viewModel.state.collectAsStateWithLifecycle()
    val snackbarHost    = remember { SnackbarHostState() }
    val scope           = rememberCoroutineScope()

    LaunchedEffect(Unit) {
        viewModel.effects.collect { effect ->
            when (effect) {
                is PosEffect.ShowSnackbar -> scope.launch { snackbarHost.showSnackbar(effect.message) }
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
                            imageVector        = Icons.Default.PointOfSale,
                            contentDescription = null,
                            tint               = WellnessPrimary,
                            modifier           = Modifier.size(22.dp),
                        )
                        Spacer(Modifier.width(Dimens.SpacingSm))
                        Text(
                            text       = "Point of Sale — ${state.registerId}",
                            fontWeight = FontWeight.SemiBold,
                        )
                        if (state.shiftOpen) {
                            Spacer(Modifier.width(Dimens.SpacingSm))
                            StatusBadge(status = "SHIFT OPEN")
                        }
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.surface,
                ),
                actions = {
                    if (state.shiftOpen) {
                        WellnessDangerButton(
                            text    = "Close Shift",
                            onClick = { viewModel.onEvent(PosEvent.CloseShift("0")) },
                            modifier = Modifier.padding(end = Dimens.SpacingMd),
                        )
                    }
                },
            )
        },
        containerColor = MaterialTheme.colorScheme.background,
    ) { padding ->
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding),
        ) {
            if (!state.shiftOpen) {
                OpenShiftCard(
                    state   = state,
                    onEvent = viewModel::onEvent,
                    modifier = Modifier.align(Alignment.Center),
                )
            } else {
                PosLayout(state = state, onEvent = viewModel::onEvent)
            }
        }
    }
}

// ─── Open Shift card ──────────────────────────────────────────────────────────

@Composable
private fun OpenShiftCard(
    state: PosUiState,
    onEvent: (PosEvent) -> Unit,
    modifier: Modifier = Modifier,
) {
    var registerId   by remember { mutableStateOf(state.registerId) }
    var openingFloat by remember { mutableStateOf("") }

    WellnessCard(modifier = modifier.width(360.dp)) {
        Column(
            modifier            = Modifier
                .padding(Dimens.SpacingXl)
                .fillMaxWidth(),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
        ) {
            Icon(
                imageVector        = Icons.Default.PointOfSale,
                contentDescription = null,
                tint               = WellnessPrimary,
                modifier           = Modifier.size(48.dp),
            )
            Text(
                text       = "Open Register Shift",
                style      = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.SemiBold,
                textAlign  = TextAlign.Center,
            )
            Text(
                text  = "Set the opening float to begin accepting sales.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(Dimens.SpacingSm))
            WellnessTextField(
                value         = registerId,
                onValueChange = { registerId = it },
                label         = "Register Name",
                imeAction     = ImeAction.Next,
            )
            WellnessTextField(
                value         = openingFloat,
                onValueChange = { openingFloat = it },
                label         = "Opening Float (cash in drawer)",
                keyboardType  = KeyboardType.Decimal,
                imeAction     = ImeAction.Done,
            )
            Spacer(Modifier.height(Dimens.SpacingSm))
            WellnessButton(
                text      = "Open Shift",
                onClick   = { onEvent(PosEvent.OpenShift(registerId, openingFloat)) },
                isLoading = state.isLoading,
                modifier  = Modifier.fillMaxWidth(),
            )
        }
    }
}

// ─── Two-column POS layout ────────────────────────────────────────────────────

@Composable
private fun PosLayout(
    state: PosUiState,
    onEvent: (PosEvent) -> Unit,
) {
    // If a receipt is showing, display it full-screen instead of the sale layout.
    if (state.lastReceipt != null) {
        ReceiptCard(
            receipt = state.lastReceipt,
            onNewSale = { onEvent(PosEvent.DismissReceipt) },
            modifier  = Modifier
                .fillMaxSize()
                .padding(Dimens.SpacingXxl),
        )
        return
    }

    Row(
        modifier            = Modifier
            .fillMaxSize()
            .padding(Dimens.SpacingLg),
        horizontalArrangement = Arrangement.spacedBy(Dimens.SpacingLg),
    ) {
        // Left column — item entry
        Column(
            modifier = Modifier
                .weight(0.55f)
                .fillMaxHeight()
                .verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
        ) {
            PatientSection(state = state, onEvent = onEvent)
            LineItemForm(state = state, onEvent = onEvent)
            LineItemsTable(state = state, onEvent = onEvent)
        }

        // Right column — totals + payment
        Column(
            modifier = Modifier
                .weight(0.45f)
                .fillMaxHeight()
                .verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
        ) {
            RunningTotalCard(state = state, onEvent = onEvent)
            WellnessButton(
                text      = "Complete Sale",
                onClick   = { onEvent(PosEvent.SubmitSale) },
                isLoading = state.isSubmitting,
                enabled   = state.lineItems.isNotEmpty(),
                modifier  = Modifier.fillMaxWidth(),
            )
        }
    }
}

// ─── Patient section ──────────────────────────────────────────────────────────

@Composable
private fun PatientSection(
    state: PosUiState,
    onEvent: (PosEvent) -> Unit,
) {
    WellnessCard {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(Dimens.SpacingMd),
            verticalArrangement = Arrangement.spacedBy(Dimens.SpacingSm),
        ) {
            Text(
                text       = "Patient",
                style      = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold,
            )
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(Dimens.SpacingSm),
            ) {
                Text(
                    text  = "Guest Checkout",
                    style = MaterialTheme.typography.bodyMedium,
                )
                Switch(
                    checked         = state.isGuestCheckout,
                    onCheckedChange = { onEvent(PosEvent.GuestCheckoutToggled(it)) },
                    colors          = SwitchDefaults.colors(
                        checkedThumbColor  = Color.White,
                        checkedTrackColor  = WellnessPrimary,
                    ),
                )
            }
            if (!state.isGuestCheckout) {
                WellnessTextField(
                    value         = state.patientName,
                    onValueChange = { onEvent(PosEvent.PatientChanged("", it)) },
                    label         = "Patient Name / Phone",
                    leadingIcon   = {
                        Icon(
                            imageVector        = Icons.Default.Person,
                            contentDescription = null,
                            modifier           = Modifier.size(18.dp),
                        )
                    },
                    imeAction = ImeAction.Search,
                )
            }
        }
    }
}

// ─── Line item form ───────────────────────────────────────────────────────────

@Composable
private fun LineItemForm(
    state: PosUiState,
    onEvent: (PosEvent) -> Unit,
) {
    val lineTypeOptions = listOf(
        "SERVICE"    to "Service",
        "PRODUCT"    to "Product",
        "MEMBERSHIP" to "Membership",
        "PACKAGE"    to "Package",
        "GIFT_CARD"  to "Gift Card",
    )

    WellnessCard {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(Dimens.SpacingMd),
            verticalArrangement = Arrangement.spacedBy(Dimens.SpacingSm),
        ) {
            Text(
                text       = "Add Item",
                style      = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold,
            )

            // Line type chips
            Row(
                horizontalArrangement = Arrangement.spacedBy(Dimens.SpacingXs),
                modifier = Modifier.fillMaxWidth(),
            ) {
                lineTypeOptions.forEach { (value, label) ->
                    FilterChip(
                        selected = state.currentItemForm.lineType == value,
                        onClick  = { onEvent(PosEvent.ItemFormChanged("lineType", value)) },
                        label    = { Text(label, style = MaterialTheme.typography.labelSmall) },
                        colors   = FilterChipDefaults.filterChipColors(
                            selectedContainerColor = WellnessPrimary,
                            selectedLabelColor     = Color.White,
                        ),
                    )
                }
            }

            WellnessTextField(
                value         = state.currentItemForm.name,
                onValueChange = { onEvent(PosEvent.ItemFormChanged("name", it)) },
                label         = "Item Name",
                imeAction     = ImeAction.Next,
            )

            Row(horizontalArrangement = Arrangement.spacedBy(Dimens.SpacingSm)) {
                WellnessTextField(
                    value         = state.currentItemForm.qty,
                    onValueChange = { onEvent(PosEvent.ItemFormChanged("qty", it)) },
                    label         = "Qty",
                    keyboardType  = KeyboardType.Number,
                    imeAction     = ImeAction.Next,
                    modifier      = Modifier.weight(1f),
                )
                WellnessTextField(
                    value         = state.currentItemForm.unitPrice,
                    onValueChange = { onEvent(PosEvent.ItemFormChanged("unitPrice", it)) },
                    label         = "Unit Price",
                    keyboardType  = KeyboardType.Decimal,
                    imeAction     = ImeAction.Next,
                    modifier      = Modifier.weight(1.5f),
                )
                WellnessTextField(
                    value         = state.currentItemForm.lineDiscount,
                    onValueChange = { onEvent(PosEvent.ItemFormChanged("lineDiscount", it)) },
                    label         = "Line Disc.",
                    keyboardType  = KeyboardType.Decimal,
                    imeAction     = ImeAction.Done,
                    modifier      = Modifier.weight(1f),
                )
            }

            WellnessButton(
                text     = "+ Add Item",
                onClick  = { onEvent(PosEvent.AddLineItem) },
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

// ─── Line items table ─────────────────────────────────────────────────────────

@Composable
private fun LineItemsTable(
    state: PosUiState,
    onEvent: (PosEvent) -> Unit,
) {
    if (state.lineItems.isEmpty()) {
        EmptyState(
            message  = "No items added yet.\nUse the form above to add services, products or packages.",
            modifier = Modifier
                .fillMaxWidth()
                .height(160.dp),
        )
        return
    }

    WellnessCard {
        Column(modifier = Modifier.fillMaxWidth()) {
            // Header row
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(WellnessPrimary.copy(alpha = 0.07f))
                    .padding(horizontal = Dimens.SpacingMd, vertical = Dimens.SpacingSm),
            ) {
                Text("Item",      style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Bold, modifier = Modifier.weight(2.5f))
                Text("Qty",       style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Bold, modifier = Modifier.weight(0.5f), textAlign = TextAlign.Center)
                Text("Price",     style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f),   textAlign = TextAlign.End)
                Text("Disc.",     style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Bold, modifier = Modifier.weight(0.8f), textAlign = TextAlign.End)
                Text("Subtotal",  style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f),   textAlign = TextAlign.End)
                Spacer(Modifier.width(36.dp))
            }
            Divider()
            state.lineItems.forEachIndexed { index, item ->
                LineItemRow(item = item, onDelete = { onEvent(PosEvent.RemoveLineItem(index)) })
                if (index < state.lineItems.lastIndex) Divider(thickness = 0.5.dp)
            }
        }
    }
}

@Composable
private fun LineItemRow(item: PosLineItem, onDelete: () -> Unit) {
    Row(
        modifier          = Modifier
            .fillMaxWidth()
            .padding(horizontal = Dimens.SpacingMd, vertical = Dimens.SpacingSm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(2.5f)) {
            Text(item.name, style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.Medium)
            Text(item.lineType.lowercase().replaceFirstChar { it.uppercase() },
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Text(item.qty.toString(), style = MaterialTheme.typography.bodySmall,
            modifier = Modifier.weight(0.5f), textAlign = TextAlign.Center)
        Text(formatMoney(item.unitPrice), style = MaterialTheme.typography.bodySmall,
            modifier = Modifier.weight(1f), textAlign = TextAlign.End)
        Text(formatMoney(item.lineDiscount), style = MaterialTheme.typography.bodySmall,
            modifier = Modifier.weight(0.8f), textAlign = TextAlign.End)
        Text(formatMoney(item.subtotal), style = MaterialTheme.typography.bodySmall,
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier.weight(1f), textAlign = TextAlign.End)
        IconButton(onClick = onDelete, modifier = Modifier.size(36.dp)) {
            Icon(
                imageVector        = Icons.Default.Delete,
                contentDescription = "Remove item",
                tint               = MaterialTheme.colorScheme.error,
                modifier           = Modifier.size(16.dp),
            )
        }
    }
}

// ─── Running total card ───────────────────────────────────────────────────────

@Composable
private fun RunningTotalCard(
    state: PosUiState,
    onEvent: (PosEvent) -> Unit,
) {
    val discountTypeOptions = listOf(
        "none"    to "No Discount",
        "percent" to "Percent (%)",
        "flat"    to "Flat Amount",
        "coupon"  to "Coupon Code",
    )
    val paymentMethods = listOf("CASH", "CARD", "UPI", "WALLET")

    WellnessCard {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(Dimens.SpacingMd),
            verticalArrangement = Arrangement.spacedBy(Dimens.SpacingSm),
        ) {
            Text("Order Summary", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)

            TotalRow(label = "Subtotal",   value = state.subtotal)
            TotalRow(label = "Discount",   value = -state.discountAmount, highlight = state.discountAmount > 0)
            TotalRow(label = "Tax (0%)",   value = 0.0)
            Divider()
            TotalRow(
                label     = "Total",
                value     = state.finalAmount,
                highlight = true,
                large     = true,
            )

            Spacer(Modifier.height(Dimens.SpacingXs))

            // Discount section
            Text("Discount", style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Medium)
            Row(
                horizontalArrangement = Arrangement.spacedBy(Dimens.SpacingXs),
                modifier = Modifier.fillMaxWidth(),
            ) {
                discountTypeOptions.forEach { (value, label) ->
                    FilterChip(
                        selected = state.discountType == value,
                        onClick  = { onEvent(PosEvent.DiscountChanged(value, "")) },
                        label    = { Text(label, style = MaterialTheme.typography.labelSmall) },
                        colors   = FilterChipDefaults.filterChipColors(
                            selectedContainerColor = WellnessPrimary,
                            selectedLabelColor     = Color.White,
                        ),
                    )
                }
            }
            if (state.discountType != "none") {
                WellnessTextField(
                    value         = state.discountValue,
                    onValueChange = { onEvent(PosEvent.DiscountChanged(state.discountType, it)) },
                    label         = when (state.discountType) {
                        "percent" -> "Discount %"
                        "flat"    -> "Discount Amount (INR)"
                        "coupon"  -> "Coupon Code"
                        else      -> "Value"
                    },
                    keyboardType = if (state.discountType == "coupon") KeyboardType.Text else KeyboardType.Decimal,
                    imeAction    = ImeAction.Done,
                )
            }

            Spacer(Modifier.height(Dimens.SpacingXs))

            // Payment method
            Text("Payment Method", style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Medium)
            Row(
                horizontalArrangement = Arrangement.spacedBy(Dimens.SpacingXs),
                modifier = Modifier.fillMaxWidth(),
            ) {
                paymentMethods.forEach { method ->
                    FilterChip(
                        selected = state.paymentMethod == method,
                        onClick  = { onEvent(PosEvent.PaymentMethodChanged(method)) },
                        label    = { Text(method, style = MaterialTheme.typography.labelSmall) },
                        colors   = FilterChipDefaults.filterChipColors(
                            selectedContainerColor = WellnessPrimary,
                            selectedLabelColor     = Color.White,
                        ),
                    )
                }
            }
        }
    }
}

@Composable
private fun TotalRow(
    label: String,
    value: Double,
    highlight: Boolean = false,
    large: Boolean = false,
) {
    val labelStyle = if (large) MaterialTheme.typography.titleMedium else MaterialTheme.typography.bodySmall
    val valueStyle = if (large) MaterialTheme.typography.titleLarge  else MaterialTheme.typography.bodySmall
    val color      = when {
        large     -> WellnessPrimary
        highlight && value < 0 -> MaterialTheme.colorScheme.error
        highlight -> WellnessPrimary
        else      -> MaterialTheme.colorScheme.onSurface
    }

    Row(
        modifier              = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment     = Alignment.CenterVertically,
    ) {
        Text(label, style = labelStyle, fontWeight = if (large) FontWeight.Bold else FontWeight.Normal)
        Text(
            text       = formatMoney(value),
            style      = valueStyle,
            fontWeight = if (large) FontWeight.Bold else FontWeight.Normal,
            color      = color,
        )
    }
}

// ─── Receipt card ─────────────────────────────────────────────────────────────

@Composable
private fun ReceiptCard(
    receipt: PosReceiptData,
    onNewSale: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Box(modifier = modifier, contentAlignment = Alignment.Center) {
        WellnessCard(modifier = Modifier.width(380.dp)) {
            Column(
                modifier            = Modifier
                    .padding(Dimens.SpacingXxl)
                    .fillMaxWidth(),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
            ) {
                Icon(
                    imageVector        = Icons.Default.CheckCircle,
                    contentDescription = null,
                    tint               = WellnessSuccess,
                    modifier           = Modifier.size(56.dp),
                )
                Text(
                    text       = "Sale Complete",
                    style      = MaterialTheme.typography.headlineSmall,
                    fontWeight = FontWeight.Bold,
                    color      = WellnessSuccess,
                )
                Text(
                    text  = receipt.invoiceNumber,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    fontFamily = FontFamily.Monospace,
                )
                Divider()
                Row(
                    modifier              = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    Text("Amount Charged", style = MaterialTheme.typography.bodyMedium)
                    Text(
                        text       = formatMoney(receipt.finalAmount),
                        style      = MaterialTheme.typography.titleLarge,
                        fontWeight = FontWeight.Bold,
                        color      = WellnessPrimary,
                    )
                }
                Row(
                    modifier              = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    Text("Payment Method", style = MaterialTheme.typography.bodyMedium)
                    StatusBadge(status = receipt.paymentMethod)
                }
                Spacer(Modifier.height(Dimens.SpacingSm))
                WellnessButton(
                    text     = "New Sale",
                    onClick  = onNewSale,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

private fun formatMoney(amount: Double): String =
    NumberFormat.getCurrencyInstance(Locale("en", "IN")).format(amount)
