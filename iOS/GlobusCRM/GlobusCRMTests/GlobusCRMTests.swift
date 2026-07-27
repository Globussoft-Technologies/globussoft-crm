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
