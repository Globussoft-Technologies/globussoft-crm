package com.globussoft.wellness.feature.crm.presentation.tickets

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.globussoft.wellness.core.domain.model.Ticket

private val GenericPrimary = Color(0xFF4F46E5)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TicketDetailScreen(
    ticketId: String,
    onBack: () -> Unit = {},
    viewModel: TicketDetailViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val listState = rememberLazyListState()

    // Scroll to bottom when new comment arrives
    LaunchedEffect(state.comments.size) {
        if (state.comments.isNotEmpty()) {
            listState.animateScrollToItem(state.comments.size - 1)
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(state.ticket?.subject ?: "Ticket Detail") },
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") }
                },
                actions = {
                    state.ticket?.let { ticket ->
                        TextButton(onClick = { viewModel.showStatusSheet() }) {
                            StatusBadge(ticket.status)
                        }
                    }
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
                // Ticket header info
                val ticket = state.ticket
                if (ticket != null) {
                    TicketInfoHeader(ticket)
                }

                // Comment thread
                LazyColumn(
                    state = listState,
                    modifier = Modifier.weight(1f),
                    contentPadding = PaddingValues(16.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    // Original ticket description as first "comment"
                    val desc = ticket?.description
                    if (!desc.isNullOrBlank()) {
                        item {
                            CommentBubble(
                                author = ticket.contactName ?: "Customer",
                                body = desc,
                                timestamp = ticket.createdAt?.take(10) ?: "",
                                isAgent = false,
                            )
                        }
                    }
                    if (state.comments.isEmpty() && desc.isNullOrBlank()) {
                        item {
                            Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                                Text("No replies yet", color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }
                    }
                    items(state.comments, key = { it.id }) { comment ->
                        CommentBubble(
                            author = comment.author,
                            body = comment.body,
                            timestamp = comment.createdAt,
                            isAgent = true,
                        )
                    }
                }

                // Reply input
                HorizontalDivider()
                ReplyInputBar(
                    text = state.replyText,
                    isSending = state.isSendingReply,
                    onTextChange = { viewModel.setReplyText(it) },
                    onSend = { viewModel.sendReply() },
                )
            }
        }
    }

    // Status change sheet
    if (state.showStatusSheet) {
        TicketStatusSheet(
            current = state.ticket?.status ?: "",
            isUpdating = state.isUpdating,
            onDismiss = { viewModel.dismissStatusSheet() },
            onSelect = { viewModel.changeStatus(it) },
        )
    }
}

