package com.globussoft.wellness.feature.services.domain.repository

import com.globussoft.wellness.core.common.result.WResult
import com.globussoft.wellness.core.domain.model.Service

/**
 * Repository contract for the Services feature.
 *
 * The services catalog is an admin-managed resource — create, update, and
 * delete are available only to ADMIN-role users. The mobile app enforces this
 * at the UI layer (buttons are shown/hidden by role), but the repository
 * exposes the full write surface so that admin users on mobile can manage
 * the catalog without switching to the web app.
 *
 * All methods return [WResult] so the presentation layer handles
 * Loading / Success / Error consistently without catching raw exceptions.
 */
interface ServicesRepository {

    /** Returns the full service catalog (active + inactive) for the tenant. */
    suspend fun getServices(): WResult<List<Service>>

    /**
     * Creates a new service entry.
     *
     * [params] keys match the API request body:
     * - `name`           (String, required)
     * - `category`       (String, optional — "aesthetics" | "dermatology" | "wellness" | "other")
     * - `ticketTier`     (String, optional — "high" | "medium" | "low")
     * - `basePrice`      (Double, required — must be ≥ 1.0)
     * - `durationMin`    (Int, optional — defaults 30 on the server)
     * - `targetRadiusKm` (Double, optional — only meaningful for AT_HOME services)
     * - `description`    (String, optional)
     */
    suspend fun createService(params: Map<String, Any>): WResult<Service>

    /**
     * Updates an existing service identified by [id].
     *
     * [params] follow the same shape as [createService]; only supplied keys
     * are patched (the API performs a partial update via PUT with full body
     * — omitting a field means the existing value is preserved).
     */
    suspend fun updateService(id: String, params: Map<String, Any>): WResult<Service>

    /**
     * Deletes the service identified by [id].
     *
     * The API soft-deletes (sets `isActive = false`) rather than hard-deleting
     * so historical visit records remain intact. The returned [WResult.Success]
     * carries [Unit].
     */
    suspend fun deleteService(id: String): WResult<Unit>
}
