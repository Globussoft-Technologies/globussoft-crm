package com.globus.crm.core.navigation

import android.content.Intent
import android.net.Uri

object DeepLinkHandler {

    private const val SCHEME = "globuscrm"
    private const val HOST = "screen"

    fun resolveRoute(intent: Intent?): String? {
        val data: Uri = intent?.data ?: return null
        if (data.scheme != SCHEME || data.host != HOST) return null
        val screenName = data.pathSegments.firstOrNull() ?: return null
        val entityId = data.getQueryParameter("id")
        return mapToRoute(screenName, entityId)
    }

    fun resolveRoute(uri: String?): String? {
        if (uri == null) return null
        return resolveRoute(Intent(Intent.ACTION_VIEW, Uri.parse(uri)))
    }

    private fun mapToRoute(screenName: String, id: String?): String? = when (screenName) {
        "splash" -> Screen.Splash.route
        "login" -> Screen.Login.route
        "dashboard" -> Screen.Dashboard.route
        "appointments" -> Screen.MyAppointments.route
        "book" -> Screen.BookAppointment.createRoute()
        "visit_history" -> Screen.VisitHistory.route
        "prescriptions" -> Screen.Prescriptions.route
        "prescription_pdf" -> id?.toIntOrNull()?.let { Screen.PrescriptionPdf.createRoute(it) }
        "memberships" -> Screen.Memberships.route
        "wallet" -> Screen.Wallet.route
        "gift_cards" -> Screen.GiftCards.route
        "profile" -> Screen.Profile.route
        "notifications" -> Screen.Notifications.route
        "treatment_plans" -> Screen.TreatmentPlans.route
        "consent_forms" -> Screen.ConsentForms.route
        "loyalty" -> Screen.Loyalty.route
        else -> null
    }
}
