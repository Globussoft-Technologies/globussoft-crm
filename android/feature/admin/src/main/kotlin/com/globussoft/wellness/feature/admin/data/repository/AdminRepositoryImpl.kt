package com.globussoft.wellness.feature.admin.data.repository

import com.globussoft.wellness.core.common.result.WResult
import com.globussoft.wellness.core.data.mapper.toDomain
import com.globussoft.wellness.core.domain.model.Location
import com.globussoft.wellness.core.network.api.WellnessApi
import com.globussoft.wellness.core.network.util.safeApiCall
import com.globussoft.wellness.feature.admin.domain.repository.AdminRepository
import com.globussoft.wellness.feature.admin.domain.repository.AutoConsumptionRuleItem
import com.globussoft.wellness.feature.admin.domain.repository.CashbackRuleItem
import com.globussoft.wellness.feature.admin.domain.repository.DrugItem
import com.globussoft.wellness.feature.admin.domain.repository.HolidayItem
import com.globussoft.wellness.feature.admin.domain.repository.ProductCategoryItem
import com.globussoft.wellness.feature.admin.domain.repository.ProductItem
import com.globussoft.wellness.feature.admin.domain.repository.ServiceItem
import com.globussoft.wellness.feature.admin.domain.repository.ServiceCategoryItem
import com.globussoft.wellness.feature.admin.domain.repository.VendorItem
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Production implementation of [AdminRepository].
 *
 * Location operations delegate to the existing wellness/locations endpoints
 * and use the shared [toDomain] mapper from [core:data].
 *
 * Drug operations delegate to the wellness/drugs endpoints added in the admin
 * feature wave.  The API responses are free-form JSON objects ([Map<String,Any>])
 * which are mapped to [DrugItem] by the private [toDrugItem] extension.
 */
