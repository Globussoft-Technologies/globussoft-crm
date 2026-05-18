package com.globussoft.wellness.feature.crm.presentation.sla

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.globussoft.wellness.core.designsystem.components.EmptyState
import com.globussoft.wellness.core.designsystem.components.ErrorState
import com.globussoft.wellness.core.designsystem.components.ShimmerList
import com.globussoft.wellness.core.designsystem.components.WellnessCard
import com.globussoft.wellness.core.designsystem.theme.Dimens
import com.globussoft.wellness.core.designsystem.theme.GenericPrimary

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SlaScreen(
    viewModel: SlaViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    Scaffold(
        topBar = {
            TopAppBar(
                title  = { Text("SLA Policies") },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.surface,
                ),
            )
        },
        floatingActionButton = {
            FloatingActionButton(
                onClick        = { viewModel.showCreate() },
                containerColor = GenericPrimary,
            ) {
                Icon(Icons.Default.Add, contentDescription = "New SLA Policy", tint = Color.White)
            }
        },
        containerColor = MaterialTheme.colorScheme.background,
    ) { contentPadding ->
        PullToRefreshBox(
            isRefreshing = state.isLoading && state.policies.isNotEmpty(),
            onRefresh    = { viewModel.refresh() },
            modifier     = Modifier.fillMaxSize().padding(contentPadding),
        ) {
            when {
                state.isLoading && state.policies.isEmpty() ->
                    ShimmerList(itemCount = 5, modifier = Modifier.fillMaxSize())
                state.error != null && state.policies.isEmpty() ->
                    ErrorState(message = state.error!!, onRetry = { viewModel.refresh() }, modifier = Modifier.fillMaxSize())
                state.policies.isEmpty() ->
                    EmptyState(message = "No SLA policies yet.", modifier = Modifier.fillMaxSize())
                else ->
                    LazyColumn(
                        contentPadding      = PaddingValues(horizontal = Dimens.SpacingLg, vertical = Dimens.SpacingSm),
                        verticalArrangement = Arrangement.spacedBy(Dimens.SpacingSm),
                    ) {
                        items(state.policies) { policy ->
                            SlaPolicyCard(policy = policy)
                        }
                    }
            }
        }
    }

    if (state.showCreateForm) {
        SlaCreateSheet(
            isCreating = state.isCreating,
            formError  = state.formError,
            onDismiss  = { viewModel.dismissCreate() },
            onSave     = { name, responseHours, resolutionHours ->
                viewModel.createPolicy(name, responseHours, resolutionHours)
            },
        )
    }
}

@Composable
private fun SlaPolicyCard(policy: Map<String, Any>) {
    val name           = policy["name"] as? String ?: "Unnamed Policy"
    val responseHours  = (policy["responseTime"] as? Number)?.toInt() ?: 0
    val resolutionHours = (policy["resolutionTime"] as? Number)?.toInt() ?: 0
    val breachPct      = (policy["breachPercentage"] as? Number)?.toFloat()
        ?: (policy["breachPct"] as? Number)?.toFloat() ?: 0f
    val breachColor    = when {
        breachPct < 5f  -> Color(0xFF2E7D32)
        breachPct < 20f -> Color(0xFFF57C00)
        else            -> Color(0xFFC62828)
    }

    WellnessCard(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.fillMaxWidth().padding(Dimens.SpacingMd)) {
            Text(name, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.padding(top = 6.dp))
            Row(
                modifier              = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalAlignment     = Alignment.CenterVertically,
            ) {
                MetricChip(label = "Response", value = "${responseHours}h", color = GenericPrimary)
                MetricChip(label = "Resolution", value = "${resolutionHours}h", color = Color(0xFF1565C0))
                Spacer(Modifier.weight(1f))
                Box(
                    modifier = Modifier
                        .clip(RoundedCornerShape(6.dp))
                        .background(breachColor.copy(alpha = 0.15f))
                        .padding(horizontal = 8.dp, vertical = 4.dp),
                ) {
                    Text(
                        text      = "Breach ${breachPct.toInt()}%",
                        style     = MaterialTheme.typography.labelSmall,
                        color     = breachColor,
                        fontWeight = FontWeight.Bold,
                    )
                }
            }
        }
    }
}

@Composable
private fun MetricChip(label: String, value: String, color: Color) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Text(value, style = MaterialTheme.typography.labelLarge, color = color, fontWeight = FontWeight.Bold)
        Text(label, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SlaCreateSheet(
    isCreating: Boolean,
    formError: String?,
    onDismiss: () -> Unit,
    onSave: (String, Int, Int) -> Unit,
) {
    var name           by remember { mutableStateOf("") }
    var responseHours  by remember { mutableStateOf("") }
    var resolutionHours by remember { mutableStateOf("") }

    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(
            modifier            = Modifier.padding(horizontal = 24.dp).padding(bottom = 32.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text("New SLA Policy", style = MaterialTheme.typography.titleMedium)
            OutlinedTextField(
                value         = name,
                onValueChange = { name = it },
                label         = { Text("Policy Name") },
                modifier      = Modifier.fillMaxWidth(),
            )
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                OutlinedTextField(
                    value         = responseHours,
                    onValueChange = { responseHours = it },
                    label         = { Text("Response (hrs)") },
                    modifier      = Modifier.weight(1f),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                )
                OutlinedTextField(
                    value         = resolutionHours,
                    onValueChange = { resolutionHours = it },
                    label         = { Text("Resolution (hrs)") },
                    modifier      = Modifier.weight(1f),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                )
            }
            formError?.let {
                Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
            }
            val canSave = name.isNotBlank() &&
                responseHours.toIntOrNull() != null &&
                resolutionHours.toIntOrNull() != null
            Button(
                onClick  = { onSave(name, responseHours.toIntOrNull() ?: 0, resolutionHours.toIntOrNull() ?: 0) },
                enabled  = !isCreating && canSave,
                modifier = Modifier.fillMaxWidth(),
                colors   = ButtonDefaults.buttonColors(containerColor = GenericPrimary),
            ) {
                Text(if (isCreating) "Creating…" else "Create Policy")
            }
        }
    }
}
