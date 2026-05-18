package com.globussoft.wellness.feature.admin.presentation.memberships

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
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.CardMembership
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SuggestionChip
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
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
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.globussoft.wellness.core.designsystem.components.EmptyState
import com.globussoft.wellness.core.designsystem.components.ErrorState
import com.globussoft.wellness.core.designsystem.components.ShimmerList
import com.globussoft.wellness.core.designsystem.components.WellnessCard
import com.globussoft.wellness.core.designsystem.theme.Dimens
import com.globussoft.wellness.core.designsystem.theme.WellnessPrimary
import com.globussoft.wellness.feature.admin.domain.repository.MembershipPlanItem

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MembershipsScreen(
    viewModel: MembershipsViewModel = hiltViewModel(),
    onNavigateBack: () -> Unit = {},
) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text("Membership Plans", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
                        if (state.plans.isNotEmpty()) {
                            Text("${state.plans.size} plans", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                },
                navigationIcon = {
                    IconButton(onClick = onNavigateBack) { Icon(Icons.Default.ArrowBack, contentDescription = "Back") }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.surface),
            )
        },
        containerColor = MaterialTheme.colorScheme.background,
    ) { padding ->
        PullToRefreshBox(
            isRefreshing = state.isLoading && state.plans.isNotEmpty(),
            onRefresh    = viewModel::refresh,
            modifier     = Modifier.fillMaxSize().padding(padding),
        ) {
            when {
                state.isLoading && state.plans.isEmpty() ->
                    ShimmerList(itemCount = 6, modifier = Modifier.fillMaxSize())
                state.error != null && state.plans.isEmpty() ->
                    ErrorState(message = state.error!!, onRetry = viewModel::refresh, modifier = Modifier.fillMaxSize())
                state.plans.isEmpty() ->
                    EmptyState(message = "No membership plans found.", icon = Icons.Default.CardMembership, modifier = Modifier.fillMaxSize())
                else -> LazyColumn(
                    contentPadding      = PaddingValues(Dimens.SpacingLg),
                    verticalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
                    modifier            = Modifier.fillMaxSize(),
                ) {
                    items(state.plans, key = { it.id }) { item ->
                        MembershipPlanCard(
                            item     = item,
                            onEnroll = { viewModel.showEnroll(item.id) },
                        )
                    }
                }
            }
        }
    }

    if (state.showEnrollSheet) {
        EnrollMembershipSheet(
            isEnrolling = state.isEnrolling,
            onDismiss   = { viewModel.dismissEnroll() },
            onEnroll    = { patientId -> viewModel.enrollPatient(patientId) },
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun EnrollMembershipSheet(
    isEnrolling: Boolean,
    onDismiss:   () -> Unit,
    onEnroll:    (String) -> Unit,
) {
    var patientId by remember { mutableStateOf("") }
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(
            Modifier.padding(horizontal = 24.dp).padding(bottom = 32.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text("Enroll Patient", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
            OutlinedTextField(
                value         = patientId,
                onValueChange = { patientId = it },
                label         = { Text("Patient ID *") },
                modifier      = Modifier.fillMaxWidth(),
            )
            Button(
                onClick  = { onEnroll(patientId) },
                enabled  = patientId.isNotBlank() && !isEnrolling,
                modifier = Modifier.fillMaxWidth(),
                colors   = ButtonDefaults.buttonColors(containerColor = WellnessPrimary),
            ) {
                if (isEnrolling) CircularProgressIndicator(Modifier.padding(horizontal = 8.dp).height(18.dp), color = Color.White, strokeWidth = 2.dp)
                else Text("Enroll")
            }
        }
    }
}

@Composable
private fun MembershipPlanCard(
    item:     MembershipPlanItem,
    onEnroll: () -> Unit = {},
) {
    WellnessCard(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.fillMaxWidth().padding(Dimens.SpacingMd)) {
            Row(
                modifier              = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment     = Alignment.Top,
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(item.name, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                    if (!item.description.isNullOrBlank()) {
                        Spacer(Modifier.height(2.dp))
                        Text(
                            item.description,
                            style    = MaterialTheme.typography.bodySmall,
                            color    = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 2,
                        )
                    }
                    Text(
                        text  = "${item.durationDays} days",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Column(horizontalAlignment = Alignment.End) {
                    Text(
                        text       = "${item.currency} ${"%.0f".format(item.price)}",
                        style      = MaterialTheme.typography.titleSmall,
                        fontWeight = FontWeight.Bold,
                        color      = WellnessPrimary,
                    )
                    if (!item.isActive) {
                        SuggestionChip(
                            onClick = {},
                            label   = { Text("Inactive", style = MaterialTheme.typography.labelSmall) },
                        )
                    }
                }
            }
            if (!item.entitlements.isNullOrBlank() && item.entitlements != "null") {
                Spacer(Modifier.height(4.dp))
                Text(
                    text  = "Entitlements: ${item.entitlements}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 2,
                )
            }
            if (item.isActive) {
                Spacer(Modifier.height(8.dp))
                TextButton(
                    onClick  = onEnroll,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text("+ Enroll Patient", color = WellnessPrimary)
                }
            }
        }
    }
}
