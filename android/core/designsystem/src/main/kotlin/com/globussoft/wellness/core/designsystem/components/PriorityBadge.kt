package com.globussoft.wellness.core.designsystem.components

import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.globussoft.wellness.core.designsystem.theme.Dimens
import com.globussoft.wellness.core.designsystem.theme.WellnessTheme

/**
 * A priority pill badge — a thin wrapper around [StatusBadge] that accepts
 * a [priority] string (`HIGH`, `MEDIUM`, `LOW`) and delegates color mapping to
 * [statusBadgeColor].
 *
 * Keeping this as a separate composable makes call-sites self-documenting
 * (`PriorityBadge(priority = lead.priority)` vs the generic `StatusBadge`).
 *
 * @param priority  Priority string (case-insensitive: HIGH, MEDIUM, LOW).
 * @param modifier  Layout modifier.
 */
@Composable
fun PriorityBadge(
    priority: String,
    modifier: Modifier = Modifier,
) {
    // Delegate to StatusBadge — statusBadgeColor already handles HIGH/MEDIUM/LOW.
    StatusBadge(status = priority, modifier = modifier)
}

// ─── Preview ──────────────────────────────────────────────────────────────────

@Preview(name = "PriorityBadge – all levels", showBackground = true)
@Composable
private fun PriorityBadgePreview() {
    WellnessTheme {
        Row(modifier = Modifier.padding(Dimens.SpacingLg)) {
            PriorityBadge(priority = "HIGH")
            Spacer(modifier = Modifier.width(6.dp))
            PriorityBadge(priority = "MEDIUM")
            Spacer(modifier = Modifier.width(6.dp))
            PriorityBadge(priority = "LOW")
        }
    }
}
