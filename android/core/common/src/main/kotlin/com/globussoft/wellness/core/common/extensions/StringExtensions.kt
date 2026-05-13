package com.globussoft.wellness.core.common.extensions

/**
 * Normalises a raw phone string to a bare 10-digit Indian mobile number.
 *
 * Strips leading `+91` or `91` country code, then removes all spaces,
 * hyphens, and parentheses. Returns the original trimmed string unchanged
 * if the result is not exactly 10 digits (so callers can surface a
 * validation error rather than silently corrupt data).
 */
fun String.toIndianMobile(): String {
    var digits = trim()
        .removePrefix("+91")
        .removePrefix("91")
        .replace(Regex("[\\s\\-()]+"), "")
    // If the cleanup still left a leading country code (e.g. "0" STD prefix)
    if (digits.length == 11 && digits.startsWith("0")) {
        digits = digits.drop(1)
    }
    return if (digits.length == 10 && digits.all { it.isDigit() }) digits else trim()
}

/**
 * Returns `true` when the string is a syntactically valid e-mail address.
 * Uses a pragmatic RFC-5321-subset pattern sufficient for form validation.
 */
fun String.isValidEmail(): Boolean {
    if (isBlank()) return false
    val emailRegex = Regex(
        "^[a-zA-Z0-9._%+\\-]+@[a-zA-Z0-9.\\-]+\\.[a-zA-Z]{2,}$"
    )
    return emailRegex.matches(trim())
}

/**
 * Returns `true` when the string (after stripping the +91 country code
 * and formatting characters) is a valid 10-digit Indian mobile number.
 *
 * Indian mobiles must start with 6, 7, 8, or 9.
 */
fun String.isValidIndianMobile(): Boolean {
    val normalized = toIndianMobile()
    return normalized.length == 10 &&
        normalized.all { it.isDigit() } &&
        normalized[0] in "6789"
}

/**
 * Title-cases every whitespace-separated word in the string.
 * e.g. `"john doe"` -> `"John Doe"`.
 */
fun String.capitalizeWords(): String =
    trim().split(Regex("\\s+")).joinToString(" ") { word ->
        word.replaceFirstChar { if (it.isLowerCase()) it.titlecase() else it.toString() }
    }

/**
 * Returns the string itself if it is non-null and non-blank,
 * otherwise returns the em-dash placeholder `"—"`.
 *
 * Defined as an extension on nullable [String] so it can be called
 * directly on nullable receivers: `user.middleName.orDash()`.
 */
fun String?.orDash(): String = if (isNullOrBlank()) "—" else this
