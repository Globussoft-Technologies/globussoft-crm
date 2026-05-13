package com.globussoft.wellness.core.designsystem.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color

// ─── Composition local for dark-theme awareness ───────────────────────────────
/**
 * Provides the current dark-theme state to any composable in the tree.
 *
 * Usage:
 * ```kotlin
 * val isDark = LocalDarkTheme.current
 * ```
 */
val LocalDarkTheme = staticCompositionLocalOf { false }

// ─── Light color scheme ───────────────────────────────────────────────────────
private val WellnessLightColorScheme = lightColorScheme(
    // Brand
    primary          = WellnessPrimary,
    onPrimary        = Color.White,
    primaryContainer = WellnessSubtleBg3,
    onPrimaryContainer = WellnessPrimary,

    // Secondary (accent / blush)
    secondary          = WellnessAccent,
    onSecondary        = Color.White,
    secondaryContainer = Color(0xFFF5E4DA),   // soft blush tint
    onSecondaryContainer = WellnessAccentDark,

    // Tertiary (success green)
    tertiary          = WellnessSuccess,
    onTertiary        = Color.White,
    tertiaryContainer = Color(0xFFD6EDDC),
    onTertiaryContainer = Color(0xFF1E4D2B),

    // Error
    error          = WellnessDanger,
    onError        = Color.White,
    errorContainer = Color(0xFFFFDAD9),
    onErrorContainer = Color(0xFF680014),

    // Backgrounds & surfaces
    background = WellnessBg,
    onBackground = WellnessTextPrimary,
    surface    = WellnessSurface,
    onSurface  = WellnessTextPrimary,
    surfaceVariant    = WellnessBgGradientEnd,
    onSurfaceVariant  = WellnessTextSecondary,

    // Outline
    outline      = WellnessBorderColor,
    outlineVariant = WellnessBorderLight,

    // Inverse (for snackbars / tooltips)
    inverseSurface    = WellnessTextPrimary,
    inverseOnSurface  = WellnessBg,
    inversePrimary    = WellnessPrimaryDark,

    // Scrim (overlay)
    scrim = Color(0x80000000),
)

// ─── Dark color scheme ────────────────────────────────────────────────────────
private val WellnessDarkColorScheme = darkColorScheme(
    // Brand
    primary          = WellnessPrimaryDarkMode,
    onPrimary        = Color(0xFF003736),
    primaryContainer = Color(0xFF00504E),
    onPrimaryContainer = Color(0xFF70EFEA),

    // Secondary (accent / blush)
    secondary          = WellnessAccentDarkMode,
    onSecondary        = Color(0xFF4A2215),
    secondaryContainer = Color(0xFF65382A),
    onSecondaryContainer = WellnessAccentDarkHover,

    // Tertiary
    tertiary          = Color(0xFF7FCFA3),
    onTertiary        = Color(0xFF003921),
    tertiaryContainer = Color(0xFF005232),
    onTertiaryContainer = Color(0xFF9AECBF),

    // Error
    error          = Color(0xFFFFB4AB),
    onError        = Color(0xFF690005),
    errorContainer = Color(0xFF93000A),
    onErrorContainer = Color(0xFFFFDAD6),

    // Backgrounds & surfaces
    background = WellnessBgDark,
    onBackground = WellnessTextPrimaryDark,
    surface    = Color(0xFF1E2628),
    onSurface  = WellnessTextPrimaryDark,
    surfaceVariant    = Color(0xFF1A2022),
    onSurfaceVariant  = WellnessTextSecondaryDark,

    // Outline
    outline      = WellnessBorderDark,
    outlineVariant = Color(0x0FF5EFE6),

    // Inverse
    inverseSurface    = WellnessTextPrimaryDark,
    inverseOnSurface  = Color(0xFF14181A),
    inversePrimary    = WellnessPrimary,

    // Scrim
    scrim = Color(0x80000000),
)

// ─── Root theme composable ────────────────────────────────────────────────────
/**
 * The root Material 3 theme for the Globussoft Wellness CRM application.
 *
 * Wraps [MaterialTheme] with wellness-specific color roles, typography, and
 * shapes. Also provides [LocalDarkTheme] so nested composables can read the
 * current dark-mode state without propagating it through parameters.
 *
 * @param darkTheme  Whether to use the dark color scheme. Defaults to the
 *                   system value via [isSystemInDarkTheme].
 * @param content    Composable content drawn within this theme.
 */
@Composable
fun WellnessTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    val colorScheme = if (darkTheme) WellnessDarkColorScheme else WellnessLightColorScheme

    CompositionLocalProvider(LocalDarkTheme provides darkTheme) {
        MaterialTheme(
            colorScheme = colorScheme,
            typography  = WellnessTypography,
            shapes      = WellnessShapes,
            content     = content,
        )
    }
}
