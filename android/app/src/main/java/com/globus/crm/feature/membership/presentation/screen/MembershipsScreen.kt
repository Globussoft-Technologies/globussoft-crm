package com.globus.crm.feature.membership.presentation.screen

import androidx.compose.foundation.BorderStroke
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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Group
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
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
import com.globus.crm.core.ui.ErrorState
import com.globus.crm.core.ui.StatusChip
import com.globus.crm.core.ui.WellnessCard
import com.globus.crm.core.ui.WellnessProgressBar
import com.globus.crm.core.util.CurrencyUtil
import com.globus.crm.core.util.DateUtil
import com.globus.crm.feature.membership.domain.model.Membership
import com.globus.crm.feature.membership.domain.model.MembershipPlan
import com.globus.crm.feature.membership.presentation.state.MembershipsUiEvent
import com.globus.crm.feature.membership.presentation.state.MembershipsUiState

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MembershipsScreen(
    state: MembershipsUiState,
    onEvent: (MembershipsUiEvent) -> Unit,
) {
    var isRefreshing by remember { mutableStateOf(false) }
    var showAvailablePlans by remember { mutableStateOf(true) }
    LaunchedEffect(state.isLoading) { if (!state.isLoading) isRefreshing = false }

    PullToRefreshBox(
        isRefreshing = isRefreshing,
        onRefresh = { isRefreshing = true; onEvent(MembershipsUiEvent.Refresh) },
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background),
    ) {
        when {
            state.isLoading && state.memberships.isEmpty() && state.plans.isEmpty() ->
                androidx.compose.material3.CircularProgressIndicator(modifier = Modifier.align(Alignment.Center))
            state.error != null && state.memberships.isEmpty() && state.plans.isEmpty() -> ErrorState(
                message = state.error,
                onRetry = { onEvent(MembershipsUiEvent.Refresh) },
                modifier = Modifier.align(Alignment.Center),
            )
            else -> Column(modifier = Modifier.fillMaxSize()) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp, vertical = 10.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    FilterChip(
                        selected = showAvailablePlans,
                        onClick = { showAvailablePlans = true },
                        label = { Text("Available") },
                    )
                    FilterChip(
                        selected = !showAvailablePlans,
                        onClick = { showAvailablePlans = false },
                        label = { Text("Mine") },
                    )
                }
                if (showAvailablePlans) {
                    AvailablePlansContent(
                        plans = state.plans,
                        myMemberships = state.memberships,
                        onViewDetails = { onEvent(MembershipsUiEvent.SelectPlan(it)) },
                        onJoinNow = { plan ->
                            onEvent(MembershipsUiEvent.SelectPlan(plan))
                            onEvent(MembershipsUiEvent.JoinPlan(plan.id))
                        },
                    )
                } else {
                    MyMembershipsList(
                        memberships = state.memberships,
                        onSelect = { onEvent(MembershipsUiEvent.SelectMembership(it)) },
                    )
                }
            }
        }
    }

    state.selectedMembership?.let { membership ->
        MembershipDetailSheet(
            membership = membership,
            onDismiss = { onEvent(MembershipsUiEvent.DismissDetail) },
        )
    }

    state.selectedPlan?.let { plan ->
        PlanDetailSheet(
            plan = plan,
            onDismiss = { onEvent(MembershipsUiEvent.DismissPlanDetail) },
            onJoin = { onEvent(MembershipsUiEvent.JoinPlan(plan.id)) },
        )
    }

    if (state.showJoinConfirm) {
        val plan = state.selectedPlan
        AlertDialog(
            onDismissRequest = { onEvent(MembershipsUiEvent.DismissJoinConfirm) },
            title = { Text("Join membership?") },
            text = {
                Text("Contact the clinic to purchase ${plan?.name ?: "this membership plan"}.")
            },
            confirmButton = {
                Button(onClick = { onEvent(MembershipsUiEvent.ConfirmJoin) }) { Text("OK") }
            },
            dismissButton = {
                TextButton(onClick = { onEvent(MembershipsUiEvent.DismissJoinConfirm) }) { Text("Cancel") }
            },
        )
    }
}

