import Foundation

extension TenantBrandingResponseDTO.TenantInfo {
    func toDomain() -> TenantBranding {
        TenantBranding(id: id, slug: slug, name: name,
                       brandColor: brandColor, logoUrl: logoUrl, tagline: tagline)
    }
}

extension AuthPatientProfileDTO {
    func toDomain() -> Patient {
        Patient(id: id, name: name, email: email ?? "",
                phone: phone, dob: dob, gender: gender)
    }
}

extension PatientPermissionsDTO {
    func toDomain() -> PatientPermissions {
        PatientPermissions(permissions: Set(permissions))
    }
}

extension AuthProfileResponseDTO {
    func toDomain() -> AuthUser {
        AuthUser(id: id, name: name, email: email, role: role, profilePicture: profilePicture)
    }
}
