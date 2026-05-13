package com.globussoft.wellness.core.domain.model

/**
 * Authenticated user as returned by the Globussoft Wellness CRM API.
 *
 * [userId]       — server-side UUID; matches `req.user.userId` in the backend.
 * [role]         — RBAC role governing API access: ADMIN / MANAGER / USER.
 * [wellnessRole] — optional wellness-vertical role; null for generic-tenant users.
 * [vertical]     — tenant vertical (`"generic"` or `"wellness"`).
 */
data class User(
    val userId: String,
    val email: String,
    val name: String,
    val role: UserRole,
    val wellnessRole: WellnessRole?,
    val tenantId: String,
    val tenantName: String,
    val vertical: String,
)

/** Top-level RBAC roles — mirrors the backend `User.role` enum. */
enum class UserRole { ADMIN, MANAGER, USER }

/**
 * Wellness-vertical sub-roles — orthogonal to [UserRole].
 * Mirrors the backend `User.wellnessRole` enum.
 */
enum class WellnessRole { DOCTOR, PROFESSIONAL, TELECALLER, HELPER }
