import Foundation

nonisolated enum ImageURLParser {
    static func firstURL(single: String? = nil, list: String? = nil) -> String? {
        if let single = normalizedURLString(single) {
            return single
        }

        guard let list = list?.trimmingCharacters(in: .whitespacesAndNewlines),
              !list.isEmpty,
              !isNullLiteral(list) else {
            return nil
        }

        guard let data = list.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) else {
            return normalizedURLString(list)
        }

        return firstURL(in: object)
    }

    private static func firstURL(in object: Any) -> String? {
        if let string = object as? String {
            return normalizedURLString(string)
        }

        if let array = object as? [Any] {
            return array.lazy.compactMap(firstURL(in:)).first
        }

        if let dict = object as? [String: Any] {
            for key in ["url", "imageUrl", "imageURL", "src", "path"] {
                if let value = dict[key], let url = firstURL(in: value) {
                    return url
                }
            }
            for key in ["images", "imageUrls", "imageURLs", "data", "items"] {
                if let value = dict[key], let url = firstURL(in: value) {
                    return url
                }
            }
        }

        return nil
    }

    private static func normalizedURLString(_ value: String?) -> String? {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              !value.isEmpty,
              !isNullLiteral(value) else {
            return nil
        }
        return value
    }

    private static func isNullLiteral(_ value: String) -> Bool {
        value.lowercased() == "null"
    }
}
