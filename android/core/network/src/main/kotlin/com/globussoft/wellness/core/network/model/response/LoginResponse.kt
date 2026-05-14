package com.globussoft.wellness.core.network.model.response

/**
 * Payload returned directly by POST /api/auth/login.
 *
 * The [token] is a JWT that must be attached as `Authorization: Bearer <token>`
 * on every subsequent API request.
 *
 * Server shape:
 * {"token": "...", "user": {"id": 9, "email": "...", "name": "...", "role": "ADMIN",
 *  "wellnessRole": null},
 *  "tenant": {"id": 2, "name": "...", "vertical": "wellness",
 *   "defaultCurrency": "INR", "locale": "en-IN"}}
 */
data class LoginResponse(
    val token: String,
    val user: UserResponse,
    val tenant: TenantResponse,
)

/**
 * Authenticated user descriptor embedded in [LoginResponse].
 *
 * [id]           — server-side integer user ID.
 * [wellnessRole] — null for generic-tenant users.
 */
data class UserResponse(
    val id: Int,
    val email: String,
    val name: String,
    val role: String,
    val wellnessRole: String?,
)

/**
 * Tenant descriptor embedded in [LoginResponse].
 *
 * [vertical]        — "wellness" or "generic".
 * [defaultCurrency] — ISO currency code, e.g. "INR" or "USD".
 * [locale]          — BCP-47 locale string, e.g. "en-IN".
 */
data class TenantResponse(
    val id: Int,
    val name: String,
    val vertical: String,
    val defaultCurrency: String?,
    val locale: String?,
)
