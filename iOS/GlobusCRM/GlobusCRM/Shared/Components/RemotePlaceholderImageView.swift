import SwiftUI

struct RemotePlaceholderImageView: View {
    let imageUrl: String?
    var placeholderSystemImage: String = Symbols.serviceDefault
    var accent: Color = .wellnessTeal
    var cornerRadius: CGFloat = WellnessRadius.small

    var body: some View {
        Group {
            if let url = resolvedURL {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let image):
                        image
                            .resizable()
                            .scaledToFill()
                    default:
                        placeholder
                    }
                }
            } else {
                placeholder
            }
        }
        .clipped()
        .clipShape(RoundedRectangle(cornerRadius: cornerRadius))
        .accessibilityHidden(true)
    }

    private var resolvedURL: URL? {
        guard let raw = ImageURLParser.firstURL(single: imageUrl) else { return nil }
        if raw.hasPrefix("http://") || raw.hasPrefix("https://") {
            return URL(string: raw)
        }
        let slash = raw.hasPrefix("/") ? "" : "/"
        return URL(string: "\(AppConstants.API.baseURL)\(slash)\(raw)")
    }

    private var placeholder: some View {
        ZStack {
            LinearGradient(
                colors: [
                    accent.opacity(0.16),
                    Color.wellnessGold.opacity(0.12),
                    Color.wellnessSurface
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            Image(systemName: placeholderSystemImage)
                .font(.system(size: IconSize.accent, weight: .semibold))
                .foregroundColor(accent.opacity(0.78))
        }
    }
}

struct ServiceImageFrameView: View {
    let imageUrl: String?
    var height: CGFloat
    var placeholderSystemImage: String = Symbols.serviceDefault
    var accent: Color = .wellnessTeal

    var body: some View {
        RemotePlaceholderImageView(
            imageUrl: imageUrl,
            placeholderSystemImage: placeholderSystemImage,
            accent: accent,
            cornerRadius: WellnessRadius.small
        )
        .frame(maxWidth: .infinity)
        .frame(height: height)
        .background(Color.wellnessBackground)
        .clipShape(RoundedRectangle(cornerRadius: WellnessRadius.small))
        .overlay(
            RoundedRectangle(cornerRadius: WellnessRadius.small)
                .stroke(Color.wellnessMuted.opacity(0.22), lineWidth: 1)
        )
    }
}
