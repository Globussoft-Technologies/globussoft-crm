//
//  GlobusCRMTests.swift
//  GlobusCRMTests
//
//  Created by GLB-BLR-M1 on 09/06/26.
//

import Foundation
import SwiftUI
import Testing
@testable import GlobusCRM

@MainActor
struct DeepLinkHandlerTests {
    @Test func resolvesKnownRouteWithIdentifier() {
        let url = URL(string: "wellnesspatient://screen/prescription?id=42")!

        if case .prescriptionPdf(let id) = DeepLinkHandler.resolve(url: url) {
            #expect(id == 42)
        } else {
            #expect(Bool(false), "Expected prescription PDF route")
        }
    }

    @Test func resolvesAndroidPrescriptionPdfAlias() {
        let url = URL(string: "globuscrm://screen/prescription_pdf?id=42")!

        if case .prescriptionPdf(let id) = DeepLinkHandler.resolve(url: url) {
            #expect(id == 42)
        } else {
            #expect(Bool(false), "Expected prescription PDF route")
        }
    }

    @Test func resolvesTreatmentAnalysisRouteWithVisitIdentifier() {
        let url = URL(string: "wellnesspatient://screen/prescription_analysis?id=42&visitId=9")!

        if case .treatmentAnalysis(let prescriptionId, let visitId) = DeepLinkHandler.resolve(url: url) {
            #expect(prescriptionId == "42")
            #expect(visitId == "9")
        } else {
            #expect(Bool(false), "Expected treatment analysis route")
        }
    }

    @Test func resolvesAndroidSchemeAndSnakeCaseAliases() {
        #expect(DeepLinkHandler.resolve(url: URL(string: "globuscrm://screen/treatment_plans")!) == .treatmentPlans)
        #expect(DeepLinkHandler.resolve(url: URL(string: "globuscrm://screen/consent_forms")!) == .consentForms)
        #expect(DeepLinkHandler.resolve(url: URL(string: "globuscrm://screen/gift_cards")!) == .giftCards)
        #expect(DeepLinkHandler.resolve(url: URL(string: "globuscrm://screen/visit_history")!) == .visitHistory)
        #expect(DeepLinkHandler.resolve(url: URL(string: "globuscrm://screen/profile")!) == .profile)
        #expect(DeepLinkHandler.resolve(url: URL(string: "globuscrm://screen/wallet/transactions")!) == .wallet)
    }

    @Test func rejectsUnknownSchemeAndScreen() {
        #expect(DeepLinkHandler.resolve(url: URL(string: "https://screen/wallet")!) == nil)
        #expect(DeepLinkHandler.resolve(url: URL(string: "wellnesspatient://screen/unknown")!) == nil)
    }
}

@MainActor
struct AppRouterTests {
    @Test func homeRoutesSwitchToHomeTabForDeepLinks() {
        let router = AppRouter()
        router.selectedTab = .finance

        router.navigate(to: .prescriptionPdf(prescriptionId: 42))

        #expect(router.selectedTab == .home)
        #expect(router.homePath == [.prescriptionPdf(prescriptionId: 42)])
    }
}

struct AppErrorTests {
    @Test func comparesHttpErrorsByStatusCode() {
        let first = AppError.http(statusCode: 404, message: "Missing", serverCode: "A")
        let second = AppError.http(statusCode: 404, message: "Not found", serverCode: "B")
        let different = AppError.http(statusCode: 500, message: "Failure", serverCode: nil)

        if case .http(let firstStatus, _, _) = first,
           case .http(let secondStatus, _, _) = second,
           case .http(let differentStatus, _, _) = different {
            #expect(firstStatus == secondStatus)
            #expect(firstStatus != differentStatus)
        } else {
            #expect(Bool(false), "Expected HTTP errors")
        }
    }
}

struct TreatmentAnalysisDraftTests {
    @Test func derivesUploadAndReviewStatus() {
        let beforeUploaded = TreatmentAnalysisDraft(
            prescriptionId: "42",
            analysisId: nil,
            beforeLocalPath: nil,
            beforeRemoteUrl: "",
            beforeCapturedAt: nil,
            afterLocalPath: nil,
            afterRemoteUrl: nil,
            afterCapturedAt: nil,
            status: .beforeUploaded,
            updatedAt: 0
        )

        let submitted = TreatmentAnalysisDraft(
            prescriptionId: "42",
            analysisId: nil,
            beforeLocalPath: nil,
            beforeRemoteUrl: nil,
            beforeCapturedAt: nil,
            afterLocalPath: nil,
            afterRemoteUrl: "https://example.test/after.jpg",
            afterCapturedAt: nil,
            status: .submittedForReview,
            updatedAt: 0
        )

        #expect(beforeUploaded.hasUploadedBefore)
        #expect(submitted.hasSubmittedAfter)
    }
}

