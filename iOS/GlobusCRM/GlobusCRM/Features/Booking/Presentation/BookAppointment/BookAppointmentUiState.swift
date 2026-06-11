import Foundation

struct BookAppointmentUiState {
    var step: Int = 1
    var isLoading: Bool = false
    var error: String? = nil
    // Step 1
    var services: [Product] = []
    var categories: [ProductCategory] = []
    var serviceSearchQuery: String = ""
    var selectedService: Product? = nil
    // Step 2
    var doctors: [DoctorOption] = []
    var selectedDoctorId: Int? = nil     // nil = no preference
    var selectedDoctorName: String? = nil
    // Step 3
    var selectedDate: Date = DateUtil.tomorrow()
    var selectedTime: String = "09:00"
    // Step 4
    var reason: String = ""
    var membershipId: Int? = nil
    var isBooking: Bool = false
    var bookingSuccess: Appointment? = nil
}

enum BookAppointmentUiEvent {
    case loadServices
    case selectService(Product)
    case searchChanged(String)
    case loadDoctors
    case selectDoctor(DoctorOption)
    case nextStep
    case dateChanged(Date)
    case timeChanged(String)
    case reasonChanged(String)
    case membershipChanged(Int?)
    case confirm
    case back
    case reset
}
