import Foundation

struct ConsentForm: Identifiable, Equatable {
    let id: String
    let title: String
    let signedAt: String?
    let isSigned: Bool
    let formType: String
    let serviceName: String?
    let hasPdfBlob: Bool
    let visitId: String?
}
