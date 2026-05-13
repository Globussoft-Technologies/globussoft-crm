package com.globussoft.wellness.core.designsystem.components

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.width
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.VerticalDivider
import androidx.compose.material3.windowsizeclass.WindowSizeClass
import androidx.compose.material3.windowsizeclass.WindowWidthSizeClass
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.globussoft.wellness.core.designsystem.theme.Dimens
import com.globussoft.wellness.core.designsystem.theme.WellnessBorderColor
import com.globussoft.wellness.core.designsystem.theme.WellnessTheme

/**
 * A responsive two-pane layout that adapts to the current [WindowSizeClass].
 *
 * ### Expanded (>= 840 dp)
 * Both panes are displayed side-by-side simultaneously.  [listPane] is rendered
 * in a fixed 300 dp column on the leading edge; [detailPane] fills the remainder.
 * The [showDetailPane] flag is ignored on this width class because both panes
 * are always visible.
 *
 * ### Medium / Compact (< 840 dp)
 * A single pane fills the screen. When [showDetailPane] is `false` the
 * [listPane] is displayed; when `true` the [detailPane] replaces it.  Navigation
 * between panes is the responsibility of the caller (e.g. pressing back should
 * set `showDetailPane = false`).
 *
 * @param windowSizeClass Current window size class from `calculateWindowSizeClass()`.
 * @param listPane        List / master pane composable.
 * @param detailPane      Detail / content pane composable.
 * @param showDetailPane  Controls which pane is visible on narrow screens.
 * @param modifier        Layout modifier applied to the root container.
 */
@Composable
fun AdaptiveTwoPaneLayout(
    windowSizeClass: WindowSizeClass,
    listPane: @Composable () -> Unit,
    detailPane: @Composable () -> Unit,
    showDetailPane: Boolean = false,
    modifier: Modifier = Modifier,
) {
    when (windowSizeClass.widthSizeClass) {
        WindowWidthSizeClass.Expanded -> {
            // Side-by-side layout: list fixed at 300 dp, detail fills the rest.
            Row(modifier = modifier.fillMaxSize()) {
                Box(modifier = Modifier.width(300.dp).fillMaxHeight()) {
                    listPane()
                }
                VerticalDivider(
                    modifier  = Modifier.fillMaxHeight(),
                    thickness = 1.dp,
                    color     = WellnessBorderColor,
                )
                Box(modifier = Modifier.weight(1f).fillMaxHeight()) {
                    detailPane()
                }
            }
        }
        else -> {
            // Single-pane: switch between list and detail based on showDetailPane.
            Box(modifier = modifier.fillMaxSize()) {
                if (showDetailPane) {
                    detailPane()
                } else {
                    listPane()
                }
            }
        }
    }
}

// ─── Preview note ─────────────────────────────────────────────────────────────
// WindowSizeClass requires an Activity/LocalContext to calculate, so previews
// are annotated but rendered with a stub; interactive testing should be done on
// a device or emulator.

@Preview(name = "AdaptiveTwoPaneLayout – compact list", showBackground = true,
    widthDp = 400, heightDp = 700)
@Composable
private fun AdaptiveTwoPaneCompactListPreview() {
    WellnessTheme {
        EmptyState(
            message  = "[List pane – compact]",
            modifier = Modifier.fillMaxSize(),
        )
    }
}
