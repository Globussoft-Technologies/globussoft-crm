package com.globussoft.wellness.core.network.api

import com.globussoft.wellness.core.network.model.request.CreateContactRequest
import com.globussoft.wellness.core.network.model.request.CreateCrmTaskRequest
import com.globussoft.wellness.core.network.model.request.CreateDealRequest
import com.globussoft.wellness.core.network.model.request.CreateEstimateRequest
import com.globussoft.wellness.core.network.model.request.CreateExpenseRequest
import com.globussoft.wellness.core.network.model.request.CreateInvoiceRequest
import com.globussoft.wellness.core.network.model.request.CreatePatientRequest
import com.globussoft.wellness.core.network.model.request.CreateTicketRequest
import com.globussoft.wellness.core.network.model.request.CreateVisitRequest
import com.globussoft.wellness.core.network.model.request.CreateWaitlistRequest
import com.globussoft.wellness.core.network.model.request.DispositionRequest
import com.globussoft.wellness.core.network.model.request.LoginRequest
import com.globussoft.wellness.core.network.model.response.ApprovalResponse
import com.globussoft.wellness.core.network.model.response.CampaignResponse
import com.globussoft.wellness.core.network.model.response.ContactResponse
import com.globussoft.wellness.core.network.model.response.CrmTaskResponse
import com.globussoft.wellness.core.network.model.response.DashboardResponse
import com.globussoft.wellness.core.network.model.response.DealInsightResponse
import com.globussoft.wellness.core.network.model.response.DealResponse
import com.globussoft.wellness.core.network.model.response.DealStatsResponse
import com.globussoft.wellness.core.network.model.response.EstimateResponse
import com.globussoft.wellness.core.network.model.response.ExpenseResponse
import com.globussoft.wellness.core.network.model.response.ForecastResponse
import com.globussoft.wellness.core.network.model.response.InvoiceResponse
import com.globussoft.wellness.core.network.model.response.LocationResponse
import com.globussoft.wellness.core.network.model.response.LoginResponse
import com.globussoft.wellness.core.network.model.response.PatientsPageResponse
import com.globussoft.wellness.core.network.model.response.PatientResponse
import com.globussoft.wellness.core.network.model.response.PipelineResponse
import com.globussoft.wellness.core.network.model.response.RecommendationResponse
import com.globussoft.wellness.core.network.model.response.ServiceResponse
import com.globussoft.wellness.core.network.model.response.StaffResponse
import com.globussoft.wellness.core.network.model.response.TelecallerQueueResponse
import com.globussoft.wellness.core.network.model.response.PaymentResponse
import com.globussoft.wellness.core.network.model.response.TicketResponse
import com.globussoft.wellness.core.network.model.response.VisitResponse
import com.globussoft.wellness.core.network.model.response.WaitlistEntryResponse
import retrofit2.Response
import retrofit2.http.Body
import retrofit2.http.DELETE
import retrofit2.http.GET
import retrofit2.http.PATCH
import retrofit2.http.POST
import retrofit2.http.PUT
import retrofit2.http.Path
import retrofit2.http.Query
import retrofit2.http.Streaming

/**
 * Retrofit interface for all Globussoft Wellness CRM API endpoints consumed
 * by the Android app.
 *
 * All paths are relative to the base URL configured in [NetworkModule]
 * (e.g. "https://crm.globusdemos.com/api/").
 *
 * Every function is a suspend function returning [Response]<T> directly —
 * the server returns data without an ApiResponse wrapper. [safeApiCall]
 * inspects the HTTP status code and maps the result to [WResult].
 */
interface WellnessApi {

    // -------------------------------------------------------------------------
    // Auth
    // -------------------------------------------------------------------------

    @POST("auth/login")
    suspend fun login(
        @Body req: LoginRequest,
    ): Response<LoginResponse>

    // -------------------------------------------------------------------------
    // Dashboard
    // -------------------------------------------------------------------------

    @GET("wellness/dashboard")
    suspend fun getDashboard(
        @Query("locationId") locationId: String? = null,
    ): Response<DashboardResponse>

    @GET("wellness/recommendations")
    suspend fun getRecommendations(
        @Query("status") status: String? = null,
    ): Response<List<RecommendationResponse>>

    @POST("wellness/recommendations/{id}/approve")
    suspend fun approveRecommendation(
        @Path("id") id: String,
    ): Response<RecommendationResponse>

    @POST("wellness/recommendations/{id}/reject")
    suspend fun rejectRecommendation(
        @Path("id") id: String,
    ): Response<RecommendationResponse>

    @POST("wellness/orchestrator/run")
    suspend fun runOrchestrator(): Response<Unit>

    // -------------------------------------------------------------------------
    // Patients
    // -------------------------------------------------------------------------

    @GET("wellness/patients")
    suspend fun getPatients(
        @Query("search") search: String? = null,
        @Query("skip") skip: Int = 0,
        @Query("limit") limit: Int = 20,
    ): Response<PatientsPageResponse>

    @GET("wellness/patients/{id}")
    suspend fun getPatient(
        @Path("id") id: String,
    ): Response<PatientResponse>

    @POST("wellness/patients")
    suspend fun createPatient(
        @Body req: CreatePatientRequest,
    ): Response<PatientResponse>

    @PUT("wellness/patients/{id}")
    suspend fun updatePatient(
        @Path("id") id: String,
        @Body req: CreatePatientRequest,
    ): Response<PatientResponse>

    // -------------------------------------------------------------------------
    // Visits / Calendar
    // -------------------------------------------------------------------------

    @GET("wellness/visits")
    suspend fun getVisits(
        @Query("date") date: String? = null,
        @Query("locationId") locationId: String? = null,
        @Query("from") from: String? = null,
        @Query("to") to: String? = null,
        @Query("skip") skip: Int = 0,
        @Query("limit") limit: Int = 50,
    ): Response<List<VisitResponse>>

    @POST("wellness/visits")
    suspend fun createVisit(
        @Body req: CreateVisitRequest,
    ): Response<VisitResponse>

    @PATCH("wellness/visits/{id}/status")
    suspend fun updateVisitStatus(
        @Path("id") id: String,
        @Body body: Map<String, String>,
    ): Response<VisitResponse>

    // -------------------------------------------------------------------------
    // Staff
    // -------------------------------------------------------------------------

    @GET("wellness/staff")
    suspend fun getStaff(
        @Query("wellnessRole") wellnessRole: String? = null,
    ): Response<List<StaffResponse>>

