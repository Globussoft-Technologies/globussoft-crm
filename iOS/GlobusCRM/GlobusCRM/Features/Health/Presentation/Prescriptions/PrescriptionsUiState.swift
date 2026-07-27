import Foundation

struct PrescriptionsUiState {
    var isLoading: Bool = false
    var hasLoaded: Bool = false
    var prescriptions: [Prescription] = []
    var error: String? = nil
    var reminderEnabledIds: Set<String> = []
    var reminderActionInProgressId: String? = nil
    var reminderMessage: String? = nil
    var selectedPrescription: Prescription? = nil
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
    case toggleReminder(Prescription, Bool)
    case dismissReminderMessage
}

enum PrescriptionsNavSignal {
    case openPdf(prescriptionId: Int)
}
