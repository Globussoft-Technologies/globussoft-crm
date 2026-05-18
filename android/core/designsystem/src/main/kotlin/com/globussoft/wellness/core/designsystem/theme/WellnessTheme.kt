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

// ─── Generic CRM color schemes ───────────────────────────────────────────────

private val GenericCrmLightColorScheme = lightColorScheme(
    primary             = GenericPrimary,
    onPrimary           = Color.White,
    primaryContainer    = GenericSubtleBg3,
    onPrimaryContainer  = GenericPrimary,

    secondary             = GenericAccent,
    onSecondary           = Color.White,
    secondaryContainer    = Color(0xFFD1FAE5),
    onSecondaryContainer  = GenericAccentDark,

    tertiary             = GenericSuccess,
    onTertiary           = Color.White,
    tertiaryContainer    = Color(0xFFD1FAE5),
    onTertiaryContainer  = Color(0xFF064E3B),

    error             = GenericDanger,
    onError           = Color.White,
    errorContainer    = Color(0xFFFEE2E2),
    onErrorContainer  = Color(0xFF7F1D1D),

    background         = GenericBg,
    onBackground       = GenericTextPrimary,
    surface            = GenericSurface,
    onSurface          = GenericTextPrimary,
    surfaceVariant     = GenericBgGradientEnd,
    onSurfaceVariant   = GenericTextSecondary,

    outline        = GenericBorderColor,
    outlineVariant = GenericBorderLight,

    inverseSurface    = GenericTextPrimary,
    inverseOnSurface  = GenericBg,
    inversePrimary    = GenericPrimaryDark,

    scrim = Color(0x80000000),
)

private val GenericCrmDarkColorScheme = darkColorScheme(
    primary             = GenericPrimaryDarkMode,
    onPrimary           = Color(0xFF1E1B4B),
    primaryContainer    = Color(0xFF312E81),
    onPrimaryContainer  = Color(0xFFC7D2FE),

    secondary             = GenericAccentDarkMode,
    onSecondary           = Color(0xFF064E3B),
    secondaryContainer    = Color(0xFF065F46),
    onSecondaryContainer  = Color(0xFFA7F3D0),

    tertiary             = Color(0xFF6EE7B7),
    onTertiary           = Color(0xFF064E3B),
    tertiaryContainer    = Color(0xFF065F46),
    onTertiaryContainer  = Color(0xFFA7F3D0),

    error             = Color(0xFFFCA5A5),
    onError           = Color(0xFF7F1D1D),
    errorContainer    = Color(0xFF991B1B),
    onErrorContainer  = Color(0xFFFEE2E2),

    background         = GenericBgDark,
    onBackground       = GenericTextPrimaryDark,
    surface            = Color(0xFF1E293B),
    onSurface          = GenericTextPrimaryDark,
    surfaceVariant     = Color(0xFF1A2332),
    onSurfaceVariant   = GenericTextSecondaryDark,

    outline        = GenericBorderDark,
    outlineVariant = Color(0x0FE0E7FF),

    inverseSurface    = GenericTextPrimaryDark,
    inverseOnSurface  = Color(0xFF0F172A),
    inversePrimary    = GenericPrimary,

    scrim = Color(0x80000000),
)

// ─── Root theme composable ────────────────────────────────────────────────────
/**
 * The root Material 3 theme for the Globussoft CRM application.
 *
 * Switches between the Wellness palette (teal/blush) and the Generic CRM
 * palette (indigo/emerald) based on [vertical]. Both verticals share the same
 * typography and shapes.
 *
 * @param vertical   Tenant vertical — "wellness" or "generic". Defaults to "wellness".
 * @param darkTheme  Whether to use the dark color scheme. Defaults to the
 *                   system value via [isSystemInDarkTheme].
 * @param content    Composable content drawn within this theme.
 */
@Composable
fun WellnessTheme(
    vertical: String = "wellness",
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    val colorScheme = when {
        vertical == "generic" && darkTheme  -> GenericCrmDarkColorScheme
        vertical == "generic"               -> GenericCrmLightColorScheme
        darkTheme                           -> WellnessDarkColorScheme
        else                                -> WellnessLightColorScheme
    }

    CompositionLocalProvider(LocalDarkTheme provides darkTheme) {
        MaterialTheme(
            colorScheme = colorScheme,
            typography  = WellnessTypography,
            shapes      = WellnessShapes,
            content     = content,
        )
    }
}
