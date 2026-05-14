package com.globussoft.wellness.core.designsystem.components

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.tooling.preview.Preview
import com.globussoft.wellness.core.designsystem.theme.Dimens
import com.globussoft.wellness.core.designsystem.theme.WellnessDanger
import com.globussoft.wellness.core.designsystem.theme.WellnessTheme
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions

// ─── Text field ───────────────────────────────────────────────────────────────

/**
 * A branded [OutlinedTextField] that follows the wellness design-system color
 * scheme.  Displays an optional error message below the field when
 * [isError] is `true` and [errorMessage] is non-null.
 *
 * @param value         Current field text.
 * @param onValueChange Called whenever the user changes the text.
 * @param label         Floating label above the field.
 * @param modifier      Layout modifier.
 * @param placeholder   Hint text shown when the field is empty.
 * @param isError       Whether to render the field in an error state.
 * @param errorMessage  Text shown below the field when [isError] is `true`.
 * @param keyboardType  Keyboard type (text, number, email, etc.).
 * @param imeAction     IME action button shown on the keyboard.
 * @param trailingIcon  Optional composable rendered as a trailing icon.
 * @param leadingIcon   Optional composable rendered as a leading icon.
 * @param singleLine    Constrain to a single line (default `true`).
 * @param maxLines      Maximum lines when [singleLine] is `false`.
 * @param readOnly      Whether the field is read-only.
 * @param enabled       Whether the field accepts input.
 */
@Composable
fun WellnessTextField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    modifier: Modifier = Modifier,
    placeholder: String = "",
    isError: Boolean = false,
    errorMessage: String? = null,
    keyboardType: KeyboardType = KeyboardType.Text,
    imeAction: ImeAction = ImeAction.Next,
    trailingIcon: @Composable (() -> Unit)? = null,
    leadingIcon: @Composable (() -> Unit)? = null,
    singleLine: Boolean = true,
    maxLines: Int = 1,
    readOnly: Boolean = false,
    enabled: Boolean = true,
    visualTransformation: VisualTransformation = VisualTransformation.None,
) {
    Column(modifier = modifier) {
        OutlinedTextField(
            value         = value,
            onValueChange = onValueChange,
            label         = { Text(label) },
            placeholder   = if (placeholder.isNotEmpty()) {
                { Text(placeholder, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            } else null,
            isError       = isError,
            singleLine    = singleLine,
            maxLines      = if (singleLine) 1 else maxLines,
            readOnly      = readOnly,
            enabled       = enabled,
            trailingIcon  = trailingIcon,
            leadingIcon   = leadingIcon,
            visualTransformation = visualTransformation,
            keyboardOptions = KeyboardOptions(
                keyboardType = keyboardType,
                imeAction    = imeAction,
            ),
            colors = OutlinedTextFieldDefaults.colors(
                focusedBorderColor   = MaterialTheme.colorScheme.primary,
                unfocusedBorderColor = MaterialTheme.colorScheme.outline,
                errorBorderColor     = WellnessDanger,
                focusedLabelColor    = MaterialTheme.colorScheme.primary,
                errorLabelColor      = WellnessDanger,
                cursorColor          = MaterialTheme.colorScheme.primary,
            ),
            shape    = MaterialTheme.shapes.small,
            modifier = Modifier.fillMaxWidth(),
        )

        if (isError && errorMessage != null) {
            Text(
                text     = errorMessage,
                color    = WellnessDanger,
                style    = MaterialTheme.typography.bodySmall,
                modifier = Modifier.padding(
                    start = Dimens.SpacingLg,
                    top   = Dimens.SpacingXs,
                ),
            )
        }
    }
}

// ─── Dropdown ─────────────────────────────────────────────────────────────────

/**
 * An outlined-text-field styled dropdown selector.
 *
 * @param value         The currently selected value key.
 * @param onValueChange Called with the newly selected value key.
 * @param label         Floating label.
 * @param options       List of (value, displayLabel) pairs.
 * @param modifier      Layout modifier.
 */
@Composable
fun WellnessDropdown(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    options: List<Pair<String, String>>,
    modifier: Modifier = Modifier,
) {
    var expanded by remember { mutableStateOf(false) }

    val displayLabel = options.firstOrNull { it.first == value }?.second ?: value

    Column(modifier = modifier) {
        Box {
        OutlinedTextField(
            value         = displayLabel,
            onValueChange = {},
            label         = { Text(label) },
            readOnly      = true,
            trailingIcon  = {
                IconButton(onClick = { expanded = !expanded }) {
                    Icon(
                        imageVector        = Icons.Default.KeyboardArrowDown,
                        contentDescription = if (expanded) "Collapse" else "Expand",
                        tint               = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            },
            colors = OutlinedTextFieldDefaults.colors(
                focusedBorderColor   = MaterialTheme.colorScheme.primary,
                unfocusedBorderColor = MaterialTheme.colorScheme.outline,
                focusedLabelColor    = MaterialTheme.colorScheme.primary,
                cursorColor          = MaterialTheme.colorScheme.primary,
            ),
            shape    = MaterialTheme.shapes.small,
            modifier = Modifier.fillMaxWidth(),
        )
        // Transparent overlay so tapping anywhere on the field opens the menu
        Box(Modifier.matchParentSize().clickable { expanded = !expanded })
        } // Box

        DropdownMenu(
            expanded        = expanded,
            onDismissRequest = { expanded = false },
        ) {
            options.forEach { (optValue, optLabel) ->
                DropdownMenuItem(
                    text    = { Text(optLabel) },
                    onClick = {
                        onValueChange(optValue)
                        expanded = false
                    },
                )
            }
        }
    }
}

// ─── Previews ─────────────────────────────────────────────────────────────────

@Preview(name = "WellnessTextField – normal", showBackground = true)
@Composable
private fun WellnessTextFieldPreview() {
    WellnessTheme {
        WellnessTextField(
            value         = "Ramesh Kumar",
            onValueChange = {},
            label         = "Patient Name",
            modifier      = Modifier.padding(Dimens.SpacingLg),
        )
    }
}

@Preview(name = "WellnessTextField – error", showBackground = true)
@Composable
private fun WellnessTextFieldErrorPreview() {
    WellnessTheme {
        WellnessTextField(
            value         = "",
            onValueChange = {},
            label         = "Phone",
            isError       = true,
            errorMessage  = "Phone number is required",
            modifier      = Modifier.padding(Dimens.SpacingLg),
        )
    }
}

@Preview(name = "WellnessDropdown", showBackground = true)
@Composable
private fun WellnessDropdownPreview() {
    WellnessTheme {
        WellnessDropdown(
            value         = "doctor",
            onValueChange = {},
            label         = "Staff Role",
            options       = listOf(
                "doctor"      to "Doctor",
                "professional" to "Professional",
                "telecaller"  to "Telecaller",
            ),
            modifier = Modifier.padding(Dimens.SpacingLg),
        )
    }
}