// ─── Public: embedded into CatalogTabScreen via NavGraph lambda ───────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun InlineMembershipsTab(
    state: MembershipsUiState,
    onEvent: (MembershipsUiEvent) -> Unit,
) {
    var showAvailable by remember { mutableStateOf(true) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background),
    ) {
        // Available / Mine toggle
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 10.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            FilterChip(
                selected = showAvailable,
                onClick = { showAvailable = true },
                label = { Text("Available") },
            )
            FilterChip(
                selected = !showAvailable,
                onClick = { showAvailable = false },
                label = { Text("Mine") },
            )
        }

        if (showAvailable) {
            AvailablePlansContent(
                plans = state.plans,
                myMemberships = state.memberships,
                onViewDetails = { onEvent(MembershipsUiEvent.SelectPlan(it)) },
                onJoinNow = { plan ->
                    onEvent(MembershipsUiEvent.SelectPlan(plan))
                    onEvent(MembershipsUiEvent.JoinPlan(plan.id))
                },
            )
        } else {
            MyMembershipsList(
                memberships = state.memberships,
                onSelect = { onEvent(MembershipsUiEvent.SelectMembership(it)) },
            )
        }
    }

    // Sheets + dialogs (same as MembershipsScreen)
    state.selectedMembership?.let { membership ->
        MembershipDetailSheet(
            membership = membership,
            onDismiss = { onEvent(MembershipsUiEvent.DismissDetail) },
        )
    }

    state.selectedPlan?.let { plan ->
        PlanDetailSheet(
            plan = plan,
            onDismiss = { onEvent(MembershipsUiEvent.DismissPlanDetail) },
            onJoin = { onEvent(MembershipsUiEvent.JoinPlan(plan.id)) },
        )
    }

    if (state.showJoinConfirm) {
        val plan = state.selectedPlan
        AlertDialog(
            onDismissRequest = { onEvent(MembershipsUiEvent.DismissJoinConfirm) },
            title = { Text("Join membership?") },
            text = {
                Text("Contact the clinic to purchase ${plan?.name ?: "this membership plan"}.")
            },
            confirmButton = {
                Button(onClick = { onEvent(MembershipsUiEvent.ConfirmJoin) }) { Text("OK") }
            },
            dismissButton = {
                TextButton(onClick = { onEvent(MembershipsUiEvent.DismissJoinConfirm) }) { Text("Cancel") }
            },
        )
    }
}

@Composable
private fun AvailablePlansContent(
    plans: List<MembershipPlan>,
    myMemberships: List<Membership>,
    onViewDetails: (MembershipPlan) -> Unit,
    onJoinNow: (MembershipPlan) -> Unit,
) {
    if (plans.isEmpty()) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text("No plans available", color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        return
    }
    LazyColumn(
        contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        items(plans) { plan ->
            val isOwned = myMemberships.any { it.planName == plan.name && it.status == "active" }
            val ownedMembership = myMemberships.firstOrNull { it.planName == plan.name && it.status == "active" }
            ProfessionalPlanCard(
                plan = plan,
                isOwned = isOwned,
                ownedUntil = ownedMembership?.let { DateUtil.toDisplayDate(it.endDate) },
                onViewDetails = { onViewDetails(plan) },
                onJoinNow = { onJoinNow(plan) },
            )
        }
    }
}

private fun planCardColor(planName: String): Color = when {
    planName.contains("diamond", ignoreCase = true) -> Color(0xFF1B2E4B)
    planName.contains("gold", ignoreCase = true) -> Color(0xFF7B5B0D)
    planName.contains("platinum", ignoreCase = true) -> Color(0xFF4A3470)
    else -> Color(0xFF265855)
}

private val PLAN_PERKS = listOf(
    "Priority booking & scheduling",
    "Discounted session rates",
    "Dedicated wellness advisor",
)

@Composable
private fun ProfessionalPlanCard(
    plan: MembershipPlan,
    isOwned: Boolean,
    ownedUntil: String?,
    onViewDetails: () -> Unit,
    onJoinNow: () -> Unit,
) {
    val bgColor = planCardColor(plan.name)
    val contentColor = Color.White

    Surface(
        shape = MaterialTheme.shapes.large,
        color = bgColor,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Box(modifier = Modifier.fillMaxWidth()) {
            // Watermark
            Icon(
                imageVector = Icons.Default.Group,
                contentDescription = null,
                tint = contentColor.copy(alpha = 0.10f),
                modifier = Modifier
                    .size(80.dp)
                    .align(Alignment.TopEnd)
                    .padding(12.dp),
            )

            Column(modifier = Modifier.padding(20.dp)) {
                // Plan name + price
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.Top,
                ) {
                    Column {
                        Text(
                            text = plan.name,
                            style = MaterialTheme.typography.titleLarge,
                            fontWeight = FontWeight.Bold,
                            color = contentColor,
                        )
                        Text(
                            text = "${CurrencyUtil.formatRupees(plan.price)} / year",
                            style = MaterialTheme.typography.bodyMedium,
                            color = contentColor.copy(alpha = 0.85f),
                        )
                    }
                    if (isOwned) {
                        Surface(
                            shape = MaterialTheme.shapes.small,
                            color = contentColor.copy(alpha = 0.20f),
                        ) {
                            Text(
                                text = "ACTIVE",
                                style = MaterialTheme.typography.labelSmall,
                                fontWeight = FontWeight.Bold,
                                color = contentColor,
                                modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
                                letterSpacing = 1.sp,
                            )
                        }
                    }
                }

                Spacer(Modifier.height(4.dp))
                Text(
                    text = "Exclusive benefits included",
                    style = MaterialTheme.typography.bodySmall,
                    color = contentColor.copy(alpha = 0.70f),
                )

                Spacer(Modifier.height(12.dp))

                // Perks
                val perks = if (!plan.description.isNullOrBlank()) {
                    listOf(plan.description) + PLAN_PERKS.take(2)
                } else {
                    PLAN_PERKS
                }
                perks.take(3).forEach { perk ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(
                            imageVector = Icons.Default.Check,
                            contentDescription = null,
                            tint = contentColor,
                            modifier = Modifier.size(14.dp),
                        )
                        Spacer(Modifier.width(6.dp))
                        Text(
                            text = perk,
                            style = MaterialTheme.typography.bodySmall,
                            color = contentColor.copy(alpha = 0.90f),
                        )
                    }
                    Spacer(Modifier.height(4.dp))
                }

                Spacer(Modifier.height(16.dp))

                // Buttons
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    OutlinedButton(
                        onClick = onViewDetails,
                        modifier = Modifier.weight(1f),
                        shape = MaterialTheme.shapes.extraLarge,
                        colors = ButtonDefaults.outlinedButtonColors(contentColor = contentColor),
                        border = BorderStroke(1.dp, contentColor.copy(alpha = 0.60f)),
                    ) {
                        Text("View Details", style = MaterialTheme.typography.labelMedium)
                    }

                    Button(
                        onClick = onJoinNow,
                        modifier = Modifier.weight(1f),
                        shape = MaterialTheme.shapes.extraLarge,
                        colors = ButtonDefaults.buttonColors(
                            containerColor = contentColor,
                            contentColor = bgColor,
                        ),
                    ) {
                        if (isOwned && ownedUntil != null) {
                            Text("Until $ownedUntil", style = MaterialTheme.typography.labelSmall)
                        } else {
                            Text("Join Now", style = MaterialTheme.typography.labelMedium)
                        }
                    }
                }
            }
        }
    }
}

