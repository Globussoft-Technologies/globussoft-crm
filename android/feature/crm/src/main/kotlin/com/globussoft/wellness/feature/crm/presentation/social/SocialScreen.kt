package com.globussoft.wellness.feature.crm.presentation.social

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

private fun sentimentColor(sentiment: String): Color = when (sentiment.uppercase()) {
    "POSITIVE" -> Color(0xFF2E7D32)
    "NEGATIVE" -> Color(0xFFC62828)
    else       -> Color(0xFF757575) // NEUTRAL or unknown
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SocialScreen(
    viewModel: SocialViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    Scaffold(
        topBar = {
            TopAppBar(
                title  = { Text("Social Mentions") },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.surface,
                ),
            )
        },
        containerColor = MaterialTheme.colorScheme.background,
    ) { contentPadding ->
        PullToRefreshBox(
            isRefreshing = state.isLoading && state.mentions.isNotEmpty(),
            onRefresh    = { viewModel.refresh() },
            modifier     = Modifier.fillMaxSize().padding(contentPadding),
        ) {
            when {
                state.isLoading && state.mentions.isEmpty() ->
                    ShimmerList(itemCount = 5, modifier = Modifier.fillMaxSize())
                state.error != null && state.mentions.isEmpty() ->
                    ErrorState(message = state.error!!, onRetry = { viewModel.refresh() }, modifier = Modifier.fillMaxSize())
                state.mentions.isEmpty() ->
                    EmptyState(message = "No social mentions yet.", modifier = Modifier.fillMaxSize())
                else ->
                    LazyColumn(
                        contentPadding      = PaddingValues(horizontal = Dimens.SpacingLg, vertical = Dimens.SpacingSm),
                        verticalArrangement = Arrangement.spacedBy(Dimens.SpacingSm),
                    ) {
                        items(state.mentions) { mention ->
                            SocialMentionCard(mention = mention)
                        }
                    }
            }
        }
    }
}

@Composable
private fun SocialMentionCard(mention: Map<String, Any>) {
    val content   = mention["content"] as? String
        ?: mention["text"] as? String
        ?: mention["mention"] as? String
        ?: "No content"
    val platform  = mention["platform"] as? String ?: "Unknown"
    val sentiment = mention["sentiment"] as? String ?: "NEUTRAL"
    val sentColor = sentimentColor(sentiment)

    WellnessCard(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.fillMaxWidth().padding(Dimens.SpacingMd)) {
            Row(
                modifier              = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment     = Alignment.CenterVertically,
            ) {
                Box(
                    modifier = Modifier
                        .clip(RoundedCornerShape(4.dp))
                        .background(Color(0xFF1565C0).copy(alpha = 0.12f))
                        .padding(horizontal = 8.dp, vertical = 3.dp),
                ) {
                    Text(
                        text       = platform,
                        style      = MaterialTheme.typography.labelSmall,
                        color      = Color(0xFF1565C0),
                        fontWeight = FontWeight.Bold,
                    )
                }
                Box(
                    modifier = Modifier
                        .clip(RoundedCornerShape(4.dp))
                        .background(sentColor.copy(alpha = 0.15f))
                        .padding(horizontal = 8.dp, vertical = 3.dp),
                ) {
                    Text(
                        text       = sentiment,
                        style      = MaterialTheme.typography.labelSmall,
                        color      = sentColor,
                        fontWeight = FontWeight.Bold,
                    )
                }
            }
            Spacer(Modifier.padding(top = 6.dp))
            Text(
                text  = content,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurface,
            )
        }
    }
}
