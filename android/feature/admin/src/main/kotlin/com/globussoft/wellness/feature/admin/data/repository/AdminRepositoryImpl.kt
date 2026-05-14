package com.globussoft.wellness.feature.admin.data.repository

import com.globussoft.wellness.core.common.result.WResult
import com.globussoft.wellness.core.data.mapper.toDomain
import com.globussoft.wellness.core.domain.model.Location
import com.globussoft.wellness.core.network.api.WellnessApi
import com.globussoft.wellness.core.network.util.safeApiCall
import com.globussoft.wellness.feature.admin.domain.repository.AdminRepository
import com.globussoft.wellness.feature.admin.domain.repository.AuditLogItem
import com.globussoft.wellness.feature.admin.domain.repository.AuditLogsPage
import com.globussoft.wellness.feature.admin.domain.repository.CommissionProfileItem
import com.globussoft.wellness.feature.admin.domain.repository.InventoryAdjustmentItem
import com.globussoft.wellness.feature.admin.domain.repository.InventoryReceiptItem
import com.globussoft.wellness.feature.admin.domain.repository.LeadDetailItem
import com.globussoft.wellness.feature.admin.domain.repository.LeadItem
import com.globussoft.wellness.feature.admin.domain.repository.LeadsPage
import com.globussoft.wellness.feature.admin.domain.repository.MembershipPlanItem
import com.globussoft.wellness.feature.admin.domain.repository.RevenueGoalItem
import com.globussoft.wellness.feature.admin.domain.repository.IntegrationItem
import com.globussoft.wellness.feature.admin.domain.repository.LandingPageItem
import com.globussoft.wellness.feature.admin.domain.repository.NotificationItem
import com.globussoft.wellness.feature.admin.domain.repository.RoutingRuleItem
import com.globussoft.wellness.feature.admin.domain.repository.SequenceItem
import com.globussoft.wellness.feature.admin.domain.repository.StaffManagementItem
import com.globussoft.wellness.feature.admin.domain.repository.SurveyItem
import com.globussoft.wellness.feature.admin.domain.repository.WhatsAppMessageItem
import com.globussoft.wellness.feature.admin.domain.repository.TaskItem
import com.globussoft.wellness.feature.admin.domain.repository.TasksPage
import com.globussoft.wellness.feature.admin.domain.repository.WorkingHoursItem
import com.globussoft.wellness.feature.admin.domain.repository.AutoConsumptionRuleItem
import com.globussoft.wellness.feature.admin.domain.repository.CashbackRuleItem
import com.globussoft.wellness.feature.admin.domain.repository.ConvertedLeadItem
import com.globussoft.wellness.feature.admin.domain.repository.DrugItem
import com.globussoft.wellness.feature.admin.domain.repository.HolidayItem
import com.globussoft.wellness.feature.admin.domain.repository.MarketplaceLeadItem
import com.globussoft.wellness.feature.admin.domain.repository.MarketplaceLeadsPage
import com.globussoft.wellness.feature.admin.domain.repository.ProductCategoryItem
import com.globussoft.wellness.feature.admin.domain.repository.ProductItem
import com.globussoft.wellness.feature.admin.domain.repository.RetentionPolicyItem
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

    // ── Audit Log ──────────────────────────────────────────────────────────────

    override suspend fun getAuditLogs(page: Int): WResult<AuditLogsPage> =
        safeApiCall { api.getAuditLogs(page = page) }
            .mapSuccess { envelope ->
                @Suppress("UNCHECKED_CAST")
                val rawLogs = (envelope["logs"] ?: envelope["data"]) as? List<*> ?: emptyList<Any>()
                AuditLogsPage(
                    logs        = rawLogs.filterIsInstance<Map<*, *>>().map { it.toAuditLogItem() },
                    pages       = (envelope["pages"] as? Number)?.toInt() ?: 1,
                    total       = (envelope["total"] as? Number)?.toInt() ?: 0,
                    currentPage = page,
                )
            }

    // ── Marketplace Leads ──────────────────────────────────────────────────────

    override suspend fun getMarketplaceLeads(provider: String?, status: String?, page: Int): WResult<MarketplaceLeadsPage> =
        safeApiCall { api.getMarketplaceLeads(provider = provider, status = status, page = page) }
            .mapSuccess { envelope ->
                @Suppress("UNCHECKED_CAST")
                val rawLeads = (envelope["leads"] ?: envelope["data"]) as? List<*> ?: emptyList<Any>()
                MarketplaceLeadsPage(
                    leads       = rawLeads.filterIsInstance<Map<*, *>>().map { it.toMarketplaceLead() },
                    pages       = (envelope["pages"] as? Number)?.toInt() ?: 1,
                    total       = (envelope["total"] as? Number)?.toInt() ?: 0,
                    currentPage = page,
                )
            }

    // ── Converted Leads ────────────────────────────────────────────────────────

    override suspend fun getConvertedLeads(): WResult<List<ConvertedLeadItem>> =
        safeApiCall { api.getContacts(status = "Converted") }
            .mapSuccess { list -> list.filterIsInstance<Map<*, *>>().map { it.toConvertedLead() } }

    // ── Privacy / Retention Policies ───────────────────────────────────────────

    override suspend fun getRetentionPolicies(): WResult<List<RetentionPolicyItem>> =
        safeApiCall { api.getRetentionPolicies() }
            .mapSuccess { list -> list.filterIsInstance<Map<*, *>>().map { it.toRetentionPolicy() } }

    // ── Inventory Receipts ─────────────────────────────────────────────────────

    override suspend fun getInventoryReceipts(): WResult<List<InventoryReceiptItem>> =
        safeApiCall { api.getInventoryReceipts() }
            .mapSuccess { list -> list.filterIsInstance<Map<*, *>>().map { it.toInventoryReceipt() } }

    // ── Inventory Adjustments ──────────────────────────────────────────────────

    override suspend fun getInventoryAdjustments(): WResult<List<InventoryAdjustmentItem>> =
        safeApiCall { api.getInventoryAdjustments() }
            .mapSuccess { list -> list.filterIsInstance<Map<*, *>>().map { it.toInventoryAdjustment() } }

    // ── Revenue Goals ──────────────────────────────────────────────────────────

    override suspend fun getRevenueGoals(): WResult<List<RevenueGoalItem>> =
        safeApiCall { api.getRevenueGoals() }
            .mapSuccess { list -> list.filterIsInstance<Map<*, *>>().map { it.toRevenueGoal() } }

    // ── Commission Profiles ────────────────────────────────────────────────────

    override suspend fun getCommissionProfiles(): WResult<List<CommissionProfileItem>> =
        safeApiCall { api.getCommissionProfiles() }
            .mapSuccess { list -> list.filterIsInstance<Map<*, *>>().map { it.toCommissionProfile() } }

    // ── Working Hours ──────────────────────────────────────────────────────────

    override suspend fun getWorkingHours(doctorId: String?): WResult<List<WorkingHoursItem>> =
        safeApiCall { api.getWorkingHours(doctorId) }
            .mapSuccess { list -> list.filterIsInstance<Map<*, *>>().map { it.toWorkingHours() } }

    // ── Membership Plans ───────────────────────────────────────────────────────

    override suspend fun getMembershipPlans(): WResult<List<MembershipPlanItem>> =
        safeApiCall { api.getMembershipPlans() }
            .mapSuccess { list -> list.filterIsInstance<Map<*, *>>().map { it.toMembershipPlan() } }

    // ── All Leads ──────────────────────────────────────────────────────────────

    override suspend fun getLeads(search: String?, status: String?, page: Int): WResult<LeadsPage> =
        safeApiCall { api.getLeads(search, status, page = page) }
            .mapSuccess { list ->
                val contacts = list.filterIsInstance<Map<*, *>>()
                LeadsPage(
                    leads       = contacts.map { it.toLeadItem() },
                    total       = contacts.size,
                    pages       = 1,
                    currentPage = page,
                )
            }

    override suspend fun getLeadDetail(id: String): WResult<LeadDetailItem> =
        safeApiCall { api.getLeadDetail(id) }
            .mapSuccess { it.toLeadDetailItem() }

    // ── Tasks ──────────────────────────────────────────────────────────────────

    override suspend fun getTasks(status: String?, page: Int): WResult<TasksPage> =
        safeApiCall { api.getTasks(status, page = page) }
            .mapSuccess { list ->
                val tasks = list.filterIsInstance<Map<*, *>>()
                TasksPage(
                    tasks       = tasks.map { it.toTaskItem() },
                    total       = tasks.size,
                    pages       = 1,
                    currentPage = page,
                )
            }

    // ── Lead Routing Rules ─────────────────────────────────────────────────────

    override suspend fun getLeadRoutingRules(): WResult<List<RoutingRuleItem>> =
        safeApiCall { api.getLeadRoutingRules() }
            .mapSuccess { list -> list.filterIsInstance<Map<*, *>>().map { it.toRoutingRule() } }

    // ── Staff Management (Wave 4) ──────────────────────────────────────────────

    override suspend fun getAllStaff(): WResult<List<StaffManagementItem>> =
        safeApiCall { api.getAllStaff() }
            .mapSuccess { list -> list.filterIsInstance<Map<*, *>>().map { it.toStaffManagementItem() } }

    // ── Wave 5: Communication & Marketing ─────────────────────────────────────

    override suspend fun getWhatsAppMessages(): WResult<List<WhatsAppMessageItem>> =
        safeApiCall { api.getWhatsAppMessages() }.mapSuccess { map ->
            val msgs = (map["messages"] as? List<*>)?.filterIsInstance<Map<*, *>>() ?: emptyList()
            msgs.map { m ->
                WhatsAppMessageItem(
                    id          = m["id"]?.toString() ?: "",
                    contactName = (m["contact"] as? Map<*, *>)?.get("name")?.toString(),
                    body        = m["body"]?.toString() ?: "",
                    direction   = m["direction"]?.toString() ?: "OUTBOUND",
                    status      = m["status"]?.toString() ?: "",
                    isRead      = m["read"] as? Boolean ?: false,
                    createdAt   = m["createdAt"]?.toString() ?: "",
                )
            }
        }

    override suspend fun getNotifications(): WResult<List<NotificationItem>> =
        safeApiCall { api.getNotifications() }.mapSuccess { map ->
            val notifs = (map["notifications"] as? List<*>)?.filterIsInstance<Map<*, *>>() ?: emptyList()
            notifs.map { n ->
                NotificationItem(
                    id        = n["id"]?.toString() ?: "",
                    title     = n["title"]?.toString() ?: "",
                    message   = n["message"]?.toString() ?: "",
                    type      = n["type"]?.toString() ?: "",
                    isRead    = n["isRead"] as? Boolean ?: false,
                    createdAt = n["createdAt"]?.toString() ?: "",
                )
            }
        }

    override suspend fun getSequences(): WResult<List<SequenceItem>> =
        safeApiCall { api.getSequences() }.mapSuccess { list ->
            list.filterIsInstance<Map<*, *>>().map { s ->
                SequenceItem(
                    id              = s["id"]?.toString() ?: "",
                    name            = s["name"]?.toString() ?: "",
                    isActive        = s["isActive"] as? Boolean ?: false,
                    enrollmentCount = ((s["_count"] as? Map<*, *>)?.get("enrollments") as? Number)?.toInt() ?: 0,
                )
            }
        }

    override suspend fun getLandingPages(): WResult<List<LandingPageItem>> =
        safeApiCall { api.getLandingPages() }.mapSuccess { list ->
            list.filterIsInstance<Map<*, *>>().map { p ->
                LandingPageItem(
                    id          = p["id"]?.toString() ?: "",
                    title       = p["title"]?.toString() ?: "",
                    slug        = p["slug"]?.toString() ?: "",
                    status      = p["status"]?.toString() ?: "",
                    visits      = (p["visits"] as? Number)?.toInt() ?: 0,
                    submissions = (p["submissions"] as? Number)?.toInt() ?: 0,
                )
            }
        }

    override suspend fun getSurveys(): WResult<List<SurveyItem>> =
        safeApiCall { api.getSurveys() }.mapSuccess { list ->
            list.filterIsInstance<Map<*, *>>().map { s ->
                SurveyItem(
                    id            = s["id"]?.toString() ?: "",
                    name          = s["name"]?.toString() ?: "",
                    type          = s["type"]?.toString() ?: "",
                    isActive      = s["isActive"] as? Boolean ?: false,
                    responseCount = (s["responseCount"] as? Number)?.toInt() ?: 0,
                    avgScore      = (s["avgScore"] as? Number)?.toDouble() ?: 0.0,
                )
            }
        }

    override suspend fun getIntegrations(): WResult<List<IntegrationItem>> =
        safeApiCall { api.getIntegrations() }.mapSuccess { list ->
            list.filterIsInstance<Map<*, *>>().map { i ->
                IntegrationItem(
                    id          = i["id"]?.toString() ?: i["provider"]?.toString() ?: "",
                    provider    = i["provider"]?.toString() ?: "",
                    name        = i["name"]?.toString() ?: "",
                    description = i["description"]?.toString(),
                    category    = i["category"]?.toString() ?: "",
                    isActive    = i["isActive"] as? Boolean ?: false,
                )
            }
        }

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

    private fun Map<*, *>.toAuditLogItem(): AuditLogItem {
        val user = this["user"] as? Map<*, *>
        return AuditLogItem(
            id         = this["id"]?.toString() ?: "",
            action     = this["action"]?.toString() ?: "",
            entity     = this["entity"]?.toString() ?: "",
            entityId   = this["entityId"]?.toString(),
            userName   = user?.get("name")?.toString() ?: this["userName"]?.toString(),
            userEmail  = user?.get("email")?.toString() ?: this["userEmail"]?.toString(),
            timestamp  = (this["timestamp"] ?: this["createdAt"])?.toString() ?: "",
            details    = this["details"]?.toString(),
        )
    }

    private fun Map<*, *>.toMarketplaceLead() = MarketplaceLeadItem(
        id        = this["id"]?.toString() ?: "",
        name      = this["name"]?.toString(),
        email     = this["email"]?.toString(),
        phone     = this["phone"]?.toString(),
        company   = this["company"]?.toString(),
        provider  = this["provider"]?.toString() ?: "",
        status    = this["status"]?.toString() ?: "New",
        createdAt = this["createdAt"]?.toString() ?: "",
    )

    private fun Map<*, *>.toConvertedLead() = ConvertedLeadItem(
        id        = this["id"]?.toString() ?: "",
        name      = this["name"]?.toString(),
        email     = this["email"]?.toString(),
        phone     = this["phone"]?.toString(),
        company   = this["company"]?.toString(),
        status    = this["status"]?.toString(),
        source    = this["source"]?.toString(),
        createdAt = this["createdAt"]?.toString() ?: "",
    )

    private fun Map<*, *>.toRetentionPolicy() = RetentionPolicyItem(
        id         = this["id"]?.toString() ?: "",
        entity     = this["entity"]?.toString() ?: "",
        label      = this["label"]?.toString(),
        retainDays = (this["retainDays"] as? Number)?.toInt() ?: 0,
        isActive   = this["isActive"] as? Boolean ?: true,
    )

    private fun Map<*, *>.toInventoryReceipt(): InventoryReceiptItem {
        val product = this["product"] as? Map<*, *>
        val vendor  = this["vendor"] as? Map<*, *>
        val qty     = (this["quantity"] as? Number)?.toDouble() ?: 0.0
        val unit    = (this["unitCost"] as? Number)?.toDouble() ?: 0.0
        return InventoryReceiptItem(
            id            = this["id"]?.toString() ?: "",
            receiptNumber = this["receiptNumber"]?.toString(),
            productName   = product?.get("name")?.toString() ?: this["productName"]?.toString() ?: "",
            vendorName    = vendor?.get("name")?.toString() ?: this["vendorName"]?.toString(),
            quantity      = qty,
            unitCost      = unit,
            totalCost     = (this["totalCost"] as? Number)?.toDouble() ?: (qty * unit),
            batchNumber   = this["batchNumber"]?.toString(),
            expiryDate    = this["expiryDate"]?.toString(),
            receivedAt    = this["receivedAt"]?.toString() ?: this["createdAt"]?.toString() ?: "",
            notes         = this["notes"]?.toString(),
        )
    }

    private fun Map<*, *>.toInventoryAdjustment(): InventoryAdjustmentItem {
        val product = this["product"] as? Map<*, *>
        return InventoryAdjustmentItem(
            id            = this["id"]?.toString() ?: "",
            productName   = product?.get("name")?.toString() ?: this["productName"]?.toString() ?: "",
            quantityDelta = (this["quantityDelta"] as? Number)?.toDouble() ?: 0.0,
            reason        = this["reason"]?.toString() ?: "",
            notes         = this["notes"]?.toString(),
            createdAt     = this["createdAt"]?.toString() ?: "",
        )
    }

    private fun Map<*, *>.toRevenueGoal(): RevenueGoalItem {
        val user = this["user"] as? Map<*, *>
        return RevenueGoalItem(
            id             = this["id"]?.toString() ?: "",
            userName       = user?.get("name")?.toString() ?: this["userName"]?.toString(),
            userEmail      = user?.get("email")?.toString() ?: this["userEmail"]?.toString(),
            period         = this["period"]?.toString() ?: "MONTHLY",
            periodStart    = this["periodStart"]?.toString() ?: "",
            periodEnd      = this["periodEnd"]?.toString() ?: "",
            targetAmount   = (this["targetAmount"] as? Number)?.toDouble() ?: this["targetAmount"]?.toString()?.toDoubleOrNull() ?: 0.0,
            achievedAmount = (this["achievedAmount"] as? Number)?.toDouble() ?: 0.0,
            scope          = this["scope"]?.toString() ?: "ALL",
            notes          = this["notes"]?.toString(),
        )
    }

    private fun Map<*, *>.toCommissionProfile() = CommissionProfileItem(
        id                 = this["id"]?.toString() ?: "",
        name               = this["name"]?.toString() ?: "",
        basis              = this["basis"]?.toString() ?: "REVENUE_PERCENT",
        percentage         = (this["percentage"] as? Number)?.toDouble() ?: this["percentage"]?.toString()?.toDoubleOrNull(),
        flatAmount         = (this["flatAmount"] as? Number)?.toDouble() ?: this["flatAmount"]?.toString()?.toDoubleOrNull(),
        appliesToCategory  = this["appliesToCategory"]?.toString(),
        isActive           = this["isActive"] as? Boolean ?: true,
    )

    private fun Map<*, *>.toWorkingHours() = WorkingHoursItem(
        id         = this["id"]?.toString() ?: "",
        doctorId   = this["doctorId"]?.toString() ?: "",
        dayOfWeek  = (this["dayOfWeek"] as? Number)?.toInt() ?: 0,
        startTime  = this["startTime"]?.toString() ?: "09:00",
        endTime    = this["endTime"]?.toString() ?: "18:00",
        isActive   = this["isActive"] as? Boolean ?: true,
    )

    private fun Map<*, *>.toMembershipPlan() = MembershipPlanItem(
        id           = this["id"]?.toString() ?: "",
        name         = this["name"]?.toString() ?: "",
        description  = this["description"]?.toString(),
        durationDays = (this["durationDays"] as? Number)?.toInt() ?: 30,
        price        = (this["price"] as? Number)?.toDouble() ?: 0.0,
        currency     = this["currency"]?.toString() ?: "INR",
        isActive     = this["isActive"] as? Boolean ?: true,
        entitlements = this["entitlements"]?.toString(),
    )

    private fun Map<*, *>.toLeadItem() = LeadItem(
        id         = this["id"]?.toString() ?: "",
        name       = this["name"]?.toString() ?: this["firstName"]?.toString()?.let {
            "$it ${this["lastName"] ?: ""}".trim()
        },
        email      = this["email"]?.toString(),
        phone      = this["phone"]?.toString(),
        company    = this["company"]?.toString(),
        status     = this["status"]?.toString(),
        source     = this["source"]?.toString(),
        score      = (this["score"] as? Number)?.toInt(),
        assignedTo = (this["assignedUser"] as? Map<*, *>)?.get("name")?.toString()
                     ?: this["assignedToName"]?.toString(),
        createdAt  = this["createdAt"]?.toString() ?: "",
    )

    private fun Map<*, *>.toLeadDetailItem(): LeadDetailItem {
        @Suppress("UNCHECKED_CAST")
        val rawTags = this["tags"]
        val tags = when (rawTags) {
            is List<*> -> rawTags.filterIsInstance<String>()
            is String  -> if (rawTags.isBlank()) emptyList() else listOf(rawTags)
            else       -> emptyList()
        }
        return LeadDetailItem(
            id         = this["id"]?.toString() ?: "",
            name       = this["name"]?.toString() ?: this["firstName"]?.toString()?.let {
                "$it ${this["lastName"] ?: ""}".trim()
            },
            email      = this["email"]?.toString(),
            phone      = this["phone"]?.toString(),
            company    = this["company"]?.toString(),
            status     = this["status"]?.toString(),
            source     = this["source"]?.toString(),
            score      = (this["score"] as? Number)?.toInt(),
            tags       = tags,
            notes      = this["notes"]?.toString(),
            assignedTo = (this["assignedUser"] as? Map<*, *>)?.get("name")?.toString()
                         ?: this["assignedToName"]?.toString(),
            createdAt  = this["createdAt"]?.toString() ?: "",
            updatedAt  = this["updatedAt"]?.toString(),
        )
    }

    private fun Map<*, *>.toTaskItem() = TaskItem(
        id             = this["id"]?.toString() ?: "",
        title          = this["title"]?.toString() ?: "",
        description    = this["notes"]?.toString() ?: this["description"]?.toString(),
        status         = this["status"]?.toString() ?: "pending",
        priority       = this["priority"]?.toString(),
        dueDate        = this["dueDate"]?.toString(),
        assignedToName = (this["user"] as? Map<*, *>)?.get("name")?.toString()
                         ?: (this["assignedTo"] as? Map<*, *>)?.get("name")?.toString()
                         ?: this["assignedToName"]?.toString(),
        createdAt      = this["createdAt"]?.toString() ?: "",
    )

    private fun Map<*, *>.toStaffManagementItem() = StaffManagementItem(
        id           = this["id"]?.toString() ?: "",
        name         = this["name"]?.toString() ?: "",
        email        = this["email"]?.toString() ?: "",
        role         = this["role"]?.toString() ?: "",
        wellnessRole = this["wellnessRole"]?.toString(),
        isActive     = this["deactivatedAt"] == null,
        createdAt    = this["createdAt"]?.toString() ?: "",
    )

    private fun Map<*, *>.toRoutingRule() = RoutingRuleItem(
        id                = this["id"]?.toString() ?: "",
        name              = this["name"]?.toString() ?: "",
        priority          = (this["priority"] as? Number)?.toInt() ?: 0,
        assignedUserName  = (this["assignTo"] as? Map<*, *>)?.get("name")?.toString()
                            ?: (this["assignedUser"] as? Map<*, *>)?.get("name")?.toString()
                            ?: this["assignedUserName"]?.toString(),
        serviceCategory   = this["serviceCategory"]?.toString(),
        isActive          = this["isActive"] as? Boolean ?: true,
        conditions        = this["conditions"]?.toString(),
    )
}

// ─── Local mapping helper ─────────────────────────────────────────────────────

private inline fun <T, R> WResult<T>.mapSuccess(transform: (T) -> R): WResult<R> =
    when (this) {
        is WResult.Success -> WResult.Success(transform(data))
        is WResult.Error   -> this
        WResult.Loading    -> WResult.Loading
    }