    // -------------------------------------------------------------------------
    // Services
    // -------------------------------------------------------------------------

    @GET("wellness/services")
    suspend fun getServices(): Response<List<ServiceResponse>>

    @POST("wellness/services")
    suspend fun createService(
        @Body body: Map<String, @JvmSuppressWildcards Any>,
    ): Response<ServiceResponse>

    @PUT("wellness/services/{id}")
    suspend fun updateService(
        @Path("id") id: String,
        @Body body: Map<String, @JvmSuppressWildcards Any>,
    ): Response<ServiceResponse>

    @DELETE("wellness/services/{id}")
    suspend fun deleteService(
        @Path("id") id: String,
    ): Response<Unit>

    // -------------------------------------------------------------------------
    // Waitlist
    // -------------------------------------------------------------------------

    @GET("wellness/waitlist")
    suspend fun getWaitlist(
        @Query("status") status: String? = null,
    ): Response<List<WaitlistEntryResponse>>

    @POST("wellness/waitlist")
    suspend fun createWaitlistEntry(
        @Body req: CreateWaitlistRequest,
    ): Response<WaitlistEntryResponse>

    @PATCH("wellness/waitlist/{id}")
    suspend fun updateWaitlistEntry(
        @Path("id") id: String,
        @Body body: Map<String, String>,
    ): Response<WaitlistEntryResponse>

    // -------------------------------------------------------------------------
    // Locations
    // -------------------------------------------------------------------------

    @GET("wellness/locations")
    suspend fun getLocations(): Response<List<LocationResponse>>

    @POST("wellness/locations")
    suspend fun createLocation(
        @Body body: Map<String, @JvmSuppressWildcards Any>,
    ): Response<LocationResponse>

    @PUT("wellness/locations/{id}")
    suspend fun updateLocation(
        @Path("id") id: String,
        @Body body: Map<String, @JvmSuppressWildcards Any>,
    ): Response<LocationResponse>

    @DELETE("wellness/locations/{id}")
    suspend fun deleteLocation(
        @Path("id") id: String,
    ): Response<Unit>

    // -------------------------------------------------------------------------
    // Reports
    // -------------------------------------------------------------------------

    @GET("wellness/reports/pnl-by-service")
    suspend fun getPnlByService(
        @Query("from") from: String,
        @Query("to") to: String,
    ): Response<Map<String, @JvmSuppressWildcards Any>>

    @GET("wellness/reports/per-professional")
    suspend fun getPerProfessional(
        @Query("from") from: String,
        @Query("to") to: String,
    ): Response<Map<String, @JvmSuppressWildcards Any>>

    @GET("wellness/reports/per-location")
    suspend fun getPerLocation(
        @Query("from") from: String,
        @Query("to") to: String,
    ): Response<Map<String, @JvmSuppressWildcards Any>>

    @GET("wellness/reports/attribution")
    suspend fun getAttribution(
        @Query("from") from: String,
        @Query("to") to: String,
    ): Response<Map<String, @JvmSuppressWildcards Any>>

    // -------------------------------------------------------------------------
    // Telecaller Queue
    // -------------------------------------------------------------------------

    @GET("wellness/telecaller/queue")
    suspend fun getTelecallerQueue(): Response<TelecallerQueueResponse>

    @POST("wellness/telecaller/dispose/{leadId}")
    suspend fun disposeLead(
        @Path("leadId") leadId: String,
        @Body req: DispositionRequest,
    ): Response<Unit>

    // -------------------------------------------------------------------------
    // Pending Recommendations (alias for getRecommendations with status filter)
    // -------------------------------------------------------------------------

    @GET("wellness/recommendations")
    suspend fun getPendingRecommendations(): Response<List<RecommendationResponse>>

    // -------------------------------------------------------------------------
    // POS  (feature/finance)
    // POST wellness/pos/shift/open  — open a register shift
    // POST wellness/pos/shift/close — close the current shift
    // POST wellness/pos/sale        — submit a completed sale
    // -------------------------------------------------------------------------

    @GET("pos/registers")
    suspend fun getPosRegisters(): Response<List<@JvmSuppressWildcards Any>>

    @GET("pos/shifts/current")
    suspend fun getCurrentShift(): Response<Map<String, @JvmSuppressWildcards Any>>

    @POST("pos/shifts/open")
    suspend fun openShift(
        @Body body: Map<String, @JvmSuppressWildcards Any>,
    ): Response<Map<String, @JvmSuppressWildcards Any>>

    @POST("pos/shifts/{shiftId}/close")
    suspend fun closeShift(
        @Path("shiftId") shiftId: Int,
        @Body body: Map<String, @JvmSuppressWildcards Any>,
    ): Response<Map<String, @JvmSuppressWildcards Any>>

    @POST("pos/sales")
    suspend fun submitPosSale(
        @Body body: Map<String, @JvmSuppressWildcards Any>,
    ): Response<Map<String, @JvmSuppressWildcards Any>>

    // -------------------------------------------------------------------------
    // Wallet  (feature/finance)
    // GET wellness/wallet/{patientId} — balance + transaction ledger
    // -------------------------------------------------------------------------

    @GET("wellness/patients/{patientId}/wallet")
    suspend fun getWallet(
        @Path("patientId") patientId: String,
    ): Response<Map<String, @JvmSuppressWildcards Any>>

    // -------------------------------------------------------------------------
    // Gift Cards  (feature/finance)
    // GET  wellness/gift-cards          — list (optional ?status= filter)
    // POST wellness/gift-cards          — issue a new gift card
    // -------------------------------------------------------------------------

    @GET("wellness/giftcards")
    suspend fun getGiftCards(
        @Query("status") status: String? = null,
    ): Response<Map<String, @JvmSuppressWildcards Any>>

    @POST("wellness/giftcards")
    suspend fun issueGiftCard(
        @Body body: Map<String, @JvmSuppressWildcards Any>,
    ): Response<@JvmSuppressWildcards Any>

    // -------------------------------------------------------------------------
    // Coupons  (feature/finance)
    // GET    wellness/coupons           — list all coupons
    // POST   wellness/coupons           — create a coupon
    // PUT    wellness/coupons/{id}      — update a coupon
    // DELETE wellness/coupons/{id}      — delete a coupon
    // POST   wellness/coupons/preview   — preview discount math
    // -------------------------------------------------------------------------

    @GET("wellness/coupons")
    suspend fun getCoupons(): Response<Map<String, @JvmSuppressWildcards Any>>

