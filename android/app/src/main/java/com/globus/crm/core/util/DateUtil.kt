package com.globus.crm.core.util

import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

object DateUtil {

    private val iso8601 = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
        timeZone = TimeZone.getTimeZone("UTC")
    }
    private val iso8601Short = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US).apply {
        timeZone = TimeZone.getTimeZone("UTC")
    }
    private val displayDate = SimpleDateFormat("d MMM yyyy", Locale.getDefault())
    private val displayDateTime = SimpleDateFormat("d MMM yyyy, h:mm a", Locale.getDefault())
    private val displayMonthYear = SimpleDateFormat("MMMM yyyy", Locale.getDefault())
    private val apiDate = SimpleDateFormat("yyyy-MM-dd", Locale.US)
    private val apiTime = SimpleDateFormat("HH:mm", Locale.US)

    fun parseIso8601(iso: String?): Date? = iso?.let { isoStr ->
        runCatching { iso8601.parse(isoStr) }.getOrElse { runCatching { iso8601Short.parse(isoStr) }.getOrNull() }
    }

    fun toDisplayDate(iso: String?): String = parseIso8601(iso)?.let { displayDate.format(it) } ?: "—"

    fun toDisplayDateTime(iso: String?): String = parseIso8601(iso)?.let { displayDateTime.format(it) } ?: "—"

    fun toDisplayMonthYear(iso: String?): String = parseIso8601(iso)?.let { displayMonthYear.format(it) } ?: "—"

    fun toDisplayDate(epochMs: Long): String = displayDate.format(Date(epochMs))

    fun toDisplayDateTime(epochMs: Long): String = displayDateTime.format(Date(epochMs))

    fun toDisplayMonthYear(epochMs: Long): String = displayMonthYear.format(Date(epochMs))

    fun isoToEpochMs(iso: String?): Long = parseIso8601(iso)?.time ?: 0L

    fun epochMsToIso(epochMs: Long): String = iso8601.format(Date(epochMs))

    fun toApiDate(epochMs: Long): String = apiDate.format(Date(epochMs))

    fun todayApiDate(): String = apiDate.format(Date())

    fun toApiTime(epochMs: Long): String = apiTime.format(Date(epochMs))
}
