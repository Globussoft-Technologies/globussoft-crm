package com.globussoft.wellness.feature.crm.data.repository

import com.globussoft.wellness.core.common.result.WResult
import com.globussoft.wellness.core.data.datastore.AuthDataStore
import com.globussoft.wellness.core.data.mapper.toDomain
import com.globussoft.wellness.core.database.dao.CrmContactDao
import com.globussoft.wellness.core.database.dao.CrmDealDao
import com.globussoft.wellness.core.database.dao.CrmTaskDao
import com.globussoft.wellness.core.database.dao.CrmTicketDao
import com.globussoft.wellness.core.database.entity.CrmContactEntity
import com.globussoft.wellness.core.database.entity.CrmDealEntity
import com.globussoft.wellness.core.database.entity.CrmTaskEntity
import com.globussoft.wellness.core.database.entity.CrmTicketEntity
import com.globussoft.wellness.core.domain.model.Approval
import com.globussoft.wellness.core.domain.model.Campaign
import com.globussoft.wellness.core.domain.model.Contact
import com.globussoft.wellness.core.domain.model.CrmTask
import com.globussoft.wellness.core.domain.model.Deal
import com.globussoft.wellness.core.domain.model.DealInsight
import com.globussoft.wellness.core.domain.model.DealStats
import com.globussoft.wellness.core.domain.model.Estimate
import com.globussoft.wellness.core.domain.model.Expense
import com.globussoft.wellness.core.domain.model.ForecastEntry
import com.globussoft.wellness.core.domain.model.Invoice
import com.globussoft.wellness.core.domain.model.Pipeline
import com.globussoft.wellness.core.domain.model.Ticket
import com.globussoft.wellness.core.network.api.WellnessApi
import com.globussoft.wellness.core.network.model.request.CreateContactRequest
import com.globussoft.wellness.core.network.model.request.CreateCrmTaskRequest
import com.globussoft.wellness.core.network.model.request.CreateDealRequest
import com.globussoft.wellness.core.network.model.request.CreateEstimateRequest
import com.globussoft.wellness.core.network.model.request.CreateExpenseRequest
import com.globussoft.wellness.core.network.model.request.CreateInvoiceRequest
import com.globussoft.wellness.core.network.model.request.CreateTicketRequest
import com.globussoft.wellness.core.network.model.request.EstimateLineItemRequest
import com.globussoft.wellness.core.network.model.request.InvoiceLineItemRequest
import com.globussoft.wellness.core.network.util.safeApiCall
import com.globussoft.wellness.feature.crm.domain.repository.CrmRepository
import kotlinx.coroutines.flow.first
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class CrmRepositoryImpl @Inject constructor(
    private val api:            WellnessApi,
    private val contactDao:     CrmContactDao,
    private val dealDao:        CrmDealDao,
    private val taskDao:        CrmTaskDao,
    private val ticketDao:      CrmTicketDao,
    private val authDataStore:  AuthDataStore,
) : CrmRepository {

    // ── Contacts ─────────────────────────────────────────────────────────────

    override suspend fun getContacts(status: String?, search: String?, skip: Int): WResult<List<Contact>> {
        val tenantId = tenantId()
        val networkResult = safeApiCall { api.getCrmContacts(status = status, search = search, skip = skip) }
            .mapSuccess { list -> list.map { it.toDomain() } }

        if (networkResult is WResult.Success) {
            contactDao.insertContacts(networkResult.data.map { it.toEntity(tenantId) })
            return networkResult
        }

        // Network failed — serve from cache
        val cached = contactDao.getContacts(
            tenantId = tenantId,
            status   = status,
            query    = search ?: "",
        ).first().map { it.toDomain() }

        return if (cached.isNotEmpty()) WResult.Success(cached) else networkResult
    }

    override suspend fun getContact(id: String): WResult<Contact> {
        val tenantId = tenantId()
        val result = safeApiCall { api.getCrmContact(id) }.mapSuccess { it.toDomain() }

        if (result is WResult.Success) {
            contactDao.insertContacts(listOf(result.data.toEntity(tenantId)))
            return result
        }

        val cached = contactDao.getContactById(id)
        return if (cached != null) WResult.Success(cached.toDomain()) else result
    }

    override suspend fun createContact(name: String, email: String?, phone: String?, company: String?, source: String?, status: String?): WResult<Contact> {
        val result = safeApiCall {
            api.createCrmContact(CreateContactRequest(contactName = name, email = email, phone = phone, company = company, source = source, status = status))
        }.mapSuccess { it.toDomain() }

        if (result is WResult.Success) {
            contactDao.insertContacts(listOf(result.data.toEntity(tenantId())))
        }
        return result
    }

    override suspend fun updateContact(id: String, name: String, email: String?, phone: String?, company: String?, source: String?): WResult<Contact> {
        val result = safeApiCall {
            api.updateCrmContact(id, CreateContactRequest(contactName = name, email = email, phone = phone, company = company, source = source))
        }.mapSuccess { it.toDomain() }

        if (result is WResult.Success) {
            contactDao.insertContacts(listOf(result.data.toEntity(tenantId())))
        }
        return result
    }

    override suspend fun deleteContact(id: String): WResult<Unit> =
        safeApiCall { api.deleteCrmContact(id) }

    // ── Deals ─────────────────────────────────────────────────────────────────

    override suspend fun getDeals(stage: String?, status: String?, search: String?, skip: Int): WResult<List<Deal>> {
        val tenantId = tenantId()
        val networkResult = safeApiCall { api.getCrmDeals(stage = stage, status = status, search = search, skip = skip) }
            .mapSuccess { list -> list.map { it.toDomain() } }

        if (networkResult is WResult.Success) {
            dealDao.insertDeals(networkResult.data.map { it.toEntity(tenantId) })
            return networkResult
        }

        val cached = dealDao.getDeals(tenantId = tenantId, status = status, stage = stage)
            .first().map { it.toDomain() }

        return if (cached.isNotEmpty()) WResult.Success(cached) else networkResult
    }

    override suspend fun getDealStats(): WResult<DealStats> =
        safeApiCall { api.getCrmDealStats() }.mapSuccess { it.toDomain() }

    override suspend fun getDeal(id: String): WResult<Deal> {
        val result = safeApiCall { api.getCrmDeal(id) }.mapSuccess { it.toDomain() }

        if (result is WResult.Success) {
            dealDao.insertDeals(listOf(result.data.toEntity(tenantId())))
            return result
        }

        val cached = dealDao.getDealById(id)
        return if (cached != null) WResult.Success(cached.toDomain()) else result
    }

    override suspend fun createDeal(title: String, amount: Double, stage: String, pipelineId: String?, contactId: String?, probability: Int): WResult<Deal> {
        val result = safeApiCall {
            api.createCrmDeal(CreateDealRequest(title = title, amount = amount, stage = stage, pipelineId = pipelineId, contactId = contactId, probability = probability, expectedClose = null))
        }.mapSuccess { it.toDomain() }

        if (result is WResult.Success) {
            dealDao.insertDeals(listOf(result.data.toEntity(tenantId())))
        }
        return result
    }

    override suspend fun updateDeal(id: String, params: Map<String, Any>): WResult<Deal> {
        val result = safeApiCall {
            api.updateCrmDeal(
                id,
                CreateDealRequest(
                    title         = params["title"] as? String ?: "",
                    amount        = params["amount"] as? Double ?: 0.0,
                    stage         = params["stage"] as? String ?: "",
                    pipelineId    = params["pipelineId"] as? String,
                    probability   = params["probability"] as? Int,
                    expectedClose = params["expectedClose"] as? String,
                    contactId     = params["contactId"] as? String,
                ),
            )
        }.mapSuccess { it.toDomain() }

        if (result is WResult.Success) {
            dealDao.insertDeals(listOf(result.data.toEntity(tenantId())))
        }
        return result
    }

    // ── Pipelines ─────────────────────────────────────────────────────────────

    override suspend fun getPipelines(): WResult<List<Pipeline>> =
        safeApiCall { api.getCrmPipelines() }.mapSuccess { list -> list.map { it.toDomain() } }

    // ── Tickets ───────────────────────────────────────────────────────────────

    override suspend fun getTickets(status: String?, priority: String?, skip: Int): WResult<List<Ticket>> {
        val tenantId = tenantId()
        val networkResult = safeApiCall { api.getCrmTickets(status = status, priority = priority, skip = skip) }
            .mapSuccess { list -> list.map { it.toDomain() } }

        if (networkResult is WResult.Success) {
            ticketDao.insertTickets(networkResult.data.map { it.toEntity(tenantId) })
            return networkResult
        }

        val cached = ticketDao.getTickets(tenantId = tenantId, status = status, priority = priority)
            .first().map { it.toDomain() }

        return if (cached.isNotEmpty()) WResult.Success(cached) else networkResult
    }

    override suspend fun getTicket(id: String): WResult<Ticket> {
        val result = safeApiCall { api.getCrmTicket(id) }.mapSuccess { it.toDomain() }

        if (result is WResult.Success) {
            ticketDao.insertTickets(listOf(result.data.toEntity(tenantId())))
            return result
        }

        val cached = ticketDao.getTicketById(id)
        return if (cached != null) WResult.Success(cached.toDomain()) else result
    }

    override suspend fun createTicket(subject: String, description: String?, priority: String): WResult<Ticket> =
        safeApiCall {
            api.createCrmTicket(CreateTicketRequest(subject = subject, description = description, priority = priority, contactId = null))
        }.mapSuccess { it.toDomain() }

    override suspend fun updateTicket(id: String, params: Map<String, Any>): WResult<Ticket> =
        safeApiCall { api.updateCrmTicket(id, params) }.mapSuccess { it.toDomain() }

    // ── Tasks ─────────────────────────────────────────────────────────────────

    override suspend fun getTasks(status: String?, skip: Int): WResult<List<CrmTask>> {
        val tenantId = tenantId()
        val networkResult = safeApiCall { api.getCrmTasks(status = status, skip = skip) }
            .mapSuccess { list -> list.map { it.toDomain() } }

        if (networkResult is WResult.Success) {
            taskDao.insertTasks(networkResult.data.map { it.toEntity(tenantId) })
            return networkResult
        }

        val cached = taskDao.getTasks(tenantId = tenantId, status = status)
            .first().map { it.toDomain() }

        return if (cached.isNotEmpty()) WResult.Success(cached) else networkResult
    }

    override suspend fun createTask(title: String, description: String?, dueDate: String?, assigneeId: String?): WResult<CrmTask> =
        safeApiCall {
            api.createCrmTask(CreateCrmTaskRequest(title = title, description = description, dueDate = dueDate, assigneeId = assigneeId, contactId = null))
        }.mapSuccess { it.toDomain() }

    override suspend fun completeTask(id: String): WResult<CrmTask> {
        val result = safeApiCall { api.completeCrmTask(id) }.mapSuccess { it.toDomain() }
        // Mirror the completion in the local cache regardless of network outcome
        taskDao.markCompleted(id)
        return result
    }

    // ── Invoices ──────────────────────────────────────────────────────────────

    override suspend fun getInvoices(status: String?, skip: Int): WResult<List<Invoice>> =
        safeApiCall { api.getCrmInvoices(status = status, skip = skip) }
            .mapSuccess { list -> list.map { it.toDomain() } }

    override suspend fun getInvoice(id: String): WResult<Invoice> =
        safeApiCall { api.getCrmInvoice(id) }.mapSuccess { it.toDomain() }

    override suspend fun sendInvoice(id: String): WResult<Invoice> =
        safeApiCall { api.sendCrmInvoice(id) }.mapSuccess { it.toDomain() }

    override suspend fun markInvoicePaid(id: String): WResult<Invoice> =
        safeApiCall { api.markCrmInvoicePaid(id) }.mapSuccess { it.toDomain() }

    override suspend fun createInvoice(contactId: String?, dueDate: String?, notes: String?, lineItems: List<InvoiceLineItemRequest>): WResult<Invoice> =
        safeApiCall { api.createCrmInvoice(CreateInvoiceRequest(contactId, dueDate, lineItems, notes)) }
            .mapSuccess { it.toDomain() }

    // ── Estimates ─────────────────────────────────────────────────────────────

    override suspend fun getEstimates(status: String?, skip: Int): WResult<List<Estimate>> =
        safeApiCall { api.getCrmEstimates(status = status, skip = skip) }
            .mapSuccess { list -> list.map { it.toDomain() } }

    override suspend fun getEstimate(id: String): WResult<Estimate> =
        safeApiCall { api.getCrmEstimate(id) }.mapSuccess { it.toDomain() }

    override suspend fun createEstimate(contactId: String?, validUntil: String?, notes: String?, lineItems: List<EstimateLineItemRequest>): WResult<Estimate> =
        safeApiCall { api.createCrmEstimate(CreateEstimateRequest(contactId, validUntil, lineItems, notes)) }
            .mapSuccess { it.toDomain() }

    // ── Expenses ──────────────────────────────────────────────────────────────

    override suspend fun getExpenses(category: String?, skip: Int): WResult<List<Expense>> =
        safeApiCall { api.getCrmExpenses(category = category, skip = skip) }
            .mapSuccess { list -> list.map { it.toDomain() } }

    override suspend fun approveExpense(id: String): WResult<Expense> =
        safeApiCall { api.approveCrmExpense(id) }.mapSuccess { it.toDomain() }

    override suspend fun rejectExpense(id: String): WResult<Expense> =
        safeApiCall { api.rejectCrmExpense(id) }.mapSuccess { it.toDomain() }

    override suspend fun createExpense(title: String, amount: Double, category: String, date: String, notes: String?): WResult<Expense> =
        safeApiCall { api.createCrmExpense(CreateExpenseRequest(title, amount, category, date, notes)) }
            .mapSuccess { it.toDomain() }

    // ── Forecasting ───────────────────────────────────────────────────────────

    override suspend fun getForecasting(): WResult<List<ForecastEntry>> =
        safeApiCall { api.getCrmForecasting() }.mapSuccess { list -> list.map { it.toDomain() } }

    // ── Deal Insights ─────────────────────────────────────────────────────────

    override suspend fun getDealInsights(): WResult<List<DealInsight>> =
        safeApiCall { api.getCrmDealInsights() }.mapSuccess { list -> list.map { it.toDomain() } }

    // ── Approvals ─────────────────────────────────────────────────────────────

    override suspend fun getApprovals(status: String?, mine: Boolean?): WResult<List<Approval>> =
        safeApiCall { api.getCrmApprovals(status = status, mine = mine) }
            .mapSuccess { list -> list.map { it.toDomain() } }

    override suspend fun approveApproval(id: String, comment: String?): WResult<Approval> =
        safeApiCall {
            api.approveCrmApproval(id, buildMap { comment?.let { put("comment", it) } })
        }.mapSuccess { it.toDomain() }

    override suspend fun rejectApproval(id: String, comment: String?): WResult<Approval> =
        safeApiCall {
            api.rejectCrmApproval(id, buildMap { comment?.let { put("comment", it) } })
        }.mapSuccess { it.toDomain() }

    // ── Campaigns ─────────────────────────────────────────────────────────────

    override suspend fun getCampaigns(channel: String?, status: String?): WResult<List<Campaign>> =
        safeApiCall { api.getCrmCampaigns(channel = channel, status = status) }
            .mapSuccess { list -> list.map { it.toDomain() } }

    override suspend fun createCampaign(name: String, channel: String, subject: String, body: String, scheduledAt: String?): WResult<Campaign> {
        val params = buildMap<String, Any> {
            put("name", name)
            put("channel", channel)
            put("subject", subject)
            put("body", body)
            scheduledAt?.let { put("scheduledAt", it) }
        }
        return safeApiCall { api.createCrmCampaign(params) }.mapSuccess { it.toDomain() }
    }

    override suspend fun sendCampaign(id: String): WResult<Unit> =
        safeApiCall { api.sendCrmCampaign(id, mapOf("status" to "SENT")) }
            .mapSuccess { Unit }

    // ── Reports ───────────────────────────────────────────────────────────────

    @Suppress("UNCHECKED_CAST")
    override suspend fun getReports(from: String?, to: String?): WResult<Map<String, Any>> =
        safeApiCall { api.getCrmReports(from = from, to = to) } as WResult<Map<String, Any>>

    @Suppress("UNCHECKED_CAST")
    override suspend fun getAgentPerformance(from: String?, to: String?): WResult<List<Map<String, Any>>> =
        safeApiCall { api.getCrmAgentPerformance(from = from, to = to) } as WResult<List<Map<String, Any>>>

    // ── Misc ──────────────────────────────────────────────────────────────────

    @Suppress("UNCHECKED_CAST")
    override suspend fun getQuotas(): WResult<List<Map<String, Any>>> =
        safeApiCall { api.getCrmQuotas() } as WResult<List<Map<String, Any>>>

    override suspend fun createQuota(repName: String, target: Double): WResult<Map<String, Any>> =
        safeApiCall { api.createCrmQuota(mapOf("repName" to repName, "target" to target)) }
            .mapSuccess { @Suppress("UNCHECKED_CAST") (it as? Map<String, Any>) ?: emptyMap() }

    @Suppress("UNCHECKED_CAST")
    override suspend fun getWinLoss(from: String?, to: String?): WResult<Map<String, Any>> =
        safeApiCall { api.getCrmWinLoss(from = from, to = to) } as WResult<Map<String, Any>>

    @Suppress("UNCHECKED_CAST")
    override suspend fun getFunnel(): WResult<Map<String, Any>> =
        safeApiCall { api.getCrmFunnel() } as WResult<Map<String, Any>>

    @Suppress("UNCHECKED_CAST")
    override suspend fun getSequences(): WResult<List<Map<String, Any>>> =
        safeApiCall { api.getCrmSequences() } as WResult<List<Map<String, Any>>>

    override suspend fun toggleSequence(id: String, isActive: Boolean): WResult<Unit> =
        safeApiCall { api.updateCrmSequence(id, mapOf("isActive" to isActive)) }
            .mapSuccess { Unit }

    @Suppress("UNCHECKED_CAST")
    override suspend fun getTerritories(): WResult<List<Map<String, Any>>> =
        safeApiCall { api.getCrmTerritories() } as WResult<List<Map<String, Any>>>

    override suspend fun createTerritory(name: String, region: String): WResult<Map<String, Any>> =
        safeApiCall { api.createCrmTerritory(mapOf("name" to name, "region" to region)) }
            .mapSuccess { @Suppress("UNCHECKED_CAST") (it as? Map<String, Any>) ?: emptyMap() }

    @Suppress("UNCHECKED_CAST")
    override suspend fun getLeadRoutingRules(): WResult<List<Map<String, Any>>> =
        safeApiCall { api.getCrmLeadRoutingRules() } as WResult<List<Map<String, Any>>>

    override suspend fun createLeadRoutingRule(name: String, assignTo: String, type: String): WResult<Map<String, Any>> =
        safeApiCall { api.createCrmLeadRoutingRule(mapOf("name" to name, "assignedTo" to assignTo, "type" to type)) }
            .mapSuccess { @Suppress("UNCHECKED_CAST") (it as? Map<String, Any>) ?: emptyMap() }

    @Suppress("UNCHECKED_CAST")
    override suspend fun getStaff(): WResult<List<Map<String, Any>>> =
        safeApiCall { api.getCrmStaff() } as WResult<List<Map<String, Any>>>

    override suspend fun createStaff(name: String, email: String, role: String): WResult<Map<String, Any>> =
        safeApiCall { api.createCrmStaff(mapOf("name" to name, "email" to email, "role" to role)) }
            .mapSuccess { @Suppress("UNCHECKED_CAST") (it as? Map<String, Any>) ?: emptyMap() }

    override suspend fun updateStaff(id: String, params: Map<String, Any>): WResult<Map<String, Any>> =
        safeApiCall { api.updateCrmStaff(id, params) }
            .mapSuccess { @Suppress("UNCHECKED_CAST") (it as? Map<String, Any>) ?: emptyMap() }

    @Suppress("UNCHECKED_CAST")
    override suspend fun getSettings(): WResult<Map<String, Any>> =
        safeApiCall { api.getCrmSettings() } as WResult<Map<String, Any>>

    @Suppress("UNCHECKED_CAST")
    override suspend fun getChannels(): WResult<Map<String, Any>> =
        safeApiCall { api.getCrmChannels() } as WResult<Map<String, Any>>

    @Suppress("UNCHECKED_CAST")
    override suspend fun getKbArticles(search: String?): WResult<List<Map<String, Any>>> =
        safeApiCall { api.getCrmKbArticles(search = search) } as WResult<List<Map<String, Any>>>

    override suspend fun createKbArticle(title: String, category: String, body: String): WResult<Map<String, Any>> =
        safeApiCall { api.createCrmKbArticle(mapOf("title" to title, "category" to category, "body" to body, "isPublished" to true)) }
            .mapSuccess { @Suppress("UNCHECKED_CAST") (it as? Map<String, Any>) ?: emptyMap() }

    @Suppress("UNCHECKED_CAST")
    override suspend fun getSurveys(): WResult<List<Map<String, Any>>> =
        safeApiCall { api.getCrmSurveys() } as WResult<List<Map<String, Any>>>

    @Suppress("UNCHECKED_CAST")
    override suspend fun getAuditLogs(page: Int, entityType: String?, action: String?): WResult<Map<String, Any>> =
        safeApiCall { api.getCrmAuditLogs(entityType = entityType, action = action, page = page) } as WResult<Map<String, Any>>

    override suspend fun saveSettings(params: Map<String, Any>): WResult<Map<String, Any>> =
        safeApiCall { api.updateCrmSettings(params) }
            .mapSuccess { @Suppress("UNCHECKED_CAST") (it as? Map<String, Any>) ?: emptyMap() }

    override suspend fun getContracts(status: String?): WResult<List<Map<String, Any>>> =
        safeApiCall { api.getCrmContracts(status = status) }
            .mapSuccess { list -> list.map { @Suppress("UNCHECKED_CAST") (it as Map<String, Any>) } }

    override suspend fun createContract(title: String, value: Double, startDate: String?, endDate: String?): WResult<Map<String, Any>> =
        safeApiCall { api.createCrmContract(buildMap {
            put("title", title); put("value", value)
            startDate?.let { put("startDate", it) }; endDate?.let { put("endDate", it) }
        }) }.mapSuccess { @Suppress("UNCHECKED_CAST") (it as? Map<String, Any>) ?: emptyMap() }

    override suspend fun getProjects(status: String?): WResult<List<Map<String, Any>>> =
        safeApiCall { api.getCrmProjects(status = status) }
            .mapSuccess { list -> list.map { @Suppress("UNCHECKED_CAST") (it as Map<String, Any>) } }

    override suspend fun createProject(name: String, description: String?, deadline: String?): WResult<Map<String, Any>> =
        safeApiCall { api.createCrmProject(buildMap {
            put("name", name)
            description?.let { put("description", it) }; deadline?.let { put("deadline", it) }
        }) }.mapSuccess { @Suppress("UNCHECKED_CAST") (it as? Map<String, Any>) ?: emptyMap() }

    override suspend fun createSurvey(title: String): WResult<Map<String, Any>> =
        safeApiCall { api.createCrmSurvey(mapOf("title" to title)) }
            .mapSuccess { @Suppress("UNCHECKED_CAST") (it as? Map<String, Any>) ?: emptyMap() }

    override suspend fun getEmailInbox(): WResult<List<Map<String, Any>>> =
        safeApiCall { api.getEmailInbox() }
            .mapSuccess { list -> list.mapNotNull { @Suppress("UNCHECKED_CAST") it as? Map<String, Any> } }

    override suspend fun getSmsMessages(): WResult<List<Map<String, Any>>> =
        safeApiCall { api.getSmsMessages() }
            .mapSuccess { list -> list.mapNotNull { @Suppress("UNCHECKED_CAST") it as? Map<String, Any> } }

    override suspend fun getWhatsAppInbox(): WResult<List<Map<String, Any>>> =
        safeApiCall { api.getWhatsAppMessages() }
            .mapSuccess { raw ->
                @Suppress("UNCHECKED_CAST")
                (raw["messages"] as? List<*>)?.mapNotNull { it as? Map<String, Any> } ?: emptyList()
            }

    override suspend fun getNotificationsFeed(): WResult<List<Map<String, Any>>> =
        safeApiCall { api.getNotifications() }
            .mapSuccess { raw ->
                @Suppress("UNCHECKED_CAST")
                (raw["notifications"] as? List<*>)?.mapNotNull { it as? Map<String, Any> } ?: emptyList()
            }

    override suspend fun getSharedInbox(status: String?): WResult<List<Map<String, Any>>> =
        safeApiCall { api.getSharedInbox(status = status) }
            .mapSuccess { list -> list.mapNotNull { @Suppress("UNCHECKED_CAST") it as? Map<String, Any> } }

    override suspend fun assignSharedInboxItem(id: String, assigneeId: String): WResult<Map<String, Any>> =
        safeApiCall { api.assignSharedInboxItem(id, mapOf("assigneeId" to assigneeId)) }
            .mapSuccess { @Suppress("UNCHECKED_CAST") (it as? Map<String, Any>) ?: emptyMap() }

    // ── Wave 17 ───────────────────────────────────────────────────────────────

    override suspend fun getDocumentViews(): WResult<List<Map<String, Any>>> =
        safeApiCall { api.getDocumentViews() }
            .mapSuccess { list -> list.mapNotNull { @Suppress("UNCHECKED_CAST") it as? Map<String, Any> } }

    override suspend fun getDocumentTemplates(): WResult<List<Map<String, Any>>> =
        safeApiCall { api.getDocumentTemplates() }
            .mapSuccess { list -> list.mapNotNull { @Suppress("UNCHECKED_CAST") it as? Map<String, Any> } }

    override suspend fun createDocumentTemplate(name: String, type: String): WResult<Map<String, Any>> =
        safeApiCall { api.createDocumentTemplate(buildMap { put("name", name); put("type", type) }) }
            .mapSuccess { @Suppress("UNCHECKED_CAST") (it as? Map<String, Any>) ?: emptyMap() }

    override suspend fun getIntegrations(): WResult<List<Map<String, Any>>> =
        safeApiCall { api.getIntegrations() }
            .mapSuccess { list -> list.mapNotNull { @Suppress("UNCHECKED_CAST") it as? Map<String, Any> } }

    override suspend fun getBookingPages(): WResult<List<Map<String, Any>>> =
        safeApiCall { api.getBookingPages() }
            .mapSuccess { list -> list.mapNotNull { @Suppress("UNCHECKED_CAST") it as? Map<String, Any> } }

    override suspend fun createBookingPage(name: String, description: String): WResult<Map<String, Any>> =
        safeApiCall { api.createBookingPage(buildMap { put("name", name); put("description", description) }) }
            .mapSuccess { @Suppress("UNCHECKED_CAST") (it as? Map<String, Any>) ?: emptyMap() }

    // ── Wave 15 gaps ──────────────────────────────────────────────────────────

    override suspend fun getChatbots(): WResult<List<Map<String, Any>>> =
        safeApiCall { api.getChatbots() }
            .mapSuccess { list -> list.mapNotNull { @Suppress("UNCHECKED_CAST") it as? Map<String, Any> } }

    override suspend fun getSignatures(): WResult<List<Map<String, Any>>> =
        safeApiCall { api.getSignatures() }
            .mapSuccess { list -> list.mapNotNull { @Suppress("UNCHECKED_CAST") it as? Map<String, Any> } }

    override suspend fun createSignatureRequest(documentName: String, signerEmail: String): WResult<Map<String, Any>> =
        safeApiCall { api.createSignatureRequest(buildMap { put("documentName", documentName); put("signerEmail", signerEmail) }) }
            .mapSuccess { @Suppress("UNCHECKED_CAST") (it as? Map<String, Any>) ?: emptyMap() }

    override suspend fun getSlaList(): WResult<List<Map<String, Any>>> =
        safeApiCall { api.getSlaList() }
            .mapSuccess { list -> list.mapNotNull { @Suppress("UNCHECKED_CAST") it as? Map<String, Any> } }

    override suspend fun createSlaPolicy(name: String, responseHours: Int, resolutionHours: Int): WResult<Map<String, Any>> =
        safeApiCall { api.createSlaPolicy(buildMap { put("name", name); put("responseHours", responseHours); put("resolutionHours", resolutionHours) }) }
            .mapSuccess { @Suppress("UNCHECKED_CAST") (it as? Map<String, Any>) ?: emptyMap() }

    override suspend fun getSocialMentions(): WResult<List<Map<String, Any>>> =
        safeApiCall { api.getSocialMentions() }
            .mapSuccess { list -> list.mapNotNull { @Suppress("UNCHECKED_CAST") it as? Map<String, Any> } }

    override suspend fun getLandingPages(): WResult<List<Map<String, Any>>> =
        safeApiCall { api.getLandingPages() }
            .mapSuccess { list -> list.mapNotNull { @Suppress("UNCHECKED_CAST") it as? Map<String, Any> } }

    override suspend fun createLandingPage(name: String, slug: String): WResult<Map<String, Any>> =
        safeApiCall { api.createLandingPage(buildMap { put("name", name); put("slug", slug) }) }
            .mapSuccess { @Suppress("UNCHECKED_CAST") (it as? Map<String, Any>) ?: emptyMap() }

    @Suppress("UNCHECKED_CAST")
    override suspend fun getMarketplaceLeads(): WResult<List<Map<String, Any>>> {
        val result = safeApiCall { api.getMarketplaceLeads() } as WResult<Map<String, Any>>
        return result.mapSuccess { raw ->
            (raw["leads"] as? List<*>)?.mapNotNull { it as? Map<String, Any> } ?: emptyList()
        }
    }

    // ── Wave 20 ───────────────────────────────────────────────────────────────

    @Suppress("UNCHECKED_CAST")
    override suspend fun globalSearch(query: String): WResult<Map<String, Any>> =
        safeApiCall { api.globalSearch(query) } as WResult<Map<String, Any>>

    // ── Wave 18 ───────────────────────────────────────────────────────────────

    override suspend fun getCustomReports(): WResult<List<Map<String, Any>>> =
        safeApiCall { api.getCustomReports() }
            .mapSuccess { list -> list.mapNotNull { @Suppress("UNCHECKED_CAST") it as? Map<String, Any> } }

    override suspend fun createCustomReport(name: String, entityType: String): WResult<Map<String, Any>> =
        safeApiCall { api.createCustomReport(buildMap { put("name", name); put("entity", entityType) }) }
            .mapSuccess { @Suppress("UNCHECKED_CAST") (it as? Map<String, Any>) ?: emptyMap() }

    override suspend fun getDashboardsList(): WResult<List<Map<String, Any>>> =
        safeApiCall { api.getDashboards() }
            .mapSuccess { list -> list.mapNotNull { @Suppress("UNCHECKED_CAST") it as? Map<String, Any> } }

    override suspend fun createDashboardItem(name: String): WResult<Map<String, Any>> =
        safeApiCall { api.createDashboard(buildMap { put("name", name) }) }
            .mapSuccess { @Suppress("UNCHECKED_CAST") (it as? Map<String, Any>) ?: emptyMap() }

    override suspend fun getPlaybooks(): WResult<List<Map<String, Any>>> =
        safeApiCall { api.getPlaybooks() }
            .mapSuccess { list -> list.mapNotNull { @Suppress("UNCHECKED_CAST") it as? Map<String, Any> } }

    override suspend fun createPlaybook(name: String, description: String): WResult<Map<String, Any>> =
        safeApiCall { api.createPlaybook(buildMap { put("name", name); put("description", description) }) }
            .mapSuccess { @Suppress("UNCHECKED_CAST") (it as? Map<String, Any>) ?: emptyMap() }

    override suspend fun getLeadScores(): WResult<List<Map<String, Any>>> =
        safeApiCall { api.getLeadScores() }
            .mapSuccess { list -> list.mapNotNull { @Suppress("UNCHECKED_CAST") it as? Map<String, Any> } }

    override suspend fun getAbTests(): WResult<List<Map<String, Any>>> =
        safeApiCall { api.getAbTests() }
            .mapSuccess { list -> list.mapNotNull { @Suppress("UNCHECKED_CAST") it as? Map<String, Any> } }

    override suspend fun createAbTest(name: String, variantA: String, variantB: String): WResult<Map<String, Any>> =
        safeApiCall { api.createAbTest(buildMap { put("name", name); put("variantA", variantA); put("variantB", variantB) }) }
            .mapSuccess { @Suppress("UNCHECKED_CAST") (it as? Map<String, Any>) ?: emptyMap() }

    // ── Private helpers ───────────────────────────────────────────────────────

    private suspend fun tenantId(): String =
        authDataStore.userFlow.first()?.tenantId ?: ""
}

