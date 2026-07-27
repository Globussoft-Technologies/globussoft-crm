import Foundation
import UserNotifications

struct ScheduledMedication: Codable, Equatable {
    let name: String
    let dosage: String?
    let frequencyPerDay: Int
    let durationDays: Int
}

struct MedicationReminderToggleResult {
    let enabled: Bool
    let message: String
}

extension Drug {
    func toScheduledMedication() -> ScheduledMedication? {
        let frequency = frequency?.medicationFrequencyPerDay() ?? 1
        let duration = duration?.medicationDurationDays() ?? 7
        guard !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              frequency > 0,
              duration > 0 else { return nil }

        return ScheduledMedication(
            name: name,
            dosage: dosage,
            frequencyPerDay: frequency,
            durationDays: duration
        )
    }
}

extension String {
    func medicationFrequencyPerDay() -> Int? {
        let value = normalizedMedicationValue()
        guard !value.isEmpty else { return nil }

        if let dosePattern = value.medicationDosePatternFrequency() {
            return dosePattern
        }
        if let word = value.medicationFrequencyWord() {
            return word
        }

        guard let number = value.firstMedicationNumber() else { return nil }
        if value.contains("hour") || value.contains("hr") {
            guard number > 0 else { return nil }
            return max(1, Int((24.0 / number).rounded()))
        }
        let count = Int(number)
        return count > 0 ? count : nil
    }

    func medicationDurationDays() -> Int? {
        let value = normalizedMedicationValue()
        guard !value.isEmpty else { return nil }

        guard let number = value.firstMedicationNumber() ?? value.medicationNumberWord().map(Double.init) else {
            return nil
        }

        let days: Double
        if value.contains("week") {
            days = number * 7
        } else if value.contains("month") {
            days = number * 30
        } else {
            days = number
        }

        let wholeDays = Int(days)
        return wholeDays > 0 ? wholeDays : nil
    }

    private func normalizedMedicationValue() -> String {
        trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    private func firstMedicationNumber() -> Double? {
        guard let range = range(of: #"\d+(?:\.\d+)?"#, options: .regularExpression) else {
            return nil
        }
        return Double(self[range])
    }

    private func medicationDosePatternFrequency() -> Int? {
        guard range(of: #"^\d+(?:\s*[-+/]\s*\d+)+$"#, options: .regularExpression) != nil else {
            return nil
        }
        let numbers = components(separatedBy: CharacterSet.decimalDigits.inverted)
            .compactMap { Int($0) }
        let total = numbers.reduce(0, +)
        return total > 0 ? total : nil
    }

    private func medicationFrequencyWord() -> Int? {
        if contains("qid") || contains("qds") || contains("four times") { return 4 }
        if contains("tds") || contains("tid") || contains("thrice") || contains("three times") { return 3 }
        if contains("bd") || contains("bid") || contains("twice") || contains("two times") { return 2 }
        if contains("od") || contains("once") || contains("daily") { return 1 }
        return medicationNumberWord()
    }

    private func medicationNumberWord() -> Int? {
        if contains("one") { return 1 }
        if contains("two") { return 2 }
        if contains("three") { return 3 }
        if contains("four") { return 4 }
        if contains("five") { return 5 }
        if contains("six") { return 6 }
        if contains("seven") { return 7 }
        if contains("eight") { return 8 }
        if contains("nine") { return 9 }
        if contains("ten") { return 10 }
        return nil
    }
}

final class MedicationReminderScheduler {
    private struct ReminderState: Codable {
        let prescriptionId: String
        let requestIdentifiers: [String]
        let endAt: Date
    }

    private let center: UNUserNotificationCenter
    private let defaults: UserDefaults
    private let calendar: Calendar

    init(center: UNUserNotificationCenter = .current(),
         defaults: UserDefaults = .standard,
         calendar: Calendar = .current) {
        self.center = center
        self.defaults = defaults
        self.calendar = calendar
    }

    func enabledReminderIds() -> Set<String> {
        cleanupExpired()
        return Set(loadStates().keys)
    }

