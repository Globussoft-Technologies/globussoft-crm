package com.globussoft.wellness.core.network.api

import com.globussoft.wellness.core.network.model.request.CreatePatientRequest
import com.globussoft.wellness.core.network.model.request.CreateVisitRequest
import com.globussoft.wellness.core.network.model.request.CreateWaitlistRequest
import com.globussoft.wellness.core.network.model.request.DispositionRequest
import com.globussoft.wellness.core.network.model.request.LoginRequest
import com.globussoft.wellness.core.network.model.response.DashboardResponse
import com.globussoft.wellness.core.network.model.response.LocationResponse
import com.globussoft.wellness.core.network.model.response.LoginResponse
import com.globussoft.wellness.core.network.model.response.PatientsPageResponse
import com.globussoft.wellness.core.network.model.response.PatientResponse
import com.globussoft.wellness.core.network.model.response.RecommendationResponse
import com.globussoft.wellness.core.network.model.response.ServiceResponse
import com.globussoft.wellness.core.network.model.response.StaffResponse
import com.globussoft.wellness.core.network.model.response.TelecallerQueueResponse
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
    suspend fun getLeaveRequests(): Response<@JvmSuppressWildcards Any>

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
    // GET wellness/prescriptions/{id}/pdf — download prescription as a PDF stream
    // -------------------------------------------------------------------------

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
    // Holidays  (feature/schedule)
    // GET wellness/holidays — list clinic holidays within a date range
    // -------------------------------------------------------------------------

    @GET("wellness/holidays")
    suspend fun getHolidays(
        @Query("from") from: String,
        @Query("to") to: String,
    ): Response<List<@JvmSuppressWildcards Any>>
}
