package com.globussoft.wellness.core.common.utils

import java.text.NumberFormat
import java.util.Currency
import java.util.Locale

/**
 * Formats a monetary [amount] with the given ISO-4217 [currency] code.
 *
 * INR uses the Indian number system (lakh/crore grouping):
 *   e.g. 123456.0 -> "₹1,23,456"
 *   e.g. 1234567.89 -> "₹12,34,567.89"
 *
 * All other currencies fall back to [java.util.Currency] symbol + standard
 * grouping via [NumberFormat]:
 *   e.g. 1234.56 (USD) -> "$1,234.56"
 *   e.g. 1234.56 (EUR) -> "€1,234.56"
 *
 * Fractional cents/paise are shown only when [amount] is not a whole number.
 */
fun formatMoney(amount: Double, currency: String = "INR"): String {
    return when (currency.uppercase()) {
        "INR" -> formatInr(amount)
        else  -> formatGeneric(amount, currency)
    }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Indian number formatting — groups of 2 digits after the first 3 from the
 * right, with the rupee symbol prefix.
 *
 * Algorithm:
 *  1. Separate integer and fractional parts.
 *  2. Format the integer part in Indian grouping:
 *     last 3 digits first, then pairs of 2 moving left.
 *  3. Append fractional part only when non-zero.
 */
private fun formatInr(amount: Double): String {
    val isNegative = amount < 0
    val absAmount  = kotlin.math.abs(amount)

    // Split into integer and fractional parts.
    val intPart    = absAmount.toLong()
    val fracPart   = absAmount - intPart

    // Build Indian-grouped integer string.
    val intStr     = intPart.toString()
    val grouped    = buildString {
        val len = intStr.length
        when {
            len <= 3 -> append(intStr)
            else -> {
                // First (rightmost) group of 3.
                append(intStr.substring(len - 3))
                var remaining = intStr.substring(0, len - 3)
                // Subsequent groups of 2, prepended with comma.
                while (remaining.isNotEmpty()) {
                    val chunkSize = minOf(2, remaining.length)
                    val start     = remaining.length - chunkSize
                    insert(0, ",")
                    insert(0, remaining.substring(start))
                    remaining = remaining.substring(0, start)
                }
            }
        }
    }

    // Fractional suffix — show paise only when non-zero.
    val fracSuffix = if (fracPart > 0.0) {
        val paise = Math.round(fracPart * 100)
        ".%02d".format(paise)
    } else {
        ""
    }

    val sign = if (isNegative) "-" else ""
    return "${sign}₹$grouped$fracSuffix"
}

/**
 * Generic currency formatting via [NumberFormat] for any ISO-4217 code.
 * Falls back to the raw amount string if the currency code is unrecognised.
 */
private fun formatGeneric(amount: Double, currencyCode: String): String {
    return try {
        val currency = Currency.getInstance(currencyCode.uppercase())
        val locale   = localeForCurrency(currencyCode)
        val nf       = NumberFormat.getCurrencyInstance(locale).apply {
            this.currency = currency
            minimumFractionDigits = if (amount == kotlin.math.floor(amount)) 0 else 2
            maximumFractionDigits = 2
        }
        nf.format(amount)
    } catch (_: Exception) {
        "$currencyCode %.2f".format(amount)
    }
}

/**
 * Returns a best-effort [Locale] to use when formatting the given [currencyCode].
 * This controls grouping separators and decimal symbols.
 */
private fun localeForCurrency(currencyCode: String): Locale = when (currencyCode.uppercase()) {
    "USD" -> Locale.US
    "EUR" -> Locale.GERMANY
    "GBP" -> Locale.UK
    "JPY" -> Locale.JAPAN
    "AUD" -> Locale("en", "AU")
    "CAD" -> Locale.CANADA
    "SGD" -> Locale("en", "SG")
    "AED" -> Locale("ar", "AE")
    else  -> Locale.getDefault()
}
