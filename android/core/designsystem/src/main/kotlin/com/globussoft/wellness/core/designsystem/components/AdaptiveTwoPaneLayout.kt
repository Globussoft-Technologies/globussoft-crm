package com.globussoft.wellness.core.designsystem.components

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.width
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.globussoft.wellness.core.designsystem.theme.WellnessBorderColor

private val EXPANDED_WIDTH = 840.dp

@Composable
fun AdaptiveTwoPaneLayout(
    listPane: @Composable () -> Unit,
    detailPane: @Composable () -> Unit,
    showDetailPane: Boolean = false,
    modifier: Modifier = Modifier,
) {
    BoxWithConstraints(modifier = modifier.fillMaxSize()) {
        val isExpanded = maxWidth >= EXPANDED_WIDTH
        if (isExpanded) {
            Row(modifier = Modifier.fillMaxSize()) {
                Box(modifier = Modifier.width(300.dp).fillMaxHeight()) { listPane() }
                VerticalDivider(
                    modifier  = Modifier.fillMaxHeight(),
                    thickness = 1.dp,
                    color     = WellnessBorderColor,
                )
                Box(modifier = Modifier.weight(1f).fillMaxHeight()) { detailPane() }
            }
        } else {
            Box(modifier = Modifier.fillMaxSize()) {
                if (showDetailPane) detailPane() else listPane()
            }
        }
    }
}
