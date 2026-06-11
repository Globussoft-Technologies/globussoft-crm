import Foundation

extension PrescriptionDTO {
    func toDomain() -> Prescription {
        // drugs field is a JSON-encoded string, must parse manually
        var parsedDrugs: [Drug] = []
        if let drugsString = drugs,
           let data = drugsString.data(using: .utf8),
           let array = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] {
            parsedDrugs = array.map { dict in
                Drug(
                    id: dict["id"] as? String ?? UUID().uuidString,
                    name: dict["name"] as? String ?? "",
                    dosage: dict["dosage"] as? String,
                    frequency: dict["frequency"] as? String,
                    duration: dict["duration"] as? String,
                    instructions: dict["instructions"] as? String
                )
            }
        }
        return Prescription(
            id: String(id),
            visitDate: visit?.visitDate ?? createdAt ?? "",
            serviceName: visit?.service?.name ?? "",
            doctorName: doctor?.name ?? "",
            drugs: parsedDrugs,
            instructions: instructions,
            pdfUrl: pdfUrl,
            cachedPdfData: nil,
            pdfCachedAt: nil
        )
    }
}

extension TreatmentPlanDTO {
    func toDomain() -> TreatmentPlan {
        TreatmentPlan(
            id: String(id),
            name: name,
            serviceName: service?.name,
            serviceCategory: service?.category,
            startedAt: startedAt,
            nextDueAt: nextDueAt,
            sessionsTotal: totalSessions,
            sessionsCompleted: completedSessions,
            status: status,
            totalPrice: totalPrice
        )
    }
}

extension ConsentFormDTO {
    func toDomain() -> ConsentForm {
        ConsentForm(
            id: String(id),
            title: templateName,
            signedAt: signedAt,
            isSigned: signedAt != nil,
            formType: service?.name ?? "Consent",
            serviceName: service?.name,
            hasPdfBlob: hasPdfBlob ?? false,
            visitId: nil
        )
    }
}
