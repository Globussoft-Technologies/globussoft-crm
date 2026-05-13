package com.globussoft.wellness.core.designsystem.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Inbox
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.globussoft.wellness.core.designsystem.theme.Dimens
import com.globussoft.wellness.core.designsystem.theme.WellnessPrimary
import com.globussoft.wellness.core.designsystem.theme.WellnessTheme

/**
 * Zero-data / empty list state screen.
 *
 * Renders a centred column with a teal-tinted icon, a descriptive message, and
 * an optional CTA button.  Mirrors the frontend's blank-slate treatment used
 * for empty patient lists, empty appointment slots, etc.
 *
 * @param message     Human-readable description of the empty state.
 * @param modifier    Layout modifier (typically fills the remaining height).
 * @param icon        Vector icon drawn above the message. Defaults to [Icons.Outlined.Inbox].
 * @param actionLabel Label for the optional action button.
 * @param onAction    Callback for the optional action button. Only rendered when non-null.
 */
@Composable
fun EmptyState(
    message: String,
    modifier: Modifier = Modifier,
    icon: ImageVector = Icons.Outlined.Inbox,
    actionLabel: String? = null,
    onAction: (() -> Unit)? = null,
) {
    Column(
        modifier            = modifier
            .fillMaxWidth()
            .padding(Dimens.SpacingXxl),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Icon(
            imageVector        = icon,
            contentDescription = null,
            tint               = WellnessPrimary.copy(alpha = 0.5f),
            modifier           = Modifier.size(64.dp),
        )

        Spacer(modifier = Modifier.height(Dimens.SpacingLg))

        Text(
            text      = message,
            style     = MaterialTheme.typography.bodyLarge,
            color     = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )

        if (actionLabel != null && onAction != null) {
            Spacer(modifier = Modifier.height(Dimens.SpacingXl))
            WellnessButton(
                text    = actionLabel,
                onClick = onAction,
            )
        }
    }
}

// ─── Preview ──────────────────────────────────────────────────────────────────

@Preview(name = "EmptyState – with action", showBackground = true)
@Composable
private fun EmptyStatePreview() {
    WellnessTheme {
        EmptyState(
            message     = "No patients found. Add your first patient to get started.",
            actionLabel = "Add Patient",
            onAction    = {},
            modifier    = Modifier.padding(Dimens.SpacingLg),
        )
    }
}

@Preview(name = "EmptyState – no action", showBackground = true)
@Composable
private fun EmptyStateNoActionPreview() {
    WellnessTheme {
        EmptyState(
            message  = "No appointments scheduled for today.",
            modifier = Modifier.padding(Dimens.SpacingLg),
        )
    }
}
