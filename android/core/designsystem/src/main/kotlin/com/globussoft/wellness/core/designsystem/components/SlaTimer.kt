package com.globussoft.wellness.core.designsystem.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.globussoft.wellness.core.designsystem.theme.Dimens
import com.globussoft.wellness.core.designsystem.theme.WellnessDanger
import com.globussoft.wellness.core.designsystem.theme.WellnessSuccess
import com.globussoft.wellness.core.designsystem.theme.WellnessTheme
import com.globussoft.wellness.core.designsystem.theme.WellnessWarning
import kotlinx.coroutines.delay
import java.time.Instant
import java.time.format.DateTimeParseException

// ─── Thresholds ───────────────────────────────────────────────────────────────
private const val GREEN_THRESHOLD_SECONDS  =  5 * 60L   //  5 min
private const val AMBER_THRESHOLD_SECONDS  = 30 * 60L   // 30 min

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Formats [elapsedSeconds] as "Xs", "Xm Ys", or "Xh Ym". */
private fun formatElapsed(elapsedSeconds: Long): String {
    val abs = elapsedSeconds.coerceAtLeast(0L)
    val hours   = abs / 3600
    val minutes = (abs % 3600) / 60
    val seconds = abs % 60
    return when {
        hours > 0   -> "${hours}h ${minutes.toString().padStart(2, '0')}m"
        minutes > 0 -> "${minutes}m ${seconds.toString().padStart(2, '0')}s"
        else        -> "${seconds}s"
    }
}

/** Returns the [Color] for the elapsed seconds. */
private fun timerColor(elapsedSeconds: Long): Color = when {
    elapsedSeconds < GREEN_THRESHOLD_SECONDS -> WellnessSuccess
    elapsedSeconds < AMBER_THRESHOLD_SECONDS -> WellnessWarning
    else                                     -> WellnessDanger
}

// ─── Composable ───────────────────────────────────────────────────────────────

/**
 * A live elapsed-time chip that updates every second.
 *
 * Color coding mirrors the Telecaller Queue SLA indicator in the web frontend:
 * - Green  → < 5 minutes (within normal handling time)
 * - Amber  → 5–30 minutes (approaching breach)
 * - Red    → > 30 minutes (SLA breach, bold weight)
 *
 * @param createdAtIso ISO-8601 timestamp string (e.g. `"2026-05-13T09:30:00Z"`).
 * @param modifier     Layout modifier applied to the chip container.
 */
@Composable
fun SlaTimer(
    createdAtIso: String,
    modifier: Modifier = Modifier,
) {
    // Parse the start instant once; fall back to "now" on parse error so the
    // chip still renders rather than crashing.
    val startInstant: Instant = remember(createdAtIso) {
        try {
            Instant.parse(createdAtIso)
        } catch (_: DateTimeParseException) {
            Instant.now()
        }
    }

    var elapsedSeconds by remember { mutableLongStateOf(0L) }

    // Tick every second, re-measuring elapsed time against the wall clock.
    LaunchedEffect(startInstant) {
        while (true) {
            elapsedSeconds = Instant.now().epochSecond - startInstant.epochSecond
            delay(1_000L)
        }
    }

    val color     = timerColor(elapsedSeconds)
    val isBreach  = elapsedSeconds >= AMBER_THRESHOLD_SECONDS
    val label     = formatElapsed(elapsedSeconds)

    Box(
        modifier = modifier
            .background(
                color  = color.copy(alpha = 0.15f),
                shape  = RoundedCornerShape(100),
            )
            .padding(horizontal = 10.dp, vertical = 4.dp),
    ) {
        Text(
            text      = label,
            style     = MaterialTheme.typography.labelSmall.copy(
                fontWeight = if (isBreach) FontWeight.Bold else FontWeight.Medium,
            ),
            color     = color,
        )
    }
}

// ─── Previews ─────────────────────────────────────────────────────────────────

@Preview(name = "SlaTimer – green (< 5 min)", showBackground = true)
@Composable
private fun SlaTimerGreenPreview() {
    WellnessTheme {
        // 2 minutes ago
        val iso = Instant.now().minusSeconds(120).toString()
        SlaTimer(createdAtIso = iso, modifier = Modifier.padding(Dimens.SpacingLg))
    }
}

@Preview(name = "SlaTimer – amber (5–30 min)", showBackground = true)
@Composable
private fun SlaTimerAmberPreview() {
    WellnessTheme {
        val iso = Instant.now().minusSeconds(900).toString()
        SlaTimer(createdAtIso = iso, modifier = Modifier.padding(Dimens.SpacingLg))
    }
}

@Preview(name = "SlaTimer – red breach (> 30 min)", showBackground = true)
@Composable
private fun SlaTimerRedPreview() {
    WellnessTheme {
        val iso = Instant.now().minusSeconds(3700).toString()
        SlaTimer(createdAtIso = iso, modifier = Modifier.padding(Dimens.SpacingLg))
    }
}
