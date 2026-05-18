package com.globussoft.wellness.feature.crm.presentation.signatures

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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.globussoft.wellness.core.designsystem.components.EmptyState
import com.globussoft.wellness.core.designsystem.components.ErrorState
import com.globussoft.wellness.core.designsystem.components.ShimmerList
import com.globussoft.wellness.core.designsystem.components.WellnessCard
import com.globussoft.wellness.core.designsystem.theme.Dimens
import com.globussoft.wellness.core.designsystem.theme.GenericPrimary

private fun signatureStatusColor(status: String): Color = when (status.uppercase()) {
    "SIGNED"   -> Color(0xFF2E7D32)
    "DECLINED" -> Color(0xFFC62828)
    else       -> Color(0xFFF57C00) // PENDING
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SignaturesScreen(
    viewModel: SignaturesViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    Scaffold(
        topBar = {
            TopAppBar(
                title  = { Text("E-Signatures") },
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
                Icon(Icons.Default.Add, contentDescription = "New Signature Request", tint = Color.White)
            }
        },
        containerColor = MaterialTheme.colorScheme.background,
    ) { contentPadding ->
        PullToRefreshBox(
            isRefreshing = state.isLoading && state.signatures.isNotEmpty(),
            onRefresh    = { viewModel.refresh() },
            modifier     = Modifier.fillMaxSize().padding(contentPadding),
        ) {
            when {
                state.isLoading && state.signatures.isEmpty() ->
                    ShimmerList(itemCount = 5, modifier = Modifier.fillMaxSize())
                state.error != null && state.signatures.isEmpty() ->
                    ErrorState(message = state.error!!, onRetry = { viewModel.refresh() }, modifier = Modifier.fillMaxSize())
                state.signatures.isEmpty() ->
                    EmptyState(message = "No signature requests yet.", modifier = Modifier.fillMaxSize())
                else ->
                    LazyColumn(
                        contentPadding      = PaddingValues(horizontal = Dimens.SpacingLg, vertical = Dimens.SpacingSm),
                        verticalArrangement = Arrangement.spacedBy(Dimens.SpacingSm),
                    ) {
                        items(state.signatures) { sig ->
                            SignatureCard(sig = sig)
                        }
                    }
            }
        }
    }

    if (state.showCreateForm) {
        SignatureCreateSheet(
            isCreating = state.isCreating,
            formError  = state.formError,
            onDismiss  = { viewModel.dismissCreate() },
            onSave     = { docName, email -> viewModel.createSignatureRequest(docName, email) },
        )
    }
}

@Composable
private fun SignatureCard(sig: Map<String, Any>) {
    val docName     = sig["documentName"] as? String
        ?: sig["title"] as? String
        ?: "Unnamed Document"
    val signerEmail = sig["signerEmail"] as? String ?: sig["email"] as? String ?: "—"
    val status      = sig["status"] as? String ?: "PENDING"
    val createdAt   = sig["createdAt"] as? String ?: sig["requestedAt"] as? String ?: ""
    val statusColor = signatureStatusColor(status)

    WellnessCard(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.fillMaxWidth().padding(Dimens.SpacingMd)) {
            Row(
                modifier              = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment     = Alignment.CenterVertically,
            ) {
                Text(docName, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                Box(
                    modifier = Modifier
                        .clip(RoundedCornerShape(4.dp))
                        .background(statusColor.copy(alpha = 0.15f))
                        .padding(horizontal = 6.dp, vertical = 2.dp),
                ) {
                    Text(status, style = MaterialTheme.typography.labelSmall, color = statusColor, fontWeight = FontWeight.Bold)
                }
            }
            Spacer(Modifier.padding(top = 4.dp))
            Text(
                text  = signerEmail,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            if (createdAt.isNotEmpty()) {
                val displayDate = createdAt.take(10)
                Text(
                    text  = "Requested: $displayDate",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SignatureCreateSheet(
    isCreating: Boolean,
    formError: String?,
    onDismiss: () -> Unit,
    onSave: (String, String) -> Unit,
) {
    var documentName by remember { mutableStateOf("") }
    var signerEmail  by remember { mutableStateOf("") }

    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(
            modifier            = Modifier.padding(horizontal = 24.dp).padding(bottom = 32.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text("New Signature Request", style = MaterialTheme.typography.titleMedium)
            OutlinedTextField(
                value         = documentName,
                onValueChange = { documentName = it },
                label         = { Text("Document Name") },
                modifier      = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value         = signerEmail,
                onValueChange = { signerEmail = it },
                label         = { Text("Signer Email") },
                modifier      = Modifier.fillMaxWidth(),
            )
            formError?.let {
                Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
            }
            Button(
                onClick  = { onSave(documentName, signerEmail) },
                enabled  = !isCreating && documentName.isNotBlank() && signerEmail.isNotBlank(),
                modifier = Modifier.fillMaxWidth(),
                colors   = ButtonDefaults.buttonColors(containerColor = GenericPrimary),
            ) {
                Text(if (isCreating) "Sending…" else "Send for Signature")
            }
        }
    }
}
