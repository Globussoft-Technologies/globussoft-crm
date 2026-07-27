import Foundation

extension PrescriptionDTO {
    func toDomain() -> Prescription {
        let parsedDrugs = PrescriptionDrugParser.parse(drugs)
        return Prescription(
            id: String(id),
            visitId: visitId.map(String.init) ?? visit?.id.map(String.init),
            visitDate: visit?.visitDate ?? createdAt ?? "",
            serviceName: visit?.service?.name.nonBlank ?? "Prescription",
            doctorName: doctor?.name?.nonBlank ?? "",
            drugs: parsedDrugs,
            instructions: instructions,
            pdfUrl: pdfUrl,
            cachedPdfData: nil,
            pdfCachedAt: nil
        )
    }
}

nonisolated private enum PrescriptionDrugParser {
    static func parse(_ json: String?) -> [Drug] {
        guard let json = json?.trimmingCharacters(in: .whitespacesAndNewlines),
              !json.isEmpty,
              json.lowercased() != "null",
              let data = json.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) else {
            return []
        }
        return parseDrugList(from: object)
    }

    private static func parseDrugList(from object: Any) -> [Drug] {
        if let array = object as? [Any] {
            return array.compactMap { ($0 as? [String: Any]).flatMap(drug(from:)) }
        }

        guard let dict = object as? [String: Any] else { return [] }

        for key in ["drugs", "medications", "items", "data"] {
            if let wrapped = dict[key] {
                let drugs = parseDrugList(from: wrapped)
                if !drugs.isEmpty { return drugs }
            }
        }

        return drug(from: dict).map { [$0] } ?? []
    }

    private static func drug(from dict: [String: Any]) -> Drug? {
        let nestedDrug = nestedObject(in: dict, keys: ["drug", "medicine", "medication", "product"])
        let name = firstString(in: dict, keys: [
            "name", "drugName", "medicineName", "medicationName", "title", "label"
        ]) ?? nestedDrug.flatMap {
            firstString(in: $0, keys: ["name", "drugName", "medicineName", "title", "label"])
        }

        guard let name, !name.isEmpty else { return nil }

        return Drug(
            id: firstString(in: dict, keys: ["id", "drugId", "medicineId"]) ?? UUID().uuidString,
            name: name,
            dosage: firstString(in: dict, keys: ["dosage", "dose", "dosageValue", "quantity", "strength"])
                ?? nestedDrug.flatMap {
                    firstString(in: $0, keys: ["dosage", "dose", "dosageValue", "quantity", "strength"])
                }
                ?? strengthString(in: dict)
                ?? nestedDrug.flatMap { strengthString(in: $0) },
            frequency: firstString(in: dict, keys: [
                "frequency", "frequencyPerDay", "dailyFrequency", "timesPerDay", "times",
                "perDay", "noOfTimes", "numberOfTimes"
            ]) ?? nestedDrug.flatMap {
                firstString(in: $0, keys: [
                    "frequency", "frequencyPerDay", "dailyFrequency", "timesPerDay", "times"
                ])
            },
            duration: firstString(in: dict, keys: [
                "duration", "durationDays", "days", "noOfDays", "numberOfDays", "courseDuration"
            ]) ?? nestedDrug.flatMap {
                firstString(in: $0, keys: ["duration", "durationDays", "days", "noOfDays"])
            },
            instructions: firstString(in: dict, keys: ["instructions", "instruction", "notes", "remarks"])
                ?? nestedDrug.flatMap {
                    firstString(in: $0, keys: ["instructions", "instruction", "notes", "remarks"])
                }
        )
    }

    private static func nestedObject(in dict: [String: Any], keys: [String]) -> [String: Any]? {
        keys.lazy.compactMap { dict[$0] as? [String: Any] }.first
    }

    private static func firstString(in dict: [String: Any], keys: [String]) -> String? {
        keys.lazy.compactMap { key -> String? in
            guard let value = dict[key], !(value is NSNull) else { return nil }
            if let string = value as? String {
                return nonBlank(string)
            }
            if let number = value as? NSNumber {
                return nonBlank("\(number)")
            }
            return nil
        }.first
    }

    private static func strengthString(in dict: [String: Any]) -> String? {
        guard let value = firstString(in: dict, keys: ["strengthValue", "strengthAmount", "strength"]) else {
            return nil
        }
        guard let unit = firstString(in: dict, keys: ["strengthUnit", "unit"]) else {
            return value
        }
        return "\(value) \(unit)"
    }

    private static func nonBlank(_ value: String) -> String? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty || trimmed.lowercased() == "null" ? nil : trimmed
    }
}

private extension String {
    var nonBlank: String? {
        let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty || trimmed.lowercased() == "null" ? nil : trimmed
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
