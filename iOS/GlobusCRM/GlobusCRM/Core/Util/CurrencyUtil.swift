import Foundation

enum CurrencyUtil {
    static func formatAmount(_ amount: Double, currency: String) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = currency
        formatter.maximumFractionDigits = 2
        return formatter.string(from: NSNumber(value: amount)) ?? "\(currency) \(String(format: "%.2f", amount))"
    }

    static func formatINR(_ amount: Double) -> String {
        formatAmount(amount, currency: "INR")
    }
}
