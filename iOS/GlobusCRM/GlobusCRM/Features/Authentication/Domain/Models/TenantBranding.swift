import Foundation

struct TenantBranding {
    let id: Int
    let slug: String
    let name: String
    let brandColor: String?
    let logoUrl: String?
    let tagline: String?
}

struct PatientPermissions {
    let permissions: Set<String>

    func has(_ permission: String) -> Bool {
        permissions.contains(permission)
    }

    static let empty = PatientPermissions(permissions: [])
}
