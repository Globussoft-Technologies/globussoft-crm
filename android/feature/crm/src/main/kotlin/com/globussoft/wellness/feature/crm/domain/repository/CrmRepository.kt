package com.globussoft.wellness.feature.crm.domain.repository

import com.globussoft.wellness.core.common.result.WResult
import com.globussoft.wellness.core.domain.model.Approval
import com.globussoft.wellness.core.domain.model.Campaign
import com.globussoft.wellness.core.domain.model.Contact
import com.globussoft.wellness.core.domain.model.Deal
import com.globussoft.wellness.core.domain.model.DealInsight
import com.globussoft.wellness.core.domain.model.DealStats
import com.globussoft.wellness.core.domain.model.Estimate
import com.globussoft.wellness.core.domain.model.Expense
import com.globussoft.wellness.core.domain.model.ForecastEntry
import com.globussoft.wellness.core.domain.model.Invoice
import com.globussoft.wellness.core.domain.model.Pipeline
import com.globussoft.wellness.core.domain.model.CrmTask
import com.globussoft.wellness.core.domain.model.Ticket

interface CrmRepository {

    // ── Contacts ─────────────────────────────────────────────────────────────
    suspend fun getContacts(status: String? = null, search: String? = null, skip: Int = 0): WResult<List<Contact>>
    suspend fun getContact(id: String): WResult<Contact>
    suspend fun createContact(name: String, email: String?, phone: String?, company: String?, source: String?, status: String?): WResult<Contact>
    suspend fun updateContact(id: String, name: String, email: String?, phone: String?, company: String?, source: String?): WResult<Contact>
    suspend fun deleteContact(id: String): WResult<Unit>

    // ── Deals ────────────────────────────────────────────────────────────────
    suspend fun getDeals(stage: String? = null, status: String? = null, search: String? = null, skip: Int = 0): WResult<List<Deal>>
    suspend fun getDealStats(): WResult<DealStats>
    suspend fun getDeal(id: String): WResult<Deal>
    suspend fun createDeal(title: String, amount: Double, stage: String, pipelineId: String?, contactId: String?, probability: Int): WResult<Deal>
    suspend fun updateDeal(id: String, params: Map<String, Any>): WResult<Deal>

    // ── Pipelines ─────────────────────────────────────────────────────────────
    suspend fun getPipelines(): WResult<List<Pipeline>>

    // ── Tickets ───────────────────────────────────────────────────────────────
    suspend fun getTickets(status: String? = null, priority: String? = null, skip: Int = 0): WResult<List<Ticket>>
    suspend fun getTicket(id: String): WResult<Ticket>
    suspend fun createTicket(subject: String, description: String?, priority: String): WResult<Ticket>
    suspend fun updateTicket(id: String, params: Map<String, Any>): WResult<Ticket>

    // ── Tasks ─────────────────────────────────────────────────────────────────
    suspend fun getTasks(status: String? = null, skip: Int = 0): WResult<List<CrmTask>>
    suspend fun createTask(title: String, description: String?, dueDate: String?, assigneeId: String?, priority: String? = null): WResult<CrmTask>
    suspend fun completeTask(id: String): WResult<CrmTask>

    // ── Invoices ──────────────────────────────────────────────────────────────
    suspend fun getInvoices(status: String? = null, skip: Int = 0): WResult<List<Invoice>>
    suspend fun getInvoice(id: String): WResult<Invoice>
    suspend fun sendInvoice(id: String): WResult<Invoice>
    suspend fun markInvoicePaid(id: String): WResult<Invoice>
    suspend fun voidInvoice(id: String): WResult<Invoice>
    suspend fun createInvoice(contactId: String?, dueDate: String?, notes: String?, lineItems: List<com.globussoft.wellness.core.network.model.request.InvoiceLineItemRequest>): WResult<Invoice>

    // ── Estimates ─────────────────────────────────────────────────────────────
    suspend fun getEstimates(status: String? = null, skip: Int = 0): WResult<List<Estimate>>
    suspend fun getEstimate(id: String): WResult<Estimate>
    suspend fun sendEstimate(id: String): WResult<Estimate>
    suspend fun createEstimate(contactId: String?, validUntil: String?, notes: String?, lineItems: List<com.globussoft.wellness.core.network.model.request.EstimateLineItemRequest>): WResult<Estimate>

    // ── Expenses ──────────────────────────────────────────────────────────────
    suspend fun getExpenses(category: String? = null, skip: Int = 0): WResult<List<Expense>>
    suspend fun approveExpense(id: String): WResult<Expense>
    suspend fun rejectExpense(id: String): WResult<Expense>
    suspend fun createExpense(title: String, amount: Double, category: String, date: String, notes: String?, status: String? = null): WResult<Expense>

    // ── Forecasting ───────────────────────────────────────────────────────────
    suspend fun getForecasting(): WResult<List<ForecastEntry>>

    // ── Deal Insights ─────────────────────────────────────────────────────────
    suspend fun getDealInsights(): WResult<List<DealInsight>>

    // ── Approvals ─────────────────────────────────────────────────────────────
    suspend fun getApprovals(status: String? = null, mine: Boolean? = null): WResult<List<Approval>>
    suspend fun approveApproval(id: String, comment: String?): WResult<Approval>
    suspend fun rejectApproval(id: String, comment: String?): WResult<Approval>

    // ── Campaigns ─────────────────────────────────────────────────────────────
    suspend fun getCampaigns(channel: String? = null, status: String? = null): WResult<List<Campaign>>
    suspend fun createCampaign(name: String, channel: String, subject: String, body: String, scheduledAt: String?): WResult<Campaign>
    suspend fun sendCampaign(id: String): WResult<Unit>

