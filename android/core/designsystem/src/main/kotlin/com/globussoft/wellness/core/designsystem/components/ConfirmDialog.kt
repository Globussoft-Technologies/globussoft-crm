package com.globussoft.wellness.core.designsystem.components

import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.tooling.preview.Preview
import com.globussoft.wellness.core.designsystem.theme.WellnessDanger
import com.globussoft.wellness.core.designsystem.theme.WellnessTheme

/**
 * A standard confirmation dialog with optional destructive styling for the
 * confirm button.
 *
 * Mirrors the `confirmDestructive` pattern from the backend's admin trigger
 * endpoints — any action that permanently mutates data (GDPR deletion, cancel
 * appointment, remove record) should set [isDestructive] to `true` so the
 * confirm button renders in [WellnessDanger] red.
 *
 * @param title         Dialog heading.
 * @param message       Explanatory body text.
 * @param confirmLabel  Label for the confirm action button. Defaults to "Confirm".
 * @param dismissLabel  Label for the dismiss button. Defaults to "Cancel".
 * @param isDestructive Whether the confirm button should be styled as danger.
 * @param onConfirm     Invoked when the user confirms.
 * @param onDismiss     Invoked when the user dismisses (button or back/outside tap).
 */
@Composable
fun ConfirmDialog(
    title: String,
    message: String,
    confirmLabel: String = "Confirm",
    dismissLabel: String = "Cancel",
    isDestructive: Boolean = false,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Text(
                text  = title,
                style = MaterialTheme.typography.titleMedium,
            )
        },
        text = {
            Text(
                text  = message,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        },
        confirmButton = {
            TextButton(
                onClick = onConfirm,
                colors  = if (isDestructive) {
                    ButtonDefaults.textButtonColors(contentColor = WellnessDanger)
                } else {
                    ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.primary)
                },
            ) {
                Text(confirmLabel)
            }
        },
        dismissButton = {
            TextButton(
                onClick = onDismiss,
                colors  = ButtonDefaults.textButtonColors(
                    contentColor = MaterialTheme.colorScheme.onSurfaceVariant,
                ),
            ) {
                Text(dismissLabel)
            }
        },
        shape              = MaterialTheme.shapes.large,
        containerColor     = MaterialTheme.colorScheme.surface,
        titleContentColor  = MaterialTheme.colorScheme.onSurface,
        textContentColor   = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

// ─── Previews ─────────────────────────────────────────────────────────────────

@Preview(name = "ConfirmDialog – standard", showBackground = true)
@Composable
private fun ConfirmDialogPreview() {
    WellnessTheme {
        ConfirmDialog(
            title     = "Confirm Booking",
            message   = "Are you sure you want to book this appointment for tomorrow at 10:00 AM?",
            onConfirm = {},
            onDismiss = {},
        )
    }
}

@Preview(name = "ConfirmDialog – destructive", showBackground = true)
@Composable
private fun ConfirmDialogDestructivePreview() {
    WellnessTheme {
        ConfirmDialog(
            title          = "Cancel Appointment",
            message        = "This will permanently cancel the appointment and notify the patient. This action cannot be undone.",
            confirmLabel   = "Cancel Appointment",
            isDestructive  = true,
            onConfirm      = {},
            onDismiss      = {},
        )
    }
}