    @POST("wellness/coupons")
    suspend fun createCoupon(
        @Body body: Map<String, @JvmSuppressWildcards Any>,
    ): Response<@JvmSuppressWildcards Any>

    @PUT("wellness/coupons/{id}")
    suspend fun updateCoupon(
        @Path("id") id: String,
        @Body body: Map<String, @JvmSuppressWildcards Any>,
    ): Response<@JvmSuppressWildcards Any>

    @DELETE("wellness/coupons/{id}")
    suspend fun deleteCoupon(
        @Path("id") id: String,
    ): Response<Unit>

    @POST("wellness/coupons/preview")
    suspend fun previewCoupon(
        @Body body: Map<String, @JvmSuppressWildcards Any>,
    ): Response<@JvmSuppressWildcards Any>

    // -------------------------------------------------------------------------
    // Attendance  (feature/visits)
    // GET  wellness/attendance/today      — today's punch-in / out state
    // POST wellness/attendance/punch-in   — record a punch-in
    // POST wellness/attendance/punch-out  — record a punch-out
    // GET  wellness/attendance/history    — 30-day history for the current user
    // GET  wellness/attendance/all-today  — all staff today (MANAGER+)
    // -------------------------------------------------------------------------

    @GET("attendance/me")
    suspend fun getAttendanceToday(): Response<List<@JvmSuppressWildcards Any>>

    @POST("attendance/clock-in")
    suspend fun punchIn(): Response<@JvmSuppressWildcards Any>

    @POST("attendance/clock-out")
    suspend fun punchOut(): Response<@JvmSuppressWildcards Any>

    @GET("attendance/me")
    suspend fun getAttendanceHistory(
        @Query("from") from: String? = null,
    ): Response<List<@JvmSuppressWildcards Any>>

    @GET("attendance/summary")
    suspend fun getAllStaffAttendanceToday(
        @Query("from") from: String? = null,
        @Query("to") to: String? = null,
    ): Response<@JvmSuppressWildcards Any>

    // -------------------------------------------------------------------------
    // Leave  (feature/visits)
    // GET  wellness/leave                  — list leave requests (?myOnly=true|false)
    // POST wellness/leave                  — create a leave request
    // POST wellness/leave/{id}/approve     — approve a leave request (MANAGER+)
    // POST wellness/leave/{id}/reject      — reject a leave request (MANAGER+)
    // -------------------------------------------------------------------------

    @GET("leave/requests")
    suspend fun getLeaveRequests(
        @Query("myOnly") myOnly: Boolean? = null,
    ): Response<@JvmSuppressWildcards Any>

    @GET("leave/balances/me")
    suspend fun getLeaveBalances(): Response<@JvmSuppressWildcards Any>

    @GET("leave/policies")
    suspend fun getLeavePolicies(): Response<@JvmSuppressWildcards Any>

    @POST("leave/requests")
    suspend fun createLeaveRequest(
        @Body body: Map<String, @JvmSuppressWildcards Any>,
    ): Response<@JvmSuppressWildcards Any>

    @POST("leave/requests/{id}/approve")
    suspend fun approveLeaveRequest(
        @Path("id") id: String,
    ): Response<@JvmSuppressWildcards Any>

    @POST("leave/requests/{id}/reject")
    suspend fun rejectLeaveRequest(
        @Path("id") id: String,
    ): Response<@JvmSuppressWildcards Any>

    // -------------------------------------------------------------------------
    // Treatment Plans  (feature/services)
    // GET wellness/activetreatment        — list active treatment plans
    // PUT wellness/treatment-plans/{id}   — update a treatment plan (pause/resume/cancel)
    // -------------------------------------------------------------------------

    @GET("wellness/activetreatment")
    suspend fun getActiveTreatments(): Response<List<@JvmSuppressWildcards Any>>

    @PUT("wellness/treatment-plans/{id}")
    suspend fun updateTreatmentPlan(
        @Path("id") id: String,
        @Body body: Map<String, @JvmSuppressWildcards Any>,
    ): Response<@JvmSuppressWildcards Any>

    // -------------------------------------------------------------------------
    // Drugs / Formulary  (feature/admin)
    // GET    wellness/drugs           — list all drugs in the catalogue
    // POST   wellness/drugs           — create a new drug entry
    // PUT    wellness/drugs/{id}      — update a drug entry
    // DELETE wellness/drugs/{id}      — remove a drug from the catalogue
    // -------------------------------------------------------------------------

    @GET("wellness/drugs")
    suspend fun getDrugs(): Response<List<@JvmSuppressWildcards Any>>

    @POST("wellness/drugs")
    suspend fun createDrug(
        @Body body: Map<String, @JvmSuppressWildcards Any>,
    ): Response<@JvmSuppressWildcards Any>

    @PUT("wellness/drugs/{id}")
    suspend fun updateDrug(
        @Path("id") id: String,
        @Body body: Map<String, @JvmSuppressWildcards Any>,
    ): Response<@JvmSuppressWildcards Any>

    @DELETE("wellness/drugs/{id}")
    suspend fun deleteDrug(
        @Path("id") id: String,
    ): Response<Unit>

    // -------------------------------------------------------------------------
    // Prescriptions  (feature/patients)
    // GET wellness/patients/{id}/prescriptions — list Rx for a patient
    // POST wellness/prescriptions              — create a new prescription
    // GET wellness/prescriptions/{id}/pdf      — download as PDF stream
    // -------------------------------------------------------------------------

    @GET("wellness/patients/{id}/prescriptions")
    suspend fun getPatientPrescriptions(
        @Path("id") patientId: String,
    ): Response<List<@JvmSuppressWildcards Any>>

    @POST("wellness/prescriptions")
    suspend fun createPrescription(
        @Body body: Map<String, @JvmSuppressWildcards Any>,
    ): Response<@JvmSuppressWildcards Any>

    // -------------------------------------------------------------------------
    // Treatment Plans  (feature/patients)
    // GET wellness/patients/{id}/treatment-plans — list plans for a patient
    // POST wellness/treatment-plans              — create a new plan
    // -------------------------------------------------------------------------

    @GET("wellness/patients/{id}/treatment-plans")
    suspend fun getPatientTreatmentPlans(
        @Path("id") patientId: String,
    ): Response<List<@JvmSuppressWildcards Any>>

    @POST("wellness/treatment-plans")
    suspend fun createTreatmentPlan(
        @Body body: Map<String, @JvmSuppressWildcards Any>,
    ): Response<@JvmSuppressWildcards Any>

