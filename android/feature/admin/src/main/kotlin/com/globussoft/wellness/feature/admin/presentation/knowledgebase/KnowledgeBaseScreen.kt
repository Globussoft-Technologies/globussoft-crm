package com.globussoft.wellness.feature.admin.presentation.knowledgebase

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.MenuBook
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.globussoft.wellness.core.designsystem.components.EmptyState
import com.globussoft.wellness.core.designsystem.components.ErrorState
import com.globussoft.wellness.core.designsystem.components.ShimmerList
import com.globussoft.wellness.core.designsystem.components.WellnessCard
import com.globussoft.wellness.core.designsystem.theme.Dimens
import com.globussoft.wellness.core.designsystem.theme.WellnessPrimary
import com.globussoft.wellness.feature.admin.domain.repository.KbArticleItem

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun KnowledgeBaseScreen(viewModel: KnowledgeBaseViewModel = hiltViewModel()) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text("Knowledge Base", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
                        if (state.articles.isNotEmpty()) {
                            Text("${state.articles.size} articles", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.surface),
            )
        },
        containerColor = MaterialTheme.colorScheme.background,
    ) { padding ->
        PullToRefreshBox(
            isRefreshing = state.isLoading && state.articles.isNotEmpty(),
            onRefresh    = viewModel::refresh,
            modifier     = Modifier.fillMaxSize().padding(padding),
        ) {
            when {
                state.isLoading && state.articles.isEmpty() ->
                    ShimmerList(itemCount = 6, modifier = Modifier.fillMaxSize())
                state.error != null && state.articles.isEmpty() ->
                    ErrorState(message = state.error!!, onRetry = viewModel::refresh, modifier = Modifier.fillMaxSize())
                state.articles.isEmpty() ->
                    EmptyState(message = "No articles found.", icon = Icons.AutoMirrored.Filled.MenuBook, modifier = Modifier.fillMaxSize())
                else -> LazyColumn(
                    contentPadding      = PaddingValues(Dimens.SpacingLg),
                    verticalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
                    modifier            = Modifier.fillMaxSize(),
                ) {
                    items(state.articles, key = { it.id }) { article ->
                        KbArticleCard(article)
                    }
                }
            }
        }
    }
}

@Composable
private fun KbArticleCard(article: KbArticleItem) {
    WellnessCard(modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier              = Modifier.fillMaxWidth().padding(Dimens.SpacingMd),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment     = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(article.title, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                Text(
                    "${article.views} views  ·  ${article.createdAt.take(10)}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Text(
                text       = if (article.isPublished) "Published" else "Draft",
                style      = MaterialTheme.typography.labelSmall,
                color      = if (article.isPublished) WellnessPrimary else MaterialTheme.colorScheme.onSurfaceVariant,
                fontWeight = FontWeight.SemiBold,
            )
        }
    }
}
