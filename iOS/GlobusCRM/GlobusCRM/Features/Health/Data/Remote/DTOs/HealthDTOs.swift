import Foundation

// GET /wellness/portal/prescriptions — plain array, no wrapper
// visit and doctor are nested objects
struct PrescriptionDTO: Decodable {
    let id: Int
    let visitId: Int?
    let drugs: String?
    let instructions: String?
    let pdfUrl: String?
    let visit: PrescriptionVisitDTO?
    let doctor: PrescriptionDoctorDTO?
    let createdAt: String?
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