// ─── mapSuccess helper ────────────────────────────────────────────────────────

private inline fun <T, R> WResult<T>.mapSuccess(transform: (T) -> R): WResult<R> =
    when (this) {
        is WResult.Success -> WResult.Success(transform(data))
        is WResult.Error   -> this
        WResult.Loading    -> WResult.Loading
    }

// ─── Domain → Entity converters ───────────────────────────────────────────────

private fun Contact.toEntity(tenantId: String) = CrmContactEntity(
    id           = id,
    tenantId     = tenantId,
    name         = name,
    email        = email,
    phone        = phone,
    company      = company,
    status       = status,
    source       = source,
    aiScore      = aiScore,
    assigneeName = assigneeName,
    dealsCount   = dealsCount,
    createdAt    = createdAt,
    syncedAt     = System.currentTimeMillis(),
)

private fun Deal.toEntity(tenantId: String) = CrmDealEntity(
    id           = id,
    tenantId     = tenantId,
    title        = title,
    amount       = amount,
    stage        = stage,
    status       = status,
    probability  = probability,
    pipelineId   = null,
    pipelineName = pipelineName,
    contactId    = null,
    contactName  = contactName,
    ownerId      = null,
    ownerName    = ownerName,
    expectedClose= expectedClose,
    notes        = null,
    createdAt    = createdAt,
    syncedAt     = System.currentTimeMillis(),
)

