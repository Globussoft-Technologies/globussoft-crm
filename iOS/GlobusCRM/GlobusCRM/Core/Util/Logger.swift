import os.log
import Foundation

enum WellnessLogger {
    private static let subsystem = Bundle.main.bundleIdentifier ?? "com.globussoft.wellness.patient"
    private static let log = OSLog(subsystem: subsystem, category: "WellnessCRM")

    static func debug(_ message: String, file: String = #file, line: Int = #line) {
        os_log(.debug, log: log, "%{public}@:%{public}d %{public}@",
               (file as NSString).lastPathComponent, line, message)
    }

    static func info(_ message: String) {
        os_log(.info, log: log, "%{public}@", message)
    }

    static func error(_ message: String, file: String = #file, line: Int = #line) {
        os_log(.error, log: log, "%{public}@:%{public}d %{public}@",
               (file as NSString).lastPathComponent, line, message)
    }

    // Never log patient name, phone, or clinical fields — use patientId only
    static func audit(_ event: String, patientId: Int? = nil) {
        let msg = patientId.map { "\(event) [pid:\($0)]" } ?? event
        os_log(.info, log: log, "%{public}@", msg)
    }
}