struct MedicationReminderParserTests {
    @Test func parsesFrequencyVariants() {
        #expect("BD".medicationFrequencyPerDay() == 2)
        #expect("TDS".medicationFrequencyPerDay() == 3)
        #expect("1-0-1".medicationFrequencyPerDay() == 2)
        #expect("every 8 hours".medicationFrequencyPerDay() == 3)
    }

    @Test func parsesDurationVariants() {
        #expect("7 days".medicationDurationDays() == 7)
        #expect("2 weeks".medicationDurationDays() == 14)
        #expect("1 month".medicationDurationDays() == 30)
        #expect("ten days".medicationDurationDays() == 10)
    }
}

@MainActor
struct PrescriptionMappingTests {
    @Test func decodesArrayBackedDrugsAndMapsMedicationDetails() throws {
        let json = """
        {
          "id": 41,
          "visitId": 9,
          "drugs": [
            {
              "medicine": {
                "name": "Amoxicillin",
                "strengthValue": "500",
                "strengthUnit": "mg"
              },
              "frequencyPerDay": "BD",
              "durationDays": "5 days",
              "instruction": "After food"
            }
          ],
          "instructions": "<p>Complete the course</p>",
          "visit": {
            "id": 9,
            "visitDate": "2026-07-27T10:00:00Z",
            "service": { "name": "Skin Treatment" }
          },
          "doctor": { "id": 3, "name": "Dr. Harsh" },
          "createdAt": "2026-07-27T09:00:00Z"
        }
        """.data(using: .utf8)!

        let dto = try JSONDecoder().decode(PrescriptionDTO.self, from: json)
        let prescription = dto.toDomain()
        let drug = try #require(prescription.drugs.first)

        #expect(prescription.id == "41")
        #expect(prescription.visitId == "9")
        #expect(prescription.serviceName == "Skin Treatment")
        #expect(prescription.doctorName == "Dr. Harsh")
        #expect(drug.name == "Amoxicillin")
        #expect(drug.dosage == "500 mg")
        #expect(drug.frequency == "BD")
        #expect(drug.duration == "5 days")
        #expect(drug.instructions == "After food")
    }

    @Test func decodesWrappedDrugObjectsAndUsesPrescriptionFallbackTitle() throws {
        let json = """
        {
          "id": 42,
          "visitId": null,
          "drugs": {
            "medications": [
              {
                "medicineName": "Vitamin C",
                "dose": "1 tablet",
                "timesPerDay": "OD",
                "noOfDays": 10
              }
            ]
          },
          "visit": { "id": 12, "visitDate": "2026-07-28T10:00:00Z", "service": { "name": "" } },
          "doctor": { "name": "  " },
          "createdAt": "2026-07-27T09:00:00Z"
        }
        """.data(using: .utf8)!

        let dto = try JSONDecoder().decode(PrescriptionDTO.self, from: json)
        let prescription = dto.toDomain()
        let drug = try #require(prescription.drugs.first)

        #expect(prescription.visitId == "12")
        #expect(prescription.serviceName == "Prescription")
        #expect(prescription.doctorName == "")
        #expect(drug.name == "Vitamin C")
        #expect(drug.dosage == "1 tablet")
        #expect(drug.frequency == "OD")
        #expect(drug.duration == "10")
    }
}

@MainActor
struct ServiceImageMappingTests {
    @Test func bookingProductMapsImageUrl() throws {
        let json = """
        {
          "id": 7,
          "name": "Hydra Facial",
          "description": "Deep cleanse",
          "basePrice": 2500,
          "discountedPrice": 1999,
          "imageUrl": "/uploads/services/hydra.jpg",
          "categoryId": 2,
          "category": "Facials",
          "durationMin": 45,
          "isActive": true
        }
        """.data(using: .utf8)!

        let dto = try JSONDecoder().decode(ProductDTO.self, from: json)
        let product = dto.toDomain()

        #expect(product.imageUrl == "/uploads/services/hydra.jpg")
        #expect(product.category == "Facials")
    }

