import Foundation

final class NotificationRepositoryImpl: NotificationRepository {
    private let apiClient: WellnessAPIClient

    init(apiClient: WellnessAPIClient) {
        self.apiClient = apiClient
    }

    // Endpoint /wellness/portal/me/notifications not yet implemented in backend
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
        let result: Result<MarkReadResponseDTO, AppError> = await apiClient.request(
            endpoint: .markNotificationRead(id: id)
        )
        switch result {
        case .success: return .success(())
        case .failure(let e): return .failure(e)
        }
    }

    func markAllRead() async -> Result<Void, AppError> {
        let result: Result<MarkReadResponseDTO, AppError> = await apiClient.request(
            endpoint: .markAllNotificationsRead
        )
        switch result {
        case .success: return .success(())
        case .failure(let e): return .failure(e)
        }
    }
}

private extension NotificationItemDTO {
    func toDomain() -> AppNotification {
        AppNotification(
            id: String(id),
            type: AppNotification.NotificationType(rawValue: type ?? "") ?? .general,
            title: title ?? "",
            body: body ?? "",
            screen: screen,
            entityId: entityId.map { String($0) },
            isRead: isRead ?? false,
            receivedAt: ISO8601DateFormatter().date(from: createdAt ?? "") ?? Date()
        )
    }
}
