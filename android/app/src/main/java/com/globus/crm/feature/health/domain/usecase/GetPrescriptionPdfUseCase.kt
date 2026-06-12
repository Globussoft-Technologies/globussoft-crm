package com.globus.crm.feature.health.domain.usecase

import com.globus.crm.core.util.Result
import com.globus.crm.feature.health.domain.repository.PrescriptionRepository
import retrofit2.HttpException
import java.io.IOException
import javax.inject.Inject

class GetPrescriptionPdfUseCase @Inject constructor(
    private val repository: PrescriptionRepository,
) {
    suspend operator fun invoke(prescriptionId: Int): Result<ByteArray> = try {
        val cached = repository.getCachedPdf(prescriptionId)
        if (cached != null) {
            Result.Success(cached)
        } else {
            val pdfBytes = repository.getPrescriptionPdf(prescriptionId)
            repository.savePdfToCache(prescriptionId, pdfBytes)
            Result.Success(pdfBytes)
        }
    } catch (e: HttpException) {
        Result.Error("HTTP_${e.code()}", e.message() ?: "Server error", e.code())
    } catch (e: IOException) {
        Result.Error("NETWORK_ERROR", "No internet connection. Please try again.")
    } catch (e: Exception) {
        Result.Error("UNEXPECTED_ERROR", e.message ?: "An unexpected error occurred")
    }
}
