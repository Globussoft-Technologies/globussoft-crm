package com.globussoft.wellness.feature.crm.presentation.landingpages

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

private fun pageStatusColor(status: String): Color = when (status.uppercase()) {
    "PUBLISHED" -> Color(0xFF2E7D32)
    "DRAFT"     -> Color(0xFF757575)
    else        -> Color(0xFF1565C0)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LandingPagesScreen(
    viewModel: LandingPagesViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    Scaffold(
        topBar = {
            TopAppBar(
                title  = { Text("Landing Pages") },
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
                Icon(Icons.Default.Add, contentDescription = "New Landing Page", tint = Color.White)
            }
        },
        containerColor = MaterialTheme.colorScheme.background,
    ) { contentPadding ->
        PullToRefreshBox(
            isRefreshing = state.isLoading && state.pages.isNotEmpty(),
            onRefresh    = { viewModel.refresh() },
            modifier     = Modifier.fillMaxSize().padding(contentPadding),
        ) {
            when {
                state.isLoading && state.pages.isEmpty() ->
                    ShimmerList(itemCount = 5, modifier = Modifier.fillMaxSize())
                state.error != null && state.pages.isEmpty() ->
                    ErrorState(message = state.error!!, onRetry = { viewModel.refresh() }, modifier = Modifier.fillMaxSize())
                state.pages.isEmpty() ->
                    EmptyState(message = "No landing pages yet.", modifier = Modifier.fillMaxSize())
                else ->
                    LazyColumn(
                        contentPadding      = PaddingValues(horizontal = Dimens.SpacingLg, vertical = Dimens.SpacingSm),
                        verticalArrangement = Arrangement.spacedBy(Dimens.SpacingSm),
                    ) {
                        items(state.pages) { page ->
                            LandingPageCard(page = page)
                        }
                    }
            }
        }
    }

    if (state.showCreateForm) {
        LandingPageCreateSheet(
            isCreating = state.isCreating,
            formError  = state.formError,
            onDismiss  = { viewModel.dismissCreate() },
            onSave     = { name, slug -> viewModel.createPage(name, slug) },
        )
    }
}

@Composable
private fun LandingPageCard(page: Map<String, Any>) {
    val name       = page["name"] as? String
        ?: page["title"] as? String
        ?: "Unnamed Page"
    val slug       = page["slug"] as? String ?: "—"
    val status     = page["status"] as? String ?: "DRAFT"
    val visitCount = (page["visitCount"] as? Number)?.toInt()
        ?: (page["visits"] as? Number)?.toInt()
        ?: 0
    val statusColor = pageStatusColor(status)

    WellnessCard(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.fillMaxWidth().padding(Dimens.SpacingMd)) {
            Row(
                modifier              = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment     = Alignment.CenterVertically,
            ) {
                Text(name, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
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
                text  = "/$slug",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text(
                text  = "$visitCount visits",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun LandingPageCreateSheet(
    isCreating: Boolean,
    formError: String?,
    onDismiss: () -> Unit,
    onSave: (String, String) -> Unit,
) {
    var name by remember { mutableStateOf("") }
    var slug by remember { mutableStateOf("") }

    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(
            modifier            = Modifier.padding(horizontal = 24.dp).padding(bottom = 32.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text("New Landing Page", style = MaterialTheme.typography.titleMedium)
            OutlinedTextField(
                value         = name,
                onValueChange = { name = it },
                label         = { Text("Page Name") },
                modifier      = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value         = slug,
                onValueChange = { slug = it },
                label         = { Text("URL Slug") },
                modifier      = Modifier.fillMaxWidth(),
            )
            formError?.let {
                Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
            }
            Button(
                onClick  = { onSave(name, slug) },
                enabled  = !isCreating && name.isNotBlank() && slug.isNotBlank(),
                modifier = Modifier.fillMaxWidth(),
                colors   = ButtonDefaults.buttonColors(containerColor = GenericPrimary),
            ) {
                Text(if (isCreating) "Creating…" else "Create Page")
            }
        }
    }
}
