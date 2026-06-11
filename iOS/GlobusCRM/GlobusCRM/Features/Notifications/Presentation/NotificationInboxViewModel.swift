import Foundation
import Combine

@MainActor
final class NotificationInboxViewModel: ObservableObject {
    @Published var notifications: [AppNotification] = []
    @Published var unreadCount: Int = 0
    @Published var isLoading = false

    private let dao: NotificationDAO
    private let appState: AppState
    private let getNotificationsUseCase: GetNotificationsUseCase
    private let markReadUseCase: MarkNotificationReadUseCase
    private let markAllReadUseCase: MarkAllNotificationsReadUseCase

    init(dao: NotificationDAO,
         appState: AppState,
         getNotificationsUseCase: GetNotificationsUseCase,
         markReadUseCase: MarkNotificationReadUseCase,
         markAllReadUseCase: MarkAllNotificationsReadUseCase) {
        self.dao = dao
        self.appState = appState
        self.getNotificationsUseCase = getNotificationsUseCase
        self.markReadUseCase = markReadUseCase
        self.markAllReadUseCase = markAllReadUseCase
    }

    // MARK: - Load (server-first, local fallback)

    func load() {
        let local = dao.getAll()
        if !local.isEmpty {
            notifications = local
            refreshUnreadCount()
        }
        dao.deleteOlderThan90Days()
        Task { await fetchFromServer() }
    }

    private func fetchFromServer() async {
        isLoading = true
        let result = await getNotificationsUseCase()
        isLoading = false

        switch result {
        case .success(let serverItems):
            // Merge server items (authoritative) with local-only push notifications
            var merged = serverItems
            let serverIds = Set(serverItems.map(\.id))
            let localOnly = notifications.filter { !serverIds.contains($0.id) }
            merged.append(contentsOf: localOnly)
            merged.sort { $0.receivedAt > $1.receivedAt }
            notifications = merged
            for item in serverItems { dao.save(notification: item) }
            refreshUnreadCount()
        case .failure:
            break // Keep local cache displayed
        }
    }

    // MARK: - Actions

    func markRead(_ notification: AppNotification) {
        dao.markRead(id: notification.id)
        if let idx = notifications.firstIndex(where: { $0.id == notification.id }) {
            notifications[idx].isRead = true
        }
        refreshUnreadCount()
        Task { await markReadUseCase(id: notification.id) }
    }

    func delete(_ notification: AppNotification) {
        dao.delete(id: notification.id)
        notifications.removeAll { $0.id == notification.id }
        refreshUnreadCount()
    }

    func markAllRead() {
        dao.markAllRead()
        for idx in notifications.indices { notifications[idx].isRead = true }
        refreshUnreadCount()
        Task { await markAllReadUseCase() }
    }

    // MARK: - Private

    private func refreshUnreadCount() {
        unreadCount = notifications.filter { !$0.isRead }.count
        appState.unreadNotificationCount = unreadCount
    }
}
