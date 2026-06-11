import Foundation

extension AppointmentDTO {
    func toDomain() -> Appointment {
        Appointment(
            id: id,
            doctorName: doctorName,
            serviceName: serviceName,
            appointmentDate: appointmentDate,
            status: AppointmentStatus(rawValue: status) ?? .booked,
            reason: reason,
            doctorAssigned: doctorAssigned ?? false,
            bookingType: bookingType,
            videoCallUrl: videoCallUrl,
            canCancel: canCancel ?? true,
            canReschedule: canReschedule ?? true
        )
    }
}

extension VisitDTO {
    func toDomain() -> Visit {
        Visit(
            id: id,
            visitDate: visitDate,
            status: status,
            serviceName: service?.name ?? "—",
            doctorName: doctor?.name ?? "—",
            locationName: locationName,
            bookingType: bookingType,
            videoCallUrl: videoCallUrl,
            amountCharged: amountCharged ?? 0
        )
    }
}

extension WaitlistEntryDTO {
    func toDomain() -> WaitlistEntry {
        WaitlistEntry(
            id: id,
            serviceId: serviceId,
            serviceName: serviceName,
            status: WaitlistEntry.WaitlistStatus(rawValue: status) ?? .pending,
            notes: notes,
            createdAt: createdAt
        )
    }
}

extension ProductDTO {
    func toDomain() -> Product {
        Product(
            id: id, name: name, description: description,
            basePrice: basePrice, discountedPrice: discountedPrice,
            categoryId: categoryId, category: category,
            durationMin: durationMin, isActive: isActive ?? true
        )
    }
}

extension BookAppointmentRequest {
    func toDTO() -> BookAppointmentDTO {
        BookAppointmentDTO(
            appointmentDate: appointmentDate,
            appointmentTime: appointmentTime,
            reason: reason,
            doctorId: doctorId,
            serviceId: serviceId,
            membershipId: membershipId
        )
    }
}