    @GET("wellness/prescriptions/{id}/pdf")
    @Streaming
    suspend fun getPrescriptionPdf(
        @Path("id") id: String,
    ): Response<okhttp3.ResponseBody>

    // -------------------------------------------------------------------------
    // Gift Cards — Redeem  (feature/finance)
    // POST wellness/giftcards/redeem — redeem a gift card code to a patient wallet
    // -------------------------------------------------------------------------

    @POST("wellness/giftcards/redeem")
    suspend fun redeemGiftCard(
        @Body body: Map<String, @JvmSuppressWildcards Any>,
    ): Response<Map<String, @JvmSuppressWildcards Any>>

    // -------------------------------------------------------------------------
    // Resources  (feature/schedule)
    // GET wellness/resources — list treatment rooms / equipment
    // -------------------------------------------------------------------------

    @GET("wellness/resources")
    suspend fun getResources(
        @Query("activeOnly") activeOnly: Int = 1,
    ): Response<List<@JvmSuppressWildcards Any>>

    // -------------------------------------------------------------------------
    // Holidays  (admin)
    // GET    wellness/holidays          — list within date range
    // POST   wellness/holidays          — create a holiday
    // DELETE wellness/holidays/{id}     — remove a holiday
    // -------------------------------------------------------------------------

    @GET("wellness/holidays")
    suspend fun getHolidays(
        @Query("from") from: String,
        @Query("to") to: String,
    ): Response<List<@JvmSuppressWildcards Any>>

    @POST("wellness/holidays")
    suspend fun createHoliday(
        @Body body: Map<String, @JvmSuppressWildcards Any>,
    ): Response<@JvmSuppressWildcards Any>

    @DELETE("wellness/holidays/{id}")
    suspend fun deleteHoliday(
        @Path("id") id: String,
    ): Response<Unit>

    // -------------------------------------------------------------------------
    // Service Categories  (admin)
    // GET    wellness/service-categories
    // POST   wellness/service-categories
    // PUT    wellness/service-categories/{id}
    // DELETE wellness/service-categories/{id}
    // -------------------------------------------------------------------------

    @GET("wellness/service-categories")
    suspend fun getServiceCategories(): Response<List<@JvmSuppressWildcards Any>>

    @POST("wellness/service-categories")
    suspend fun createServiceCategory(
        @Body body: Map<String, @JvmSuppressWildcards Any>,
    ): Response<@JvmSuppressWildcards Any>

    @PUT("wellness/service-categories/{id}")
    suspend fun updateServiceCategory(
        @Path("id") id: String,
        @Body body: Map<String, @JvmSuppressWildcards Any>,
    ): Response<@JvmSuppressWildcards Any>

    @DELETE("wellness/service-categories/{id}")
    suspend fun deleteServiceCategory(
        @Path("id") id: String,
    ): Response<Unit>

    // -------------------------------------------------------------------------
    // Cashback Rules  (finance/admin)
    // GET    wellness/cashback-rules
    // POST   wellness/cashback-rules
    // PUT    wellness/cashback-rules/{id}
    // DELETE wellness/cashback-rules/{id}
    // -------------------------------------------------------------------------

    @GET("wellness/cashback-rules")
    suspend fun getCashbackRules(): Response<Map<String, @JvmSuppressWildcards Any>>

    @POST("wellness/cashback-rules")
    suspend fun createCashbackRule(
        @Body body: Map<String, @JvmSuppressWildcards Any>,
    ): Response<@JvmSuppressWildcards Any>

    @PUT("wellness/cashback-rules/{id}")
    suspend fun updateCashbackRule(
        @Path("id") id: String,
        @Body body: Map<String, @JvmSuppressWildcards Any>,
    ): Response<@JvmSuppressWildcards Any>

    @DELETE("wellness/cashback-rules/{id}")
    suspend fun deleteCashbackRule(
        @Path("id") id: String,
    ): Response<Unit>

    // -------------------------------------------------------------------------
    // Vendors  (inventory/admin)
    // GET    wellness/vendors
    // POST   wellness/vendors
    // PUT    wellness/vendors/{id}
    // DELETE wellness/vendors/{id}
    // -------------------------------------------------------------------------

    @GET("wellness/vendors")
    suspend fun getVendors(): Response<List<@JvmSuppressWildcards Any>>

    @POST("wellness/vendors")
    suspend fun createVendor(
        @Body body: Map<String, @JvmSuppressWildcards Any>,
    ): Response<@JvmSuppressWildcards Any>

    @PUT("wellness/vendors/{id}")
    suspend fun updateVendor(
        @Path("id") id: String,
        @Body body: Map<String, @JvmSuppressWildcards Any>,
    ): Response<@JvmSuppressWildcards Any>

    @DELETE("wellness/vendors/{id}")
    suspend fun deleteVendor(
        @Path("id") id: String,
    ): Response<Unit>

    // -------------------------------------------------------------------------
    // Product Categories  (inventory/admin)
    // GET    wellness/product-categories
    // POST   wellness/product-categories
    // PUT    wellness/product-categories/{id}
    // DELETE wellness/product-categories/{id}
    // -------------------------------------------------------------------------

    @GET("wellness/product-categories")
    suspend fun getProductCategories(): Response<List<@JvmSuppressWildcards Any>>

    @POST("wellness/product-categories")
    suspend fun createProductCategory(
        @Body body: Map<String, @JvmSuppressWildcards Any>,
    ): Response<@JvmSuppressWildcards Any>

    @PUT("wellness/product-categories/{id}")
    suspend fun updateProductCategory(
        @Path("id") id: String,
        @Body body: Map<String, @JvmSuppressWildcards Any>,
    ): Response<@JvmSuppressWildcards Any>

    @DELETE("wellness/product-categories/{id}")
    suspend fun deleteProductCategory(
        @Path("id") id: String,
    ): Response<Unit>

    // -------------------------------------------------------------------------
    // Auto-consumption Rules  (inventory/admin)
    // GET    wellness/auto-consumption-rules
    // POST   wellness/auto-consumption-rules
    // PUT    wellness/auto-consumption-rules/{id}
    // DELETE wellness/auto-consumption-rules/{id}
    // GET    wellness/products  — product list for rule picker
    // -------------------------------------------------------------------------

    @GET("wellness/auto-consumption-rules")
    suspend fun getAutoConsumptionRules(): Response<List<@JvmSuppressWildcards Any>>

