package com.globussoft.wellness.core.common.utils

import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import kotlin.math.abs

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

private val ISO_FORMATS = listOf(
    "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",
    "yyyy-MM-dd'T'HH:mm:ss'Z'",
    "yyyy-MM-dd'T'HH:mm:ss.SSSXXX",
    "yyyy-MM-dd'T'HH:mm:ssXXX",
    "yyyy-MM-dd'T'HH:mm:ss",
    "yyyy-MM-dd HH:mm:ss",
    "yyyy-MM-dd",
)

/**
 * Tries to parse [isoString] through a list of common ISO-8601 variants.
 * Returns `null` when none match.
 */
private fun parseIso(isoString: String): Date? {
    val candidate = isoString.trim()
    for (pattern in ISO_FORMATS) {
        try {
            val sdf = SimpleDateFormat(pattern, Locale.US).apply {
                isLenient = false
                // Patterns ending in 'Z' literal are UTC; others preserve offset.
                if (pattern.endsWith("'Z'") || pattern == "yyyy-MM-dd HH:mm:ss" || pattern == "yyyy-MM-dd") {
                    timeZone = TimeZone.getTimeZone("UTC")
                }
            }
            return sdf.parse(candidate) ?: continue
        } catch (_: Exception) {
            // try next format
        }
    }
    return null
}

private fun formatWith(isoString: String, pattern: String, tz: TimeZone = TimeZone.getDefault()): String {
    val date = parseIso(isoString) ?: return isoString
    return SimpleDateFormat(pattern, Locale.getDefault()).apply { timeZone = tz }.format(date)
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Formats an ISO-8601 date/datetime string to a human-readable date.
 * e.g. `"2026-05-13T09:30:00Z"` -> `"13 May 2026"`.
 */
fun formatDate(isoString: String): String = formatWith(isoString, "dd MMM yyyy")

/**
 * Formats an ISO-8601 string to a date-and-time string in the device locale.
 * e.g. `"2026-05-13T09:30:00Z"` -> `"13 May 2026, 03:00 PM"`.
 */
fun formatDateTime(isoString: String): String = formatWith(isoString, "dd MMM yyyy, hh:mm a")

/**
 * Formats an ISO-8601 string to a time-only string appended with " IST".
 * The time is converted to IST (Asia/Kolkata) before formatting.
 * e.g. `"2026-05-13T09:30:00Z"` -> `"03:00 PM IST"`.
 */
fun formatTimeOnly(isoString: String): String {
    val ist = TimeZone.getTimeZone("Asia/Kolkata")
    val time = formatWith(isoString, "hh:mm a", ist)
    return "$time IST"
}

/**
 * Returns a human-friendly relative-time string using wall-clock distance
 * from the current instant.
 *
 * Buckets:
 *  - < 60 s  → "just now"
 *  - < 60 min → "Xm ago" / "in Xm"
 *  - < 24 h  → "Xh ago" / "in Xh"
 *  - ≥ 24 h  → "Xd ago" / "in Xd"
 */
fun formatRelativeTime(isoString: String): String {
    val date = parseIso(isoString) ?: return isoString
    val diffMs = System.currentTimeMillis() - date.time
    val absDiffMs = abs(diffMs)
    val isFuture = diffMs < 0

    val seconds = absDiffMs / 1_000L
    val minutes = absDiffMs / 60_000L
    val hours   = absDiffMs / 3_600_000L
    val days    = absDiffMs / 86_400_000L

    return when {
        seconds < 60L  -> "just now"
        minutes < 60L  -> if (isFuture) "in ${minutes}m" else "${minutes}m ago"
        hours   < 24L  -> if (isFuture) "in ${hours}h"   else "${hours}h ago"
        else           -> if (isFuture) "in ${days}d"    else "${days}d ago"
    }
}

/**
 * Returns today's date as an ISO-8601 date string `"yyyy-MM-dd"` in UTC.
 */
fun todayIsoDate(): String =
    SimpleDateFormat("yyyy-MM-dd", Locale.US)
        .apply { timeZone = TimeZone.getTimeZone("UTC") }
        .format(Date())

/**
 * Parses [isoString] and returns its value as Unix epoch milliseconds.
 * Returns `0L` when parsing fails.
 */
fun isoDateToMillis(isoString: String): Long = parseIso(isoString)?.time ?: 0L

/**
 * Converts Unix epoch [millis] to an ISO-8601 date string `"yyyy-MM-dd"` in UTC.
 */
fun millisToIsoDate(millis: Long): String =
    SimpleDateFormat("yyyy-MM-dd", Locale.US)
        .apply { timeZone = TimeZone.getTimeZone("UTC") }
        .format(Date(millis))
