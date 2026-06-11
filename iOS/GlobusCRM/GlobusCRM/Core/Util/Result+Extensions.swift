import Foundation

extension Result where Failure == AppError {
    var isSuccess: Bool {
        if case .success = self { return true }
        return false
    }

    var value: Success? {
        if case .success(let v) = self { return v }
        return nil
    }

    var appError: AppError? {
        if case .failure(let e) = self { return e }
        return nil
    }
}
