package com.globussoft.wellness.core.designsystem.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.globussoft.wellness.core.designsystem.theme.Dimens
import com.globussoft.wellness.core.designsystem.theme.WellnessDanger
import com.globussoft.wellness.core.designsystem.theme.WellnessSuccess
import com.globussoft.wellness.core.designsystem.theme.WellnessTextTertiary
import com.globussoft.wellness.core.designsystem.theme.WellnessTheme
import com.globussoft.wellness.core.designsystem.theme.WellnessWarning

// ─── Color mapping ────────────────────────────────────────────────────────────

private val Blue    = Color(0xFF3B82F6)
private val Indigo  = Color(0xFF6366F1)
private val Purple  = Color(0xFF8B5CF6)
private val Amber   = Color(0xFFD97706)
private val Grey    = Color(0xFF6B7280)

/**
 * Returns the pill background [Color] for a given [status] string.
 * Handles both visit/appointment statuses and priority levels.
 */
fun statusBadgeColor(status: String): Color = when (status.uppercase()) {
    // ── Visit / appointment ──────────────────────────────────────────────────
    "BOOKED"       -> Blue
    "CONFIRMED"    -> Indigo
    "ARRIVED"      -> Purple
    "IN_TREATMENT" -> Amber
    "COMPLETED"    -> WellnessSuccess
    "NO_SHOW"      -> WellnessDanger
    "CANCELLED"    -> Grey
    "WAITING"      -> Amber
    "OFFERED"      -> Blue

    // ── Priority ─────────────────────────────────────────────────────────────
    "HIGH"   -> WellnessDanger
    "MEDIUM" -> Amber
    "LOW"    -> Grey

    // ── Fallback ─────────────────────────────────────────────────────────────
    else -> WellnessTextTertiary
}

// ─── Composable ───────────────────────────────────────────────────────────────

/**
 * A small pill-shaped badge that communicates a status or priority at a glance.
 *
 * Colors mirror the frontend's wellness status indicators. Text is always white
 * for contrast on the colored background.
 *
 * @param status  The raw status string (case-insensitive).
 */
@Composable
fun StatusBadge(
    status: String,
    modifier: Modifier = Modifier,
) {
    val bgColor = statusBadgeColor(status)
    val label   = status.replace('_', ' ').lowercase()
        .replaceFirstChar { it.uppercase() }

    Box(
        modifier = modifier
            .background(
                color  = bgColor,
                shape  = RoundedCornerShape(100),
            )
            .padding(horizontal = 10.dp, vertical = 4.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text  = label,
            style = MaterialTheme.typography.labelSmall,
            color = Color.White,
        )
    }
}

// ─── Previews ─────────────────────────────────────────────────────────────────

@Preview(name = "StatusBadge – all statuses", showBackground = true)
@Composable
private fun StatusBadgePreview() {
    WellnessTheme {
        Row(modifier = Modifier.padding(Dimens.SpacingLg)) {
            val statuses = listOf(
                "BOOKED", "CONFIRMED", "ARRIVED", "IN_TREATMENT",
                "COMPLETED", "NO_SHOW", "CANCELLED", "WAITING",
            )
            statuses.forEachIndexed { idx, s ->
                StatusBadge(status = s)
                if (idx < statuses.lastIndex) Spacer(modifier = Modifier.width(6.dp))
            }
        }
    }
}
