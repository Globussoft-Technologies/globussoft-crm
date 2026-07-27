//
//  GlobusCRMTests.swift
//  GlobusCRMTests
//
//  Created by GLB-BLR-M1 on 09/06/26.
//

import Foundation
import Testing
@testable import GlobusCRM

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
}