    @Test func catalogServiceExtractsFirstImageFromJsonList() throws {
        let json = """
        {
          "id": 8,
          "name": "Laser Treatment",
          "description": "Hair reduction",
          "basePrice": 6000,
          "discountedPrice": null,
          "currency": "INR",
          "durationMin": 60,
          "categoryId": 3,
          "category": "Laser",
          "imageUrls": "[\\"https://cdn.example.test/laser.jpg\\",\\"https://cdn.example.test/alt.jpg\\"]",
          "isActive": true
        }
        """.data(using: .utf8)!

        let dto = try JSONDecoder().decode(ServiceDTO.self, from: json)
        let service = dto.toDomain()

        #expect(service.imageUrl == "https://cdn.example.test/laser.jpg")
    }

    @Test func imageUrlParserAcceptsPlainAndWrappedValues() {
        #expect(ImageURLParser.firstURL(list: "/uploads/service.jpg") == "/uploads/service.jpg")
        #expect(ImageURLParser.firstURL(list: #"{"images":[{"url":"/uploads/first.jpg"}]}"#) == "/uploads/first.jpg")
        #expect(ImageURLParser.firstURL(list: #"["","/uploads/second.jpg"]"#) == "/uploads/second.jpg")
    }
}

struct BookingDateValidationTests {
    @Test func rejectsPastOrTooNearBookingTimes() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try #require(TimeZone(secondsFromGMT: 0))
        let now = try #require(calendar.date(from: DateComponents(
            timeZone: calendar.timeZone,
            year: 2026,
            month: 7,
            day: 27,
            hour: 10,
            minute: 0
        )))
        let yesterday = try #require(calendar.date(byAdding: .day, value: -1, to: now))
        let tomorrow = try #require(calendar.date(byAdding: .day, value: 1, to: now))

        #expect(DateUtil.bookingValidationError(date: yesterday,
                                                time: "16:00",
                                                now: now,
                                                calendar: calendar) == "Please select a future date")
        #expect(DateUtil.bookingValidationError(date: now,
                                                time: "10:15",
                                                now: now,
                                                calendar: calendar) == "Please select a future time slot")
        #expect(DateUtil.bookingValidationError(date: now,
                                                time: "10:30",
                                                now: now,
                                                calendar: calendar) == "Please select a future time slot")
        #expect(DateUtil.bookingValidationError(date: now,
                                                time: "10:31",
                                                now: now,
                                                calendar: calendar) == nil)
        #expect(DateUtil.bookingValidationError(date: tomorrow,
                                                time: "09:00",
                                                now: now,
                                                calendar: calendar) == nil)
    }
}

@MainActor
struct ThemePreferenceTests {
    @Test func systemPreferenceFollowsDeviceColorSchemeUntilOverridden() {
        let themeKey = "wellness.themePreference"
        let legacyDarkKey = "wellness.isDarkTheme"
        let previousTheme = UserDefaults.standard.string(forKey: themeKey)
        let previousLegacyDark = UserDefaults.standard.object(forKey: legacyDarkKey)
        defer {
            if let previousTheme {
                UserDefaults.standard.set(previousTheme, forKey: themeKey)
            } else {
                UserDefaults.standard.removeObject(forKey: themeKey)
            }
            if let previousLegacyDark {
                UserDefaults.standard.set(previousLegacyDark, forKey: legacyDarkKey)
            } else {
                UserDefaults.standard.removeObject(forKey: legacyDarkKey)
            }
        }

        UserDefaults.standard.removeObject(forKey: themeKey)
        UserDefaults.standard.removeObject(forKey: legacyDarkKey)

        let appState = AppState(userDefaultsManager: UserDefaultsManager())
        #expect(appState.themePreference == .system)
        #expect(appState.preferredColorScheme == nil)
        #expect(appState.resolvedIsDark(systemColorScheme: .dark))
        #expect(!appState.resolvedIsDark(systemColorScheme: .light))

        appState.setThemePreference(.light)
        #expect(appState.preferredColorScheme == .light)
        #expect(!appState.resolvedIsDark(systemColorScheme: .dark))

        appState.setThemePreference(.dark)
        #expect(appState.preferredColorScheme == .dark)
        #expect(appState.resolvedIsDark(systemColorScheme: .light))
    }
}

@MainActor
struct NotificationMappingTests {
    @Test func decodesLiveBackendMessageAndLinkShape() throws {
        let json = """
        {
          "notifications": [
            {
              "id": 12,
              "type": "billing",
              "title": "Payment received",
              "message": "Your receipt is ready.",
              "link": "/wallet/transactions",
              "entityId": 9,
              "isRead": false,
              "createdAt": "2026-07-27T10:30:00Z"
            }
          ],
          "unreadCount": 1,
          "count": 1
        }
        """.data(using: .utf8)!

        let response = try JSONDecoder().decode(NotificationListResponseDTO.self, from: json)
        let item = try #require(response.notifications?.first)
        #expect(response.total == 1)
        #expect(response.unreadCount == 1)
        #expect(item.body == "Your receipt is ready.")
        #expect(NotificationRouteMapper.canonicalScreen(from: item.screen) == "wallet")
        #expect(NotificationRouteMapper.canonicalScreen(from: "wallet/transactions") == "wallet")
    }
}

