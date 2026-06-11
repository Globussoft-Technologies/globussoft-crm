import SwiftUI

@main
@MainActor
struct WellnessCRMApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    @StateObject private var container = AppContainer()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(container.sessionManager)
                .environmentObject(container.appRouter)
                .environmentObject(container.appState)
                .environmentObject(container)
        }
    }
}
