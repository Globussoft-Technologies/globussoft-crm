import SwiftUI
import Combine

struct NotificationSettingsView: View {
    @StateObject var viewModel: NotificationSettingsViewModel
    @EnvironmentObject var appState: AppState

    var body: some View {
        Form {
            Section {
                NotificationToggle(
                    label: "Appointment Reminders",
                    icon: "calendar.badge.clock",
                    description: "Reminders 24h and 1h before appointments",
                    isOn: Binding(
                        get: { viewModel.preferences.appointmentReminders },
                        set: { viewModel.update(\.appointmentReminders, value: $0) }
                    )
                )
                NotificationToggle(
                    label: "Health Tips",
                    icon: "heart.text.square",
                    description: "Wellness tips and care recommendations",
                    isOn: Binding(
                        get: { viewModel.preferences.healthTips },
                        set: { viewModel.update(\.healthTips, value: $0) }
                    )
                )
                NotificationToggle(
                    label: "Billing Alerts",
                    icon: "creditcard",
                    description: "Payment receipts and invoice notifications",
                    isOn: Binding(
                        get: { viewModel.preferences.billing },
                        set: { viewModel.update(\.billing, value: $0) }
                    )
                )
                NotificationToggle(
                    label: "Promotions & Offers",
                    icon: "tag",
                    description: "Special deals and membership offers",
                    isOn: Binding(
                        get: { viewModel.preferences.promotions },
                        set: { viewModel.update(\.promotions, value: $0) }
                    )
                )
                NotificationToggle(
                    label: "General Updates",
                    icon: "bell",
                    description: "App updates and general announcements",
                    isOn: Binding(
                        get: { viewModel.preferences.generalUpdates },
                        set: { viewModel.update(\.generalUpdates, value: $0) }
                    )
                )
            } header: {
                Text("Notification Preferences")
            }

            Section {
                NotificationToggle(
                    label: "Push Notifications",
                    icon: "bell.badge",
                    description: "In-app and lock screen alerts",
                    isOn: Binding(
                        get: { viewModel.preferences.pushNotifications },
                        set: { viewModel.update(\.pushNotifications, value: $0) }
                    )
                )
                NotificationToggle(
                    label: "SMS",
                    icon: "message",
                    description: "Text message alerts to your phone",
                    isOn: Binding(
                        get: { viewModel.preferences.smsNotifications },
                        set: { viewModel.update(\.smsNotifications, value: $0) }
                    )
                )
                NotificationToggle(
                    label: "Email",
                    icon: "envelope",
                    description: "Notifications sent to your email address",
                    isOn: Binding(
                        get: { viewModel.preferences.emailNotifications },
                        set: { viewModel.update(\.emailNotifications, value: $0) }
                    )
                )
            } header: {
                Text("Delivery Channels")
            }

            Section {
                NotificationToggle(
                    label: "Enable Quiet Hours",
                    icon: "moon.fill",
                    description: "Silence notifications during specified hours",
                    isOn: Binding(
                        get: { viewModel.preferences.quietHoursEnabled },
                        set: { viewModel.update(\.quietHoursEnabled, value: $0) }
                    )
                )

                if viewModel.preferences.quietHoursEnabled {
                    DatePicker(
                        "Start Time",
                        selection: Binding(
                            get: { viewModel.quietHoursStartDate },
                            set: { viewModel.updateQuietHoursStart($0) }
                        ),
                        displayedComponents: .hourAndMinute
                    )
                    .tint(.wellnessTeal)

                    DatePicker(
                        "End Time",
                        selection: Binding(
                            get: { viewModel.quietHoursEndDate },
                            set: { viewModel.updateQuietHoursEnd($0) }
                        ),
                        displayedComponents: .hourAndMinute
                    )
                    .tint(.wellnessTeal)
                }
            } header: {
                Text("Quiet Hours")
            } footer: {
                if viewModel.preferences.quietHoursEnabled {
                    Text("Notifications will be silenced from \(viewModel.quietHoursStartFormatted) to \(viewModel.quietHoursEndFormatted).")
                        .font(.wellnessCaption2)
                }
            }
        }
        .navigationTitle("Notifications")
        .navigationBarTitleDisplayMode(.large)
    }
}

private struct NotificationToggle: View {
    let label: String
    let icon: String
    let description: String
    @Binding var isOn: Bool

    var body: some View {
        HStack(spacing: WellnessSpacing.md) {
            Image(systemName: icon)
                .foregroundColor(.wellnessTeal)
                .frame(width: 28)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: WellnessSpacing.xs) {
                Text(label)
                    .font(.wellnessBody)
                    .foregroundColor(.wellnessOnSurface)
                Text(description)
                    .font(.wellnessCaption2)
                    .foregroundColor(.wellnessMuted)
            }

            Spacer()
            Toggle("", isOn: $isOn)
                .tint(.wellnessTeal)
                .labelsHidden()
                .accessibilityLabel(label)
        }
        .padding(.vertical, WellnessSpacing.xs)
    }
}

