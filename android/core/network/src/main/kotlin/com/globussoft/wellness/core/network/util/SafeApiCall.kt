package com.globussoft.wellness.core.network.util

import com.globussoft.wellness.core.common.result.WResult
import com.globussoft.wellness.core.domain.error.DomainError
import com.globussoft.wellness.core.network.model.ApiResponse
import com.globussoft.wellness.core.network.interceptor.NoConnectivityException
import retrofit2.Response

/**
 * Executes a suspend Retrofit [apiCall] and maps the result to [WResult].
 *
 * Mapping rules:
 * - HTTP 2xx + [ApiResponse.success] true + non-null [ApiResponse.data]
 *   → [WResult.Success]
 * - HTTP 2xx but [ApiResponse.success] false or null [ApiResponse.data]
 *   → [WResult.Error] with message from [ApiResponse.message]
 * - HTTP 401 → [WResult.Error] wrapping [DomainError.UnauthorizedError]
 * - HTTP 404 → [WResult.Error] wrapping [DomainError.NotFoundError]
 * - Any other non-2xx → [WResult.Error] wrapping [DomainError.ApiError]
 * - [NoConnectivityException] → [WResult.Error] wrapping [DomainError.NetworkError]
 * - Any other [Exception] → [WResult.Error] wrapping [DomainError.UnknownError]
 *
 * @param T The expected data type carried by [ApiResponse.data].
 * @param apiCall Suspend lambda that performs the Retrofit call and returns a
 *                raw [Response]<[ApiResponse]<[T]>>.
 * @return [WResult.Success] with the unwrapped data, or [WResult.Error] with a
 *         typed [DomainError] describing the failure.
 */
suspend fun <T> safeApiCall(
    apiCall: suspend () -> Response<ApiResponse<T>>,
): WResult<T> {
    return try {
        val response = apiCall()

        if (response.isSuccessful) {
            val body = response.body()
            when {
                body == null -> WResult.Error(
                    exception = DomainError.UnknownError("Empty response body"),
                )
                !body.success -> WResult.Error(
                    exception = DomainError.ApiError(
                        code = response.code(),
                        message = body.message ?: body.error ?: "Request failed",
                    ),
                    message = body.message ?: body.error,
                )
                body.data == null -> WResult.Error(
                    exception = DomainError.UnknownError(
                        body.message ?: "Response data is null",
                    ),
                )
                else -> WResult.Success(body.data)
            }
        } else {
            when (response.code()) {
                401 -> WResult.Error(exception = DomainError.UnauthorizedError())
                404 -> WResult.Error(exception = DomainError.NotFoundError())
                else -> WResult.Error(
                    exception = DomainError.ApiError(
                        code = response.code(),
                        message = response.message(),
                    ),
                )
            }
        }
    } catch (e: NoConnectivityException) {
        WResult.Error(exception = DomainError.NetworkError())
    } catch (e: Exception) {
        WResult.Error(
            exception = DomainError.UnknownError(e.message ?: "Unknown error"),
        )
    }
}
