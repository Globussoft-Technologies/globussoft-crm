package com.globussoft.wellness.core.designsystem.components

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ScrollableTabRow
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRowDefaults
import androidx.compose.material3.TabRowDefaults.tabIndicatorOffset
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.globussoft.wellness.core.designsystem.theme.WellnessPrimary
import com.globussoft.wellness.core.designsystem.theme.WellnessTheme

/**
 * A horizontally scrollable tab strip styled with the wellness brand.
 *
 * The active tab's underline indicator uses [WellnessPrimary] teal. All tabs
 * scroll so that even feature screens with 7+ tabs (e.g. PatientDetail) stay
 * accessible on compact-width devices.
 *
 * @param tabs          Ordered list of tab label strings.
 * @param selectedIndex Zero-based index of the currently selected tab.
 * @param onTabSelected Called with the index of the tapped tab.
 * @param modifier      Layout modifier applied to the [ScrollableTabRow].
 */
@Composable
fun WellnessTabStrip(
    tabs: List<String>,
    selectedIndex: Int,
    onTabSelected: (Int) -> Unit,
    modifier: Modifier = Modifier,
) {
    ScrollableTabRow(
        selectedTabIndex = selectedIndex,
        modifier         = modifier,
        containerColor   = MaterialTheme.colorScheme.surface,
        contentColor     = MaterialTheme.colorScheme.onSurface,
        edgePadding      = 0.dp,
        indicator        = { tabPositions ->
            if (selectedIndex < tabPositions.size) {
                TabRowDefaults.SecondaryIndicator(
                    modifier = Modifier.tabIndicatorOffset(tabPositions[selectedIndex]),
                    color    = WellnessPrimary,
                )
            }
        },
        divider = {},
    ) {
        tabs.forEachIndexed { index, label ->
            Tab(
                selected = index == selectedIndex,
                onClick  = { onTabSelected(index) },
                text     = {
                    Text(
                        text  = label,
                        style = MaterialTheme.typography.labelLarge,
                        color = if (index == selectedIndex) {
                            WellnessPrimary
                        } else {
                            MaterialTheme.colorScheme.onSurfaceVariant
                        },
                    )
                },
                selectedContentColor   = WellnessPrimary,
                unselectedContentColor = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

// ─── Preview ──────────────────────────────────────────────────────────────────

@Preview(name = "WellnessTabStrip – patient detail tabs", showBackground = true)
@Composable
private fun WellnessTabStripPreview() {
    WellnessTheme {
        WellnessTabStrip(
            tabs = listOf(
                "History", "Prescriptions", "Consent", "Treatment",
                "Log Visit", "Photos", "Inventory",
            ),
            selectedIndex = 1,
            onTabSelected = {},
        )
    }
}