    @POST("wellness/auto-consumption-rules")
    suspend fun createAutoConsumptionRule(
        @Body body: Map<String, @JvmSuppressWildcards Any>,
    ): Response<@JvmSuppressWildcards Any>

    @PUT("wellness/auto-consumption-rules/{id}")
    suspend fun updateAutoConsumptionRule(
        @Path("id") id: String,
        @Body body: Map<String, @JvmSuppressWildcards Any>,
    ): Response<@JvmSuppressWildcards Any>

    @DELETE("wellness/auto-consumption-rules/{id}")
    suspend fun deleteAutoConsumptionRule(
        @Path("id") id: String,
    ): Response<Unit>

    @GET("wellness/products")
    suspend fun getProducts(): Response<List<@JvmSuppressWildcards Any>>

    // -------------------------------------------------------------------------
    // Audit Log  (admin / read-only)
    // GET audit-viewer?page=X&limit=25 → { logs:[], pages, total }
    // -------------------------------------------------------------------------

    @GET("audit-viewer")
    suspend fun getAuditLogs(
        @Query("page")  page:  Int = 1,
        @Query("limit") limit: Int = 25,
    ): Response<Map<String, @JvmSuppressWildcards Any>>

    // -------------------------------------------------------------------------
    // Payments  (finance / read-only)
    // GET payments → { payments:[] }
    // -------------------------------------------------------------------------

    @GET("payments")
    suspend fun getPayments(): Response<List<PaymentResponse>>

    // -------------------------------------------------------------------------
    // Marketplace Leads  (admin / read-only)
    // GET marketplace-leads?provider=X&status=Y&page=Z&limit=50 → { leads:[], pages, stats }
    // -------------------------------------------------------------------------

    @GET("marketplace-leads")
    suspend fun getMarketplaceLeads(
        @Query("provider") provider: String? = null,
        @Query("status")   status:   String? = null,
        @Query("page")     page:     Int     = 1,
        @Query("limit")    limit:    Int     = 50,
    ): Response<Map<String, @JvmSuppressWildcards Any>>

    // -------------------------------------------------------------------------
    // Contacts  (used for Converted Leads list)
    // GET contacts?status=Converted → array of contact objects
    // -------------------------------------------------------------------------

    @GET("contacts")
    suspend fun getContacts(
        @Query("status") status: String? = null,
        @Query("limit")  limit:  Int     = 100,
    ): Response<List<@JvmSuppressWildcards Any>>

    // -------------------------------------------------------------------------
    // GDPR / Privacy  (admin / read-only)
    // GET gdpr/retention-policies → array of { entity, label, retainDays, isActive }
    // -------------------------------------------------------------------------

    @GET("gdpr/retention-policies")
    suspend fun getRetentionPolicies(): Response<List<@JvmSuppressWildcards Any>>

    // -------------------------------------------------------------------------
    // Inventory Receipts  (admin / read-only list)
    // GET wellness/inventory/receipts?from=&to=&limit=100
    // -------------------------------------------------------------------------

    @GET("wellness/inventory/receipts")
    suspend fun getInventoryReceipts(
        @Query("from")   from:  String? = null,
        @Query("to")     to:    String? = null,
        @Query("limit")  limit: Int     = 100,
    ): Response<List<@JvmSuppressWildcards Any>>

    // -------------------------------------------------------------------------
    // Inventory Adjustments  (admin / read-only list)
    // GET wellness/inventory/adjustments?from=&to=&limit=100
    // -------------------------------------------------------------------------

    @GET("wellness/inventory/adjustments")
    suspend fun getInventoryAdjustments(
        @Query("from")   from:  String? = null,
        @Query("to")     to:    String? = null,
        @Query("limit")  limit: Int     = 100,
    ): Response<List<@JvmSuppressWildcards Any>>

    // -------------------------------------------------------------------------
    // Revenue Goals  (admin / read-only list)
    // GET staff/revenue-goals
    // -------------------------------------------------------------------------

    @GET("staff/revenue-goals")
    suspend fun getRevenueGoals(): Response<List<@JvmSuppressWildcards Any>>

    // -------------------------------------------------------------------------
    // Commission Profiles  (admin / read-only list)
    // GET staff/commission-profiles
    // -------------------------------------------------------------------------

    @GET("staff/commission-profiles")
    suspend fun getCommissionProfiles(): Response<List<@JvmSuppressWildcards Any>>

    // -------------------------------------------------------------------------
    // Working Hours  (admin / read+edit)
    // GET wellness/working-hours?doctorId=X
    // -------------------------------------------------------------------------

    @GET("wellness/working-hours")
    suspend fun getWorkingHours(
        @Query("doctorId") doctorId: String? = null,
    ): Response<List<@JvmSuppressWildcards Any>>

    // -------------------------------------------------------------------------
    // Membership Plans  (admin / read-only list)
    // GET wellness/membership-plans?includeInactive=1
    // -------------------------------------------------------------------------

    @GET("wellness/membership-plans")
    suspend fun getMembershipPlans(
        @Query("includeInactive") includeInactive: Int = 1,
    ): Response<List<@JvmSuppressWildcards Any>>

    // -------------------------------------------------------------------------
    // All Leads / Contacts  (Wave 3)
    // GET contacts?search=&status=&limit=50&page=1
    // GET contacts/{id}
    // -------------------------------------------------------------------------

    @GET("contacts")
    suspend fun getLeads(
        @Query("search") search: String?  = null,
        @Query("status") status: String?  = null,
        @Query("limit")  limit:  Int      = 50,
        @Query("page")   page:   Int      = 1,
    ): Response<List<@JvmSuppressWildcards Any>>

    @GET("contacts/{id}")
    suspend fun getLeadDetail(
        @Path("id") id: String,
    ): Response<Map<String, @JvmSuppressWildcards Any>>

    // -------------------------------------------------------------------------
    // Tasks  (Wave 3)
    // GET tasks?status=&page=1&limit=50
    // -------------------------------------------------------------------------

    @GET("tasks")
    suspend fun getTasks(
        @Query("status") status: String? = null,
        @Query("page")   page:   Int     = 1,
        @Query("limit")  limit:  Int     = 50,
    ): Response<List<@JvmSuppressWildcards Any>>

    // -------------------------------------------------------------------------
    // Lead Routing Rules  (Wave 3)
    // GET lead-routing
    // -------------------------------------------------------------------------

    @GET("lead-routing")
    suspend fun getLeadRoutingRules(): Response<List<@JvmSuppressWildcards Any>>

