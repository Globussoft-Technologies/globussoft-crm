import Foundation

extension String {
    func sanitiseDescription() -> String {
        var s = self
        let patternsToRemove = [
            "Imported from Zylu",
            "Migrated from",
            "Legacy entry"
        ]
        for pattern in patternsToRemove {
            s = s.replacingOccurrences(of: pattern, with: "", options: .caseInsensitive)
        }
        return s.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    func truncated(to length: Int, trailing: String = "...") -> String {
        count > length ? String(prefix(length)) + trailing : self
    }

    var isValidEmail: Bool {
        let regex = "[A-Z0-9a-z._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}"
        return NSPredicate(format: "SELF MATCHES %@", regex).evaluate(with: self)
    }

    var isValidPassword: Bool {
        count >= 8
    }
}
