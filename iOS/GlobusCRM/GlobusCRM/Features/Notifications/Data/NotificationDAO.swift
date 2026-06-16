import Foundation

final class NotificationDAO {
    private let fileURL: URL

    init(fileURL: URL? = nil) {
        if let fileURL {
            self.fileURL = fileURL
            return
        }

        let applicationSupport = FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first ?? FileManager.default.temporaryDirectory
        let directory = applicationSupport.appendingPathComponent("GlobusCRM", isDirectory: true)
        try? FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.complete]
        )
        self.fileURL = directory.appendingPathComponent("notifications.json")
    }

    func save(notification: AppNotification) {
        var all = getAll()
        guard !all.contains(where: { $0.id == notification.id }) else { return }
        all.insert(notification, at: 0)
        if all.count > 100 { all = Array(all.prefix(100)) }
        persist(all)
    }

    func getAll() -> [AppNotification] {
        guard let data = try? Data(contentsOf: fileURL),
              let items = try? JSONDecoder().decode([StoredNotification].self, from: data) else {
            return []
        }
        return items.map { $0.toAppNotification() }
    }

    func markRead(id: String) {
        var stored = loadStored()
        for i in stored.indices where stored[i].id == id { stored[i].isRead = true }
        saveStored(stored)
    }

    func markAllRead() {
        var stored = loadStored()
        for i in stored.indices { stored[i].isRead = true }
        saveStored(stored)
    }

    func unreadCount() -> Int {
        loadStored().filter { !$0.isRead }.count
    }

    func delete(id: String) {
        saveStored(loadStored().filter { $0.id != id })
    }

    func deleteOlderThan90Days() {
        let cutoff = Date().addingTimeInterval(-90 * 24 * 3600).timeIntervalSince1970
        saveStored(loadStored().filter { $0.receivedAt > cutoff })
    }

    func deleteAll() {
        guard FileManager.default.fileExists(atPath: fileURL.path) else { return }
        do {
            try FileManager.default.removeItem(at: fileURL)
        } catch {
            WellnessLogger.error("Failed to clear notifications: \(error.localizedDescription)")
        }
    }

    // MARK: - Private

    private func loadStored() -> [StoredNotification] {
        guard let data = try? Data(contentsOf: fileURL),
              let items = try? JSONDecoder().decode([StoredNotification].self, from: data) else {
            return []
        }
        return items
    }

    private func persist(_ notifications: [AppNotification]) {
        saveStored(notifications.map { StoredNotification(from: $0) })
    }

    private func saveStored(_ items: [StoredNotification]) {
        guard let data = try? JSONEncoder().encode(items) else { return }
        do {
            try data.write(to: fileURL, options: [.atomic, .completeFileProtection])
        } catch {
            WellnessLogger.error("Failed to persist notifications: \(error.localizedDescription)")
        }
    }
}

// Flat Codable mirror of AppNotification (avoids making the domain model Codable)
private struct StoredNotification: Codable {
    let id: String
    let type: String
    let title: String
    let body: String
    let screen: String?
    let entityId: String?
    var isRead: Bool
    let receivedAt: TimeInterval

    init(from n: AppNotification) {
        id = n.id
        type = n.type.rawValue
        title = n.title
        body = n.body
        screen = n.screen
        entityId = n.entityId
        isRead = n.isRead
        receivedAt = n.receivedAt.timeIntervalSince1970
    }

    func toAppNotification() -> AppNotification {
        AppNotification(
            id: id,
            type: AppNotification.NotificationType(rawValue: type) ?? .general,
            title: title,
            body: body,
            screen: screen,
            entityId: entityId,
            isRead: isRead,
            receivedAt: Date(timeIntervalSince1970: receivedAt)
        )
    }
}