    // -------------------------------------------------------------------------
    // Invoices  (Wave 4) — GET billing
    // -------------------------------------------------------------------------

    @GET("billing")
    suspend fun getInvoices(
        @Query("status") status: String? = null,
        @Query("limit")  limit:  Int     = 50,
        @Query("page")   page:   Int     = 1,
    ): Response<List<@JvmSuppressWildcards Any>>

    // -------------------------------------------------------------------------
    // Estimates  (Wave 4) — GET estimates
    // -------------------------------------------------------------------------

    @GET("estimates")
    suspend fun getEstimates(
        @Query("status") status: String? = null,
        @Query("limit")  limit:  Int     = 50,
    ): Response<List<@JvmSuppressWildcards Any>>

    // -------------------------------------------------------------------------
    // Expenses  (Wave 4) — GET expenses
    // -------------------------------------------------------------------------

    @GET("expenses")
    suspend fun getExpenses(
        @Query("limit") limit: Int = 50,
    ): Response<List<@JvmSuppressWildcards Any>>

    // -------------------------------------------------------------------------
    // Staff Management  (Wave 4) — GET staff
    // -------------------------------------------------------------------------

    @GET("staff")
    suspend fun getAllStaff(
        @Query("limit") limit: Int = 100,
    ): Response<List<@JvmSuppressWildcards Any>>

    // -------------------------------------------------------------------------
    // WhatsApp Messages  (Wave 5)
    // GET whatsapp/messages?limit=50&page=1
    // -------------------------------------------------------------------------

    @GET("whatsapp/messages")
    suspend fun getWhatsAppMessages(
        @Query("limit") limit: Int = 50,
        @Query("page")  page:  Int = 1,
    ): Response<Map<String, @JvmSuppressWildcards Any>>

    // -------------------------------------------------------------------------
    // Notifications / Inbox  (Wave 5)
    // GET notifications?limit=50&page=1
    // -------------------------------------------------------------------------

    @GET("notifications")
    suspend fun getNotifications(
        @Query("limit") limit: Int = 50,
        @Query("page")  page:  Int = 1,
    ): Response<Map<String, @JvmSuppressWildcards Any>>

    // -------------------------------------------------------------------------
    // Sequences  (Wave 5)
    // GET sequences?limit=50
    // -------------------------------------------------------------------------

    @GET("sequences")
    suspend fun getSequences(
        @Query("limit") limit: Int = 50,
    ): Response<List<@JvmSuppressWildcards Any>>

    // -------------------------------------------------------------------------
    // Landing Pages  (Wave 5)
    // GET landing-pages?limit=50
    // -------------------------------------------------------------------------

    @GET("landing-pages")
    suspend fun getLandingPages(
        @Query("limit") limit: Int = 50,
    ): Response<List<@JvmSuppressWildcards Any>>

    // -------------------------------------------------------------------------
    // Surveys  (Wave 5)
    // GET surveys?limit=50
    // -------------------------------------------------------------------------

    @GET("surveys")
    suspend fun getSurveys(
        @Query("limit") limit: Int = 50,
    ): Response<List<@JvmSuppressWildcards Any>>

    // -------------------------------------------------------------------------
    // Integrations / Channels  (Wave 5)
    // GET integrations?limit=100
    // -------------------------------------------------------------------------

    @GET("integrations")
    suspend fun getIntegrations(
        @Query("limit") limit: Int = 100,
    ): Response<List<@JvmSuppressWildcards Any>>

    // ── Marketing campaigns  (Wave 6) ─────────────────────────────────────────
    @GET("marketing/campaigns")
    suspend fun getCampaigns(
        @Query("channel") channel: String? = null,
        @Query("limit")   limit:   Int     = 100,
    ): Response<List<@JvmSuppressWildcards Any>>

    // ── Loyalty  (Wave 6) ─────────────────────────────────────────────────────
    @GET("wellness/loyalty/leaderboard/month")
    suspend fun getLoyaltyLeaderboard(): Response<List<@JvmSuppressWildcards Any>>

    @GET("wellness/referrals")
    suspend fun getReferrals(
        @Query("limit") limit: Int = 100,
    ): Response<Map<String, @JvmSuppressWildcards Any>>

    // ── Knowledge Base  (Wave 6) ──────────────────────────────────────────────
    @GET("knowledge-base/articles")
    suspend fun getKbArticles(
        @Query("limit") limit: Int = 100,
    ): Response<List<@JvmSuppressWildcards Any>>

    @GET("knowledge-base/categories")
    suspend fun getKbCategories(): Response<List<@JvmSuppressWildcards Any>>

    // =========================================================================
    // Generic CRM endpoints — typed responses for feature modules
    // =========================================================================

    // ── Contacts ─────────────────────────────────────────────────────────────

    @GET("contacts")
    suspend fun getCrmContacts(
        @Query("status") status: String? = null,
        @Query("search") search: String? = null,
        @Query("skip") skip: Int = 0,
        @Query("limit") limit: Int = 20,
    ): Response<List<ContactResponse>>

    @GET("contacts/{id}")
    suspend fun getCrmContact(
        @Path("id") id: String,
    ): Response<ContactResponse>

    @POST("contacts")
    suspend fun createCrmContact(
        @Body body: CreateContactRequest,
    ): Response<ContactResponse>

    @PUT("contacts/{id}")
    suspend fun updateCrmContact(
        @Path("id") id: String,
        @Body body: CreateContactRequest,
    ): Response<ContactResponse>

    @DELETE("contacts/{id}")
    suspend fun deleteCrmContact(
        @Path("id") id: String,
    ): Response<Unit>

    // ── Deals ─────────────────────────────────────────────────────────────────

    @GET("deals")
    suspend fun getCrmDeals(
        @Query("stage") stage: String? = null,
        @Query("status") status: String? = null,
        @Query("search") search: String? = null,
        @Query("skip") skip: Int = 0,
        @Query("limit") limit: Int = 20,
    ): Response<List<DealResponse>>

    @GET("deals/stats")
    suspend fun getCrmDealStats(): Response<DealStatsResponse>

    @GET("deals/{id}")
    suspend fun getCrmDeal(
        @Path("id") id: String,
    ): Response<DealResponse>

    @POST("deals")
    suspend fun createCrmDeal(
        @Body body: CreateDealRequest,
    ): Response<DealResponse>

