package com.globussoft.wellness.core.network.model.response

/**
 * Payload returned inside [ApiResponse.data] for POST /api/auth/login.
 *
 * The [token] is a JWT that must be attached as `Authorization: Bearer <token>`
 * on every subsequent API request.
 */
data class LoginResponse(
    val token: String,
    val user: UserResponse,
)

/**
 * Authenticated user descriptor embedded in [LoginResponse].
 *
 * [userId]       — server-side UUID; maps to `req.user.userId` in backend middleware.
 * [wellnessRole] — null for generic-tenant users.
 * [vertical]     — tenant vertical; "wellness" or "generic".
 */
data class UserResponse(
    val userId: String,
    val email: String,
    val name: String,
    val role: String,
    val wellnessRole: String?,
    val tenantId: String,
    val tenantName: String,
    val vertical: String,
)