@Singleton
class AdminRepositoryImpl @Inject constructor(
    private val api: WellnessApi,
) : AdminRepository {

    // ── Locations ──────────────────────────────────────────────────────────────

    override suspend fun getLocations(): WResult<List<Location>> =
        safeApiCall { api.getLocations() }
            .mapSuccess { list -> list.map { it.toDomain() } }

    override suspend fun createLocation(params: Map<String, Any>): WResult<Location> =
        safeApiCall { api.createLocation(params) }
            .mapSuccess { it.toDomain() }

    override suspend fun updateLocation(id: String, params: Map<String, Any>): WResult<Location> =
        safeApiCall { api.updateLocation(id, params) }
            .mapSuccess { it.toDomain() }

    override suspend fun deleteLocation(id: String): WResult<Unit> =
        safeApiCall { api.deleteLocation(id) }

    // ── Drugs ──────────────────────────────────────────────────────────────────

    @Suppress("UNCHECKED_CAST")
    override suspend fun getDrugs(): WResult<List<DrugItem>> =
        safeApiCall { api.getDrugs() }
            .mapSuccess { raw ->
                (raw as? List<*>)?.mapNotNull { item ->
                    (item as? Map<*, *>)?.let { m ->
                        @Suppress("UNCHECKED_CAST")
                        (m as Map<String, Any>).toDrugItem()
                    }
                } ?: emptyList()
            }

    @Suppress("UNCHECKED_CAST")
    override suspend fun createDrug(params: Map<String, Any>): WResult<DrugItem> =
        safeApiCall { api.createDrug(params) }
            .mapSuccess { raw ->
                @Suppress("UNCHECKED_CAST")
                (raw as Map<String, Any>).toDrugItem()
            }

    @Suppress("UNCHECKED_CAST")
    override suspend fun updateDrug(id: String, params: Map<String, Any>): WResult<DrugItem> =
        safeApiCall { api.updateDrug(id, params) }
            .mapSuccess { raw ->
                @Suppress("UNCHECKED_CAST")
                (raw as Map<String, Any>).toDrugItem()
            }

    override suspend fun deleteDrug(id: String): WResult<Unit> =
        safeApiCall { api.deleteDrug(id) }

    // ── Service Categories ─────────────────────────────────────────────────────

    override suspend fun getServiceCategories(): WResult<List<ServiceCategoryItem>> =
        safeApiCall { api.getServiceCategories() }
            .mapSuccess { list -> list.filterIsInstance<Map<*, *>>().map { it.toServiceCategory() } }

    override suspend fun createServiceCategory(params: Map<String, Any>): WResult<ServiceCategoryItem> =
        safeApiCall { api.createServiceCategory(params) }
            .mapSuccess { (it as Map<*, *>).toServiceCategory() }

    override suspend fun updateServiceCategory(id: String, params: Map<String, Any>): WResult<ServiceCategoryItem> =
        safeApiCall { api.updateServiceCategory(id, params) }
            .mapSuccess { (it as Map<*, *>).toServiceCategory() }

    override suspend fun deleteServiceCategory(id: String): WResult<Unit> =
        safeApiCall { api.deleteServiceCategory(id) }

    // ── Holidays ───────────────────────────────────────────────────────────────

    override suspend fun getHolidays(from: String, to: String): WResult<List<HolidayItem>> =
        safeApiCall { api.getHolidays(from, to) }
            .mapSuccess { list -> list.filterIsInstance<Map<*, *>>().map { it.toHoliday() } }

    override suspend fun createHoliday(params: Map<String, Any>): WResult<HolidayItem> =
        safeApiCall { api.createHoliday(params) }
            .mapSuccess { (it as Map<*, *>).toHoliday() }

    override suspend fun deleteHoliday(id: String): WResult<Unit> =
        safeApiCall { api.deleteHoliday(id) }

    // ── Cashback Rules ─────────────────────────────────────────────────────────

    override suspend fun getCashbackRules(): WResult<List<CashbackRuleItem>> =
        safeApiCall { api.getCashbackRules() }
            .mapSuccess { envelope ->
                @Suppress("UNCHECKED_CAST")
                val list = (envelope["rules"] ?: envelope["data"]) as? List<*> ?: emptyList<Any>()
                list.filterIsInstance<Map<*, *>>().map { it.toCashbackRule() }
            }

    override suspend fun createCashbackRule(params: Map<String, Any>): WResult<CashbackRuleItem> =
        safeApiCall { api.createCashbackRule(params) }
            .mapSuccess { (it as Map<*, *>).toCashbackRule() }

    override suspend fun updateCashbackRule(id: String, params: Map<String, Any>): WResult<CashbackRuleItem> =
        safeApiCall { api.updateCashbackRule(id, params) }
            .mapSuccess { (it as Map<*, *>).toCashbackRule() }

    override suspend fun deleteCashbackRule(id: String): WResult<Unit> =
        safeApiCall { api.deleteCashbackRule(id) }

    // ── Vendors ────────────────────────────────────────────────────────────────

    override suspend fun getVendors(): WResult<List<VendorItem>> =
        safeApiCall { api.getVendors() }
            .mapSuccess { list -> list.filterIsInstance<Map<*, *>>().map { it.toVendor() } }

    override suspend fun createVendor(params: Map<String, Any>): WResult<VendorItem> =
        safeApiCall { api.createVendor(params) }
            .mapSuccess { (it as Map<*, *>).toVendor() }

    override suspend fun updateVendor(id: String, params: Map<String, Any>): WResult<VendorItem> =
        safeApiCall { api.updateVendor(id, params) }
            .mapSuccess { (it as Map<*, *>).toVendor() }

    override suspend fun deleteVendor(id: String): WResult<Unit> =
        safeApiCall { api.deleteVendor(id) }

    // ── Product Categories ─────────────────────────────────────────────────────

    override suspend fun getProductCategories(): WResult<List<ProductCategoryItem>> =
        safeApiCall { api.getProductCategories() }
            .mapSuccess { list -> list.filterIsInstance<Map<*, *>>().map { it.toProductCategory() } }

    override suspend fun createProductCategory(params: Map<String, Any>): WResult<ProductCategoryItem> =
        safeApiCall { api.createProductCategory(params) }
            .mapSuccess { (it as Map<*, *>).toProductCategory() }

    override suspend fun updateProductCategory(id: String, params: Map<String, Any>): WResult<ProductCategoryItem> =
        safeApiCall { api.updateProductCategory(id, params) }
            .mapSuccess { (it as Map<*, *>).toProductCategory() }

    override suspend fun deleteProductCategory(id: String): WResult<Unit> =
        safeApiCall { api.deleteProductCategory(id) }

    // ── Auto-consumption Rules ─────────────────────────────────────────────────

    override suspend fun getAutoConsumptionRules(): WResult<List<AutoConsumptionRuleItem>> =
        safeApiCall { api.getAutoConsumptionRules() }
            .mapSuccess { list -> list.filterIsInstance<Map<*, *>>().map { it.toAutoConsumptionRule() } }

    override suspend fun createAutoConsumptionRule(params: Map<String, Any>): WResult<AutoConsumptionRuleItem> =
        safeApiCall { api.createAutoConsumptionRule(params) }
            .mapSuccess { (it as Map<*, *>).toAutoConsumptionRule() }

    override suspend fun updateAutoConsumptionRule(id: String, params: Map<String, Any>): WResult<AutoConsumptionRuleItem> =
        safeApiCall { api.updateAutoConsumptionRule(id, params) }
            .mapSuccess { (it as Map<*, *>).toAutoConsumptionRule() }

    override suspend fun deleteAutoConsumptionRule(id: String): WResult<Unit> =
        safeApiCall { api.deleteAutoConsumptionRule(id) }

    override suspend fun getProducts(): WResult<List<ProductItem>> =
        safeApiCall { api.getProducts() }
            .mapSuccess { list -> list.filterIsInstance<Map<*, *>>().map { it.toProduct() } }

    override suspend fun getServicesForPicker(): WResult<List<ServiceItem>> =
        safeApiCall { api.getServices() }
            .mapSuccess { list -> list.map { ServiceItem(it.id, it.name) } }

    // ── Mappers ────────────────────────────────────────────────────────────────

    private fun Map<String, Any>.toDrugItem() = DrugItem(
        id               = this["id"]?.toString() ?: "",
        name             = this["name"]?.toString() ?: "",
        dosageForm       = this["dosageForm"]?.toString(),
        strength         = this["strength"]?.toString(),
        unit             = this["unit"]?.toString(),
        category         = this["category"]?.toString(),
        sideEffects      = this["sideEffects"]?.toString(),
        contraindications = this["contraindications"]?.toString(),
    )

    private fun Map<*, *>.toServiceCategory() = ServiceCategoryItem(
        id           = this["id"]?.toString() ?: "",
        name         = this["name"]?.toString() ?: "",
        parentId     = this["parentId"]?.toString(),
        parentName   = this["parentName"]?.toString(),
        displayOrder = (this["displayOrder"] as? Number)?.toInt() ?: 0,
        isActive     = this["isActive"] as? Boolean ?: true,
        serviceCount = ((this["_count"] as? Map<*, *>)?.get("services") as? Number)?.toInt() ?: 0,
    )

    private fun Map<*, *>.toHoliday() = HolidayItem(
        id           = this["id"]?.toString() ?: "",
        date         = this["date"]?.toString() ?: "",
        name         = this["name"]?.toString() ?: "",
        locationId   = this["locationId"]?.toString(),
        locationName = (this["location"] as? Map<*, *>)?.get("name")?.toString()
                       ?: this["locationName"]?.toString(),
        doctorId     = this["doctorId"]?.toString(),
        doctorName   = (this["doctor"] as? Map<*, *>)?.get("name")?.toString()
                       ?: this["doctorName"]?.toString(),
    )

    private fun Map<*, *>.toCashbackRule() = CashbackRuleItem(
        id          = this["id"]?.toString() ?: "",
        name        = this["name"]?.toString() ?: "",
        earnPercent = (this["earnPercent"] as? Number)?.toDouble() ?: 0.0,
        minSpend    = (this["minSpend"] as? Number)?.toDouble(),
        isActive    = this["isActive"] as? Boolean ?: true,
    )

    private fun Map<*, *>.toVendor() = VendorItem(
        id            = this["id"]?.toString() ?: "",
        name          = this["name"]?.toString() ?: "",
        contactPerson = this["contactPerson"]?.toString(),
        phone         = this["phone"]?.toString(),
        email         = this["email"]?.toString(),
        gstin         = this["gstin"]?.toString(),
    )

    private fun Map<*, *>.toProductCategory() = ProductCategoryItem(
        id         = this["id"]?.toString() ?: "",
        name       = this["name"]?.toString() ?: "",
        parentId   = this["parentId"]?.toString(),
        parentName = this["parentName"]?.toString(),
        isActive   = this["isActive"] as? Boolean ?: true,
    )

    private fun Map<*, *>.toAutoConsumptionRule() = AutoConsumptionRuleItem(
        id               = this["id"]?.toString() ?: "",
        serviceId        = this["serviceId"]?.toString() ?: "",
        serviceName      = (this["service"] as? Map<*, *>)?.get("name")?.toString()
                           ?: this["serviceName"]?.toString() ?: "",
        productId        = this["productId"]?.toString() ?: "",
        productName      = (this["product"] as? Map<*, *>)?.get("name")?.toString()
                           ?: this["productName"]?.toString() ?: "",
        quantityPerVisit = (this["quantityPerVisit"] as? Number)?.toDouble() ?: 1.0,
        isActive         = this["isActive"] as? Boolean ?: true,
    )

    private fun Map<*, *>.toProduct() = ProductItem(
        id   = this["id"]?.toString() ?: "",
        name = this["name"]?.toString() ?: "",
        unit = this["unit"]?.toString(),
    )
}

// ─── Local mapping helper ─────────────────────────────────────────────────────

private inline fun <T, R> WResult<T>.mapSuccess(transform: (T) -> R): WResult<R> =
    when (this) {
        is WResult.Success -> WResult.Success(transform(data))
        is WResult.Error   -> this
        WResult.Loading    -> WResult.Loading
    }
