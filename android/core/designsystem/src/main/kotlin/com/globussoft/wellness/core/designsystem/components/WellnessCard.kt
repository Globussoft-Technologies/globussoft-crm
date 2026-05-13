package com.globussoft.wellness.core.designsystem.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.globussoft.wellness.core.designsystem.theme.Dimens
import com.globussoft.wellness.core.designsystem.theme.WellnessBorderColor
import com.globussoft.wellness.core.designsystem.theme.WellnessTheme

/**
 * A card surface that matches the glassmorphism style used across the wellness
 * frontend.  The container is 85 % opaque so it retains the gradient background
 * bleed-through while still being readable.
 *
 * @param modifier  Layout modifier applied to the [Card].
 * @param onClick   When non-null the card becomes clickable; when null it is a
 *                  purely decorative / informational surface.
 * @param content   Composable slot rendered inside a [Column].
 */
@Composable
fun WellnessCard(
    modifier: Modifier = Modifier,
    onClick: (() -> Unit)? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    val colors = CardDefaults.cardColors(
        containerColor = MaterialTheme.colorScheme.surface.copy(alpha = 0.85f),
    )
    val border = BorderStroke(1.dp, WellnessBorderColor)
    val shape  = MaterialTheme.shapes.medium

    if (onClick != null) {
        Card(
            onClick   = onClick,
            modifier  = modifier,
            shape     = shape,
            colors    = colors,
            border    = border,
            elevation = CardDefaults.cardElevation(defaultElevation = Dimens.CardElevation),
            content   = { Column(content = content) },
        )
    } else {
        Card(
            modifier  = modifier,
            shape     = shape,
            colors    = colors,
            border    = border,
            elevation = CardDefaults.cardElevation(defaultElevation = Dimens.CardElevation),
            content   = { Column(content = content) },
        )
    }
}

// ─── Previews ─────────────────────────────────────────────────────────────────

@Preview(name = "WellnessCard – static", showBackground = true)
@Composable
private fun WellnessCardStaticPreview() {
    WellnessTheme {
        WellnessCard(modifier = Modifier.padding(16.dp)) {
            Text(
                text  = "Patient: Ramesh Kumar",
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.padding(Dimens.SpacingLg),
            )
        }
    }
}

@Preview(name = "WellnessCard – clickable", showBackground = true)
@Composable
private fun WellnessCardClickablePreview() {
    WellnessTheme {
        WellnessCard(
            modifier = Modifier.padding(16.dp),
            onClick  = {},
        ) {
            Text(
                text  = "Tap me",
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.padding(Dimens.SpacingLg),
            )
        }
    }
}
