import Foundation

final class WellnessAPIClient {
    private let baseURL: URL
    private let session: URLSession
    private let interceptor: AuthInterceptor
    private let decoder: JSONDecoder

    weak var sessionManager: SessionManager?

    init(keychainManager: KeychainManager, sessionManager: SessionManager) {
        let base = Bundle.main.object(forInfoDictionaryKey: "BASE_URL") as? String
            ?? AppConstants.API.baseURL
        self.baseURL = URL(string: "\(base)\(AppConstants.API.apiPath)")!
        self.interceptor = AuthInterceptor(keychainManager: keychainManager)
        self.sessionManager = sessionManager
        self.decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 30
        self.session = URLSession(configuration: config)
    }

    // MARK: - Throws-based (used by Auth, Booking, Dashboard repositories)

    func request<T: Decodable>(_ endpoint: WellnessEndpoint) async throws -> T {
        let urlRequest = try buildRequest(for: endpoint)
        let (data, response) = try await session.data(for: urlRequest)
        try handle(response: response, data: data, endpoint: endpoint)
        do { return try decoder.decode(T.self, from: data) }
        catch { throw AppError.decoding(error.localizedDescription) }
    }

    func requestWithBody<T: Decodable>(_ endpoint: WellnessEndpoint, body: some Encodable) async throws -> T {
        var urlRequest = try buildRequest(for: endpoint)
        urlRequest.httpBody = try JSONEncoder().encode(body)
        let (data, response) = try await session.data(for: urlRequest)
        try handle(response: response, data: data, endpoint: endpoint)
        do { return try decoder.decode(T.self, from: data) }
        catch { throw AppError.decoding(error.localizedDescription) }
    }

    func requestData(_ endpoint: WellnessEndpoint) async throws -> Data {
        let urlRequest = try buildRequest(for: endpoint)
        let (data, response) = try await session.data(for: urlRequest)
        try handle(response: response, data: data, endpoint: endpoint)
        return data
    }

    func requestVoid(_ endpoint: WellnessEndpoint, body: (some Encodable)? = nil as String?) async throws {
        var urlRequest = try buildRequest(for: endpoint)
        if let body { urlRequest.httpBody = try JSONEncoder().encode(body) }
        let (data, response) = try await session.data(for: urlRequest)
        try handle(response: response, data: data, endpoint: endpoint)
    }

