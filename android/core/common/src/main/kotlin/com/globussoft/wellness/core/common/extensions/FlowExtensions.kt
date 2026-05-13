package com.globussoft.wellness.core.common.extensions

import com.globussoft.wellness.core.common.result.WResult
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.onStart

/**
 * Transforms a [Flow] of plain values into a [Flow] of [WResult].
 *
 * Emission order:
 *  1. [WResult.Loading] — immediately before the upstream starts collecting.
 *  2. [WResult.Success] — for every upstream value.
 *  3. [WResult.Error]   — when the upstream throws; the flow then completes.
 */
fun <T> Flow<T>.asResult(): Flow<WResult<T>> =
    map<T, WResult<T>> { WResult.Success(it) }
        .onStart { emit(WResult.Loading) }
        .catch { throwable -> emit(WResult.Error(exception = throwable, message = throwable.message)) }

/**
 * A side-effect operator for [Flow]<[WResult]<T>> that invokes the
 * appropriate callback without transforming the values.
 *
 * All three callbacks are optional; omit any you don't need.
 *
 * @param onSuccess called with the payload when the result is [WResult.Success].
 * @param onError   called with the exception and optional message when the result
 *                  is [WResult.Error].
 * @param onLoading called (no arguments) when the result is [WResult.Loading].
 */
fun <T> Flow<WResult<T>>.onEachResult(
    onSuccess: ((T) -> Unit)? = null,
    onError: ((exception: Throwable, message: String?) -> Unit)? = null,
    onLoading: (() -> Unit)? = null,
): Flow<WResult<T>> = map { result ->
    when (result) {
        is WResult.Success -> onSuccess?.invoke(result.data)
        is WResult.Error   -> onError?.invoke(result.exception, result.message)
        is WResult.Loading -> onLoading?.invoke()
    }
    result
}
