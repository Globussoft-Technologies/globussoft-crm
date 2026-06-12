package com.globus.crm.core.navigation

sealed class Screen(val route: String) {
    object Splash : Screen("splash")
    object Login : Screen("login")
    object Register : Screen("register")
    object Dashboard : Screen("dashboard")
    object BookAppointment : Screen("book_appointment?serviceId={serviceId}&membershipId={membershipId}") {
        fun createRoute(serviceId: Int? = null, membershipId: Int? = null) =
            "book_appointment?serviceId=${serviceId ?: ""}&membershipId=${membershipId ?: ""}"
    }
    object MyAppointments : Screen("my_appointments")
    object VisitHistory : Screen("visit_history")
    object Prescriptions : Screen("prescriptions")
    object PrescriptionPdf : Screen("prescription_pdf/{id}") {
        fun createRoute(id: Int) = "prescription_pdf/$id"
    }
    object TreatmentPlans : Screen("treatment_plans")  // Phase 2
    object ConsentForms : Screen("consent_forms")       // Phase 2
    object ConsentFormPdf : Screen("consent_form_pdf/{id}") {
        fun createRoute(id: Int) = "consent_form_pdf/$id"
    }
    object Memberships : Screen("memberships")
    object Wallet : Screen("wallet")
    object GiftCards : Screen("gift_cards")
    object Loyalty : Screen("loyalty")                 // Phase 2
    object Profile : Screen("profile")
    object Notifications : Screen("notifications")
    object NotificationSettings : Screen("notification_settings")
    object CatalogTab : Screen("tab_catalog")
    object FinanceTab : Screen("tab_finance")
    object Waitlist : Screen("waitlist")
}