    func enable(prescription: Prescription) async -> MedicationReminderToggleResult {
        let drugs = prescription.drugs.compactMap { $0.toScheduledMedication() }
        guard !drugs.isEmpty else {
            return MedicationReminderToggleResult(
                enabled: false,
                message: "This prescription does not include frequency and duration details."
            )
        }

        let granted = await requestAuthorization()
        guard granted else {
            return MedicationReminderToggleResult(
                enabled: false,
                message: "Notification permission is required to enable medication reminders."
            )
        }

        disable(prescriptionId: prescription.id)

        let now = Date()
        let startAt = max(parseDate(prescription.visitDate) ?? now, now)
        let endAt = drugs
            .map { startAt.addingTimeInterval(TimeInterval($0.durationDays) * Self.daySeconds) }
            .max() ?? startAt

        do {
            let identifiers = try await schedule(
                drugs: drugs,
                prescription: prescription,
                startAt: startAt,
                endAt: endAt,
                now: now
            )

            guard !identifiers.isEmpty else {
                return MedicationReminderToggleResult(
                    enabled: false,
                    message: "No future medication reminders could be scheduled."
                )
            }

            var states = loadStates()
            states[prescription.id] = ReminderState(
                prescriptionId: prescription.id,
                requestIdentifiers: identifiers,
                endAt: endAt
            )
            saveStates(states)

            return MedicationReminderToggleResult(
                enabled: true,
                message: "Medication reminders enabled."
            )
        } catch {
            return MedicationReminderToggleResult(
                enabled: false,
                message: error.localizedDescription
            )
        }
    }

    @discardableResult
    func disable(prescriptionId: String) -> MedicationReminderToggleResult {
        var states = loadStates()
        if let state = states[prescriptionId] {
            center.removePendingNotificationRequests(withIdentifiers: state.requestIdentifiers)
        }
        states.removeValue(forKey: prescriptionId)
        saveStates(states)
        return MedicationReminderToggleResult(
            enabled: false,
            message: "Medication reminders disabled."
        )
    }

    private func schedule(drugs: [ScheduledMedication],
                          prescription: Prescription,
                          startAt: Date,
                          endAt: Date,
                          now: Date) async throws -> [String] {
        var identifiers: [String] = []

        for (drugIndex, drug) in drugs.enumerated() {
            let interval = Self.daySeconds / TimeInterval(drug.frequencyPerDay)
            let drugEndAt = min(
                startAt.addingTimeInterval(TimeInterval(drug.durationDays) * Self.daySeconds),
                endAt
            )
            var triggerAt = startAt
            var sequence = 0

            while triggerAt < drugEndAt && identifiers.count < Self.maxPendingNotifications {
                if triggerAt > now {
                    let identifier = "medication-\(prescription.id)-\(drugIndex)-\(sequence)"
                    try await addNotification(
                        identifier: identifier,
                        prescription: prescription,
                        drug: drug,
                        triggerAt: triggerAt
                    )
                    identifiers.append(identifier)
                }
                sequence += 1
                triggerAt = triggerAt.addingTimeInterval(interval)
            }
        }

        return identifiers
    }

    private func addNotification(identifier: String,
                                 prescription: Prescription,
                                 drug: ScheduledMedication,
                                 triggerAt: Date) async throws {
        let content = UNMutableNotificationContent()
        content.title = "Medication Reminder"
        content.body = [drug.name, drug.dosage].compactMap { $0 }.joined(separator: " - ")
        content.sound = .default
        content.userInfo = [
            "screen": "prescription",
            "entityId": prescription.id
        ]

        let components = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: triggerAt)
        let trigger = UNCalendarNotificationTrigger(dateMatching: components, repeats: false)
        let request = UNNotificationRequest(identifier: identifier, content: content, trigger: trigger)

        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            center.add(request) { error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume(returning: ())
                }
            }
        }
    }

    private func requestAuthorization() async -> Bool {
        await withCheckedContinuation { continuation in
            center.requestAuthorization(options: [.alert, .badge, .sound]) { granted, _ in
                continuation.resume(returning: granted)
            }
        }
    }

    private func cleanupExpired() {
        let now = Date()
        var states = loadStates()
        let expired = states.values.filter { $0.endAt <= now }
        guard !expired.isEmpty else { return }
        expired.forEach { state in
            center.removePendingNotificationRequests(withIdentifiers: state.requestIdentifiers)
            states.removeValue(forKey: state.prescriptionId)
        }
        saveStates(states)
    }

    private func loadStates() -> [String: ReminderState] {
        guard let data = defaults.data(forKey: Self.storageKey),
              let states = try? JSONDecoder().decode([String: ReminderState].self, from: data) else {
            return [:]
        }
        return states
    }

    private func saveStates(_ states: [String: ReminderState]) {
        guard let data = try? JSONEncoder().encode(states) else { return }
        defaults.set(data, forKey: Self.storageKey)
    }

    private func parseDate(_ value: String) -> Date? {
        let withFractional = ISO8601DateFormatter()
        withFractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = withFractional.date(from: value) {
            return date
        }

        if let date = ISO8601DateFormatter().date(from: value) {
            return date
        }

        let dateOnly = DateFormatter()
        dateOnly.dateFormat = "yyyy-MM-dd"
        dateOnly.locale = Locale(identifier: "en_US_POSIX")
        return dateOnly.date(from: value)
    }

    private static let storageKey = "medicationReminder.states"
    private static let daySeconds: TimeInterval = 24 * 60 * 60
    private static let maxPendingNotifications = 60
}
