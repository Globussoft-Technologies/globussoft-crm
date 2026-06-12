package com.globus.crm.core.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.graphics.Color

private fun buildLightColorScheme(primaryColor: Color) = lightColorScheme(
    primary = primaryColor,
    onPrimary = WellnessOnPrimary,
    primaryContainer = WellnessPrimaryContainer,
    onPrimaryContainer = WellnessOnPrimaryContainer,
    secondary = WellnessSecondary,
    onSecondary = WellnessOnSecondary,
    secondaryContainer = WellnessSecondaryContainer,
    onSecondaryContainer = WellnessOnSecondaryContainer,
    tertiary = WellnessTertiary,
    onTertiary = WellnessOnTertiary,
    tertiaryContainer = WellnessTertiaryContainer,
    onTertiaryContainer = WellnessOnTertiaryContainer,
    background = WellnessBackground,
    onBackground = WellnessOnSurface,
    surface = WellnessSurface,
    onSurface = WellnessOnSurface,
    surfaceVariant = WellnessSurfaceVariant,
    onSurfaceVariant = WellnessOnSurfaceVariant,
    surfaceTint = WellnessSurfaceTint,
    surfaceContainerLowest = WellnessSurfaceContainerLowest,
    surfaceContainerLow = WellnessSurfaceContainerLow,
    surfaceContainer = WellnessSurfaceContainer,
    surfaceContainerHigh = WellnessSurfaceContainerHigh,
    surfaceContainerHighest = WellnessSurfaceContainerHighest,
    outline = WellnessOutline,
    outlineVariant = WellnessOutlineVariant,
    inverseSurface = WellnessInverseSurface,
    inverseOnSurface = WellnessInverseOnSurface,
    inversePrimary = WellnessInversePrimary,
    error = WellnessError,
    onError = WellnessOnError,
    errorContainer = WellnessErrorContainer,
    onErrorContainer = WellnessOnErrorContainer,
)

private val DarkColorScheme = darkColorScheme(
    primary = WellnessDarkPrimary,
    onPrimary = WellnessDarkOnPrimary,
    primaryContainer = WellnessDarkPrimaryContainer,
    onPrimaryContainer = WellnessDarkOnPrimaryContainer,
    secondary = WellnessDarkSecondary,
    onSecondary = WellnessDarkOnSecondary,
    secondaryContainer = WellnessDarkSecondaryContainer,
    onSecondaryContainer = WellnessDarkOnSecondaryContainer,
    tertiary = WellnessDarkTertiary,
    onTertiary = WellnessDarkOnTertiary,
    tertiaryContainer = WellnessDarkTertiaryContainer,
    onTertiaryContainer = WellnessDarkOnTertiaryContainer,
    background = WellnessDarkBackground,
    onBackground = WellnessDarkOnSurface,
    surface = WellnessDarkSurface,
    onSurface = WellnessDarkOnSurface,
    surfaceVariant = WellnessDarkSurfaceVariant,
    onSurfaceVariant = WellnessDarkOnSurfaceVariant,
    surfaceContainerLowest = WellnessDarkSurfaceContainerLowest,
    surfaceContainerLow = WellnessDarkSurfaceContainerLow,
    surfaceContainer = WellnessDarkSurfaceContainer,
    surfaceContainerHigh = WellnessDarkSurfaceContainerHigh,
    surfaceContainerHighest = WellnessDarkSurfaceContainerHighest,
    outline = WellnessDarkOutline,
    outlineVariant = WellnessDarkOutlineVariant,
    inverseSurface = WellnessDarkInverseSurface,
    inverseOnSurface = WellnessDarkInverseOnSurface,
    inversePrimary = WellnessDarkInversePrimary,
    error = WellnessError,
    onError = WellnessOnError,
    errorContainer = WellnessErrorContainer,
    onErrorContainer = WellnessOnErrorContainer,
)

fun parseBrandColor(hex: String?): Color {
    if (hex.isNullOrBlank()) return WellnessPrimary
    return runCatching {
        Color(android.graphics.Color.parseColor(if (hex.startsWith("#")) hex else "#$hex"))
    }.getOrDefault(WellnessPrimary)
}

@Composable
fun WellnessTheme(
    brandColor: Color = WellnessPrimary,
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    val colorScheme = if (darkTheme) {
        DarkColorScheme
    } else {
        remember(brandColor) { buildLightColorScheme(brandColor) }
    }
    MaterialTheme(
        colorScheme = colorScheme,
        typography = WellnessTypography,
        shapes = WellnessShapes,
        content = content,
    )
}
