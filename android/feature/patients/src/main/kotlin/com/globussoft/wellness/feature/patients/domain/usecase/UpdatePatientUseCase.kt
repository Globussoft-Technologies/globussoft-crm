package com.globussoft.wellness.feature.patients.domain.usecase

import com.globussoft.wellness.core.common.result.WResult
import com.globussoft.wellness.core.domain.model.Patient
import com.globussoft.wellness.core.domain.model.PatientForm
import com.globussoft.wellness.core.domain.usecase.UseCase
import com.globussoft.wellness.feature.patients.domain.repository.PatientsRepository
import javax.inject.Inject

/**
 * Updates an existing patient record on the server and refreshes the local cache.
 */
class UpdatePatientUseCase @Inject constructor(
    private val repository: PatientsRepository,
) : UseCase<UpdatePatientUseCase.Params, WResult<Patient>>() {

    /**
     * @param id   The server-side UUID of the patient to update.
     * @param form Updated field values. Blank optional fields are omitted by the
     *             mapper ([PatientForm.toRequest]) before the network call.
     */
    data class Params(
        val id: String,
        val form: PatientForm,
    )

    override suspend fun execute(params: Params): WResult<Patient> =
        repository.updatePatient(params.id, params.form)
}
