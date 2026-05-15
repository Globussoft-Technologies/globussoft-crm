package com.globussoft.wellness.feature.crm.presentation.deals

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.SwapHoriz
import androidx.compose.material3.*
import androidx.compose.material3.TabRowDefaults.tabIndicatorOffset
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.globussoft.wellness.core.domain.model.Deal
import com.globussoft.wellness.core.domain.model.Pipeline
import kotlinx.coroutines.launch

private val GenericPrimary = Color(0xFF4F46E5)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DealDetailScreen(
    dealId: String,
    onBack: () -> Unit = {},
    viewModel: DealDetailViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val pagerState = androidx.compose.foundation.pager.rememberPagerState(pageCount = { 3 })
    val coroutineScope = rememberCoroutineScope()
    val tabs = listOf("Overview", "Activities", "Files")

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(state.deal?.title ?: "Deal Detail") },
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") }
                },
                actions = {
                    IconButton(onClick = { viewModel.showEditForm() }) { Icon(Icons.Default.Edit, "Edit") }
                    IconButton(onClick = { viewModel.showStageSheet() }) { Icon(Icons.Default.SwapHoriz, "Change Stage") }
                },
            )
        }
    ) { padding ->
        when {
            state.isLoading -> Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(color = GenericPrimary)
            }
            state.error != null -> Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) {
                Text(state.error ?: "Error", color = MaterialTheme.colorScheme.error)
            }
            else -> Column(Modifier.fillMaxSize().padding(padding)) {
                val deal = state.deal
                if (deal != null) {
                    DealDetailHeader(
                        deal = deal,
                        isUpdating = state.isUpdating,
                        onMarkWon = { viewModel.markWon() },
                        onMarkLost = { viewModel.markLost() },
                    )
                }
                TabRow(
                    selectedTabIndex = pagerState.currentPage,
                    containerColor = MaterialTheme.colorScheme.surface,
                    contentColor = GenericPrimary,
                    indicator = { tabPositions ->
                        TabRowDefaults.SecondaryIndicator(
                            Modifier.tabIndicatorOffset(tabPositions[pagerState.currentPage]),
                            color = GenericPrimary,
                        )
                    }
                ) {
                    tabs.forEachIndexed { idx, title ->
                        Tab(
                            selected = pagerState.currentPage == idx,
                            onClick = { coroutineScope.launch { pagerState.animateScrollToPage(idx) } },
                            text = { Text(title, style = MaterialTheme.typography.bodySmall) },
                        )
                    }
                }
                androidx.compose.foundation.pager.HorizontalPager(
                    state = pagerState,
                    modifier = Modifier.fillMaxSize(),
                ) { page ->
                    when (page) {
                        0 -> DealOverviewTab(state.deal)
                        1 -> DealActivitiesTab()
                        2 -> DealFilesTab()
                        else -> Box(Modifier.fillMaxSize())
                    }
                }
            }
        }
    }

    // Stage change bottom sheet
    if (state.showStageSheet) {
        DealStageSheet(
            deal = state.deal,
            pipelines = state.pipelines,
            isUpdating = state.isUpdating,
            onDismiss = { viewModel.dismissStageSheet() },
            onSelectStage = { viewModel.changeStage(it) },
        )
    }

    // Edit form bottom sheet
    if (state.showEditForm) {
        val deal = state.deal
        if (deal != null) {
            DealEditSheet(
                deal = deal,
                isUpdating = state.isUpdating,
                formError = state.formError,
                onDismiss = { viewModel.dismissEditForm() },
                onSave = { title, amount, prob -> viewModel.saveDeal(title, amount, prob) },
            )
        }
    }
}

@Composable
private fun DealDetailHeader(
    deal: Deal,
    isUpdating: Boolean,
    onMarkWon: () -> Unit,
    onMarkLost: () -> Unit,
) {
    Column(Modifier.fillMaxWidth().padding(16.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.Top) {
            Column(Modifier.weight(1f)) {
                Text(deal.title, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
                Text(
                    "$${"%,.0f".format(deal.amount)}",
                    style = MaterialTheme.typography.titleMedium,
                    color = GenericPrimary,
                    fontWeight = FontWeight.SemiBold,
                )
            }
            StageBadge(deal.stage)
        }
        Spacer(Modifier.height(8.dp))
        LinearProgressIndicator(
            progress = { deal.probability / 100f },
            modifier = Modifier.fillMaxWidth().height(6.dp),
            color = GenericPrimary,
        )
        Text(
            "${deal.probability}% probability",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(top = 2.dp),
        )
        if (deal.status != "WON" && deal.status != "LOST") {
            Row(Modifier.padding(top = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(
                    onClick = onMarkWon,
                    enabled = !isUpdating,
                    colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF10B981)),
                    modifier = Modifier.weight(1f),
                ) { Text("Mark Won") }
                OutlinedButton(
                    onClick = onMarkLost,
                    enabled = !isUpdating,
                    modifier = Modifier.weight(1f),
                ) { Text("Mark Lost") }
            }
        } else {
            Box(
                Modifier
                    .padding(top = 12.dp)
                    .background(
                        if (deal.status == "WON") Color(0xFF10B981) else MaterialTheme.colorScheme.error,
                        RoundedCornerShape(8.dp),
                    )
                    .padding(horizontal = 12.dp, vertical = 4.dp)
            ) {
                Text(
                    deal.status,
                    color = Color.White,
                    style = MaterialTheme.typography.labelMedium,
                    fontWeight = FontWeight.Bold,
                )
            }
        }
    }
    HorizontalDivider()
}

