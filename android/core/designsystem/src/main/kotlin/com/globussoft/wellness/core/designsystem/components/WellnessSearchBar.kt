package com.globussoft.wellness.core.designsystem.components

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Clear
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.tooling.preview.Preview
import com.globussoft.wellness.core.designsystem.theme.Dimens
import com.globussoft.wellness.core.designsystem.theme.WellnessTheme

/**
 * A search bar styled as an [OutlinedTextField] with wellness brand colors.
 *
 * Renders a magnifier leading icon at all times. When [query] is non-empty a
 * clear button replaces (or supplements) the trailing area so users can reset
 * the search with one tap.
 *
 * @param query         Current search string.
 * @param onQueryChange Called whenever the text changes.
 * @param placeholder   Hint text shown when the field is empty.
 * @param modifier      Layout modifier.
 * @param onClear       Invoked when the user taps the clear (×) button.
 */
@Composable
fun WellnessSearchBar(
    query: String,
    onQueryChange: (String) -> Unit,
    placeholder: String = "Search…",
    modifier: Modifier = Modifier,
    onClear: () -> Unit = {},
) {
    OutlinedTextField(
        value         = query,
        onValueChange = onQueryChange,
        placeholder   = {
            Text(
                text  = placeholder,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        },
        leadingIcon = {
            Icon(
                imageVector        = Icons.Default.Search,
                contentDescription = "Search",
                tint               = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        },
        trailingIcon = if (query.isNotEmpty()) {
            {
                IconButton(onClick = {
                    onQueryChange("")
                    onClear()
                }) {
                    Icon(
                        imageVector        = Icons.Default.Clear,
                        contentDescription = "Clear search",
                        tint               = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        } else null,
        singleLine = true,
        shape      = MaterialTheme.shapes.extraLarge,  // pill shape
        colors     = OutlinedTextFieldDefaults.colors(
            focusedBorderColor   = MaterialTheme.colorScheme.primary,
            unfocusedBorderColor = MaterialTheme.colorScheme.outline,
            focusedLabelColor    = MaterialTheme.colorScheme.primary,
            cursorColor          = MaterialTheme.colorScheme.primary,
        ),
        textStyle = MaterialTheme.typography.bodyMedium,
        modifier  = modifier.fillMaxWidth(),
    )
}

// ─── Previews ─────────────────────────────────────────────────────────────────

@Preview(name = "WellnessSearchBar – empty", showBackground = true)
@Composable
private fun WellnessSearchBarEmptyPreview() {
    WellnessTheme {
        WellnessSearchBar(
            query         = "",
            onQueryChange = {},
            modifier      = Modifier.padding(Dimens.SpacingLg),
        )
    }
}

@Preview(name = "WellnessSearchBar – with query", showBackground = true)
@Composable
private fun WellnessSearchBarWithQueryPreview() {
    WellnessTheme {
        WellnessSearchBar(
            query         = "Ramesh",
            onQueryChange = {},
            modifier      = Modifier.padding(Dimens.SpacingLg),
        )
    }
}
