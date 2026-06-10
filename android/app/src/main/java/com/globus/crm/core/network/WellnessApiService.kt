package com.globus.crm.core.network

import com.globus.crm.feature.auth.data.remote.dto.LoginRequestDto
import com.globus.crm.feature.auth.data.remote.dto.LoginResponseDto
import com.globus.crm.feature.auth.data.remote.dto.PatientPermissionsDto
import com.globus.crm.feature.auth.data.remote.dto.PortalHealthDto
import com.globus.crm.feature.auth.data.remote.dto.RegisterRequestDto
import com.globus.crm.feature.auth.data.remote.dto.RegisterResponseDto
import com.globus.crm.feature.auth.data.remote.dto.TenantBrandingResponseDto
import com.globus.crm.feature.catalog.data.remote.dto.CatalogServiceCategoryDto
import com.globus.crm.feature.catalog.data.remote.dto.CatalogServiceDto
import com.globus.crm.feature.booking.data.remote.dto.AddWaitlistDto
import com.globus.crm.feature.booking.data.remote.dto.AppointmentListResponseDto
import com.globus.crm.feature.booking.data.remote.dto.BookAppointmentDto
import com.globus.crm.feature.booking.data.remote.dto.BookAppointmentResponseDto
import com.globus.crm.feature.booking.data.remote.dto.CancelAppointmentResponseDto
import com.globus.crm.feature.booking.data.remote.dto.ProductCategoryDto
import com.globus.crm.feature.booking.data.remote.dto.ProductDto
import com.globus.crm.feature.booking.data.remote.dto.RescheduleAppointmentDto
import com.globus.crm.feature.booking.data.remote.dto.RescheduleAppointmentResponseDto
import com.globus.crm.feature.booking.data.remote.dto.VisitDto
import com.globus.crm.feature.booking.data.remote.dto.WaitlistEntryDto
import com.globus.crm.feature.health.data.remote.dto.ConsentFormDto
import com.globus.crm.feature.health.data.remote.dto.PrescriptionDto
import com.globus.crm.feature.health.data.remote.dto.TreatmentPlanDto
import com.globus.crm.feature.loyalty.data.remote.dto.LoyaltyResponseDto
import com.globus.crm.feature.membership.data.remote.dto.MembershipDto
import com.globus.crm.feature.membership.data.remote.dto.MembershipPlanDto
import com.globus.crm.feature.profile.data.remote.dto.AuthProfileResponseDto
import com.globus.crm.feature.profile.data.remote.dto.DsarExportResponseDto
import com.globus.crm.feature.profile.data.remote.dto.ProfileDto
import com.globus.crm.feature.profile.data.remote.dto.UpdateAuthProfileDto
import com.globus.crm.feature.notifications.data.remote.dto.PortalNotificationsResponseDto

import com.globus.crm.feature.finance.data.remote.dto.PaymentConfigDto
import com.globus.crm.feature.finance.data.remote.dto.PaymentDto
import com.globus.crm.feature.wallet.data.remote.dto.GiftCardConfirmDto
import com.globus.crm.feature.wallet.data.remote.dto.GiftCardConfirmResponseDto
import com.globus.crm.feature.wallet.data.remote.dto.GiftCardOrderDto
import com.globus.crm.feature.wallet.data.remote.dto.GiftCardOrderResponseDto
import com.globus.crm.feature.wallet.data.remote.dto.GiftCardStorefrontResponseDto
import com.globus.crm.feature.wallet.data.remote.dto.MyTransactionsResponseDto
import com.globus.crm.feature.wallet.data.remote.dto.PatientWalletResponseDto
import okhttp3.MultipartBody
import okhttp3.ResponseBody
import retrofit2.Response
import retrofit2.http.Body
import retrofit2.http.DELETE
import retrofit2.http.GET
import retrofit2.http.Multipart
import retrofit2.http.PATCH
import retrofit2.http.POST
import retrofit2.http.PUT
import retrofit2.http.Part
import retrofit2.http.Path
import retrofit2.http.Query

interface WellnessApiService {

    // ── Tenant Branding ──────────────────────────────────────────────────────
    @GET("public/tenant/{slug}")
    suspend fun getTenantBranding(
        @Path("slug") slug: String,
    ): Response<TenantBrandingResponseDto>