// Notification settings are local-only (UserDefaults) — no API endpoint exists for these
@MainActor
final class NotificationSettingsViewModel: ObservableObject {
    @Published var preferences: NotificationPreference

    init() {
        preferences = Self.loadFromDefaults()
    }

    func update<T>(_ keyPath: WritableKeyPath<NotificationPreference, T>, value: T) {
        preferences[keyPath: keyPath] = value
        Self.saveToDefaults(preferences)
    }

    // MARK: - Quiet hours date helpers

    var quietHoursStartDate: Date {
        minutesToDate(preferences.quietHoursStartMinutes)
    }

    var quietHoursEndDate: Date {
        minutesToDate(preferences.quietHoursEndMinutes)
    }

    var quietHoursStartFormatted: String { formatMinutes(preferences.quietHoursStartMinutes) }
    var quietHoursEndFormatted:   String { formatMinutes(preferences.quietHoursEndMinutes) }

    func updateQuietHoursStart(_ date: Date) {
        preferences.quietHoursStartMinutes = dateToMinutes(date)
        Self.saveToDefaults(preferences)
    }

    func updateQuietHoursEnd(_ date: Date) {
        preferences.quietHoursEndMinutes = dateToMinutes(date)
        Self.saveToDefaults(preferences)
    }

    private func minutesToDate(_ minutes: Int) -> Date {
        var comps = Calendar.current.dateComponents([.year, .month, .day], from: Date())
        comps.hour   = minutes / 60
        comps.minute = minutes % 60
        return Calendar.current.date(from: comps) ?? Date()
    }

    private func dateToMinutes(_ date: Date) -> Int {
        let comps = Calendar.current.dateComponents([.hour, .minute], from: date)
        return (comps.hour ?? 0) * 60 + (comps.minute ?? 0)
    }

    private func formatMinutes(_ minutes: Int) -> String {
        let h = minutes / 60
        let m = minutes % 60
        let ampm = h < 12 ? "AM" : "PM"
        let h12  = h == 0 ? 12 : (h > 12 ? h - 12 : h)
        return String(format: "%d:%02d %@", h12, m, ampm)
    }

    // MARK: - Persistence

    private static func loadFromDefaults() -> NotificationPreference {
        let ud = UserDefaults.standard
        return NotificationPreference(
            appointmentReminders: ud.object(forKey: Keys.appointmentReminders) as? Bool ?? true,
            promotions: ud.bool(forKey: Keys.promotions),
            healthTips: ud.object(forKey: Keys.healthTips) as? Bool ?? true,
            billing: ud.object(forKey: Keys.billing) as? Bool ?? true,
            generalUpdates: ud.object(forKey: Keys.generalUpdates) as? Bool ?? true,
            pushNotifications: ud.object(forKey: Keys.pushNotifications) as? Bool ?? true,
            smsNotifications: ud.object(forKey: Keys.smsNotifications) as? Bool ?? false,
            emailNotifications: ud.object(forKey: Keys.emailNotifications) as? Bool ?? true,
            quietHoursEnabled: ud.bool(forKey: Keys.quietHoursEnabled),
            quietHoursStartMinutes: ud.object(forKey: Keys.quietHoursStart) as? Int ?? 1320,
            quietHoursEndMinutes: ud.object(forKey: Keys.quietHoursEnd) as? Int ?? 480
        )
    }

    private static func saveToDefaults(_ prefs: NotificationPreference) {
        let ud = UserDefaults.standard
        ud.set(prefs.appointmentReminders,  forKey: Keys.appointmentReminders)
        ud.set(prefs.promotions,            forKey: Keys.promotions)
        ud.set(prefs.healthTips,            forKey: Keys.healthTips)
        ud.set(prefs.billing,               forKey: Keys.billing)
        ud.set(prefs.generalUpdates,        forKey: Keys.generalUpdates)
        ud.set(prefs.pushNotifications,     forKey: Keys.pushNotifications)
        ud.set(prefs.smsNotifications,      forKey: Keys.smsNotifications)
        ud.set(prefs.emailNotifications,    forKey: Keys.emailNotifications)
        ud.set(prefs.quietHoursEnabled,     forKey: Keys.quietHoursEnabled)
        ud.set(prefs.quietHoursStartMinutes, forKey: Keys.quietHoursStart)
        ud.set(prefs.quietHoursEndMinutes,  forKey: Keys.quietHoursEnd)
    }

    private enum Keys {
        static let appointmentReminders = "notif.appointmentReminders"
        static let promotions           = "notif.promotions"
        static let healthTips           = "notif.healthTips"
        static let billing              = "notif.billing"
        static let generalUpdates       = "notif.generalUpdates"
        static let pushNotifications    = "notif.pushNotifications"
        static let smsNotifications     = "notif.smsNotifications"
        static let emailNotifications   = "notif.emailNotifications"
        static let quietHoursEnabled    = "notif.quietHoursEnabled"
        static let quietHoursStart      = "notif.quietHoursStart"
        static let quietHoursEnd        = "notif.quietHoursEnd"
    }
}
