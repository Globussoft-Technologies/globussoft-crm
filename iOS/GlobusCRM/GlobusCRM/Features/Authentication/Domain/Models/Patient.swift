import Foundation

struct Patient {
    let id: Int
    let name: String
    let email: String
    let phone: String?
    let dob: String?
    let gender: String?
}

struct AuthUser {
    let id: Int
    let name: String
    let email: String
    let role: String
    let profilePicture: String?
}
