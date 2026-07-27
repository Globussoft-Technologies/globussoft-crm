import Foundation
import UIKit

struct TreatmentImageQualityResult {
    let isAcceptable: Bool
    let message: String?
}

struct TreatmentImageQualityChecker {
    func check(imageData: Data) -> TreatmentImageQualityResult {
        guard !imageData.isEmpty,
              let image = UIImage(data: imageData),
              let cgImage = image.cgImage else {
            return TreatmentImageQualityResult(
                isAcceptable: false,
                message: "Image could not be read. Please retake it."
            )
        }

        let sampleWidth = max(1, cgImage.width / 8)
        let sampleHeight = max(1, cgImage.height / 8)
        let bytesPerPixel = 4
        let bytesPerRow = sampleWidth * bytesPerPixel
        var pixels = [UInt8](repeating: 0, count: sampleHeight * bytesPerRow)

        guard let context = CGContext(
            data: &pixels,
            width: sampleWidth,
            height: sampleHeight,
            bitsPerComponent: 8,
            bytesPerRow: bytesPerRow,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else {
            return TreatmentImageQualityResult(
                isAcceptable: false,
                message: "Image could not be read. Please retake it."
            )
        }

        context.draw(cgImage, in: CGRect(x: 0, y: 0, width: sampleWidth, height: sampleHeight))

        var totalBrightness = 0.0
        var totalEdgeDiff = 0.0
        var samples = 0
        let step = 2

        var y = 0
        while y < sampleHeight - step {
            var x = 0
            while x < sampleWidth - step {
                let current = luminance(pixels: pixels, x: x, y: y, width: sampleWidth)
                let right = luminance(pixels: pixels, x: x + step, y: y, width: sampleWidth)
                let bottom = luminance(pixels: pixels, x: x, y: y + step, width: sampleWidth)
                totalBrightness += current
                totalEdgeDiff += abs(current - right) + abs(current - bottom)
                samples += 1
                x += step
            }
            y += step
        }

        guard samples > 0 else {
            return TreatmentImageQualityResult(
                isAcceptable: false,
                message: "Image is too small. Please retake it."
            )
        }

        let averageBrightness = totalBrightness / Double(samples)
        let averageEdgeDiff = totalEdgeDiff / Double(samples * 2)

        if averageBrightness < Self.minimumBrightness {
            return TreatmentImageQualityResult(
                isAcceptable: false,
                message: "Photo is too dark. Move to better lighting and retake it."
            )
        }

        if averageBrightness > Self.maximumBrightness {
            return TreatmentImageQualityResult(
                isAcceptable: false,
                message: "Photo is too bright. Reduce glare and retake it."
            )
        }

        if averageEdgeDiff < Self.minimumEdgeDiff {
            return TreatmentImageQualityResult(
                isAcceptable: false,
                message: "Photo looks blurry. Hold the camera steady and retake it."
            )
        }

        return TreatmentImageQualityResult(isAcceptable: true, message: nil)
    }

    private func luminance(pixels: [UInt8], x: Int, y: Int, width: Int) -> Double {
        let index = (y * width + x) * 4
        let red = Double(pixels[index])
        let green = Double(pixels[index + 1])
        let blue = Double(pixels[index + 2])
        return 0.299 * red + 0.587 * green + 0.114 * blue
    }

    private static let minimumBrightness = 35.0
    private static let maximumBrightness = 235.0
    private static let minimumEdgeDiff = 4.0
}
