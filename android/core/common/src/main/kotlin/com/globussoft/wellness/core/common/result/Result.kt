package com.globussoft.wellness.core.common.result

/**
 * A discriminated union representing the outcome of an operation.
 *
 * [Success]  — operation completed; [data] holds the result value.
 * [Error]    — operation failed; [exception] carries the cause and
 *              [message] provides an optional human-readable override.
 * [Loading]  — operation is in progress; no data yet.
 */
sealed class WResult<out T> {

    data class Success<out T>(val data: T) : WResult<T>()

    data class Error(
        val exception: Throwable,
        val message: String? = null,
    ) : WResult<Nothing>()

    data object Loading : WResult<Nothing>()
}

// ---------------------------------------------------------------------------
// Extension functions
// ---------------------------------------------------------------------------

/**
 * Executes [action] with the contained value when this is [WResult.Success].
 * Returns the original [WResult] unchanged so calls can be chained.
 */
inline fun <T> WResult<T>.onSuccess(action: (T) -> Unit): WResult<T> {
    if (this is WResult.Success) action(data)
    return this
}

/**
 * Executes [action] with the contained [Throwable] and optional message
 * when this is [WResult.Error].
 * Returns the original [WResult] unchanged so calls can be chained.
 */
inline fun <T> WResult<T>.onError(action: (exception: Throwable, message: String?) -> Unit): WResult<T> {
    if (this is WResult.Error) action(exception, message)
    return this
}

/**
 * Returns the contained value when this is [WResult.Success], or `null` otherwise.
 */
fun <T> WResult<T>.getOrNull(): T? = if (this is WResult.Success) data else null

/**
 * `true` when this is [WResult.Loading].
 */
val <T> WResult<T>.isLoading: Boolean
    get() = this is WResult.Loading

// ---------------------------------------------------------------------------
// Safe-call factory
// ---------------------------------------------------------------------------

/**
 * Executes [block] inside a try/catch, wrapping the result in
 * [WResult.Success] on completion or [WResult.Error] if any [Throwable]
 * is thrown.
 */
suspend fun <T> safeCall(block: suspend () -> T): WResult<T> =
    try {
        WResult.Success(block())
    } catch (t: Throwable) {
        WResult.Error(exception = t, message = t.message)
    }
