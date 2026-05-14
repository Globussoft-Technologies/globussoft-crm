package com.globussoft.wellness.feature.admin.domain.repository

import com.globussoft.wellness.core.common.result.WResult
import com.globussoft.wellness.core.domain.model.Location

/**
 * Contract for admin-panel data operations.
 *
 * ### Locations
 * Full CRUD for clinic branch locations.  Create / update accept a free-form
 * [Map<String, Any>] body so the call site can forward only the fields being
 * changed without needing a dedicated request DTO for each mutation.
 *
 * ### Drugs
 * Full CRUD for the drug / formulary catalogue used in prescriptions.  Same
 * map-body convention as locations.
 */
interface AdminRepository {

    // ── Locations ──────────────────────────────────────────────────────────────

    /** Returns all clinic locations for the tenant. */
    suspend fun getLocations(): WResult<List<Location>>

    /**
     * Creates a new location with the supplied [params].
     * Required keys: name, addressLine, city, state, pincode.
     */
    suspend fun createLocation(params: Map<String, Any>): WResult<Location>

    /**
     * Updates the location identified by [id] with the supplied [params].
     * Only the provided keys are overwritten on the server.
     */
    suspend fun updateLocation(id: String, params: Map<String, Any>): WResult<Location>

    /** Deletes the location identified by [id]. */
    suspend fun deleteLocation(id: String): WResult<Unit>

    // ── Drugs ──────────────────────────────────────────────────────────────────

    /** Returns all drugs in the tenant's formulary catalogue. */
    suspend fun getDrugs(): WResult<List<DrugItem>>

    /**
     * Creates a new drug entry.
     * Required keys: name. Optional: dosageForm, strength, unit, category,
     * sideEffects, contraindications.
     */
    suspend fun createDrug(params: Map<String, Any>): WResult<DrugItem>

    /**
     * Updates the drug identified by [id] with the supplied [params].
     */
    suspend fun updateDrug(id: String, params: Map<String, Any>): WResult<DrugItem>

    /** Deletes the drug identified by [id] from the formulary. */
    suspend fun deleteDrug(id: String): WResult<Unit>

    // ── Service Categories ─────────────────────────────────────────────────────

    suspend fun getServiceCategories(): WResult<List<ServiceCategoryItem>>
    suspend fun createServiceCategory(params: Map<String, Any>): WResult<ServiceCategoryItem>
    suspend fun updateServiceCategory(id: String, params: Map<String, Any>): WResult<ServiceCategoryItem>
    suspend fun deleteServiceCategory(id: String): WResult<Unit>

    // ── Holidays ───────────────────────────────────────────────────────────────

    suspend fun getHolidays(from: String, to: String): WResult<List<HolidayItem>>
    suspend fun createHoliday(params: Map<String, Any>): WResult<HolidayItem>
    suspend fun deleteHoliday(id: String): WResult<Unit>

    // ── Cashback Rules ─────────────────────────────────────────────────────────

    suspend fun getCashbackRules(): WResult<List<CashbackRuleItem>>
    suspend fun createCashbackRule(params: Map<String, Any>): WResult<CashbackRuleItem>
    suspend fun updateCashbackRule(id: String, params: Map<String, Any>): WResult<CashbackRuleItem>
    suspend fun deleteCashbackRule(id: String): WResult<Unit>

    // ── Vendors ────────────────────────────────────────────────────────────────

    suspend fun getVendors(): WResult<List<VendorItem>>
    suspend fun createVendor(params: Map<String, Any>): WResult<VendorItem>
    suspend fun updateVendor(id: String, params: Map<String, Any>): WResult<VendorItem>
    suspend fun deleteVendor(id: String): WResult<Unit>

    // ── Product Categories ─────────────────────────────────────────────────────

    suspend fun getProductCategories(): WResult<List<ProductCategoryItem>>
    suspend fun createProductCategory(params: Map<String, Any>): WResult<ProductCategoryItem>
    suspend fun updateProductCategory(id: String, params: Map<String, Any>): WResult<ProductCategoryItem>
    suspend fun deleteProductCategory(id: String): WResult<Unit>

