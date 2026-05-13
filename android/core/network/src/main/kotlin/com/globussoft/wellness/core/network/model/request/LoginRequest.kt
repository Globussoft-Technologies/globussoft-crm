package com.globussoft.wellness.core.network.model.request

/**
 * Request body for POST /api/auth/login.
 *
 * Maps directly to the JSON object `{ "email": "...", "password": "..." }`
 * accepted by the backend auth route.
 */
data class LoginRequest(
    val email: String,
    val password: String,
)
