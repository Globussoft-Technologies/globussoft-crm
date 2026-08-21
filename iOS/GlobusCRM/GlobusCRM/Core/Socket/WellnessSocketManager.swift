import Foundation
import SocketIO

extension Notification.Name {
    static let authTokenDidChange = Notification.Name("authTokenDidChange")
}

final class WellnessSocketManager {
    private let keychain: KeychainManager
    private let notificationDAO: NotificationDAO
    private var socketManager: SocketManager?
    private var socket: SocketIOClient?
    private var tokenObserver: NSObjectProtocol?

    init(keychain: KeychainManager, notificationDAO: NotificationDAO) {
        self.keychain = keychain
        self.notificationDAO = notificationDAO
        tokenObserver = NotificationCenter.default.addObserver(
            forName: .authTokenDidChange,
            object: nil,
            queue: .main
        ) { [weak self] notification in
            let token = notification.object as? String
            if let token, !token.isEmpty {
                self?.connect(token: token)
            } else {
                self?.disconnect()
            }
        }

        if let token = keychain.getToken(), !token.isEmpty {
            connect(token: token)
        }
    }

    deinit {
        if let tokenObserver {
            NotificationCenter.default.removeObserver(tokenObserver)
        }
        disconnect()
    }

    private func connect(token: String) {
        disconnect()

        guard let url = socketURL() else { return }
        let manager = SocketManager(socketURL: url, config: [
            .log(false),
            .compress,
            .reconnects(true),
            .reconnectWait(3),
            .connectParams(["token": token])
        ])
        let client = manager.defaultSocket
        client.on("notification_new") { [weak self] data, _ in
            self?.receive(data)
        }
        client.on("connect") { _, _ in
            #if DEBUG
            print("[Socket] Connected to notification stream")
            #endif
        }
        client.on("disconnect") { _, _ in
            #if DEBUG
            print("[Socket] Disconnected from notification stream")
            #endif
        }
        socketManager = manager
        socket = client
        client.connect()
    }

    private func disconnect() {
        socket?.removeAllHandlers()
        socket?.disconnect()
        socket = nil
        socketManager = nil
    }

    private func receive(_ data: [Any]) {
        guard let payload = data.first as? [String: Any],
              let id = stringValue(payload["id"]),
              let title = payload["title"] as? String else { return }

        let item = AppNotification(
            id: id,
            type: notificationType(payload["type"] as? String),
            title: title,
            body: payload["message"] as? String ?? payload["body"] as? String ?? "",
            screen: NotificationRouteMapper.canonicalScreen(from: payload["link"] as? String ?? payload["screen"] as? String),
            entityId: stringValue(payload["entityId"]),
            isRead: false,
            receivedAt: dateValue(payload["createdAt"]) ?? Date()
        )
        notificationDAO.save(notification: item)
        NotificationCenter.default.post(name: .pushNotificationReceived, object: item)
    }

    private func socketURL() -> URL? {
        let configured = Bundle.main.object(forInfoDictionaryKey: "BASE_URL") as? String
            ?? AppConstants.API.baseURL
        let server = configured
            .replacingOccurrences(of: "/api/", with: "/")
        guard var components = URLComponents(string: server) else { return nil }
        components.path = components.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        return components.url
    }

    private func stringValue(_ value: Any?) -> String? {
        switch value {
        case let value as String: return value
        case let value as NSNumber: return value.stringValue
        default: return nil
        }
    }

    private func dateValue(_ value: Any?) -> Date? {
        guard let raw = value as? String else { return nil }
        return ISO8601DateFormatter().date(from: raw)
    }

    private func notificationType(_ rawValue: String?) -> AppNotification.NotificationType {
        let value = (rawValue ?? "").lowercased()
        if value.contains("appointment") || value.contains("booking") { return .appointment }
        if value.contains("prescription") || value.contains("treatment") { return .prescription }
        if value.contains("wallet") || value.contains("payment") || value.contains("billing") { return .billing }
        if value.contains("loyalty") { return .loyalty }
        if value.contains("membership") { return .membership }
        if value.contains("promotion") || value.contains("offer") { return .promotion }
        return .general
    }
}