@Composable
private fun StageBadge(stage: String) {
    Surface(
        shape = RoundedCornerShape(8.dp),
        color = GenericPrimary.copy(alpha = 0.12f),
    ) {
        Text(
            stage,
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp),
            style = MaterialTheme.typography.labelMedium,
            color = GenericPrimary,
            fontWeight = FontWeight.SemiBold,
        )
    }
}

@Composable
private fun DealOverviewTab(deal: Deal?) {
    if (deal == null) return
    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        DealInfoRow("Pipeline", deal.pipelineName ?: "—")
        DealInfoRow("Stage", deal.stage)
        DealInfoRow("Status", deal.status)
        DealInfoRow("Contact", deal.contactName ?: "—")
        DealInfoRow("Owner", deal.ownerName ?: "—")
        DealInfoRow("Expected Close", deal.expectedClose?.take(10) ?: "—")
        DealInfoRow("Created", deal.createdAt?.take(10) ?: "—")
    }
}

@Composable
private fun DealInfoRow(label: String, value: String) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(label, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
    }
}

@Composable
private fun DealActivitiesTab() {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Text("No activities recorded yet", color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun DealFilesTab() {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Text("No files attached", color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DealStageSheet(
    deal: Deal?,
    pipelines: List<Pipeline>,
    isUpdating: Boolean,
    onDismiss: () -> Unit,
    onSelectStage: (String) -> Unit,
) {
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(
            Modifier
                .padding(horizontal = 24.dp)
                .padding(bottom = 32.dp),
        ) {
            Text("Change Stage", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(bottom = 16.dp))
            val stages = pipelines.flatMap { it.stages }.map { it.name }.distinct().ifEmpty {
                listOf("Prospecting", "Qualification", "Proposal", "Negotiation", "Closed Won", "Closed Lost")
            }
            stages.forEach { stage ->
                val isCurrent = stage == deal?.stage
                TextButton(
                    onClick = { if (!isCurrent) onSelectStage(stage) },
                    modifier = Modifier.fillMaxWidth(),
                    enabled = !isUpdating,
                ) {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            stage,
                            color = if (isCurrent) GenericPrimary else MaterialTheme.colorScheme.onSurface,
                            fontWeight = if (isCurrent) FontWeight.Bold else FontWeight.Normal,
                        )
                        if (isCurrent) {
                            Text("Current", style = MaterialTheme.typography.labelSmall, color = GenericPrimary)
                        }
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DealEditSheet(
    deal: Deal,
    isUpdating: Boolean,
    formError: String?,
    onDismiss: () -> Unit,
    onSave: (String, String, String) -> Unit,
) {
    var title       by remember(deal.id) { mutableStateOf(deal.title) }
    var amount      by remember(deal.id) { mutableStateOf(deal.amount.toLong().toString()) }
    var probability by remember(deal.id) { mutableStateOf(deal.probability.toString()) }

    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(
            Modifier
                .padding(horizontal = 24.dp)
                .padding(bottom = 32.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text("Edit Deal", style = MaterialTheme.typography.titleMedium)
            OutlinedTextField(value = title, onValueChange = { title = it }, label = { Text("Title *") }, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(value = amount, onValueChange = { amount = it }, label = { Text("Amount") }, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(value = probability, onValueChange = { probability = it }, label = { Text("Probability (0-100)") }, modifier = Modifier.fillMaxWidth())
            formError?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
            Button(
                onClick = { onSave(title, amount, probability) },
                enabled = title.isNotBlank() && !isUpdating,
                modifier = Modifier.fillMaxWidth(),
                colors = ButtonDefaults.buttonColors(containerColor = GenericPrimary),
            ) {
                if (isUpdating) CircularProgressIndicator(Modifier.size(20.dp), color = Color.White, strokeWidth = 2.dp)
                else Text("Save Changes")
            }
        }
    }
}
