import Foundation

enum HTTPMethod: String {
    case GET, POST, PUT, PATCH, DELETE
}

enum WellnessEndpoint {
    // Auth (absolute paths — bypass portal base URL)
    case login
    case register
    case authMe
    case updateAuthMe
    case uploadProfilePicture
    case deleteProfilePicture
    case uploadAvatar
    case changePassword
    // Tenant
    case tenantBranding(slug: String)
    // Portal
    case portalHealth
    case portalMe
    case portalPermissions
    case portalExport
    case fcmToken
    // Appointments
    case myAppointments(bucket: String)
    case bookAppointment
    case cancelAppointment(id: Int)
    case rescheduleAppointment(id: Int)
    case visits
    // Waitlist
    case waitlist
    case addWaitlist
    // Services & Doctors
    case services
    case doctors(date: String)
    case serviceCategories
    // Health (Int patientId — legacy)
    case prescriptions
    case prescriptionPdf(id: Int)
    case treatmentPlans(patientId: Int)
    case consents(patientId: Int)
    case consentPdf(id: Int)
    // Health (String patientId — new repos)
    case getPrescriptions(patientId: String)
    case getPrescriptionPdf(prescriptionId: String)
    case getTreatmentPlans(patientId: String)
    case getConsentForms(patientId: String)
    // Membership (Int — legacy)
    case myMemberships
    case membershipPlans
    // Membership (new repos)
    case getMembershipPlans
    case getMyMemberships(patientId: String)
    case joinMembership
    // Wallet / Finance (Int — legacy)
    case myTransactions
    case wallet(patientId: Int)
    case giftcardsStorefront
    case purchaseGiftCardOrder(id: Int)
    case purchaseGiftCardConfirm(id: Int)
    case payments
    case paymentsConfig
    case refundPayment(id: Int)
    // Wallet (new repos)
    case getWalletBalance(patientId: String)
    case getWalletTransactions(patientId: String)
    case getGiftCards(patientId: String)
    case redeemGiftCard
    // Loyalty (Int — legacy)
    case loyalty(patientId: Int)
    // Loyalty (new repos)
    case getLoyaltyBalance(patientId: String)
    case getLoyaltyTransactions(patientId: String)
    // Catalog (new repos)
    case getServices
    case getCategories
    case getServiceDetail(id: String)
    // Profile (new repos)
    case getPatientProfile(patientId: String)
    case updatePatientProfile(patientId: String)
    case getNotificationPreferences(patientId: String)
    case updateNotificationPreferences(patientId: String)
    case requestDataExport(patientId: String)
    case requestAccountDeletion(patientId: String)
    // Server Notifications
    case getNotifications(page: Int, limit: Int)
    case markNotificationRead(id: String)
    case markAllNotificationsRead
    // Payments
    case getPayments
    case getPaymentsConfig

