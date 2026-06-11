import Foundation

struct Prescription: Identifiable, Equatable {
    let id: String
    let visitDate: String
    let serviceName: String
    let doctorName: String
    let drugs: [Drug]
    let instructions: String?
    let pdfUrl: String?
    var cachedPdfData: Data?
    var pdfCachedAt: Date?
}

struct Drug: Identifiable, Equatable {
    let id: String
    let name: String
    let dosage: String?
    let frequency: String?
    let duration: String?
    let instructions: String?
}
