import Foundation

protocol NotificationRepository {
    func getNotifications(page: Int, limit: Int) async -> Result<[AppNotification], AppError>
    func markRead(id: String) async -> Result<Void, AppError>
    func markAllRead() async -> Result<Void, AppError>
}
