import Foundation

struct PrescriptionsUiState {
    var isLoading: Bool = false
    var hasLoaded: Bool = false
    var prescriptions: [Prescription] = []
    var error: String? = nil
    var selectedPrescription: Prescription? = nil
    var isLoadingPdf: Bool = false
    var loadingPdfId: String? = nil
    var showPdfConfirm: Bool = false
    var pendingPdfPrescription: Prescription? = nil
}

enum PrescriptionsUiEvent {
    case load
    case selectPrescription(Prescription)
    case requestViewPdf(Prescription)
    case confirmViewPdf
    case dismissPdfConfirm
    case viewPdf(Prescription)
    case dismissPdf
}

enum PrescriptionsNavSignal {
    case showPdf(Data)
}
