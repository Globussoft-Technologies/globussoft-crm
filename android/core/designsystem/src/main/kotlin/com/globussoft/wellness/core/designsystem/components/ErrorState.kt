package com.globussoft.wellness.core.designsystem.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.globussoft.wellness.core.designsystem.theme.Dimens
import com.globussoft.wellness.core.designsystem.theme.WellnessDanger
import com.globussoft.wellness.core.designsystem.theme.WellnessTheme

/**
 * Error / failed-to-load state screen.
 *
 * Shows a red error icon, the error [message], and a "Retry" button that
 * invokes [onRetry].  Used whenever a feature screen cannot load its data.
 *
 * @param message  Human-readable error description.
 * @param onRetry  Callback triggered by the Retry button.
 * @param modifier Layout modifier (typically fills the remaining height).
 */
@Composable
fun ErrorState(
    message: String,
    onRetry: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier            = modifier
            .fillMaxWidth()
            .padding(Dimens.SpacingXxl),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Icon(
            imageVector        = Icons.Outlined.ErrorOutline,
            contentDescription = null,
            tint               = WellnessDanger,
            modifier           = Modifier.size(64.dp),
        )

        Spacer(modifier = Modifier.height(Dimens.SpacingLg))

        Text(
            text      = message,
            style     = MaterialTheme.typography.bodyLarge,
            color     = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )

        Spacer(modifier = Modifier.height(Dimens.SpacingXl))

        WellnessOutlinedButton(
            text    = "Retry",
            onClick = onRetry,
        )
    }
}

// ─── Preview ──────────────────────────────────────────────────────────────────

@Preview(name = "ErrorState", showBackground = true)
@Composable
private fun ErrorStatePreview() {
    WellnessTheme {
        ErrorState(
            message  = "Failed to load patient list. Check your connection and try again.",
            onRetry  = {},
            modifier = Modifier.padding(Dimens.SpacingLg),
        )
    }
}
