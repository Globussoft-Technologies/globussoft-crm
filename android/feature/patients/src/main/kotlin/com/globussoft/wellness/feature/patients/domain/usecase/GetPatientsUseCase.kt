package com.globussoft.wellness.feature.patients.domain.usecase

import com.globussoft.wellness.core.common.result.WResult
import com.globussoft.wellness.core.domain.usecase.FlowUseCase
import com.globussoft.wellness.feature.patients.domain.repository.PaginatedPatients
import com.globussoft.wellness.feature.patients.domain.repository.PatientsRepository
import kotlinx.coroutines.flow.Flow
import javax.inject.Inject

/**
 * Parameters for [GetPatientsUseCase].
 *
 * @param search Substring filter for patient name / phone. Empty string = all.
 * @param skip   Pagination offset.
 * @param limit  Page size.
 */
data class GetPatientsParams(
    val search: String = "",
    val skip: Int = 0,
    val limit: Int = 20,
)

/**
 * Returns a cold [Flow] of [WResult]<[PaginatedPatients]> from the repository.
 *
 * Delegates entirely to [PatientsRepository.getPatients] which implements the
 * offline-first strategy (Room cache → network refresh). The use-case layer
 * intentionally adds no transformation — callers need the raw [WResult] to
 * drive Loading / Success / Error states in the ViewModel.
 */
class GetPatientsUseCase @Inject constructor(
    private val repository: PatientsRepository,
) : FlowUseCase<GetPatientsParams, WResult<PaginatedPatients>>() {

    override fun execute(params: GetPatientsParams): Flow<WResult<PaginatedPatients>> =
        repository.getPatients(
            search = params.search,
            skip   = params.skip,
            limit  = params.limit,
        )
}
