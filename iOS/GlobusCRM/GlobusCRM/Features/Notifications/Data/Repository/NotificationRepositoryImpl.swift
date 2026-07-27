import Foundation

final class NotificationRepositoryImpl: NotificationRepository {
    private let apiClient: WellnessAPIClient

    init(apiClient: WellnessAPIClient) {
        self.apiClient = apiClient
    }

    func getNotifications(page: Int, limit: Int) async -> Result<[AppNotification], AppError> {
        let result: Result<NotificationListResponseDTO, AppError> = await apiClient.request(
            endpoint: .getNotifications(page: page, limit: limit)
        )
        switch result {
        case .success(let response):
            return .success((response.notifications ?? []).map { $0.toDomain() })
        case .failure(let error):
            return .failure(error)
        }
    }

    func markRead(id: String) async -> Result<Void, AppError> {
        await apiClient.resultVoid(.markNotificationRead(id: id))
    }

    func markAllRead() async -> Result<Void, AppError> {
        await apiClient.resultVoid(.markAllNotificationsRead)
    }
}

private extension NotificationItemDTO {
    func toDomain() -> AppNotification {
        AppNotification(
            id: String(id),
            type: AppNotification.NotificationType(rawValue: type ?? "") ?? .general,
            title: title ?? "",
            body: body ?? "",
            screen: NotificationRouteMapper.canonicalScreen(from: screen),
            entityId: entityId.map { String($0) },
            isRead: isRead ?? false,
            receivedAt: ISO8601DateFormatter().date(from: createdAt ?? "") ?? Date()
        )
    }
}
