package com.globussoft.wellness.feature.patients.domain.usecase

import com.globussoft.wellness.core.common.result.WResult
import com.globussoft.wellness.core.domain.model.Patient
import com.globussoft.wellness.core.domain.model.PatientForm
import com.globussoft.wellness.core.domain.usecase.UseCase
import com.globussoft.wellness.feature.patients.domain.repository.PatientsRepository
import javax.inject.Inject

/**
 * Creates a new patient on the server and upserts the result to the local cache.
 *
 * @param params A [PatientForm] containing all required and optional patient fields.
 * @return [WResult.Success] with the created [Patient] (server-assigned ID populated),
 *         or [WResult.Error] on validation failure / network error.
 */
class CreatePatientUseCase @Inject constructor(
    private val repository: PatientsRepository,
) : UseCase<PatientForm, WResult<Patient>>() {

    override suspend fun execute(params: PatientForm): WResult<Patient> =
        repository.createPatient(params)
}