@Composable
private fun TicketInfoHeader(ticket: Ticket) {
    Surface(color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f)) {
        Row(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 10.dp),
            horizontalArrangement = Arrangement.spacedBy(16.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                if (!ticket.contactName.isNullOrBlank()) {
                    Text("From: ${ticket.contactName}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                if (!ticket.assigneeName.isNullOrBlank()) {
                    Text("Assigned: ${ticket.assigneeName}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            PriorityBadge(ticket.priority)
            if (ticket.breached) {
                Surface(
                    shape = RoundedCornerShape(6.dp),
                    color = MaterialTheme.colorScheme.error,
                ) {
                    Text(
                        "SLA BREACHED",
                        modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
                        style = MaterialTheme.typography.labelSmall,
                        color = Color.White,
                        fontWeight = FontWeight.Bold,
                    )
                }
            }
        }
    }
    HorizontalDivider()
}

@Composable
private fun StatusBadge(status: String) {
    val color = when (status) {
        "OPEN"        -> Color(0xFF10B981)
        "IN_PROGRESS" -> Color(0xFFF59E0B)
        "RESOLVED"    -> Color(0xFF6B7280)
        else          -> MaterialTheme.colorScheme.onSurfaceVariant
    }
    Surface(
        shape = RoundedCornerShape(8.dp),
        color = color.copy(alpha = 0.15f),
    ) {
        Text(
            status.replace("_", " "),
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp),
            style = MaterialTheme.typography.labelMedium,
            color = color,
            fontWeight = FontWeight.SemiBold,
        )
    }
}

@Composable
private fun PriorityBadge(priority: String) {
    val color = when (priority) {
        "HIGH"   -> MaterialTheme.colorScheme.error
        "MEDIUM" -> Color(0xFFF59E0B)
        else     -> MaterialTheme.colorScheme.onSurfaceVariant
    }
    Text(
        priority,
        style = MaterialTheme.typography.labelSmall,
        color = color,
        fontWeight = FontWeight.Bold,
    )
}

@Composable
private fun CommentBubble(author: String, body: String, timestamp: String, isAgent: Boolean) {
    val alignment = if (isAgent) Alignment.End else Alignment.Start
    val bubbleColor = if (isAgent) GenericPrimary.copy(alpha = 0.12f) else MaterialTheme.colorScheme.surfaceVariant

    Column(
        modifier = Modifier.fillMaxWidth(),
        horizontalAlignment = alignment,
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Box(
                Modifier
                    .size(24.dp)
                    .background(GenericPrimary, CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    author.take(1).uppercase(),
                    color = Color.White,
                    style = MaterialTheme.typography.labelSmall,
                    fontWeight = FontWeight.Bold,
                )
            }
            Text(author, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold)
            Text(timestamp, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Spacer(Modifier.height(4.dp))
        Surface(
            shape = RoundedCornerShape(
                topStart = if (isAgent) 12.dp else 4.dp,
                topEnd = if (isAgent) 4.dp else 12.dp,
                bottomStart = 12.dp,
                bottomEnd = 12.dp,
            ),
            color = bubbleColor,
            modifier = Modifier.widthIn(max = 320.dp),
        ) {
            Text(
                body,
                modifier = Modifier.padding(12.dp),
                style = MaterialTheme.typography.bodyMedium,
            )
        }
    }
}

@Composable
private fun ReplyInputBar(
    text: String,
    isSending: Boolean,
    onTextChange: (String) -> Unit,
    onSend: () -> Unit,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        OutlinedTextField(
            value = text,
            onValueChange = onTextChange,
            modifier = Modifier.weight(1f),
            placeholder = { Text("Type a reply…") },
            maxLines = 4,
            shape = RoundedCornerShape(24.dp),
        )
        IconButton(
            onClick = onSend,
            enabled = text.isNotBlank() && !isSending,
            colors = IconButtonDefaults.iconButtonColors(
                contentColor = GenericPrimary,
            ),
        ) {
            if (isSending) {
                CircularProgressIndicator(Modifier.size(20.dp), color = GenericPrimary, strokeWidth = 2.dp)
            } else {
                Icon(Icons.AutoMirrored.Filled.Send, "Send")
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun TicketStatusSheet(
    current: String,
    isUpdating: Boolean,
    onDismiss: () -> Unit,
    onSelect: (String) -> Unit,
) {
    val statuses = listOf("OPEN", "IN_PROGRESS", "RESOLVED")
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(
            Modifier
                .padding(horizontal = 24.dp)
                .padding(bottom = 32.dp),
        ) {
            Text("Change Status", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(bottom = 16.dp))
            statuses.forEach { status ->
                val isCurrent = status == current
                TextButton(
                    onClick = { if (!isCurrent) onSelect(status) },
                    modifier = Modifier.fillMaxWidth(),
                    enabled = !isUpdating,
                ) {
                    Row(
                        Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            status.replace("_", " "),
                            color = if (isCurrent) GenericPrimary else MaterialTheme.colorScheme.onSurface,
                            fontWeight = if (isCurrent) FontWeight.Bold else FontWeight.Normal,
                        )
                        if (isCurrent) Text("Current", style = MaterialTheme.typography.labelSmall, color = GenericPrimary)
                    }
                }
            }
        }
    }
}
