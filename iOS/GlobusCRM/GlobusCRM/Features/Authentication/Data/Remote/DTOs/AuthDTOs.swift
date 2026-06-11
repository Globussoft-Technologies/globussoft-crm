import Foundation

struct LoginRequestDTO: Encodable {
    let email: String
    let password: String
}

struct RegisterRequestDTO: Encodable {
    let email: String
    let password: String
    let name: String
    let registrationTenantId: Int
}

struct AuthResponseDTO: Decodable {
    let token: String
    let user: UserDTO
    let tenant: TenantDTO?

    struct UserDTO: Decodable {
        let id: Int
        let email: String
        let name: String
        let userType: String?
    }

    struct TenantDTO: Decodable {
        let id: Int
        let name: String
        let slug: String
        let brandColor: String?
        let logoUrl: String?
    }
}

struct TenantBrandingResponseDTO: Decodable {
    let tenant: TenantInfo

    struct TenantInfo: Decodable {
        let id: Int
        let slug: String
        let name: String
        let brandColor: String?
        let logoUrl: String?
        let tagline: String?
    }
}

struct AuthPatientProfileDTO: Decodable {
    let id: Int
    let name: String
    let phone: String?
    let email: String?
    let dob: String?
    let gender: String?
}

struct PatientPermissionsDTO: Decodable {
    let permissions: [String]
}

struct PortalHealthDTO: Decodable {
    let smsConfigured: Bool
}

struct UpdateAuthProfileDTO: Encodable {
    var name: String?
    var email: String?
    var currentPassword: String?
    var newPassword: String?
}

struct AuthProfileResponseDTO: Decodable {
    let id: Int
    let name: String
    let email: String
    let role: String
    let profilePicture: String?
    let createdAt: String?
}
