import Foundation

enum DateUtil {
    private static let apiFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.locale = Locale(identifier: "en_US_POSIX")
        return f
    }()

    private static let displayFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateStyle = .medium
        f.timeStyle = .short
        return f
    }()

    /// Parses any ISO8601 variant the API might send:
    /// - "2027-06-02T10:18:49.062Z" (with fractional seconds)
    /// - "2027-06-02T10:18:49Z"     (without fractional seconds)
    /// - "2027-06-02"               (date-only)
    private static func parseISO(_ iso: String) -> Date? {
        let withFrac: ISO8601DateFormatter = {
            let f = ISO8601DateFormatter()
            f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            return f
        }()
        return withFrac.date(from: iso)
            ?? ISO8601DateFormatter().date(from: iso)
            ?? apiFormatter.date(from: iso)
    }

    static func toApiDate(epoch: Double) -> String {
        let date = Date(timeIntervalSince1970: epoch / 1000)
        return apiFormatter.string(from: date)
    }

    static func toApiDate(_ date: Date) -> String {
        apiFormatter.string(from: date)
    }

    static func fromApiDate(_ value: String) -> Date? {
        apiFormatter.date(from: value)
    }

    static func formatDisplay(iso: String) -> String {
        guard let date = parseISO(iso) else { return iso }
        return displayFormatter.string(from: date)
    }

    /// Compact appointment format: "Mon, Jun 11 · 3:30 PM"
    /// Falls back to date-only "Mon, Jun 11" when no time component is present.
    static func formatAppointment(iso: String) -> String {
        guard let date = parseISO(iso) else { return iso }
        let f = DateFormatter()
        f.dateFormat = iso.contains("T") ? "EEE, MMM d · h:mm a" : "EEE, MMM d"
        return f.string(from: date)
    }

    /// Date only — no time component. Suitable for purchase dates, expiry dates, etc.
    static func formatDate(iso: String) -> String {
        guard let date = parseISO(iso) else { return iso }
        let f = DateFormatter()
        f.dateStyle = .medium
        f.timeStyle = .none
        return f.string(from: date)
    }

    static func monthLabel(from iso: String) -> String {
        guard let date = parseISO(iso) else { return iso }
        let f = DateFormatter()
        f.dateFormat = "MMMM yyyy"
        return f.string(from: date)
    }

    static func formatTime(hhmm: String) -> String {
        let input = DateFormatter()
        input.dateFormat = "HH:mm"
        guard let date = input.date(from: hhmm) else { return hhmm }
        let output = DateFormatter()
        output.dateStyle = .none
        output.timeStyle = .short
        return output.string(from: date)
    }

    static func isToday(iso: String) -> Bool {
        guard let date = parseISO(iso) else { return false }
        return Calendar.current.isDateInToday(date)
    }

    static func bookingValidationError(date: Date,
                                       time: String,
                                       now: Date = Date(),
                                       bufferMinutes: Int = 30,
                                       calendar: Calendar = .current) -> String? {
        let selectedDay = calendar.startOfDay(for: date)
        let today = calendar.startOfDay(for: now)
        guard selectedDay >= today else { return "Please select a future date" }
        guard isFutureAppointmentDateTime(date: date,
                                          time: time,
                                          now: now,
                                          bufferMinutes: bufferMinutes,
                                          calendar: calendar) else {
            return "Please select a future time slot"
        }
        return nil
    }

    static func bookingValidationError(apiDate: String,
                                       time: String,
                                       now: Date = Date(),
                                       bufferMinutes: Int = 30,
                                       calendar: Calendar = .current) -> String? {
        guard let date = fromApiDate(apiDate) else { return "Please select a future date" }
        return bookingValidationError(date: date,
                                      time: time,
                                      now: now,
                                      bufferMinutes: bufferMinutes,
                                      calendar: calendar)
    }

    static func isFutureAppointmentDateTime(date: Date,
                                            time: String,
                                            now: Date = Date(),
                                            bufferMinutes: Int = 30,
                                            calendar: Calendar = .current) -> Bool {
        guard let appointmentDate = appointmentDateTime(date: date, time: time, calendar: calendar) else {
            return false
        }
        let minimumDate = calendar.date(byAdding: .minute, value: bufferMinutes, to: now)
            ?? now.addingTimeInterval(TimeInterval(bufferMinutes * 60))
        return appointmentDate > minimumDate
    }

    private static func appointmentDateTime(date: Date, time: String, calendar: Calendar) -> Date? {
        let parts = time.split(separator: ":").compactMap { Int($0) }
        guard parts.count == 2,
              (0...23).contains(parts[0]),
              (0...59).contains(parts[1]) else { return nil }
        var components = calendar.dateComponents([.year, .month, .day], from: date)
        components.hour = parts[0]
        components.minute = parts[1]
        components.second = 0
        components.nanosecond = 0
        return calendar.date(from: components)
    }

    static func tomorrow() -> Date {
        Calendar.current.date(byAdding: .day, value: 1, to: Date()) ?? Date()
    }
}