    // ── Auth — absolute paths (/api/auth/* not under /api/wellness/) ──────────
    @POST("/api/auth/login")
    suspend fun login(
        @Body body: LoginRequestDto,
    ): Response<LoginResponseDto>

    @POST("/api/auth/customer/register")
    suspend fun registerCustomer(
        @Body body: RegisterRequestDto,
    ): Response<RegisterResponseDto>

    // ── Portal Health (SMS availability check) ───────────────────────────────
    @GET("portal/health")
    suspend fun getPortalHealth(): Response<PortalHealthDto>

    // ── Patient Permissions ───────────────────────────────────────────────────
    @GET("portal/me/permissions")
    suspend fun getPatientPermissions(): Response<PatientPermissionsDto>

    // ── Profile ───────────────────────────────────────────────────────────────
    // GET /portal/me — patient-layer: name, phone, email, dob, gender, id (patientId)
    @GET("portal/me")
    suspend fun getProfile(): Response<ProfileDto>

    // GET /api/auth/me — user-layer: name, email, role, profilePicture
    @GET("/api/auth/me")
    suspend fun getAuthProfile(): Response<AuthProfileResponseDto>

    // PUT /api/auth/me — update name, email, or password (dob/gender/phone not supported)
    @PUT("/api/auth/me")
    suspend fun updateAuthProfile(
        @Body body: UpdateAuthProfileDto,
    ): Response<AuthProfileResponseDto>

    @Multipart
    @POST("/api/auth/me/profile-picture")
    suspend fun uploadProfilePicture(
        @Part file: MultipartBody.Part,
    ): Response<AuthProfileResponseDto>

    @DELETE("/api/auth/me/profile-picture")
    suspend fun deleteProfilePicture(): Response<AuthProfileResponseDto>

    @POST("portal/export")
    suspend fun requestDsarExport(): Response<DsarExportResponseDto>

    // ── Portal Notifications ──────────────────────────────────────────────────
    @GET("portal/me/notifications")
    suspend fun getPortalNotifications(
        @Query("page") page: Int = 1,
        @Query("limit") limit: Int = 50,
    ): Response<PortalNotificationsResponseDto>

    @PUT("portal/me/notifications/{id}/read")
    suspend fun markPortalNotificationRead(@Path("id") id: String): Response<Unit>

    @POST("portal/me/notifications/read-all")
    suspend fun markAllPortalNotificationsRead(): Response<Unit>

    // ── Visits ────────────────────────────────────────────────────────────────
    @GET("portal/visits")
    suspend fun getVisits(
        @Query("upcoming") upcoming: Boolean? = null,
    ): Response<List<VisitDto>>

    // ── Appointments (portal-scoped, verifyPatientToken) ──────────────────────
    // bucket = "upcoming" | "past" | "all" (default: "upcoming")
    @GET("portal/appointments")
    suspend fun getMyAppointments(
        @Query("bucket") bucket: String? = null,
    ): Response<AppointmentListResponseDto>

    @POST("portal/appointments/book")
    suspend fun bookAppointment(
        @Body body: BookAppointmentDto,
    ): Response<BookAppointmentResponseDto>

    @POST("portal/appointments/{id}/cancel")
    suspend fun cancelAppointment(
        @Path("id") appointmentId: Int,
    ): Response<CancelAppointmentResponseDto>

    @PATCH("portal/appointments/{id}/reschedule")
    suspend fun rescheduleAppointment(
        @Path("id") appointmentId: Int,
        @Body body: RescheduleAppointmentDto,
    ): Response<RescheduleAppointmentResponseDto>

    // ── Waitlist ──────────────────────────────────────────────────────────────
    @GET("waitlist")
    suspend fun getWaitlist(): Response<List<WaitlistEntryDto>>

    @POST("waitlist")
    suspend fun addToWaitlist(@Body body: AddWaitlistDto): Response<WaitlistEntryDto>

    // ── Products / Services (patient-facing catalogue) ────────────────────────
    // portal/products requires products.read (CUSTOMER role denied). Use public services endpoint.
    @GET("services")
    suspend fun getPortalProducts(@Query("public") public: Boolean = true): Response<List<ProductDto>>

    @GET("portal/product-categories")
    suspend fun getPortalProductCategories(): Response<List<ProductCategoryDto>>

    // ── Catalog (catalog feature — own DTOs, no cross-feature import from booking) ──
    @GET("services")
    suspend fun getCatalogServices(@Query("public") public: Boolean = true): Response<List<CatalogServiceDto>>

