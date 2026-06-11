import SwiftUI

struct SectionLabel: View {
    let title: String

    var body: some View {
        Text(title.uppercased())
            .font(.wellnessCaption)
            .fontWeight(.semibold)
            .foregroundColor(.wellnessMuted)
            .tracking(0.8)
    }
}
