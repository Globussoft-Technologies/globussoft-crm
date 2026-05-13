package com.globussoft.wellness.core.data.datastore

import com.globussoft.wellness.core.domain.model.UserRole
import com.globussoft.wellness.core.domain.model.WellnessRole

/**
 * Persisted representation of the logged-in user's identity and capabilities.
 *
 * Stored in [AuthDataStore] (DataStore Preferences) and reconstructed on
 * every app cold start without requiring a network round-trip.
 *
 * Convenience properties ([isAdmin], [isManager], [isTelecaller], [isDoctor])
 * are derived from [role] and [wellnessRole] so UI layers can gate features
 * without re-evaluating the role logic in every composable.
 *
 * [vertical] — "wellness" or "generic"; determines which navigation graph
 *              the app launches after login.
 */
data class UserSession(
    val accessToken: String,
    val userId: String,
    val email: String,
    val name: String,
    val role: UserRole,
    val wellnessRole: WellnessRole?,
    val tenantId: String,
    val tenantName: String,
    val vertical: String,
) {
    /** True when the user has full administrative access. */
    val isAdmin: Boolean get() = role == UserRole.ADMIN

    /**
     * True when the user can access manager-level features (reports, staff
     * management, service catalog edits).
     */
    val isManager: Boolean get() = role == UserRole.ADMIN || role == UserRole.MANAGER

    /** True when the user's wellness sub-role is TELECALLER. */
    val isTelecaller: Boolean get() = wellnessRole == WellnessRole.TELECALLER

    /** True when the user's wellness sub-role is DOCTOR. */
    val isDoctor: Boolean get() = wellnessRole == WellnessRole.DOCTOR
}