    @PUT("deals/{id}")
    suspend fun updateCrmDeal(
        @Path("id") id: String,
        @Body body: CreateDealRequest,
    ): Response<DealResponse>

    // ── Pipelines ─────────────────────────────────────────────────────────────

    @GET("pipelines")
    suspend fun getCrmPipelines(): Response<List<PipelineResponse>>

    @GET("pipelines/{id}")
    suspend fun getCrmPipeline(
        @Path("id") id: String,
    ): Response<PipelineResponse>

    // ── Tickets ───────────────────────────────────────────────────────────────

    @GET("tickets")
    suspend fun getCrmTickets(
        @Query("status") status: String? = null,
        @Query("priority") priority: String? = null,
        @Query("skip") skip: Int = 0,
        @Query("limit") limit: Int = 20,
    ): Response<List<TicketResponse>>

    @GET("tickets/{id}")
    suspend fun getCrmTicket(
        @Path("id") id: String,
    ): Response<TicketResponse>

    @POST("tickets")
    suspend fun createCrmTicket(
        @Body body: CreateTicketRequest,
    ): Response<TicketResponse>

    @PUT("tickets/{id}")
    suspend fun updateCrmTicket(
        @Path("id") id: String,
        @Body body: Map<String, @JvmSuppressWildcards Any>,
    ): Response<TicketResponse>

    // ── CRM Tasks ─────────────────────────────────────────────────────────────

    @GET("tasks")
    suspend fun getCrmTasks(
        @Query("status") status: String? = null,
        @Query("skip") skip: Int = 0,
        @Query("limit") limit: Int = 20,
    ): Response<List<CrmTaskResponse>>

    @POST("tasks")
    suspend fun createCrmTask(
        @Body body: CreateCrmTaskRequest,
    ): Response<CrmTaskResponse>

    @PATCH("tasks/{id}/complete")
    suspend fun completeCrmTask(
        @Path("id") id: String,
    ): Response<CrmTaskResponse>

    // ── Invoices ──────────────────────────────────────────────────────────────

    @GET("billing")
    suspend fun getCrmInvoices(
        @Query("status") status: String? = null,
        @Query("skip") skip: Int = 0,
        @Query("limit") limit: Int = 20,
    ): Response<List<InvoiceResponse>>

    @GET("billing/{id}")
    suspend fun getCrmInvoice(
        @Path("id") id: String,
    ): Response<InvoiceResponse>

    @POST("billing")
    suspend fun createCrmInvoice(
        @Body body: CreateInvoiceRequest,
    ): Response<InvoiceResponse>

    @PUT("billing/{id}/send")
    suspend fun sendCrmInvoice(
        @Path("id") id: String,
    ): Response<InvoiceResponse>

    @PUT("billing/{id}/pay")
    suspend fun markCrmInvoicePaid(
        @Path("id") id: String,
    ): Response<InvoiceResponse>

    @GET("billing/{id}/pdf")
    @Streaming
    suspend fun getCrmInvoicePdf(
        @Path("id") id: String,
    ): Response<okhttp3.ResponseBody>

    // ── Estimates ─────────────────────────────────────────────────────────────

    @GET("estimates")
    suspend fun getCrmEstimates(
        @Query("status") status: String? = null,
        @Query("skip") skip: Int = 0,
        @Query("limit") limit: Int = 20,
    ): Response<List<EstimateResponse>>

    @GET("estimates/{id}")
    suspend fun getCrmEstimate(
        @Path("id") id: String,
    ): Response<EstimateResponse>

    @POST("estimates")
    suspend fun createCrmEstimate(
        @Body body: CreateEstimateRequest,
    ): Response<EstimateResponse>

    @PUT("estimates/{id}")
    suspend fun updateCrmEstimate(
        @Path("id") id: String,
        @Body body: CreateEstimateRequest,
    ): Response<EstimateResponse>

    // ── Expenses ──────────────────────────────────────────────────────────────

    @GET("expenses")
    suspend fun getCrmExpenses(
        @Query("category") category: String? = null,
        @Query("skip") skip: Int = 0,
        @Query("limit") limit: Int = 20,
    ): Response<List<ExpenseResponse>>

    @POST("expenses")
    suspend fun createCrmExpense(
        @Body body: CreateExpenseRequest,
    ): Response<ExpenseResponse>

    @PATCH("expenses/{id}/approve")
    suspend fun approveCrmExpense(
        @Path("id") id: String,
    ): Response<ExpenseResponse>

    @PATCH("expenses/{id}/reject")
    suspend fun rejectCrmExpense(
        @Path("id") id: String,
    ): Response<ExpenseResponse>

    // ── Forecasting ───────────────────────────────────────────────────────────

    @GET("forecasting")
    suspend fun getCrmForecasting(): Response<List<ForecastResponse>>

    // ── Deal Insights ─────────────────────────────────────────────────────────

    @GET("deal-insights")
    suspend fun getCrmDealInsights(): Response<List<DealInsightResponse>>

    // ── Approvals ─────────────────────────────────────────────────────────────

    @GET("approvals")
    suspend fun getCrmApprovals(
        @Query("status") status: String? = null,
        @Query("mine") mine: Boolean? = null,
    ): Response<List<ApprovalResponse>>

    @POST("approvals/{id}/approve")
    suspend fun approveCrmApproval(
        @Path("id") id: String,
        @Body body: Map<String, @JvmSuppressWildcards Any>,
    ): Response<ApprovalResponse>

    @POST("approvals/{id}/reject")
    suspend fun rejectCrmApproval(
        @Path("id") id: String,
        @Body body: Map<String, @JvmSuppressWildcards Any>,
    ): Response<ApprovalResponse>

    // ── Marketing Campaigns ───────────────────────────────────────────────────

    @GET("marketing/campaigns")
    suspend fun getCrmCampaigns(
        @Query("channel") channel: String? = null,
        @Query("status") status: String? = null,
        @Query("skip") skip: Int = 0,
        @Query("limit") limit: Int = 20,
    ): Response<List<CampaignResponse>>

    @POST("marketing/campaigns")
    suspend fun createCrmCampaign(
        @Body body: Map<String, @JvmSuppressWildcards Any>,
    ): Response<CampaignResponse>

    @PATCH("marketing/campaigns/{id}")
    suspend fun sendCrmCampaign(
        @Path("id") id: String,
        @Body body: Map<String, @JvmSuppressWildcards Any>,
    ): Response<CampaignResponse>

    // ── Sequences ─────────────────────────────────────────────────────────────