    // ── Auto-consumption Rules ─────────────────────────────────────────────────

    suspend fun getAutoConsumptionRules(): WResult<List<AutoConsumptionRuleItem>>
    suspend fun createAutoConsumptionRule(params: Map<String, Any>): WResult<AutoConsumptionRuleItem>
    suspend fun updateAutoConsumptionRule(id: String, params: Map<String, Any>): WResult<AutoConsumptionRuleItem>
    suspend fun deleteAutoConsumptionRule(id: String): WResult<Unit>
    suspend fun getProducts(): WResult<List<ProductItem>>
    suspend fun getServicesForPicker(): WResult<List<ServiceItem>>

    // ── Audit Log ──────────────────────────────────────────────────────────────

    suspend fun getAuditLogs(page: Int = 1): WResult<AuditLogsPage>

    // ── Marketplace Leads ──────────────────────────────────────────────────────

    suspend fun getMarketplaceLeads(provider: String? = null, status: String? = null, page: Int = 1): WResult<MarketplaceLeadsPage>

    // ── Converted Leads ────────────────────────────────────────────────────────

    suspend fun getConvertedLeads(): WResult<List<ConvertedLeadItem>>

    // ── Privacy / Retention Policies ───────────────────────────────────────────

    suspend fun getRetentionPolicies(): WResult<List<RetentionPolicyItem>>
}

/**
 * A drug / formulary item in the wellness clinic's prescription catalogue.
 *
 * All fields other than [id] and [name] are optional — some clinics only
 * capture the name and form; strength / unit / side-effects are supplemental.
 */
data class DrugItem(
    val id: String,
    val name: String,
    val dosageForm: String?,
    val strength: String?,
    val unit: String?,
    val category: String?,
    val sideEffects: String?,
    val contraindications: String?,
)

data class ServiceCategoryItem(
    val id: String,
    val name: String,
    val parentId: String?,
    val parentName: String?,
    val displayOrder: Int,
    val isActive: Boolean,
    val serviceCount: Int,
)

data class HolidayItem(
    val id: String,
    val date: String,
    val name: String,
    val locationId: String?,
    val locationName: String?,
    val doctorId: String?,
    val doctorName: String?,
)

data class CashbackRuleItem(
    val id: String,
    val name: String,
    val earnPercent: Double,
    val minSpend: Double?,
    val isActive: Boolean,
)

data class VendorItem(
    val id: String,
    val name: String,
    val contactPerson: String?,
    val phone: String?,
    val email: String?,
    val gstin: String?,
)

data class ProductCategoryItem(
    val id: String,
    val name: String,
    val parentId: String?,
    val parentName: String?,
    val isActive: Boolean,
)

data class AutoConsumptionRuleItem(
    val id: String,
    val serviceId: String,
    val serviceName: String,
    val productId: String,
    val productName: String,
    val quantityPerVisit: Double,
    val isActive: Boolean,
)

data class ProductItem(
    val id: String,
    val name: String,
    val unit: String?,
)

data class ServiceItem(
    val id: String,
    val name: String,
)

data class AuditLogItem(
    val id: String,
    val action: String,
    val entity: String,
    val entityId: String?,
    val userName: String?,
    val userEmail: String?,
    val timestamp: String,
    val details: String?,
)

data class AuditLogsPage(
    val logs: List<AuditLogItem>,
    val pages: Int,
    val total: Int,
    val currentPage: Int,
)

data class MarketplaceLeadItem(
    val id: String,
    val name: String?,
    val email: String?,
    val phone: String?,
    val company: String?,
    val provider: String,
    val status: String,
    val createdAt: String,
)

data class MarketplaceLeadsPage(
    val leads: List<MarketplaceLeadItem>,
    val pages: Int,
    val total: Int,
    val currentPage: Int,
)

data class ConvertedLeadItem(
    val id: String,
    val name: String?,
    val email: String?,
    val phone: String?,
    val company: String?,
    val status: String?,
    val source: String?,
    val createdAt: String,
)

data class RetentionPolicyItem(
    val id: String,
    val entity: String,
    val label: String?,
    val retainDays: Int,
    val isActive: Boolean,
)
