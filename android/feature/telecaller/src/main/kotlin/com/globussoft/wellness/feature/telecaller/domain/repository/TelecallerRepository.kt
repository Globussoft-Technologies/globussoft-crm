package com.globussoft.wellness.feature.telecaller.domain.repository

import com.globussoft.wellness.core.common.result.WResult
import com.globussoft.wellness.core.domain.model.Lead
import com.globussoft.wellness.core.domain.model.Service
import com.globussoft.wellness.core.network.model.request.DispositionRequest

/**
 * Contract for the Telecaller Queue data layer.
 *
 * [getQueue]    fetches the current tenant's telecaller lead queue (leads assigned
 *               to the current user or all leads if the user is MANAGER+).
 *
 * [getServices] fetches the active service catalog so the "Booked" disposition
 *               can present a real service dropdown instead of free-form text.
 *
 * [disposeLead] submits a disposition for the given [leadId] using the provided
 *               [request] body.  On success the backend removes the lead from the
 *               queue and records the disposition in the audit log.
 */
interface TelecallerRepository {

    /** Returns the ordered list of leads pending disposition. */
    suspend fun getQueue(): WResult<List<Lead>>

    /** Returns the active service catalog (id + name) for the Booked form dropdown. */
    suspend fun getServices(): WResult<List<Service>>

    /**
     * Submits a disposition for the given lead.
     *
     * @param leadId  The UUID of the lead being disposed.
     * @param request The disposition type, notes, and optional scheduling data.
     * @return [WResult.Success] with [Unit] on a 200 OK, or [WResult.Error] on failure.
     */
    suspend fun disposeLead(leadId: String, request: DispositionRequest): WResult<Unit>
}
