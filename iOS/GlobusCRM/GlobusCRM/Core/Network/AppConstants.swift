import Foundation
import CoreGraphics
import SwiftUI

// MARK: - API & Tenant

enum AppConstants {
    enum API {
        static let baseURL = "https://globuscrm.globussoft.com"
        static let apiPath = "/api/"
        static var fullBaseURL: URL { URL(string: "\(baseURL)\(apiPath)")! }
    }

    enum Tenant {
        static let defaultSlug = "enhanced-wellness"
    }
}

// MARK: - SF Symbols

enum Symbols {
    // Navigation & Actions
    static let bell            = "bell"
    static let bellBadge       = "bell.badge"
    static let chevronRight    = "chevron.right"
    static let chevronLeft     = "chevron.left"
    static let close           = "xmark"
    static let plus            = "plus"
    static let plusCircle      = "plus.circle.fill"
    static let search          = "magnifyingglass"
    static let refresh         = "arrow.clockwise"
    static let share           = "square.and.arrow.up"
    static let camera          = "camera.fill"
    static let eye             = "eye"
    static let eyeSlash        = "eye.slash"
    static let checkmark       = "checkmark"
    static let checkmarkCircle = "checkmark.circle.fill"
    static let errorTriangle   = "exclamationmark.triangle"
    static let infoCircle      = "info.circle"

    // Health & Clinic
    static let clinic          = "cross.case.fill"
    static let stethoscope     = "stethoscope"
    static let prescription    = "doc.text"
    static let treatmentPlan   = "list.clipboard"
    static let consent         = "doc.badge.ellipsis"
    static let consentSigned   = "checkmark.seal.fill"
    static let consentPending  = "doc.badge.clock"

    // Booking
    static let calendar        = "calendar"
    static let calendarClock   = "calendar.badge.clock"
    static let calendarBadge   = "calendar.badge.exclamationmark"
    static let clock           = "clock"
    static let clockBadge      = "clock.badge.checkmark"
    static let doctor          = "person.fill.questionmark"

    // Finance & Wallet
    static let wallet          = "wallet.pass"
    static let giftCard        = "giftcard.fill"
    static let creditCard      = "creditcard"
    static let currency        = "indianrupeesign.circle"
    static let transaction     = "arrow.left.arrow.right"

    // Loyalty & Membership
    static let star            = "star.circle"
    static let starFill        = "star.fill"
    static let memberBadge     = "person.badge.shield.checkmark"
    static let membership      = "rosette"

    // Profile & Settings
    static let person          = "person.circle"
    static let personFill      = "person.fill"
    static let settings        = "gearshape"
    static let lock            = "lock"
    static let notification    = "bell"
    static let darkMode        = "moon"
    static let signOut         = "rectangle.portrait.and.arrow.right"
    static let download        = "square.and.arrow.down"
    static let trash           = "trash"
    static let pencil          = "pencil"

    // Catalog
    static let services        = "list.bullet"
    static let categories      = "square.grid.2x2"
    static let serviceDefault  = "cross.circle.fill"

    // Status
    static let arrowUp         = "arrow.up.circle.fill"
    static let arrowDown       = "arrow.down.circle.fill"
}

// MARK: - Icon Sizes

enum IconSize {
    /// 16 pt — inline badge icons
    static let badge:   CGFloat = 16
    /// 18 pt — KPI card icons
    static let small:   CGFloat = 18
    /// 20 pt — toolbar icons
    static let toolbar: CGFloat = 20
    /// 22 pt — FAB icons in navigation bar
    static let fab:     CGFloat = 22
    /// 24 pt — quick-action tiles
    static let medium:  CGFloat = 24
    /// 28 pt — list row leading icons
    static let row:     CGFloat = 28
    /// 32 pt — dashboard card accents
    static let accent:  CGFloat = 32
    /// 44 pt — notification type icons (HIG minimum tappable with visual affordance)
    static let large:   CGFloat = 44
    /// 48 pt — empty-state illustrations
    static let empty:   CGFloat = 48
    /// 72 pt — splash / hero icons
    static let hero:    CGFloat = 72
    /// 96 pt — avatar
    static let avatar:  CGFloat = 96
}

// MARK: - Layout

enum Layout {
    /// Standard horizontal page margin (16 pt)
    static let pagePadding: CGFloat        = 16
    /// Compact padding inside cards (12 pt)
    static let cardPaddingCompact: CGFloat = 12
    /// Standard padding inside cards (16 pt)
    static let cardPadding: CGFloat        = 16
    /// Generous padding inside hero cards (20 pt)
    static let cardPaddingLarge: CGFloat   = 20
    /// Between top-level sections in a scroll (24 pt)
    static let sectionSpacing: CGFloat     = 24
    /// Between items within a section (12 pt)
    static let itemSpacing: CGFloat        = 12
    /// Minimum HIG touch target
    static let minTapTarget: CGFloat       = 44
    /// Avatar size
    static let avatarSize: CGFloat         = 96
    /// Golden ratio constant (1.618)
    static let goldenRatio: CGFloat        = 1.618
}

// MARK: - Animation

enum AppAnimation {
    /// Default spring for interactive elements (press/release)
    static let spring   = Animation.spring(response: 0.3, dampingFraction: 0.7)
    /// Fast spring for chip / toggle selection
    static let fast     = Animation.spring(response: 0.2, dampingFraction: 0.8)
    /// Eased for sheet/modal transitions
    static let easeOut  = Animation.easeOut(duration: 0.2)
    /// Scale factor for button press effect
    static let pressScale: CGFloat = 0.96
}