    var path: String {
        switch self {
        case .login:                              return "auth/login"
        case .register:                           return "auth/customer/register"
        case .authMe:                             return "auth/me"
        case .updateAuthMe:                       return "auth/me"
        case .uploadProfilePicture:               return "auth/me/profile-picture"
        case .deleteProfilePicture:               return "auth/me/profile-picture"
        case .uploadAvatar:                       return "auth/me/profile-picture"
        case .changePassword:                     return "auth/me/change-password"
        case .tenantBranding(let slug):           return "wellness/public/tenant/\(slug)"
        case .portalHealth:                       return "wellness/portal/health"
        case .portalMe:                           return "wellness/portal/me"
        case .portalPermissions:                  return "wellness/portal/me/permissions"
        case .portalExport:                       return "wellness/portal/export"
        case .fcmToken:                           return "wellness/portal/me/fcm-token"
        case .myAppointments:                     return "wellness/portal/appointments"
        case .bookAppointment:                    return "wellness/portal/appointments/book"
        case .cancelAppointment(let id):          return "wellness/portal/appointments/\(id)/cancel"
        case .rescheduleAppointment(let id):      return "wellness/portal/appointments/\(id)/reschedule"
        case .visits:                             return "wellness/portal/visits"
        case .waitlist:                           return "wellness/waitlist"
        case .addWaitlist:                        return "wellness/waitlist"
        case .services:                           return "wellness/services"
        case .doctors:                            return "wellness/doctors/availability"
        case .serviceCategories:                  return "wellness/service-categories"
        case .prescriptions:                      return "wellness/portal/prescriptions"
        case .prescriptionPdf(let id):            return "wellness/portal/prescriptions/\(id)/pdf"
        case .treatmentPlans(let pid):            return "wellness/patients/\(pid)/treatment-plans"
        case .consents(let pid):                  return "wellness/patients/\(pid)/consents"
        case .consentPdf(let id):                 return "wellness/consents/\(id)/pdf"
        case .getPrescriptions:                   return "wellness/portal/prescriptions"
        case .getPrescriptionPdf(let id):         return "wellness/portal/prescriptions/\(id)/pdf"
        case .getTreatmentPlans(let pid):         return "wellness/patients/\(pid)/treatment-plans"
        case .getConsentForms(let pid):           return "wellness/patients/\(pid)/consents"
        case .myMemberships:                      return "wellness/appointments/my-memberships"
        case .membershipPlans:                    return "wellness/membership-plans"
        case .getMembershipPlans:                 return "wellness/membership-plans"
        case .getMyMemberships:                   return "wellness/appointments/my-memberships"
        case .joinMembership:                     return "wellness/portal/memberships/join"
        case .myTransactions:                     return "wellness/my-transactions"
        case .wallet(let pid):                    return "wellness/patients/\(pid)/wallet"
        case .giftcardsStorefront:                return "wellness/giftcards/storefront"
        case .purchaseGiftCardOrder(let id):      return "wellness/giftcards/\(id)/purchase/order"
        case .purchaseGiftCardConfirm(let id):    return "wellness/giftcards/\(id)/purchase/confirm"
        case .payments:                           return "payments"
        case .paymentsConfig:                     return "payments/config"
        case .refundPayment(let id):              return "payments/\(id)/refund"
        case .getWalletBalance(let pid):          return "wellness/patients/\(pid)/wallet"
        case .getWalletTransactions:              return "wellness/portal/wallet/transactions"
        case .getGiftCards:                       return "wellness/giftcards/storefront"
        case .redeemGiftCard:                     return "wellness/portal/giftcards/redeem"
        case .loyalty(let pid):                   return "wellness/loyalty/\(pid)"
        case .getLoyaltyBalance(let pid):         return "wellness/loyalty/\(pid)"
        case .getLoyaltyTransactions(let pid):    return "wellness/loyalty/\(pid)/transactions"
        case .getServices:                        return "wellness/services"
        case .getCategories:                      return "wellness/service-categories"
        case .getServiceDetail(let id):           return "wellness/services/\(id)"
        case .getPatientProfile:                  return "wellness/portal/me"
        case .updatePatientProfile:               return "wellness/portal/me"
        case .getNotificationPreferences:         return "wellness/portal/me/notification-preferences"
        case .updateNotificationPreferences:      return "wellness/portal/me/notification-preferences"
        case .requestDataExport:                  return "wellness/portal/export"
        case .requestAccountDeletion:             return "wellness/portal/me/delete-account"
        case .getNotifications:                   return "wellness/portal/me/notifications"
        case .markNotificationRead(let id):       return "wellness/portal/me/notifications/\(id)/read"
        case .markAllNotificationsRead:           return "wellness/portal/me/notifications/read-all"
        case .getPayments:                        return "payments"
        case .getPaymentsConfig:                  return "payments/config"
        }
    }

    var method: HTTPMethod {
        switch self {
        case .login, .register, .portalExport, .fcmToken, .bookAppointment,
             .cancelAppointment, .addWaitlist, .purchaseGiftCardOrder,
             .purchaseGiftCardConfirm, .refundPayment, .uploadProfilePicture,
             .uploadAvatar, .changePassword, .joinMembership, .redeemGiftCard,
             .requestDataExport, .requestAccountDeletion, .markAllNotificationsRead:
            return .POST
        case .markNotificationRead:
            return .PUT
        case .updateAuthMe, .updatePatientProfile, .updateNotificationPreferences:
            return .PUT
        case .rescheduleAppointment:
            return .PATCH
        case .deleteProfilePicture:
            return .DELETE
        default:
            return .GET
        }
    }

    var requiresAuth: Bool {
        switch self {
        case .login, .register, .tenantBranding, .portalHealth: return false
        default: return true
        }
    }

    var queryItems: [URLQueryItem]? {
        switch self {
        case .getNotifications(let page, let limit):
            return [URLQueryItem(name: "page", value: "\(page)"),
                    URLQueryItem(name: "limit", value: "\(limit)")]
        case .myAppointments(let bucket):
            return [URLQueryItem(name: "bucket", value: bucket)]
        case .services, .getServices:
            return [URLQueryItem(name: "public", value: "true")]
        case .serviceCategories, .getCategories:
            return [URLQueryItem(name: "public", value: "true")]
        case .doctors(let date):
            return [URLQueryItem(name: "date", value: date)]
        default: return nil
        }
    }
}
