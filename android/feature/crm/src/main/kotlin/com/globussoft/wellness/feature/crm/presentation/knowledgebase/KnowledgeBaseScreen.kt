package com.globussoft.wellness.feature.crm.presentation.knowledgebase

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SuggestionChip
import androidx.compose.material3.SuggestionChipDefaults
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.globussoft.wellness.core.designsystem.components.EmptyState
import com.globussoft.wellness.core.designsystem.components.ErrorState
import com.globussoft.wellness.core.designsystem.components.ShimmerList
import com.globussoft.wellness.core.designsystem.components.WellnessCard
import com.globussoft.wellness.core.designsystem.components.WellnessSearchBar
import com.globussoft.wellness.core.designsystem.theme.Dimens
import com.globussoft.wellness.core.designsystem.theme.GenericAccent
import com.globussoft.wellness.core.designsystem.theme.GenericPrimary

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun KnowledgeBaseScreen(
    viewModel: KnowledgeBaseViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    Scaffold(
        topBar = {
            TopAppBar(
                title  = { Text("Knowledge Base") },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.surface,
                ),
            )
        },
        floatingActionButton = {
            FloatingActionButton(onClick = { viewModel.showCreate() }, containerColor = GenericPrimary) {
                Icon(Icons.Default.Add, "New Article", tint = Color.White)
            }
        },
    ) { paddingValues ->
        PullToRefreshBox(
            isRefreshing = state.isLoading,
            onRefresh    = { viewModel.refresh() },
            modifier     = Modifier
                .fillMaxSize()
                .padding(paddingValues),
        ) {
            Column(modifier = Modifier.fillMaxSize()) {
                WellnessSearchBar(
                    query         = state.search,
                    onQueryChange = { viewModel.setSearch(it) },
                    placeholder   = "Search articles…",
                    modifier      = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = Dimens.SpacingLg, vertical = Dimens.SpacingSm),
                    onClear       = { viewModel.setSearch("") },
                )

                when {
                    state.isLoading && state.articles.isEmpty() -> {
                        ShimmerList(
                            itemCount = 5,
                            modifier  = Modifier.padding(Dimens.SpacingLg),
                        )
                    }
                    state.error != null -> {
                        ErrorState(
                            message  = state.error!!,
                            onRetry  = { viewModel.refresh() },
                            modifier = Modifier.fillMaxSize(),
                        )
                    }
                    state.articles.isEmpty() -> {
                        EmptyState(
                            message  = if (state.search.isBlank()) "No articles found"
                                       else "No results for “${state.search}”",
                            modifier = Modifier.fillMaxSize(),
                        )
                    }
                    else -> {
                        LazyColumn(
                            modifier            = Modifier.fillMaxSize(),
                            verticalArrangement = Arrangement.spacedBy(Dimens.SpacingSm),
                            contentPadding      = PaddingValues(
                                horizontal = Dimens.SpacingLg,
                                vertical   = Dimens.SpacingSm,
                            ),
                        ) {
                            items(state.articles) { article ->
                                KbArticleCard(article = article)
                            }
                        }
                    }
                }
            }
        }

        if (state.showCreateForm) {
            KbArticleCreateSheet(
                isCreating = state.isCreating,
                formError  = state.formError,
                onDismiss  = { viewModel.dismissCreate() },
                onSave     = { title, category, body -> viewModel.createArticle(title, category, body) },
            )
        }
    }
}

@Composable
private fun KbArticleCard(
    article:  Map<String, Any>,
    modifier: Modifier = Modifier,
) {
    val title       = article["title"]?.toString() ?: "Untitled"
    val isPublished = article["isPublished"]?.let {
        when (it) {
            is Boolean -> it
            is String  -> it.equals("true", ignoreCase = true)
            else       -> false
        }
    } ?: false
    val views = article["views"]?.let {
        when (it) {
            is Number -> it.toInt()
            is String -> it.toIntOrNull() ?: 0
            else      -> 0
        }
    } ?: 0

    WellnessCard(modifier = modifier.fillMaxWidth()) {
        Row(
            modifier          = Modifier
                .fillMaxWidth()
                .padding(Dimens.SpacingLg),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text  = title,
                    style = MaterialTheme.typography.titleSmall,
                )
                Text(
                    text  = "$views views",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Spacer(Modifier.width(Dimens.SpacingSm))
            PublishedBadge(isPublished = isPublished)
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun KbArticleCreateSheet(
    isCreating: Boolean,
    formError: String?,
    onDismiss: () -> Unit,
    onSave: (String, String, String) -> Unit,
) {
    var title    by remember { mutableStateOf("") }
    var category by remember { mutableStateOf("General") }
    var body     by remember { mutableStateOf("") }
    val categories = listOf("General", "Product", "Billing", "Technical", "Onboarding")

    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(
            modifier = Modifier
                .padding(horizontal = 24.dp)
                .padding(bottom = 32.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text("New Article", style = MaterialTheme.typography.titleMedium)
            OutlinedTextField(
                value         = title,
                onValueChange = { title = it },
                label         = { Text("Title *") },
                modifier      = Modifier.fillMaxWidth(),
            )
            Text("Category", style = MaterialTheme.typography.labelMedium)
            LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                items(categories) { cat ->
                    FilterChip(
                        selected = category == cat,
                        onClick  = { category = cat },
                        label    = { Text(cat) },
                        colors   = FilterChipDefaults.filterChipColors(
                            selectedContainerColor = GenericPrimary,
                            selectedLabelColor     = Color.White,
                        ),
                    )
                }
            }
            OutlinedTextField(
                value         = body,
                onValueChange = { body = it },
                label         = { Text("Content *") },
                modifier      = Modifier.fillMaxWidth(),
                minLines      = 4,
            )
            formError?.let {
                Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
            }
            Button(
                onClick  = { onSave(title, category, body) },
                enabled  = title.isNotBlank() && body.isNotBlank() && !isCreating,
                modifier = Modifier.fillMaxWidth(),
                colors   = ButtonDefaults.buttonColors(containerColor = GenericPrimary),
            ) {
                Text(if (isCreating) "Publishing…" else "Publish Article")
            }
        }
    }
}

@Composable
private fun PublishedBadge(isPublished: Boolean) {
    val (label, containerColor) = if (isPublished) {
        "Published" to GenericAccent
    } else {
        "Draft"     to Color(0xFF9CA3AF)
    }
    SuggestionChip(
        onClick = {},
        label   = {
            Text(
                text  = label,
                style = MaterialTheme.typography.labelSmall,
                color = Color.White,
            )
        },
        colors  = SuggestionChipDefaults.suggestionChipColors(
            containerColor = containerColor,
        ),
        border  = null,
    )
}
