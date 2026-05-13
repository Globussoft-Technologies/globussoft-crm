package com.globussoft.wellness.core.network.api

import com.globussoft.wellness.core.network.model.ApiResponse
import com.globussoft.wellness.core.network.model.request.CreatePatientRequest
import com.globussoft.wellness.core.network.model.request.CreateVisitRequest
import com.globussoft.wellness.core.network.model.request.CreateWaitlistRequest
import com.globussoft.wellness.core.network.model.request.DispositionRequest
import com.globussoft.wellness.core.network.model.request.LoginRequest
import com.globussoft.wellness.core.network.model.response.DashboardResponse
import com.globussoft.wellness.core.network.model.response.LeadResponse
import com.globussoft.wellness.core.network.model.response.LocationResponse
import com.globussoft.wellness.core.network.model.response.LoginResponse
import com.globussoft.wellness.core.network.model.response.PaginatedResponse
import com.globussoft.wellness.core.network.model.response.PatientResponse
import com.globussoft.wellness.core.network.model.response.RecommendationResponse
import com.globussoft.wellness.core.network.model.response.ServiceResponse
import com.globussoft.wellness.core.network.model.response.StaffResponse
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

/**
 * Retrofit interface for all Globussoft Wellness CRM API endpoints consumed
 * by the Android app.
 *
 * All paths are relative to the base URL configured in [NetworkModule]
 * (e.g. "https://crm.globusdemos.com/api/").
 *
 * Every function is a suspend function returning [Response]<[ApiResponse]<T>>
 * so that [safeApiCall] can inspect both the HTTP status code and the
 * application-level [ApiResponse.success] flag before mapping to [WResult].
 */
interface WellnessApi {

    // -------------------------------------------------------------------------
    // Auth
    // -------------------------------------------------------------------------

    @POST("auth/login")
    suspend fun login(
        @Body req: LoginRequest,
    ): Response<ApiResponse<LoginResponse>>

    // -------------------------------------------------------------------------
    // Dashboard
    // -------------------------------------------------------------------------

    @GET("wellness/dashboard")
    suspend fun getDashboard(
        @Query("locationId") locationId: String? = null,
    ): Response<ApiResponse<DashboardResponse>>

    @GET("wellness/recommendations")
    suspend fun getRecommendations(
        @Query("status") status: String? = null,
    ): Response<ApiResponse<List<RecommendationResponse>>>

    @POST("wellness/recommendations/{id}/approve")
    suspend fun approveRecommendation(
        @Path("id") id: String,
    ): Response<ApiResponse<RecommendationResponse>>

    @POST("wellness/recommendations/{id}/reject")
    suspend fun rejectRecommendation(
        @Path("id") id: String,
    ): Response<ApiResponse<RecommendationResponse>>

    @POST("wellness/orchestrator/run")
    suspend fun runOrchestrator(): Response<ApiResponse<Unit>>

    // -------------------------------------------------------------------------
    // Patients
    // -------------------------------------------------------------------------

    @GET("wellness/patients")
    suspend fun getPatients(
        @Query("search") search: String? = null,
        @Query("skip") skip: Int = 0,
        @Query("limit") limit: Int = 20,
    ): Response<ApiResponse<PaginatedResponse<PatientResponse>>>

    @GET("wellness/patients/{id}")
    suspend fun getPatient(
        @Path("id") id: String,
    ): Response<ApiResponse<PatientResponse>>

    @POST("wellness/patients")
    suspend fun createPatient(
        @Body req: CreatePatientRequest,
    ): Response<ApiResponse<PatientResponse>>