struct NotificationDAOTests {
    @Test func persistsAndUpdatesNotifications() throws {
        let fileURL = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
            .appendingPathExtension("json")
        defer { try? FileManager.default.removeItem(at: fileURL) }

        let dao = NotificationDAO(fileURL: fileURL)
        let notification = AppNotification(
            id: "notification-1",
            type: .appointment,
            title: "Appointment",
            body: "Your appointment is confirmed.",
            screen: "appointments",
            entityId: "10",
            isRead: false,
            receivedAt: Date()
        )

        dao.save(notification: notification)
        let saved = try #require(dao.getAll().first)
        #expect(dao.getAll().count == 1)
        #expect(saved.id == notification.id)
        #expect(saved.type == notification.type)
        #expect(saved.title == notification.title)
        #expect(saved.body == notification.body)
        #expect(saved.screen == notification.screen)
        #expect(saved.entityId == notification.entityId)
        #expect(saved.isRead == notification.isRead)
        #expect(abs(saved.receivedAt.timeIntervalSince(notification.receivedAt)) < 1)
        #expect(dao.unreadCount() == 1)

        dao.markRead(id: notification.id)
        #expect(dao.getAll().first?.isRead == true)
        #expect(dao.unreadCount() == 0)

        dao.delete(id: notification.id)
        #expect(dao.getAll().isEmpty)

        dao.save(notification: notification)
        dao.deleteAll()
        #expect(dao.getAll().isEmpty)
    }

    @Test func replacesExistingNotificationWithServerState() throws {
        let fileURL = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
            .appendingPathExtension("json")
        defer { try? FileManager.default.removeItem(at: fileURL) }

        let dao = NotificationDAO(fileURL: fileURL)
        let unread = AppNotification(
            id: "notification-1",
            type: .general,
            title: "Old title",
            body: "Old body",
            screen: nil,
            entityId: nil,
            isRead: false,
            receivedAt: Date(timeIntervalSince1970: 1)
        )
        let read = AppNotification(
            id: "notification-1",
            type: .billing,
            title: "Updated title",
            body: "Updated body",
            screen: "wallet",
            entityId: "9",
            isRead: true,
            receivedAt: Date(timeIntervalSince1970: 2)
        )

        dao.save(notification: unread)
        dao.save(notification: read)

        let saved = try #require(dao.getAll().first)
        #expect(dao.getAll().count == 1)
        #expect(saved.title == "Updated title")
        #expect(saved.isRead)
        #expect(saved.screen == "wallet")
        #expect(dao.unreadCount() == 0)
    }
}

@MainActor
struct MembershipViewModelTests {
    @Test func confirmingJoinPromptOnlyDismissesClinicContactAlert() {
        let repository = StubMembershipRepository()
        let viewModel = MembershipViewModel(
            getAvailablePlansUseCase: GetAvailablePlansUseCase(repository: repository),
            getMyMembershipsUseCase: GetMyMembershipsUseCase(repository: repository),
            keychain: KeychainManager()
        )
        let plan = MembershipPlan(
            id: "7",
            name: "Gold Plan",
            description: "Annual wellness membership",
            price: 9999,
            currency: "INR",
            durationDays: 365,
            benefits: [],
            entitlements: ["Priority booking"],
            tier: .gold
        )

        viewModel.initiateJoin(plan: plan)
        viewModel.confirmJoin()

        #expect(viewModel.uiState.planToJoin == nil)
        #expect(viewModel.uiState.error == nil)
        #expect(viewModel.uiState.myMemberships.isEmpty)
        #expect(!repository.didAttemptJoin)
    }
}

private final class StubMembershipRepository: MembershipRepository {
    private(set) var didAttemptJoin = false

    func getAvailablePlans() async -> Result<[MembershipPlan], AppError> {
        .success([])
    }

    func getMyMemberships(patientId: String) async -> Result<[UserMembership], AppError> {
        .success([])
    }

    func joinMembership(planId: String, patientId: String) async -> Result<UserMembership, AppError> {
        didAttemptJoin = true
        return .failure(.network("Unexpected join attempt"))
    }
}
