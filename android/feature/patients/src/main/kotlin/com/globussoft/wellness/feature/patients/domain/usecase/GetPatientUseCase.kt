package com.globussoft.wellness.feature.patients.domain.usecase

import com.globussoft.wellness.core.common.result.WResult
import com.globussoft.wellness.core.domain.model.Patient
import com.globussoft.wellness.core.domain.usecase.UseCase
import com.globussoft.wellness.feature.patients.domain.repository.PatientsRepository
import javax.inject.Inject

/**
 * Fetches a single [Patient] by server-side UUID.
 *
 * @param params A String patient ID (aliased via [Params] wrapper for type safety).
 * @return [WResult.Success] with the [Patient], [WResult.Error] on network / not-found failure.
 */
class GetPatientUseCase @Inject constructor(
    private val repository: PatientsRepository,
) : UseCase<GetPatientUseCase.Params, WResult<Patient>>() {

    /**
     * @param id The server-side UUID of the patient to fetch.
     */
    data class Params(val id: String)

    override suspend fun execute(params: Params): WResult<Patient> =
        repository.getPatient(params.id)
}
