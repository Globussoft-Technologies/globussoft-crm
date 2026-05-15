package com.globussoft.wellness.feature.crm.presentation.contacts

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Edit
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
import kotlinx.coroutines.launch

private val GenericPrimary = Color(0xFF4F46E5)

private val TABS = listOf("Overview", "Activities", "Deals", "Tasks")

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ContactDetailScreen(
    contactId: String,
    onBack: () -> Unit = {},
    viewModel: ContactDetailViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val pagerState = rememberPagerState(pageCount = { TABS.size })
    val coroutineScope = rememberCoroutineScope()

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(state.contact?.name ?: "Contact Detail") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back")
                    }
                },
                actions = {
                    IconButton(onClick = { viewModel.showEdit() }) {
                        Icon(Icons.Default.Edit, "Edit")
                    }
                },
            )
        }
    ) { padding ->
        when {
            state.isLoading -> Box(
                Modifier
                    .fillMaxSize()
                    .padding(padding),
                contentAlignment = Alignment.Center
            ) {
                CircularProgressIndicator(color = GenericPrimary)
            }
            state.error != null -> Box(
                Modifier
                    .fillMaxSize()
                    .padding(padding),
                contentAlignment = Alignment.Center
            ) {
                Text(state.error ?: "Error", color = MaterialTheme.colorScheme.error)
            }
            else -> Column(
                Modifier
                    .fillMaxSize()
                    .padding(padding)
            ) {
                val contact = state.contact
                if (contact != null) {
                    ContactDetailHeader(contact)
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
                    TABS.forEachIndexed { idx, title ->
                        Tab(
                            selected = pagerState.currentPage == idx,
                            onClick = {
                                coroutineScope.launch { pagerState.animateScrollToPage(idx) }
                            },
                            text = { Text(title, style = MaterialTheme.typography.bodySmall) },
                        )
                    }
                }
                HorizontalPager(
                    state = pagerState,
                    modifier = Modifier.fillMaxSize(),
                ) { page ->
                    when (page) {
                        0 -> ContactOverviewTab(state.contact)
                        1 -> ContactActivitiesTab()
                        2 -> ContactDealsTab(state.deals)
                        3 -> ContactTasksTab(state.tasks)
                        else -> Box(Modifier.fillMaxSize())
                    }
                }
            }
        }
    }

    if (state.showEditForm) {
        val contact = state.contact
        if (contact != null) {
            ContactEditSheet(
                contact = contact,
                isUpdating = state.isUpdating,
                formError = state.formError,
                onDismiss = { viewModel.dismissEdit() },
                onSave = { name, email, phone, company ->
                    viewModel.saveContact(name, email, phone, company)
                },
            )
        }
    }
}

@Composable
private fun ContactDetailHeader(contact: com.globussoft.wellness.core.domain.model.Contact) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier
                .size(56.dp)
                .background(GenericPrimary, CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                text = contact.name.take(2).uppercase(),
                color = Color.White,
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold,
            )
        }
        Spacer(Modifier.width(16.dp))
        Column {
            Text(
                contact.name,
                style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.SemiBold
            )
            val company = contact.company
            if (!company.isNullOrBlank()) {
                Text(
                    company,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
            val status = contact.status
            if (status != null) {
                AssistChip(
                    onClick = {},
                    label = { Text(status, style = MaterialTheme.typography.labelSmall) },
                    modifier = Modifier.padding(top = 4.dp),
                )
            }
        }
    }
    HorizontalDivider()
}

@Composable
private fun ContactOverviewTab(contact: com.globussoft.wellness.core.domain.model.Contact?) {
    if (contact == null) return
    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        ContactInfoRow("Email", contact.email ?: "—")
        ContactInfoRow("Phone", contact.phone ?: "—")
        ContactInfoRow("Company", contact.company ?: "—")
        ContactInfoRow("Status", contact.status ?: "—")
        ContactInfoRow("Source", contact.source ?: "—")
        ContactInfoRow("Assigned To", contact.assigneeName ?: "—")
        ContactInfoRow("AI Score", contact.aiScore.toString())
        ContactInfoRow("Deals", contact.dealsCount.toString())
        ContactInfoRow("Created", contact.createdAt?.take(10) ?: "—")
    }
}

@Composable
private fun ContactInfoRow(label: String, value: String) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(
            label,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        Text(value, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
    }
}

@Composable
private fun ContactActivitiesTab() {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Text("No activities recorded yet", color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun ContactDealsTab(deals: List<com.globussoft.wellness.core.domain.model.Deal>) {
    if (deals.isEmpty()) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text("No linked deals", color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        return
    }
    LazyColumn(
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        items(deals) { deal ->
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(12.dp)) {
                    Text(
                        deal.title,
                        style = MaterialTheme.typography.bodyLarge,
                        fontWeight = FontWeight.SemiBold
                    )
                    Text(
                        "$${"%,.0f".format(deal.amount)} · ${deal.stage}",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
        }
    }
}

@Composable
private fun ContactTasksTab(tasks: List<com.globussoft.wellness.core.domain.model.CrmTask>) {
    if (tasks.isEmpty()) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text("No linked tasks", color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        return
    }
    LazyColumn(
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        items(tasks) { task ->
            Card(Modifier.fillMaxWidth()) {
                Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(task.title, style = MaterialTheme.typography.bodyLarge)
                        val dueDate = task.dueDate
                        if (dueDate != null) {
                            Text(
                                "Due: ${dueDate.take(10)}",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                    }
                    AssistChip(
                        onClick = {},
                        label = { Text(task.status, style = MaterialTheme.typography.labelSmall) }
                    )
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ContactEditSheet(
    contact: com.globussoft.wellness.core.domain.model.Contact,
    isUpdating: Boolean,
    formError: String?,
    onDismiss: () -> Unit,
    onSave: (String, String, String, String) -> Unit,
) {
    var name    by remember(contact.id) { mutableStateOf(contact.name) }
    var email   by remember(contact.id) { mutableStateOf(contact.email ?: "") }
    var phone   by remember(contact.id) { mutableStateOf(contact.phone ?: "") }
    var company by remember(contact.id) { mutableStateOf(contact.company ?: "") }

    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(
            Modifier
                .padding(horizontal = 24.dp)
                .padding(bottom = 32.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text("Edit Contact", style = MaterialTheme.typography.titleMedium)
            OutlinedTextField(
                value = name,
                onValueChange = { name = it },
                label = { Text("Name *") },
                modifier = Modifier.fillMaxWidth()
            )
            OutlinedTextField(
                value = email,
                onValueChange = { email = it },
                label = { Text("Email") },
                modifier = Modifier.fillMaxWidth()
            )
            OutlinedTextField(
                value = phone,
                onValueChange = { phone = it },
                label = { Text("Phone") },
                modifier = Modifier.fillMaxWidth()
            )
            OutlinedTextField(
                value = company,
                onValueChange = { company = it },
                label = { Text("Company") },
                modifier = Modifier.fillMaxWidth()
            )
            if (formError != null) {
                Text(
                    formError,
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodySmall
                )
            }
            Button(
                onClick = { onSave(name, email, phone, company) },
                enabled = name.isNotBlank() && !isUpdating,
                modifier = Modifier.fillMaxWidth(),
                colors = ButtonDefaults.buttonColors(containerColor = GenericPrimary),
            ) {
                if (isUpdating) {
                    CircularProgressIndicator(
                        Modifier.size(20.dp),
                        color = Color.White,
                        strokeWidth = 2.dp
                    )
                } else {
                    Text("Save Changes")
                }
            }
        }
    }
}