    // ── Reports ───────────────────────────────────────────────────────────────
    suspend fun getReports(from: String? = null, to: String? = null): WResult<Map<String, Any>>
    suspend fun getAgentPerformance(from: String? = null, to: String? = null): WResult<List<Map<String, Any>>>

    // ── Misc ──────────────────────────────────────────────────────────────────
    suspend fun getQuotas(): WResult<List<Map<String, Any>>>
    suspend fun createQuota(repName: String, target: Double): WResult<Map<String, Any>>
    suspend fun getWinLoss(from: String? = null, to: String? = null): WResult<Map<String, Any>>
    suspend fun getFunnel(): WResult<Map<String, Any>>
    suspend fun getSequences(): WResult<List<Map<String, Any>>>
    suspend fun toggleSequence(id: String, isActive: Boolean): WResult<Unit>
    suspend fun getTerritories(): WResult<List<Map<String, Any>>>
    suspend fun createTerritory(name: String, region: String): WResult<Map<String, Any>>
    suspend fun getLeadRoutingRules(): WResult<List<Map<String, Any>>>
    suspend fun createLeadRoutingRule(name: String, assignTo: String, type: String): WResult<Map<String, Any>>
    suspend fun getStaff(): WResult<List<Map<String, Any>>>
    suspend fun getSettings(): WResult<Map<String, Any>>
    suspend fun getChannels(): WResult<Map<String, Any>>
    suspend fun getKbArticles(search: String? = null): WResult<List<Map<String, Any>>>
    suspend fun getSurveys(): WResult<List<Map<String, Any>>>
    suspend fun getAuditLogs(page: Int = 1, entityType: String? = null, action: String? = null): WResult<Map<String, Any>>
    suspend fun createStaff(name: String, email: String, role: String): WResult<Map<String, Any>>
    suspend fun updateStaff(id: String, params: Map<String, Any>): WResult<Map<String, Any>>
    suspend fun createKbArticle(title: String, category: String, body: String): WResult<Map<String, Any>>
    suspend fun saveSettings(params: Map<String, Any>): WResult<Map<String, Any>>
    suspend fun getContracts(status: String? = null): WResult<List<Map<String, Any>>>
    suspend fun createContract(title: String, value: Double, startDate: String?, endDate: String?): WResult<Map<String, Any>>
    suspend fun getProjects(status: String? = null): WResult<List<Map<String, Any>>>
    suspend fun createProject(name: String, description: String?, deadline: String?): WResult<Map<String, Any>>
    suspend fun createSurvey(title: String): WResult<Map<String, Any>>
    suspend fun getEmailInbox(): WResult<List<Map<String, Any>>>
    suspend fun getSmsMessages(): WResult<List<Map<String, Any>>>
    suspend fun getWhatsAppInbox(): WResult<List<Map<String, Any>>>
    suspend fun getNotificationsFeed(): WResult<List<Map<String, Any>>>
    suspend fun getSharedInbox(status: String? = null): WResult<List<Map<String, Any>>>
    suspend fun assignSharedInboxItem(id: String, assigneeId: String): WResult<Map<String, Any>>

    // ── Wave 17 ───────────────────────────────────────────────────────────────
    suspend fun getDocumentViews(): WResult<List<Map<String, Any>>>
    suspend fun getDocumentTemplates(): WResult<List<Map<String, Any>>>
    suspend fun createDocumentTemplate(name: String, type: String): WResult<Map<String, Any>>
    suspend fun getIntegrations(): WResult<List<Map<String, Any>>>
    suspend fun getBookingPages(): WResult<List<Map<String, Any>>>
    suspend fun createBookingPage(name: String, description: String): WResult<Map<String, Any>>

    // ── Wave 15 gaps ──────────────────────────────────────────────────────────
    suspend fun getChatbots(): WResult<List<Map<String, Any>>>
    suspend fun getSignatures(): WResult<List<Map<String, Any>>>
    suspend fun createSignatureRequest(documentName: String, signerEmail: String): WResult<Map<String, Any>>
    suspend fun getSlaList(): WResult<List<Map<String, Any>>>
    suspend fun createSlaPolicy(name: String, responseHours: Int, resolutionHours: Int): WResult<Map<String, Any>>
    suspend fun getSocialMentions(): WResult<List<Map<String, Any>>>
    suspend fun getLandingPages(): WResult<List<Map<String, Any>>>
    suspend fun createLandingPage(name: String, slug: String): WResult<Map<String, Any>>
    suspend fun getMarketplaceLeads(): WResult<List<Map<String, Any>>>

    // ── Wave 20 ───────────────────────────────────────────────────────────────
    suspend fun globalSearch(query: String): WResult<Map<String, Any>>

    // ── Wave 18 ───────────────────────────────────────────────────────────────
    suspend fun getCustomReports(): WResult<List<Map<String, Any>>>
    suspend fun createCustomReport(name: String, entityType: String): WResult<Map<String, Any>>
    suspend fun getDashboardsList(): WResult<List<Map<String, Any>>>
    suspend fun createDashboardItem(name: String): WResult<Map<String, Any>>
    suspend fun getPlaybooks(): WResult<List<Map<String, Any>>>
    suspend fun createPlaybook(name: String, description: String): WResult<Map<String, Any>>
    suspend fun getLeadScores(): WResult<List<Map<String, Any>>>
    suspend fun getAbTests(): WResult<List<Map<String, Any>>>
    suspend fun createAbTest(name: String, variantA: String, variantB: String): WResult<Map<String, Any>>

    // ── Activities / Communications ──────────────────────────────────────────
    suspend fun getActivities(contactId: String? = null, dealId: String? = null): WResult<List<Map<String, Any>>>
    suspend fun logActivity(type: String, subject: String, body: String?, contactId: String?, dealId: String?): WResult<Map<String, Any>>
}
