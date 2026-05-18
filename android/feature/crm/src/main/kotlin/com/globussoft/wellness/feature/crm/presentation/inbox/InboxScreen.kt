package com.globussoft.wellness.feature.crm.presentation.inbox

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
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.PrimaryTabRow
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Tab
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.globussoft.wellness.core.designsystem.components.EmptyState
import com.globussoft.wellness.core.designsystem.components.ErrorState
import com.globussoft.wellness.core.designsystem.components.ShimmerList
import com.globussoft.wellness.core.designsystem.components.WellnessCard
import com.globussoft.wellness.core.designsystem.theme.Dimens
import com.globussoft.wellness.core.designsystem.theme.GenericPrimary
import kotlinx.coroutines.launch

private val tabs = listOf("Email", "SMS", "WhatsApp", "Notifications")

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun InboxScreen(
    viewModel: InboxViewModel = hiltViewModel(),
) {
    val state       by viewModel.state.collectAsStateWithLifecycle()
    val pagerState  = rememberPagerState(initialPage = state.selectedTab) { tabs.size }
    val scope       = rememberCoroutineScope()

    Scaffold(
        topBar = {
            TopAppBar(
                title  = { Text("Inbox") },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.surface,
                ),
            )
        },
        containerColor = MaterialTheme.colorScheme.background,
    ) { contentPadding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(contentPadding),
        ) {
            PrimaryTabRow(selectedTabIndex = pagerState.currentPage) {
                tabs.forEachIndexed { index, title ->
                    Tab(
                        selected = pagerState.currentPage == index,
                        onClick  = {
                            viewModel.selectTab(index)
                            scope.launch { pagerState.animateScrollToPage(index) }
                        },
                        text = { Text(title, style = MaterialTheme.typography.labelMedium) },
                    )
                }
            }
            HorizontalDivider()

            HorizontalPager(
                state    = pagerState,
                modifier = Modifier.fillMaxSize(),
            ) { page ->
                when (page) {
                    0 -> InboxTabContent(
                        isLoading  = state.isLoadingEmail,
                        error      = state.errorEmail,
                        items      = state.emails,
                        onRefresh  = { viewModel.refreshEmail() },
                        emptyMsg   = "No emails yet.",
                        itemCard   = { EmailCard(it) },
                    )
                    1 -> InboxTabContent(
                        isLoading  = state.isLoadingSms,
                        error      = state.errorSms,
                        items      = state.smsMessages,
                        onRefresh  = { viewModel.refreshSms() },
                        emptyMsg   = "No SMS messages.",
                        itemCard   = { SmsCard(it) },
                    )
                    2 -> InboxTabContent(
                        isLoading  = state.isLoadingWhatsapp,
                        error      = state.errorWhatsapp,
                        items      = state.whatsapp,
                        onRefresh  = { viewModel.refreshWhatsApp() },
                        emptyMsg   = "No WhatsApp messages.",
                        itemCard   = { WhatsAppCard(it) },
                    )
                    3 -> InboxTabContent(
                        isLoading  = state.isLoadingNotifications,
                        error      = state.errorNotifications,
                        items      = state.notifications,
                        onRefresh  = { viewModel.refreshNotifications() },
                        emptyMsg   = "No notifications.",
                        itemCard   = { NotificationCard(it) },
                    )
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun InboxTabContent(
    isLoading: Boolean,
    error: String?,
    items: List<Map<String, Any>>,
    onRefresh: () -> Unit,
    emptyMsg: String,
    itemCard: @Composable (Map<String, Any>) -> Unit,
) {
    PullToRefreshBox(
        isRefreshing = isLoading && items.isNotEmpty(),
        onRefresh    = onRefresh,
        modifier     = Modifier.fillMaxSize(),
    ) {
        when {
            isLoading && items.isEmpty() ->
                ShimmerList(itemCount = 6, modifier = Modifier.fillMaxSize())
            error != null && items.isEmpty() ->
                ErrorState(message = error, onRetry = onRefresh, modifier = Modifier.fillMaxSize())
            items.isEmpty() ->
                EmptyState(message = emptyMsg, modifier = Modifier.fillMaxSize())
            else ->
                LazyColumn(
                    contentPadding      = PaddingValues(horizontal = Dimens.SpacingLg, vertical = Dimens.SpacingSm),
                    verticalArrangement = Arrangement.spacedBy(Dimens.SpacingSm),
                ) {
                    items(items) { item -> itemCard(item) }
                }
        }
    }
}

@Composable
private fun EmailCard(email: Map<String, Any>) {
    val subject = email["subject"] as? String ?: email["title"] as? String ?: "(No subject)"
    val from    = email["from"] as? String ?: email["senderEmail"] as? String ?: ""
    val date    = (email["createdAt"] as? String ?: email["date"] as? String ?: "").take(10)
    val read    = email["isRead"] as? Boolean ?: true

    WellnessCard(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.fillMaxWidth().padding(Dimens.SpacingMd)) {
            Row(
                modifier              = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(
                    text       = subject,
                    style      = MaterialTheme.typography.bodyMedium,
                    fontWeight = if (!read) FontWeight.Bold else FontWeight.Normal,
                    modifier   = Modifier.weight(1f),
                )
                Text(date, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (from.isNotBlank()) {
                Spacer(Modifier.height(2.dp))
                Text(from, style = MaterialTheme.typography.labelSmall, color = GenericPrimary)
            }
        }
    }
}

@Composable
private fun SmsCard(sms: Map<String, Any>) {
    val from = sms["from"] as? String ?: sms["contactName"] as? String ?: sms["phone"] as? String ?: ""
    val body = sms["body"] as? String ?: sms["message"] as? String ?: ""
    val date = (sms["createdAt"] as? String ?: "").take(10)

    WellnessCard(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.fillMaxWidth().padding(Dimens.SpacingMd)) {
            Row(
                modifier              = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(from.ifBlank { "Unknown" }, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                Text(date, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (body.isNotBlank()) {
                Spacer(Modifier.height(2.dp))
                Text(body.take(80), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

@Composable
private fun WhatsAppCard(msg: Map<String, Any>) {
    val contact = msg["contactName"] as? String ?: msg["from"] as? String ?: ""
    val body    = msg["message"] as? String ?: msg["body"] as? String ?: msg["content"] as? String ?: ""
    val date    = (msg["createdAt"] as? String ?: msg["timestamp"] as? String ?: "").take(10)

    WellnessCard(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.fillMaxWidth().padding(Dimens.SpacingMd)) {
            Row(
                modifier              = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(contact.ifBlank { "Unknown" }, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                Text(date, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (body.isNotBlank()) {
                Spacer(Modifier.height(2.dp))
                Text(body.take(80), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

@Composable
private fun NotificationCard(notif: Map<String, Any>) {
    val title   = notif["title"] as? String ?: notif["message"] as? String ?: ""
    val body    = notif["body"] as? String ?: notif["description"] as? String ?: ""
    val date    = (notif["createdAt"] as? String ?: "").take(10)
    val isRead  = notif["isRead"] as? Boolean ?: notif["read"] as? Boolean ?: true

    WellnessCard(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.fillMaxWidth().padding(Dimens.SpacingMd)) {
            Row(
                modifier              = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(
                    text       = title.ifBlank { "Notification" },
                    style      = MaterialTheme.typography.bodyMedium,
                    fontWeight = if (!isRead) FontWeight.Bold else FontWeight.Normal,
                    modifier   = Modifier.weight(1f),
                )
                Text(date, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (body.isNotBlank()) {
                Spacer(Modifier.height(2.dp))
                Text(body.take(100), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}