    @PUT("wellness/patients/{id}")
    suspend fun updatePatient(
        @Path("id") id: String,
        @Body req: CreatePatientRequest,
    ): Response<ApiResponse<PatientResponse>>

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
    ): Response<ApiResponse<PaginatedResponse<VisitResponse>>>

    @POST("wellness/visits")
    suspend fun createVisit(
        @Body req: CreateVisitRequest,
    ): Response<ApiResponse<VisitResponse>>

    @PATCH("wellness/visits/{id}/status")
    suspend fun updateVisitStatus(
        @Path("id") id: String,
        @Body body: Map<String, String>,
    ): Response<ApiResponse<VisitResponse>>

    // -------------------------------------------------------------------------
    // Staff
    // -------------------------------------------------------------------------

    @GET("wellness/staff")
    suspend fun getStaff(
        @Query("wellnessRole") wellnessRole: String? = null,
    ): Response<ApiResponse<List<StaffResponse>>>

    // -------------------------------------------------------------------------
    // Services
    // -------------------------------------------------------------------------

    @GET("wellness/services")
    suspend fun getServices(): Response<ApiResponse<List<ServiceResponse>>>

    @POST("wellness/services")
    suspend fun createService(
        @Body body: Map<String, @JvmSuppressWildcards Any>,
    ): Response<ApiResponse<ServiceResponse>>

    @PUT("wellness/services/{id}")
    suspend fun updateService(
        @Path("id") id: String,
        @Body body: Map<String, @JvmSuppressWildcards Any>,
    ): Response<ApiResponse<ServiceResponse>>

    @DELETE("wellness/services/{id}")
    suspend fun deleteService(
        @Path("id") id: String,
    ): Response<ApiResponse<Unit>>

    // -------------------------------------------------------------------------
    // Waitlist
    // -------------------------------------------------------------------------

    @GET("wellness/waitlist")
    suspend fun getWaitlist(
        @Query("status") status: String? = null,
    ): Response<ApiResponse<List<WaitlistEntryResponse>>>

    @POST("wellness/waitlist")
    suspend fun createWaitlistEntry(
        @Body req: CreateWaitlistRequest,
    ): Response<ApiResponse<WaitlistEntryResponse>>

    @PATCH("wellness/waitlist/{id}")
    suspend fun updateWaitlistEntry(
        @Path("id") id: String,
        @Body body: Map<String, String>,
    ): Response<ApiResponse<WaitlistEntryResponse>>

    // -------------------------------------------------------------------------
    // Locations
    // -------------------------------------------------------------------------

    @GET("wellness/locations")
    suspend fun getLocations(): Response<ApiResponse<List<LocationResponse>>>

    @POST("wellness/locations")
    suspend fun createLocation(
        @Body body: Map<String, @JvmSuppressWildcards Any>,
    ): Response<ApiResponse<LocationResponse>>

    @PUT("wellness/locations/{id}")
    suspend fun updateLocation(
        @Path("id") id: String,
        @Body body: Map<String, @JvmSuppressWildcards Any>,
    ): Response<ApiResponse<LocationResponse>>

    @DELETE("wellness/locations/{id}")
    suspend fun deleteLocation(
        @Path("id") id: String,
    ): Response<ApiResponse<Unit>>

    // -------------------------------------------------------------------------
    // Reports
    // -------------------------------------------------------------------------

    @GET("wellness/reports/pnl-by-service")
    suspend fun getPnlByService(
        @Query("from") from: String,
        @Query("to") to: String,
    ): Response<ApiResponse<List<Map<String, @JvmSuppressWildcards Any>>>>

    @GET("wellness/reports/per-professional")
    suspend fun getPerProfessional(
        @Query("from") from: String,
        @Query("to") to: String,
    ): Response<ApiResponse<List<Map<String, @JvmSuppressWildcards Any>>>>

    @GET("wellness/reports/per-location")
    suspend fun getPerLocation(
        @Query("from") from: String,
        @Query("to") to: String,
    ): Response<ApiResponse<List<Map<String, @JvmSuppressWildcards Any>>>>

    @GET("wellness/reports/attribution")
    suspend fun getAttribution(
        @Query("from") from: String,
        @Query("to") to: String,
    ): Response<ApiResponse<List<Map<String, @JvmSuppressWildcards Any>>>>

    // -------------------------------------------------------------------------
    // Telecaller Queue
    // -------------------------------------------------------------------------

    @GET("wellness/telecaller/queue")
    suspend fun getTelecallerQueue(): Response<ApiResponse<List<LeadResponse>>>

    @POST("wellness/telecaller/dispose/{leadId}")
    suspend fun disposeLead(
        @Path("leadId") leadId: String,
        @Body req: DispositionRequest,
    ): Response<ApiResponse<Unit>>

    // -------------------------------------------------------------------------
    // Pending Recommendations (alias for getRecommendations with status filter)
    // -------------------------------------------------------------------------

    @GET("wellness/recommendations")
    suspend fun getPendingRecommendations(): Response<ApiResponse<List<RecommendationResponse>>>

    // -------------------------------------------------------------------------
    // POS  (feature/finance)
    // POST wellness/pos/shift/open  — open a register shift
    // POST wellness/pos/shift/close — close the current shift
    // POST wellness/pos/sale        — submit a completed sale
    // -------------------------------------------------------------------------

    @POST("wellness/pos/shift/open")
    suspend fun openShift(
        @Body body: Map<String, @JvmSuppressWildcards Any>,
    ): Response<ApiResponse<Unit>>

    @POST("wellness/pos/shift/close")
    suspend fun closeShift(
        @Body body: Map<String, @JvmSuppressWildcards Any>,
    ): Response<ApiResponse<Unit>>

    @POST("wellness/pos/sale")
    suspend fun submitPosSale(
        @Body body: Map<String, @JvmSuppressWildcards Any>,
    ): Response<ApiResponse<Map<String, @JvmSuppressWildcards Any>>>

    // -------------------------------------------------------------------------
    // Wallet  (feature/finance)
    // GET wellness/wallet/{patientId} — balance + transaction ledger
    // -------------------------------------------------------------------------

    @GET("wellness/wallet/{patientId}")
    suspend fun getWallet(
        @Path("patientId") patientId: String,
    ): Response<ApiResponse<Map<String, @JvmSuppressWildcards Any>>>

    // -------------------------------------------------------------------------
    // Gift Cards  (feature/finance)
    // GET  wellness/gift-cards          — list (optional ?status= filter)
    // POST wellness/gift-cards          — issue a new gift card
    // -------------------------------------------------------------------------

    @GET("wellness/gift-cards")
    suspend fun getGiftCards(
        @Query("status") status: String? = null,
    ): Response<ApiResponse<List<@JvmSuppressWildcards Any>>>

    @POST("wellness/gift-cards")
    suspend fun issueGiftCard(
        @Body body: Map<String, @JvmSuppressWildcards Any>,
    ): Response<ApiResponse<@JvmSuppressWildcards Any>>

    // -------------------------------------------------------------------------
    // Coupons  (feature/finance)
    // GET    wellness/coupons           — list all coupons
    // POST   wellness/coupons           — create a coupon
    // PUT    wellness/coupons/{id}      — update a coupon
    // DELETE wellness/coupons/{id}      — delete a coupon
    // POST   wellness/coupons/preview   — preview discount math
    // -------------------------------------------------------------------------

    @GET("wellness/coupons")
    suspend fun getCoupons(): Response<ApiResponse<List<@JvmSuppressWildcards Any>>>

    @POST("wellness/coupons")
    suspend fun createCoupon(
        @Body body: Map<String, @JvmSuppressWildcards Any>,
    ): Response<ApiResponse<@JvmSuppressWildcards Any>>

    @PUT("wellness/coupons/{id}")
    suspend fun updateCoupon(
        @Path("id") id: String,
        @Body body: Map<String, @JvmSuppressWildcards Any>,
    ): Response<ApiResponse<@JvmSuppressWildcards Any>>

    @DELETE("wellness/coupons/{id}")
    suspend fun deleteCoupon(
        @Path("id") id: String,
    ): Response<ApiResponse<Unit>>

    @POST("wellness/coupons/preview")
    suspend fun previewCoupon(
        @Body body: Map<String, @JvmSuppressWildcards Any>,
    ): Response<ApiResponse<@JvmSuppressWildcards Any>>

    // -------------------------------------------------------------------------
    // Attendance  (feature/visits)
    // GET  wellness/attendance/today      — today's punch-in / out state
    // POST wellness/attendance/punch-in   — record a punch-in
    // POST wellness/attendance/punch-out  — record a punch-out
    // GET  wellness/attendance/history    — 30-day history for the current user
    // GET  wellness/attendance/all-today  — all staff today (MANAGER+)
    // -------------------------------------------------------------------------

    @GET("wellness/attendance/today")
    suspend fun getAttendanceToday(): Response<ApiResponse<Map<String, @JvmSuppressWildcards Any>>>

    @POST("wellness/attendance/punch-in")
    suspend fun punchIn(): Response<ApiResponse<@JvmSuppressWildcards Any>>

    @POST("wellness/attendance/punch-out")
    suspend fun punchOut(): Response<ApiResponse<@JvmSuppressWildcards Any>>

    @GET("wellness/attendance/history")
    suspend fun getAttendanceHistory(
        @Query("days") days: Int = 30,
    ): Response<ApiResponse<List<@JvmSuppressWildcards Any>>>

    @GET("wellness/attendance/all-today")
    suspend fun getAllStaffAttendanceToday(): Response<ApiResponse<List<@JvmSuppressWildcards Any>>>

    // -------------------------------------------------------------------------
    // Leave  (feature/visits)
    // GET  wellness/leave                  — list leave requests (?myOnly=true|false)
    // POST wellness/leave                  — create a leave request
    // POST wellness/leave/{id}/approve     — approve a leave request (MANAGER+)
    // POST wellness/leave/{id}/reject      — reject a leave request (MANAGER+)
    // -------------------------------------------------------------------------

    @GET("wellness/leave")
    suspend fun getLeaveRequests(
        @Query("myOnly") myOnly: Boolean = true,
    ): Response<ApiResponse<List<@JvmSuppressWildcards Any>>>

    @POST("wellness/leave")
    suspend fun createLeaveRequest(
        @Body body: Map<String, @JvmSuppressWildcards Any>,
    ): Response<ApiResponse<@JvmSuppressWildcards Any>>

    @POST("wellness/leave/{id}/approve")
    suspend fun approveLeaveRequest(
        @Path("id") id: String,
    ): Response<ApiResponse<@JvmSuppressWildcards Any>>

    @POST("wellness/leave/{id}/reject")
    suspend fun rejectLeaveRequest(
        @Path("id") id: String,
    ): Response<ApiResponse<@JvmSuppressWildcards Any>>

    // -------------------------------------------------------------------------
    // Drugs / Formulary  (feature/admin)
    // GET    wellness/drugs           — list all drugs in the catalogue
    // POST   wellness/drugs           — create a new drug entry
    // PUT    wellness/drugs/{id}      — update a drug entry
    // DELETE wellness/drugs/{id}      — remove a drug from the catalogue
    // -------------------------------------------------------------------------

    @GET("wellness/drugs")
    suspend fun getDrugs(): Response<ApiResponse<List<@JvmSuppressWildcards Any>>>

    @POST("wellness/drugs")
    suspend fun createDrug(
        @Body body: Map<String, @JvmSuppressWildcards Any>,
    ): Response<ApiResponse<@JvmSuppressWildcards Any>>

    @PUT("wellness/drugs/{id}")
    suspend fun updateDrug(
        @Path("id") id: String,
        @Body body: Map<String, @JvmSuppressWildcards Any>,
    ): Response<ApiResponse<@JvmSuppressWildcards Any>>

    @DELETE("wellness/drugs/{id}")
    suspend fun deleteDrug(
        @Path("id") id: String,
    ): Response<ApiResponse<Unit>>
}
