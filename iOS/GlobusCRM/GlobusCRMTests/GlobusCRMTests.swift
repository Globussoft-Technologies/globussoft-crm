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

        #expect(DeepLinkHandler.resolve(url: url) == .prescriptionPdf(prescriptionId: 42))
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

        #expect(first == second)
        #expect(first != AppError.http(statusCode: 500, message: "Failure", serverCode: nil))
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
        #expect(dao.getAll() == [notification])
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