private fun CrmTask.toEntity(tenantId: String) = CrmTaskEntity(
    id           = id,
    tenantId     = tenantId,
    title        = title,
    description  = description,
    status       = status,
    priority     = null,
    dueDate      = dueDate,
    assigneeName = assigneeName,
    contactId    = null,
    dealId       = null,
    createdAt    = createdAt,
    syncedAt     = System.currentTimeMillis(),
)

private fun Ticket.toEntity(tenantId: String) = CrmTicketEntity(
    id           = id,
    tenantId     = tenantId,
    title        = subject,
    description  = description,
    status       = status,
    priority     = priority,
    assigneeName = assigneeName,
    contactName  = contactName,
    slaBreached  = breached,
    createdAt    = createdAt,
    syncedAt     = System.currentTimeMillis(),
)

// ─── Entity → Domain converters ───────────────────────────────────────────────

private fun CrmContactEntity.toDomain() = Contact(
    id           = id,
    name         = name,
    email        = email,
    phone        = phone,
    company      = company,
    status       = status,
    source       = source,
    aiScore      = aiScore,
    assigneeName = assigneeName,
    dealsCount   = dealsCount,
    createdAt    = createdAt ?: "",
)

private fun CrmDealEntity.toDomain() = Deal(
    id           = id,
    title        = title,
    amount       = amount,
    stage        = stage,
    status       = status,
    probability  = probability,
    pipelineName = pipelineName,
    contactName  = contactName,
    ownerName    = ownerName,
    expectedClose= expectedClose,
    createdAt    = createdAt ?: "",
)

private fun CrmTaskEntity.toDomain() = CrmTask(
    id           = id,
    title        = title,
    description  = description,
    status       = status,
    dueDate      = dueDate,
    contactName  = null,
    assigneeName = assigneeName,
    createdAt    = createdAt ?: "",
)

private fun CrmTicketEntity.toDomain() = Ticket(
    id              = id,
    subject         = title,
    description     = description,
    status          = status,
    priority        = priority,
    breached        = slaBreached,
    slaResponseDue  = null,
    contactName     = contactName,
    assigneeName    = assigneeName,
    createdAt       = createdAt ?: "",
)
