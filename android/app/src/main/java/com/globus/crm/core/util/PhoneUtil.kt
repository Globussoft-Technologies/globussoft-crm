package com.globus.crm.core.util

object PhoneUtil {

    private val tenDigitRegex = Regex("^[6-9]\\d{9}$")

    fun isValid(phone: String): Boolean = tenDigitRegex.matches(normalize(phone))

    fun normalize(phone: String): String {
        val stripped = phone.trim().removePrefix("+91").removePrefix("91")
        return stripped.filter { it.isDigit() }
    }

    fun toE164(phone: String): String = "+91${normalize(phone)}"

    fun mask(phone: String): String {
        val digits = normalize(phone)
        return if (digits.length == 10) "XXXXXX${digits.takeLast(4)}" else phone
    }
}