    @GET("service-categories")
    suspend fun getCatalogServiceCategories(@Query("public") public: Boolean = true): Response<List<CatalogServiceCategoryDto>>

    // ── Prescriptions ─────────────────────────────────────────────────────────
    @GET("portal/prescriptions")
    suspend fun getPrescriptions(): Response<List<PrescriptionDto>>

    @GET("portal/prescriptions/{id}/pdf")
    suspend fun getPrescriptionPdf(
        @Path("id") prescriptionId: Int,
    ): Response<ResponseBody>

    // ── Treatment Plans (Phase 2 UI, data layer ready) ───────────────────────
    // Uses patient-row ID from EncryptedPrefsManager.getPatientId().
    @GET("patients/{patientId}/treatment-plans")
    suspend fun getTreatmentPlans(
        @Path("patientId") patientId: Int,
    ): Response<List<TreatmentPlanDto>>

    // ── Consent Forms (Phase 2 UI, data layer ready) ─────────────────────────
    @GET("patients/{patientId}/consents")
    suspend fun getConsents(
        @Path("patientId") patientId: Int,
    ): Response<List<ConsentFormDto>>

    @GET("consents/{id}/pdf")
    suspend fun getConsentPdf(
        @Path("id") consentId: Int,
    ): Response<ResponseBody>

    // ── Memberships ───────────────────────────────────────────────────────────
    // GET /appointments/my-memberships — returns patient's active/past memberships.
    @GET("appointments/my-memberships")
    suspend fun getMyMemberships(): Response<List<MembershipDto>>

    // GET /membership-plans — full catalog for plan-browse screen.
    @GET("membership-plans")
    suspend fun getMembershipPlans(): Response<List<MembershipPlanDto>>

    // ── Wallet ────────────────────────────────────────────────────────────────
    // GET /patients/{patientId}/wallet — dedicated wallet view with balance + wallet-only txns.
    @GET("patients/{patientId}/wallet")
    suspend fun getPatientWallet(
        @Path("patientId") patientId: Int,
    ): Response<PatientWalletResponseDto>

    // GET /my-transactions — unified timeline across all transaction types.
    // Also used by DashboardRepositoryImpl for summary.walletBalance.
    @GET("my-transactions")
    suspend fun getMyTransactions(
        @Query("from") from: String? = null,
        @Query("to") to: String? = null,
    ): Response<MyTransactionsResponseDto>

    // ── Loyalty (Phase 2 UI, data layer ready) ────────────────────────────────
    // ⚠️ SECURITY: backend does not verify caller owns this patientId. Use only
    // with EncryptedPrefsManager.getPatientId() — never accept patientId from user input.
    @GET("loyalty/{patientId}")
    suspend fun getLoyalty(
        @Path("patientId") patientId: Int,
    ): Response<LoyaltyResponseDto>

    // ── Gift Cards ────────────────────────────────────────────────────────────
    @GET("giftcards/storefront")
    suspend fun getGiftCardStorefront(): Response<GiftCardStorefrontResponseDto>

    @POST("giftcards/{id}/purchase/order")
    suspend fun initiateGiftCardPurchase(
        @Path("id") giftCardId: Int,
        @Body body: GiftCardOrderDto,
    ): Response<GiftCardOrderResponseDto>

    @POST("giftcards/{id}/purchase/confirm")
    suspend fun confirmGiftCardPurchase(
        @Path("id") giftCardId: Int,
        @Body body: GiftCardConfirmDto,
    ): Response<GiftCardConfirmResponseDto>

    // ── Doctors ───────────────────────────────────────────────────────────────
    @GET("doctors/availability")
    suspend fun getDoctorAvailability(
        @Query("date") date: String,
    ): Response<List<com.globus.crm.feature.booking.data.remote.dto.DoctorAvailabilityDto>>

    // ── Payments ─────────────────────────────────────────────────────────────
    @GET("/api/payments")
    suspend fun getPayments(): Response<List<PaymentDto>>

    @GET("/api/payments/config")
    suspend fun getPaymentConfig(): Response<PaymentConfigDto>

    @POST("/api/payments/{id}/refund")
    suspend fun refundPayment(
        @Path("id") paymentId: String,
    ): Response<PaymentDto>
}
