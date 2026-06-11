import Foundation

extension String {
    /// Strips HTML tags and trims whitespace. Used for API description fields that may contain markup.
    var strippingHTML: String {
        replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