    func uploadMultipart<T: Decodable>(_ endpoint: WellnessEndpoint,
                                       imageData: Data,
                                       mimeType: String = "image/jpeg") async throws -> T {
        var urlRequest = try buildRequest(for: endpoint)
        let boundary = UUID().uuidString
        urlRequest.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        var body = Data()
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"file\"; filename=\"avatar.jpg\"\r\n".data(using: .utf8)!)
        body.append("Content-Type: \(mimeType)\r\n\r\n".data(using: .utf8)!)
        body.append(imageData)
        body.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)
        urlRequest.httpBody = body
        let (data, response) = try await session.data(for: urlRequest)
        try handle(response: response, data: data, endpoint: endpoint)
        return try decoder.decode(T.self, from: data)
    }

    // MARK: - Result<>-based wrappers (positional — legacy helpers)

    func result<T: Decodable>(_ endpoint: WellnessEndpoint) async -> Result<T, AppError> {
        do { return .success(try await request(endpoint)) }
        catch let e as AppError { return .failure(e) }
        catch { return .failure(.unknown(error.localizedDescription)) }
    }

    func resultWithBody<T: Decodable>(_ endpoint: WellnessEndpoint, body: some Encodable) async -> Result<T, AppError> {
        do { return .success(try await requestWithBody(endpoint, body: body)) }
        catch let e as AppError { return .failure(e) }
        catch { return .failure(.unknown(error.localizedDescription)) }
    }

    func resultData(_ endpoint: WellnessEndpoint) async -> Result<Data, AppError> {
        do { return .success(try await requestData(endpoint)) }
        catch let e as AppError { return .failure(e) }
        catch { return .failure(.unknown(error.localizedDescription)) }
    }

    func resultVoid(_ endpoint: WellnessEndpoint, body: (some Encodable)? = nil as String?) async -> Result<Void, AppError> {
        do { try await requestVoid(endpoint, body: body); return .success(()) }
        catch let e as AppError { return .failure(e) }
        catch { return .failure(.unknown(error.localizedDescription)) }
    }

    // MARK: - Labeled overloads (used by Health, Profile, Membership, Wallet, Loyalty, Catalog repositories)

    func request<T: Decodable>(endpoint: WellnessEndpoint) async -> Result<T, AppError> {
        do { return .success(try await request(endpoint)) }
        catch let e as AppError { return .failure(e) }
        catch { return .failure(.unknown(error.localizedDescription)) }
    }

    func requestWithBody<T: Decodable>(endpoint: WellnessEndpoint, body: some Encodable) async -> Result<T, AppError> {
        do { return .success(try await requestWithBody(endpoint, body: body)) }
        catch let e as AppError { return .failure(e) }
        catch { return .failure(.unknown(error.localizedDescription)) }
    }

    func requestData(endpoint: WellnessEndpoint) async -> Result<Data, AppError> {
        do { return .success(try await requestData(endpoint)) }
        catch let e as AppError { return .failure(e) }
        catch { return .failure(.unknown(error.localizedDescription)) }
    }

    func requestVoid<B: Encodable>(endpoint: WellnessEndpoint, body: B) async -> Result<Void, AppError> {
        do {
            var urlRequest = try buildRequest(for: endpoint)
            urlRequest.httpBody = try JSONEncoder().encode(body)
            let (data, response) = try await session.data(for: urlRequest)
            try handle(response: response, data: data, endpoint: endpoint)
            return .success(())
        }
        catch let e as AppError { return .failure(e) }
        catch { return .failure(.unknown(error.localizedDescription)) }
    }

    func uploadMultipart(endpoint: WellnessEndpoint, data: Data, fieldName: String, fileName: String, mimeType: String) async -> Result<Data, AppError> {
        do {
            var urlRequest = try buildRequest(for: endpoint)
            let boundary = UUID().uuidString
            urlRequest.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
            var body = Data()
            body.append("--\(boundary)\r\n".data(using: .utf8)!)
            body.append("Content-Disposition: form-data; name=\"\(fieldName)\"; filename=\"\(fileName)\"\r\n".data(using: .utf8)!)
            body.append("Content-Type: \(mimeType)\r\n\r\n".data(using: .utf8)!)
            body.append(data)
            body.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)
            urlRequest.httpBody = body
            let (responseData, response) = try await session.data(for: urlRequest)
            try handle(response: response, data: responseData, endpoint: endpoint)
            return .success(responseData)
        }
        catch let e as AppError { return .failure(e) }
        catch { return .failure(.unknown(error.localizedDescription)) }
    }

    // MARK: - Private helpers

    private func buildRequest(for endpoint: WellnessEndpoint) throws -> URLRequest {
        var components = URLComponents(url: baseURL.appendingPathComponent(endpoint.path),
                                       resolvingAgainstBaseURL: false)!
        components.queryItems = endpoint.queryItems
        guard let url = components.url else { throw AppError.network("Invalid URL") }
        var request = URLRequest(url: url)
        request.httpMethod = endpoint.method.rawValue
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if endpoint.requiresAuth { interceptor.apply(to: &request) }
        #if DEBUG
        print("[API] → \(request.httpMethod ?? "?") \(url.absoluteString)")
        #endif
        return request
    }

    private func handle(response: URLResponse, data: Data, endpoint: WellnessEndpoint) throws {
        guard let http = response as? HTTPURLResponse else {
            throw AppError.network("Invalid response")
        }
        #if DEBUG
        let bodyString = prettyJSON(data) ?? String(data: data, encoding: .utf8) ?? "<binary \(data.count) bytes>"
        print("[API] ← \(http.statusCode) \(endpoint.path)\n\(bodyString)")
        #endif
        if http.statusCode == 401 {
            Task { @MainActor in sessionManager?.handleUnauthorized() }
            throw AppError.unauthorized
        }
        guard (200..<300).contains(http.statusCode) else {
            let msg = extractMessage(from: data) ?? HTTPURLResponse.localizedString(forStatusCode: http.statusCode)
            let code = extractCode(from: data)
            throw AppError.http(statusCode: http.statusCode, message: msg, serverCode: code)
        }
    }

    private func extractMessage(from data: Data) -> String? {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return json["error"] as? String ?? json["message"] as? String
    }

    private func extractCode(from data: Data) -> String? {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return json["code"] as? String
    }

    #if DEBUG
    private func prettyJSON(_ data: Data) -> String? {
        guard let obj = try? JSONSerialization.jsonObject(with: data),
              let pretty = try? JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted, .sortedKeys]),
              let str = String(data: pretty, encoding: .utf8) else { return nil }
        return str
    }
    #endif
}
