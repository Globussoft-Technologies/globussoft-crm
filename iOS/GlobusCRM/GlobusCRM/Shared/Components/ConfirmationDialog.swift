import SwiftUI

struct WellnessConfirmationDialog: ViewModifier {
    @Binding var isPresented: Bool
    let title: String
    let message: String
    let confirmLabel: String
    let confirmRole: ButtonRole?
    let onConfirm: () -> Void

    func body(content: Content) -> some View {
        content.confirmationDialog(title, isPresented: $isPresented, titleVisibility: .visible) {
            Button(confirmLabel, role: confirmRole, action: onConfirm)
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(message)
        }
    }
}

extension View {
    func wellnessConfirmDialog(
        isPresented: Binding<Bool>,
        title: String,
        message: String,
        confirmLabel: String = "Confirm",
        confirmRole: ButtonRole? = nil,
        onConfirm: @escaping () -> Void
    ) -> some View {
        modifier(WellnessConfirmationDialog(
            isPresented: isPresented,
            title: title,
            message: message,
            confirmLabel: confirmLabel,
            confirmRole: confirmRole,
            onConfirm: onConfirm
        ))
    }
}
