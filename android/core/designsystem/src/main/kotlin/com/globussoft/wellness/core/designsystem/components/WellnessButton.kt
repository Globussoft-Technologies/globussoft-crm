package com.globussoft.wellness.core.designsystem.components

import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.globussoft.wellness.core.designsystem.theme.Dimens
import com.globussoft.wellness.core.designsystem.theme.WellnessDanger
import com.globussoft.wellness.core.designsystem.theme.WellnessTheme

// ─── Primary button ───────────────────────────────────────────────────────────

/**
 * Primary CTA button styled with [MaterialTheme.colorScheme.primary] (teal).
 *
 * When [isLoading] is `true` the text/icon is replaced with a small
 * [CircularProgressIndicator] to give immediate feedback during async ops.
 *
 * @param text      Button label.
 * @param onClick   Click callback.
 * @param modifier  Layout modifier.
 * @param enabled   Whether the button is interactive. Defaults to `true`.
 * @param isLoading Shows a progress indicator in place of label when `true`.
 * @param icon      Optional leading icon shown to the left of the label.
 */
@Composable
fun WellnessButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    isLoading: Boolean = false,
    icon: ImageVector? = null,
) {
    Button(
        onClick  = onClick,
        modifier = modifier,
        enabled  = enabled && !isLoading,
        colors   = ButtonDefaults.buttonColors(
            containerColor = MaterialTheme.colorScheme.primary,
            contentColor   = Color.White,
        ),
        shape = MaterialTheme.shapes.small,
    ) {
        when {
            isLoading -> {
                CircularProgressIndicator(
                    modifier = Modifier.size(16.dp),
                    color    = Color.White,
                    strokeWidth = 2.dp,
                )
            }
            else -> {
                if (icon != null) {
                    Icon(
                        imageVector = icon,
                        contentDescription = null,
                        modifier = Modifier.size(18.dp),
                    )
                    Spacer(modifier = Modifier.width(Dimens.SpacingSm))
                }
                Text(text = text, style = MaterialTheme.typography.labelLarge)
            }
        }
    }
}

// ─── Outlined / secondary button ─────────────────────────────────────────────

/**
 * Secondary outlined button. Uses the primary color for border and label to
 * pair visually with [WellnessButton] on the same surface.
 */
@Composable
fun WellnessOutlinedButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    icon: ImageVector? = null,
) {
    OutlinedButton(
        onClick  = onClick,
        modifier = modifier,
        enabled  = enabled,
        colors   = ButtonDefaults.outlinedButtonColors(
            contentColor = MaterialTheme.colorScheme.primary,
        ),
        shape    = MaterialTheme.shapes.small,
    ) {
        if (icon != null) {
            Icon(
                imageVector        = icon,
                contentDescription = null,
                modifier           = Modifier.size(18.dp),
            )
            Spacer(modifier = Modifier.width(Dimens.SpacingSm))
        }
        Text(text = text, style = MaterialTheme.typography.labelLarge)
    }
}

// ─── Danger / destructive button ─────────────────────────────────────────────

/**
 * Destructive action button (cancel appointment, delete record, etc.).
 *
 * Uses [WellnessDanger] as the container color with white content. Mirrors the
 * CSS `.btn-danger` treatment in the frontend.
 */
@Composable
fun WellnessDangerButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    Button(
        onClick  = onClick,
        modifier = modifier,
        enabled  = enabled,
        colors   = ButtonDefaults.buttonColors(
            containerColor = WellnessDanger,
            contentColor   = Color.White,
        ),
        shape = MaterialTheme.shapes.small,
    ) {
        Text(text = text, style = MaterialTheme.typography.labelLarge)
    }
}

// ─── Previews ─────────────────────────────────────────────────────────────────

@Preview(name = "WellnessButton variants", showBackground = true)
@Composable
private fun WellnessButtonPreview() {
    WellnessTheme {
        Row(
            modifier = Modifier.padding(Dimens.SpacingLg),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            WellnessButton(text = "Book Visit", onClick = {})
            Spacer(modifier = Modifier.width(Dimens.SpacingSm))
            WellnessButton(text = "Loading…", onClick = {}, isLoading = true)
            Spacer(modifier = Modifier.width(Dimens.SpacingSm))
            WellnessButton(
                text  = "Add",
                onClick = {},
                icon  = Icons.Default.Add,
            )
        }
    }
}

@Preview(name = "WellnessOutlinedButton", showBackground = true)
@Composable
private fun WellnessOutlinedButtonPreview() {
    WellnessTheme {
        WellnessOutlinedButton(
            text = "View Details",
            onClick = {},
            modifier = Modifier.padding(Dimens.SpacingLg),
        )
    }
}

@Preview(name = "WellnessDangerButton", showBackground = true)
@Composable
private fun WellnessDangerButtonPreview() {
    WellnessTheme {
        WellnessDangerButton(
            text = "Cancel Appointment",
            onClick = {},
            modifier = Modifier.padding(Dimens.SpacingLg),
        )
    }
}
