package com.globussoft.wellness.core.domain.usecase

import kotlinx.coroutines.flow.Flow

/**
 * Base class for a use case that takes [Params] and returns a single
 * suspended [Result] value.
 *
 * Callers invoke via the [invoke] operator:
 * ```kotlin
 * val result = getPatientUseCase(GetPatientUseCase.Params(patientId))
 * ```
 */
abstract class UseCase<in Params, out Result> {

    /**
     * Core implementation — override this in every concrete use case.
     */
    abstract suspend fun execute(params: Params): Result

    /**
     * Delegates to [execute]; exists so callers can use the `invoke`
     * operator syntax instead of calling `execute` directly.
     */
    suspend operator fun invoke(params: Params): Result = execute(params)
}

/**
 * Base class for a use case that requires no input parameters and returns
 * a single suspended [Result] value.
 *
 * Callers invoke via the [invoke] operator:
 * ```kotlin
 * val data = getDashboardDataUseCase()
 * ```
 */
abstract class NoParamsUseCase<out Result> {

    abstract suspend fun execute(): Result

    suspend operator fun invoke(): Result = execute()
}

/**
 * Base class for a use case that takes [Params] and returns a cold [Flow]
 * of [Result] values (suitable for reactive / streaming use cases).
 *
 * Callers invoke via the [invoke] operator:
 * ```kotlin
 * observePatientsUseCase(ObservePatientsUseCase.Params(locationId))
 *     .collect { patients -> ... }
 * ```
 */
abstract class FlowUseCase<in Params, out Result> {

    abstract fun execute(params: Params): Flow<Result>

    operator fun invoke(params: Params): Flow<Result> = execute(params)
}