// ─── Private shared composables ───────────────────────────────────────────────

@Composable
private fun MyMembershipsList(memberships: List<Membership>, onSelect: (Membership) -> Unit) {
    if (memberships.isEmpty()) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text("No memberships found", color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        return
    }
    LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        items(memberships) { m ->
            MembershipCard(membership = m, onClick = { onSelect(m) })
        }
    }
}

@Composable
private fun MembershipCard(membership: Membership, onClick: () -> Unit) {
    WellnessCard(modifier = Modifier.fillMaxWidth(), onClick = onClick) {
        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.Top,
            ) {
                Text(
                    membership.planName,
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.weight(1f),
                )
                StatusChip(status = membership.status)
            }
            Text(
                "Valid until ${DateUtil.toDisplayDate(membership.endDate)}",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            if (membership.balance.isNotEmpty()) {
                membership.balance.forEach { b ->
                    if (b.serviceName != null && b.remaining != null && b.total != null) {
                        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.SpaceBetween,
                            ) {
                                Text(
                                    b.serviceName,
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                                Text("${b.remaining}/${b.total}", style = MaterialTheme.typography.labelSmall)
                            }
                            WellnessProgressBar(
                                progress = if (b.total > 0) b.remaining.toFloat() / b.total else 0f,
                                modifier = Modifier.fillMaxWidth(),
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun PlanCatalog(plans: List<MembershipPlan>, onSelect: (MembershipPlan) -> Unit) {
    if (plans.isEmpty()) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text("No plans available", color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        return
    }
    LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        items(plans) { plan ->
            WellnessCard(modifier = Modifier.fillMaxWidth(), onClick = { onSelect(plan) }) {
                Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(plan.name, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                    if (!plan.description.isNullOrBlank()) {
                        Text(
                            plan.description,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        Text(
                            CurrencyUtil.formatRupees(plan.price),
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.primary,
                            fontWeight = FontWeight.Bold,
                        )
                        Text(
                            "${plan.durationDays} days",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PlanDetailSheet(
    plan: MembershipPlan,
    onDismiss: () -> Unit,
    onJoin: () -> Unit,
) {
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(
            modifier = Modifier.padding(horizontal = 24.dp).padding(bottom = 32.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(plan.name, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
            HorizontalDivider()
            if (!plan.description.isNullOrBlank()) {
                Text(
                    plan.description,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            DetailRow("Price", CurrencyUtil.formatRupees(plan.price))
            DetailRow("Duration", "${plan.durationDays} days")
            Spacer(modifier = Modifier.height(8.dp))
            Button(
                onClick = onJoin,
                modifier = Modifier.fillMaxWidth(),
                shape = MaterialTheme.shapes.extraLarge,
            ) {
                Text("Join Now")
            }
            OutlinedButton(
                onClick = onDismiss,
                modifier = Modifier.fillMaxWidth(),
                shape = MaterialTheme.shapes.extraLarge,
            ) {
                Text("Close")
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun MembershipDetailSheet(membership: Membership, onDismiss: () -> Unit) {
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(
            modifier = Modifier.padding(horizontal = 24.dp).padding(bottom = 32.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(membership.planName, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
            HorizontalDivider()
            DetailRow("Status", membership.status)
            DetailRow("Start date", DateUtil.toDisplayDate(membership.startDate))
            DetailRow("End date", DateUtil.toDisplayDate(membership.endDate))
        }
    }
}

@Composable
private fun DetailRow(label: String, value: String) {
    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(label, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value, style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.Medium)
    }
}
