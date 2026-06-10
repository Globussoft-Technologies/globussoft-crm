package com.globus.crm.feature.health.domain.repository

import com.globus.crm.feature.health.domain.model.ConsentForm

interface ConsentFormRepository {
    suspend fun getConsentForms(): List<ConsentForm>
    suspend fun getConsentFormPdf(consentId: Int): ByteArray
}
