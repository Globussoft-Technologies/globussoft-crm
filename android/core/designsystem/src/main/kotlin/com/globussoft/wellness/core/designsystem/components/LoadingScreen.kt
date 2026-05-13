package com.globussoft.wellness.core.designsystem.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.globussoft.wellness.core.designsystem.theme.Dimens
import com.globussoft.wellness.core.designsystem.theme.WellnessPrimary
import com.globussoft.wellness.core.designsystem.theme.WellnessTheme
import com.valentinilk.shimmer.shimmer

// ─── Full-screen loading ──────────────────────────────────────────────────────

/**
 * Full-screen centred loading indicator using the wellness teal primary color.
 * Used as the initial loading state for feature screens.
 */
@Composable
fun LoadingScreen(modifier: Modifier = Modifier) {
    Box(
        modifier         = modifier.fillMaxSize(),
        contentAlignment = Alignment.Center,
    ) {
        CircularProgressIndicator(
            color       = WellnessPrimary,
            strokeWidth = 3.dp,
            modifier    = Modifier.size(48.dp),
        )
    }
}

// ─── Shimmer card ─────────────────────────────────────────────────────────────

/**
 * A card-shaped shimmer placeholder rendered while content is loading.
 *
 * Uses [com.valentinilk.shimmer.shimmer] from the compose-shimmer library for
 * the animated sweep effect.
 */
@Composable
fun ShimmerCard(modifier: Modifier = Modifier) {
    val shimmerModifier = Modifier
        .shimmer()
        .fillMaxWidth()
        .height(Dimens.ListItemHeight)
        .clip(RoundedCornerShape(Dimens.CornerMedium))

    Box(
        modifier = modifier
            .padding(horizontal = Dimens.SpacingLg, vertical = Dimens.SpacingSm)
            .then(shimmerModifier),
    ) {
        // The shimmer animation is provided by the .shimmer() modifier;
        // the solid-color background fills the shape.
        Box(
            modifier = Modifier
                .fillMaxSize()
                .clip(RoundedCornerShape(Dimens.CornerMedium)),
        )
    }
}

// ─── Shimmer list ─────────────────────────────────────────────────────────────

/**
 * Renders [itemCount] [ShimmerCard] items in a vertical column, giving a
 * skeleton-list appearance while the backing data is being fetched.
 *
 * @param itemCount Number of placeholder cards to show. Defaults to 5.
 */
@Composable
fun ShimmerList(
    itemCount: Int = 5,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier          = modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(Dimens.SpacingXs),
    ) {
        repeat(itemCount) {
            ShimmerCard()
        }
    }
}

// ─── Previews ─────────────────────────────────────────────────────────────────

@Preview(name = "LoadingScreen", showBackground = true)
@Composable
private fun LoadingScreenPreview() {
    WellnessTheme {
        LoadingScreen(modifier = Modifier.size(200.dp))
    }
}

@Preview(name = "ShimmerList – 4 items", showBackground = true)
@Composable
private fun ShimmerListPreview() {
    WellnessTheme {
        ShimmerList(itemCount = 4, modifier = Modifier.padding(Dimens.SpacingLg))
    }
}
