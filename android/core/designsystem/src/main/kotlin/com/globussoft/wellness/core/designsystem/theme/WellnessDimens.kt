package com.globussoft.wellness.core.designsystem.theme

import androidx.compose.ui.unit.dp

/**
 * Design-system spacing and sizing tokens.
 *
 * All values are expressed in dp so they scale correctly with font-size
 * accessibility settings.
 */
object Dimens {

    // ─── Spacing scale ────────────────────────────────────────────────────────
    val SpacingXs   =  4.dp
    val SpacingSm   =  8.dp
    val SpacingMd   = 12.dp
    val SpacingLg   = 16.dp
    val SpacingXl   = 24.dp
    val SpacingXxl  = 32.dp
    val SpacingHuge = 48.dp

    // ─── Card / Surface ───────────────────────────────────────────────────────
    /** Cards use no drop-shadow; border provides separation instead. */
    val CardElevation = 0.dp

    // ─── Corner radii (mirrors WellnessShapes for non-Shape use-sites) ────────
    val CornerSmall  =  8.dp
    val CornerMedium = 12.dp
    val CornerLarge  = 16.dp

    // ─── Navigation ──────────────────────────────────────────────────────────
    /** Narrow navigation rail used on medium-width windows. */
    val NavigationRailWidth = 80.dp

    /** Full sidebar width used on expanded windows. */
    val SidebarWidth = 256.dp

    // ─── Adaptive breakpoints ────────────────────────────────────────────────
    /** Compact → Medium transition (matches WindowSizeClass.Medium lower bound). */
    val TabletBreakpoint   = 600.dp

    /** Medium → Expanded transition (matches WindowSizeClass.Expanded lower bound). */
    val ExpandedBreakpoint = 840.dp

    // ─── Component sizes ─────────────────────────────────────────────────────
    val KpiCardMinWidth = 220.dp
    val ListItemHeight  =  72.dp
    val AppBarHeight    =  64.dp
}
