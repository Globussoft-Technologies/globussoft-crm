package com.globus.crm.core.util

import java.text.NumberFormat
import java.util.Locale

object CurrencyUtil {

    private val indianLocale = Locale("en", "IN")

    fun formatPaise(amount: Double, currency: String = "INR"): String = formatPaise(amount.toLong(), currency)

    fun formatPaise(amount: Long, currency: String = "INR"): String {
        return if (currency == "INR") {
            val formatter = NumberFormat.getCurrencyInstance(indianLocale)
            formatter.format(amount.toDouble())
        } else {
            "%.2f %s".format(amount.toDouble(), currency)
        }
    }

    fun formatRupees(rupees: Double): String {
        val formatter = NumberFormat.getCurrencyInstance(indianLocale)
        return formatter.format(rupees)
    }

    fun formatRupees(rupees: Long): String = formatRupees(rupees.toDouble())
}
