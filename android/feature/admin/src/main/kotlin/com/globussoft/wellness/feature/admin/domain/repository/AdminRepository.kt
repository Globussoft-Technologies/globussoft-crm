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
