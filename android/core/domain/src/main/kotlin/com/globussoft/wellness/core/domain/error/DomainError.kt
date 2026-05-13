package com.globussoft.wellness.core.domain.error

/**
 * Sealed hierarchy of domain-layer errors.
 *
 * Each subclass corresponds to a distinct failure mode so that UI layers
 * and repository implementations can switch exhaustively without a
 * catch-all fallback whenever the domain is the error source.
 *
 * Extend [Exception] (not [Throwable]) so instances can be thrown and
 * caught in standard try/catch blocks alongside platform exceptions.
 */
sealed class DomainError : Exception() {

    /**
     * The device has no active internet connection at the time of the call.
     * The operation was not attempted / should be retried when connectivity
     * is restored.
     */
    data class NetworkError(
        override val message: String = "No internet connection",
    ) : DomainError()

    /**
     * The server responded with a non-2xx HTTP status code.
     *
     * [code]    — HTTP status code (e.g. 400, 422, 500).
     * [message] — human-readable error body from the API response.
     */
    data class ApiError(
        val code: Int,
        override val message: String,
    ) : DomainError()

    /**
     * The server returned HTTP 401 — the JWT has expired or is invalid.
     * The app should clear local credentials and redirect to the login screen.
     */
    data class UnauthorizedError(
        override val message: String = "Session expired. Please login again.",
    ) : DomainError()

    /**
     * The requested resource was not found (HTTP 404 or an empty-result
     * condition treated as an error by the domain layer).
     */
    data class NotFoundError(
        override val message: String = "Resource not found",
    ) : DomainError()

    /**
     * Input validation failed before the network call was made, or the
     * server returned HTTP 422 with a field-level error.
     *
     * [message] describes which field(s) are invalid and why.
     */
    data class ValidationError(
        override val message: String,
    ) : DomainError()

    /**
     * Catch-all for errors that don't fit the above categories (e.g.
     * unexpected JSON parsing failures, null-pointer conditions, etc.).
     */
    data class UnknownError(
        override val message: String = "Something went wrong",
    ) : DomainError()
}

// ---------------------------------------------------------------------------
// Conversion helper
// ---------------------------------------------------------------------------

/**
 * Maps any [Throwable] to the most appropriate [DomainError] subclass.
 *
 * [DomainError] instances are returned unchanged (identity mapping).
 * All other throwables become [DomainError.UnknownError] preserving the
 * original message so nothing is silently swallowed.
 */
fun Throwable.toDomainError(): DomainError = when (this) {
    is DomainError -> this
    else           -> DomainError.UnknownError(message ?: "Unknown error")
}