    @GET("sequences")
    suspend fun getCrmSequences(
        @Query("skip") skip: Int = 0,
        @Query("limit") limit: Int = 20,
    ): Response<List<@JvmSuppressWildcards Any>>

    @GET("sequences/{id}")
    suspend fun getCrmSequence(
        @Path("id") id: String,
    ): Response<Map<String, @JvmSuppressWildcards Any>>

    @PATCH("sequences/{id}")
    suspend fun updateCrmSequence(
        @Path("id") id: String,
        @Body body: Map<String, @JvmSuppressWildcards Any>,
    ): Response<Map<String, @JvmSuppressWildcards Any>>

    // ── Reports ───────────────────────────────────────────────────────────────

    @GET("reports")
    suspend fun getCrmReports(
        @Query("from") from: String? = null,
        @Query("to") to: String? = null,
    ): Response<Map<String, @JvmSuppressWildcards Any>>

    @GET("reports/agent-performance")
    suspend fun getCrmAgentPerformance(
        @Query("from") from: String? = null,
        @Query("to") to: String? = null,
    ): Response<List<@JvmSuppressWildcards Any>>

    // ── Quotas ────────────────────────────────────────────────────────────────

    @GET("quotas")
    suspend fun getCrmQuotas(): Response<List<@JvmSuppressWildcards Any>>

    @POST("quotas")
    suspend fun createCrmQuota(
        @Body body: Map<String, @JvmSuppressWildcards Any>,
    ): Response<@JvmSuppressWildcards Any>

    // ── Win / Loss ────────────────────────────────────────────────────────────

    @GET("win-loss")
    suspend fun getCrmWinLoss(
        @Query("from") from: String? = null,
        @Query("to") to: String? = null,
    ): Response<Map<String, @JvmSuppressWildcards Any>>

    @GET("funnel")
    suspend fun getCrmFunnel(): Response<Map<String, @JvmSuppressWildcards Any>>

    // ── Territories ───────────────────────────────────────────────────────────

    @GET("territories")
    suspend fun getCrmTerritories(): Response<List<@JvmSuppressWildcards Any>>

    @POST("territories")
    suspend fun createCrmTerritory(
        @Body body: Map<String, @JvmSuppressWildcards Any>,
    ): Response<@JvmSuppressWildcards Any>

    // ── Lead Routing ──────────────────────────────────────────────────────────

    @GET("lead-routing")
    suspend fun getCrmLeadRoutingRules(): Response<List<@JvmSuppressWildcards Any>>

    @POST("lead-routing")
    suspend fun createCrmLeadRoutingRule(
        @Body body: Map<String, @JvmSuppressWildcards Any>,
    ): Response<@JvmSuppressWildcards Any>

    // ── Staff (CRM admin) ─────────────────────────────────────────────────────

    @GET("staff")
    suspend fun getCrmStaff(
        @Query("skip") skip: Int = 0,
        @Query("limit") limit: Int = 100,
    ): Response<List<@JvmSuppressWildcards Any>>

    @POST("staff")
    suspend fun createCrmStaff(
        @Body body: Map<String, @JvmSuppressWildcards Any>,
    ): Response<@JvmSuppressWildcards Any>

    @PUT("staff/{id}")
    suspend fun updateCrmStaff(
        @Path("id") id: String,
        @Body body: Map<String, @JvmSuppressWildcards Any>,
    ): Response<@JvmSuppressWildcards Any>

    // ── Settings ──────────────────────────────────────────────────────────────

    @GET("settings")
    suspend fun getCrmSettings(): Response<Map<String, @JvmSuppressWildcards Any>>

    @PUT("settings")
    suspend fun updateCrmSettings(
        @Body body: Map<String, @JvmSuppressWildcards Any>,
    ): Response<Map<String, @JvmSuppressWildcards Any>>

    // ── Channels (SMS / WhatsApp / Telephony / Push) ──────────────────────────

    @GET("channels")
    suspend fun getCrmChannels(): Response<Map<String, @JvmSuppressWildcards Any>>

    @PUT("channels")
    suspend fun updateCrmChannels(
        @Body body: Map<String, @JvmSuppressWildcards Any>,
    ): Response<Map<String, @JvmSuppressWildcards Any>>

    // ── Knowledge Base ────────────────────────────────────────────────────────

    @GET("knowledge-base/articles")
    suspend fun getCrmKbArticles(
        @Query("categoryId") categoryId: String? = null,
        @Query("search") search: String? = null,
        @Query("limit") limit: Int = 50,
    ): Response<List<@JvmSuppressWildcards Any>>

    @POST("knowledge-base/articles")
    suspend fun createCrmKbArticle(
        @Body body: Map<String, @JvmSuppressWildcards Any>,
    ): Response<@JvmSuppressWildcards Any>

    @PUT("knowledge-base/articles/{id}")
    suspend fun updateCrmKbArticle(
        @Path("id") id: String,
        @Body body: Map<String, @JvmSuppressWildcards Any>,
    ): Response<@JvmSuppressWildcards Any>

    // ── Contracts ─────────────────────────────────────────────────────────────

    @GET("contracts")
    suspend fun getCrmContracts(
        @Query("status") status: String? = null,
    ): Response<List<@JvmSuppressWildcards Any>>

    @POST("contracts")
    suspend fun createCrmContract(
        @Body body: Map<String, @JvmSuppressWildcards Any>,
    ): Response<@JvmSuppressWildcards Any>

    // ── Projects ──────────────────────────────────────────────────────────────

    @GET("projects")
    suspend fun getCrmProjects(
        @Query("status") status: String? = null,
    ): Response<List<@JvmSuppressWildcards Any>>

    @POST("projects")
    suspend fun createCrmProject(
        @Body body: Map<String, @JvmSuppressWildcards Any>,
    ): Response<@JvmSuppressWildcards Any>

    // ── Surveys (CRM) ─────────────────────────────────────────────────────────

    @GET("surveys")
    suspend fun getCrmSurveys(
        @Query("limit") limit: Int = 50,
    ): Response<List<@JvmSuppressWildcards Any>>

    // ── Audit Log (CRM admin) ─────────────────────────────────────────────────

    @GET("audit-viewer")
    suspend fun getCrmAuditLogs(
        @Query("entityType") entityType: String? = null,
        @Query("action") action: String? = null,
        @Query("page") page: Int = 1,
        @Query("limit") limit: Int = 25,
    ): Response<Map<String, @JvmSuppressWildcards Any>>
}
