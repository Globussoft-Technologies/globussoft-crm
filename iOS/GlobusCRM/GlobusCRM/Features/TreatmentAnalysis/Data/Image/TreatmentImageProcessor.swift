import Foundation
import UIKit

final class TreatmentImageProcessor {
    private let fileManager: FileManager

    init(fileManager: FileManager = .default) {
        self.fileManager = fileManager
    }

    func compressToPrivateFile(imageData: Data,
                               prescriptionId: String,
                               stage: TreatmentCaptureStage) throws -> URL {
        guard let image = UIImage(data: imageData) else {
            throw AppError.network("Unable to decode captured image.")
        }

        let targetSize = resizedSize(for: image)
        let renderer = UIGraphicsImageRenderer(size: targetSize)
        let normalized = renderer.image { _ in
            image.draw(in: CGRect(origin: .zero, size: targetSize))
        }

        guard let jpegData = normalized.jpegData(compressionQuality: Self.jpegQuality) else {
            throw AppError.network("Unable to save captured image.")
        }

        let directory = try privateImageDirectory()
        let fileName = "prescription_\(safeFilePart(prescriptionId))_\(stage.rawValue)_\(Int(Date().timeIntervalSince1970 * 1000)).jpg"
        let outputURL = directory.appendingPathComponent(fileName)
        try jpegData.write(to: outputURL, options: [.atomic])
        return outputURL
    }

    private func resizedSize(for image: UIImage) -> CGSize {
        let pixelWidth = CGFloat(image.cgImage?.width ?? Int(image.size.width))
        let pixelHeight = CGFloat(image.cgImage?.height ?? Int(image.size.height))
        let largest = max(pixelWidth, pixelHeight)
        guard largest > Self.maxDimension else {
            return CGSize(width: pixelWidth, height: pixelHeight)
        }
        let scale = Self.maxDimension / largest
        return CGSize(width: pixelWidth * scale, height: pixelHeight * scale)
    }

    private func privateImageDirectory() throws -> URL {
        let base = try fileManager.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )
        let directory = base
            .appendingPathComponent("GlobusCRM", isDirectory: true)
            .appendingPathComponent("treatment_analysis", isDirectory: true)
            .appendingPathComponent("images", isDirectory: true)
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }

    private func safeFilePart(_ value: String) -> String {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "_-"))
        return value.unicodeScalars
            .map { allowed.contains($0) ? Character($0) : "_" }
            .reduce(into: "") { $0.append($1) }
    }

    private static let maxDimension: CGFloat = 1600
    private static let jpegQuality = 0.8
}
