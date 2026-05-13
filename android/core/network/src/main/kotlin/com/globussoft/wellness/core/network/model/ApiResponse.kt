package com.globussoft.wellness.core.network.model

/**
 * Generic API envelope returned by every Globussoft Wellness CRM endpoint.
 *
 * [success] — true when the request completed without error.
 * [data]    — typed payload; null on error responses.
 * [message] — informational message from the server (e.g. "Patient created").
 * [error]   — error detail string; non-null only when [success] is false.
 * [total]   — total record count for paginated responses; null on non-list calls.
 */
data class ApiResponse<T>(
    val success: Boolean,
    val data: T?,
    val message: String?,
    val error: String?,
    val total: Int?,
)

/**
 * Discriminated union for network call outcomes at the call-site layer.
 *
 * Distinct from [com.globussoft.wellness.core.common.result.WResult] — this
 * type lives in the network module and is mapped to WResult by [safeApiCall]
 * before crossing into repository / domain layers.
 */
sealed class NetworkResult<out T> {
    data class Success<T>(val data: T) : NetworkResult<T>()
    data class Error(val code: Int, val message: String) : NetworkResult<Nothing>()
    data object NetworkError : NetworkResult<Nothing>()
    data object Loading : NetworkResult<Nothing>()
}
