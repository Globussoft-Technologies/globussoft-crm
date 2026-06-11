import Foundation

final class GetNotificationsUseCase {
    private let repository: NotificationRepository
    init(repository: NotificationRepository) { self.repository = repository }

    func callAsFunction(page: Int = 1, limit: Int = 50) async -> Result<[AppNotification], AppError> {
        await repository.getNotifications(page: page, limit: limit)
    }
}

final class MarkNotificationReadUseCase {
    private let repository: NotificationRepository
    init(repository: NotificationRepository) { self.repository = repository }

    func callAsFunction(id: String) async {
        _ = await repository.markRead(id: id)
    }
}

final class MarkAllNotificationsReadUseCase {
    private let repository: NotificationRepository
    init(repository: NotificationRepository) { self.repository = repository }

    func callAsFunction() async {
        _ = await repository.markAllRead()
    }
}
