import Foundation

// GET /wellness/portal/prescriptions — plain array, no wrapper.
// `drugs` may be a JSON string, a real array, or a wrapped object depending on backend environment.
struct PrescriptionDTO: Decodable {
    let id: Int
    let visitId: Int?
    let drugs: String?
    let instructions: String?
    let pdfUrl: String?
    let visit: PrescriptionVisitDTO?
    let doctor: PrescriptionDoctorDTO?
    let createdAt: String?

    enum CodingKeys: String, CodingKey {
        case id, visitId, drugs, instructions, pdfUrl, visit, doctor, createdAt
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(Int.self, forKey: .id)
        visitId = try container.decodeIfPresent(Int.self, forKey: .visitId)
        instructions = try container.decodeIfPresent(String.self, forKey: .instructions)
        pdfUrl = try container.decodeIfPresent(String.self, forKey: .pdfUrl)
        visit = try container.decodeIfPresent(PrescriptionVisitDTO.self, forKey: .visit)
        doctor = try container.decodeIfPresent(PrescriptionDoctorDTO.self, forKey: .doctor)
        createdAt = try container.decodeIfPresent(String.self, forKey: .createdAt)

        if let stringValue = try? container.decodeIfPresent(String.self, forKey: .drugs) {
            drugs = stringValue
        } else if let jsonValue = try? container.decodeIfPresent(FlexibleJSONValue.self, forKey: .drugs) {
            drugs = jsonValue.jsonString
        } else {
            drugs = nil
        }
    }
}

struct PrescriptionVisitDTO: Decodable {
    let id: Int?
    let visitDate: String?
    let service: PrescriptionServiceDTO?
}

struct PrescriptionServiceDTO: Decodable {
    let name: String
}

struct PrescriptionDoctorDTO: Decodable {
    let id: Int?
    let name: String?
}

struct DrugDTO: Decodable {
    let id: String?
    let name: String?
    let dosage: String?
    let frequency: String?
    let duration: String?
    let instructions: String?
}

private enum FlexibleJSONValue: Decodable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: FlexibleJSONValue])
    case array([FlexibleJSONValue])
    case null

    init(from decoder: Decoder) throws {
        if let keyed = try? decoder.container(keyedBy: DynamicCodingKey.self) {
            var object: [String: FlexibleJSONValue] = [:]
            for key in keyed.allKeys {
                object[key.stringValue] = try keyed.decode(FlexibleJSONValue.self, forKey: key)
            }
            self = .object(object)
            return
        }

        if var unkeyed = try? decoder.unkeyedContainer() {
            var array: [FlexibleJSONValue] = []
            while !unkeyed.isAtEnd {
                array.append(try unkeyed.decode(FlexibleJSONValue.self))
            }
            self = .array(array)
            return
        }

        let single = try decoder.singleValueContainer()
        if single.decodeNil() {
            self = .null
        } else if let value = try? single.decode(String.self) {
            self = .string(value)
        } else if let value = try? single.decode(Double.self) {
            self = .number(value)
        } else if let value = try? single.decode(Bool.self) {
            self = .bool(value)
        } else {
            self = .null
        }
    }

    var jsonString: String? {
        if case .string(let value) = self {
            return value
        }

        guard let object = jsonObject,
              JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(withJSONObject: object),
              let string = String(data: data, encoding: .utf8) else {
            return nil
        }
        return string
    }

    private var jsonObject: Any? {
        switch self {
        case .string(let value):
            return value
        case .number(let value):
            return value
        case .bool(let value):
            return value
        case .object(let value):
            return value.compactMapValues { $0.jsonObject }
        case .array(let value):
            return value.compactMap { $0.jsonObject }
        case .null:
            return NSNull()
        }
    }
}

private struct DynamicCodingKey: CodingKey {
    let stringValue: String
    let intValue: Int?

    init?(stringValue: String) {
        self.stringValue = stringValue
        self.intValue = nil
    }

    init?(intValue: Int) {
        self.stringValue = String(intValue)
        self.intValue = intValue
    }
}

// GET /wellness/patients/{patientId}/treatment-plans — plain array, no wrapper
// Real field names confirmed from Android staging 2026-06-04
struct TreatmentPlanDTO: Decodable {
    let id: Int
    let name: String
    let totalSessions: Int
    let completedSessions: Int
    let startedAt: String?
    let nextDueAt: String?
    let status: String
    let totalPrice: Double?
    let service: TreatmentServiceDTO?
}

struct TreatmentServiceDTO: Decodable {
    let id: Int?
    let name: String
    let category: String?
}

// GET /wellness/patients/{patientId}/consents — plain array, no wrapper
// Real field names confirmed from Android staging 2026-06-04
struct ConsentFormDTO: Decodable {
    let id: Int
    let templateName: String
    let signedAt: String?
    let hasPdfBlob: Bool?
    let service: ConsentServiceDTO?
}

struct ConsentServiceDTO: Decodable {
    let id: Int?
    let name: String
}
