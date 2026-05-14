package com.globussoft.wellness.navigation

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Assignment
import androidx.compose.material.icons.filled.AccessTime
import androidx.compose.material.icons.filled.AccountBalanceWallet
import androidx.compose.material.icons.filled.AccountTree
import androidx.compose.material.icons.filled.AdminPanelSettings
import androidx.compose.material.icons.filled.AttachMoney
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.Autorenew
import androidx.compose.material.icons.filled.BarChart
import androidx.compose.material.icons.filled.BeachAccess
import androidx.compose.material.icons.filled.Calculate
import androidx.compose.material.icons.filled.CalendarMonth
import androidx.compose.material.icons.filled.Campaign
import androidx.compose.material.icons.filled.CardGiftcard
import androidx.compose.material.icons.filled.CardMembership
import androidx.compose.material.icons.filled.Category
import androidx.compose.material.icons.automirrored.filled.Chat
import androidx.compose.material.icons.filled.CreditCard
import androidx.compose.material.icons.filled.Dashboard
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.EmojiEvents
import androidx.compose.material.icons.filled.Fingerprint
import androidx.compose.material.icons.filled.Groups
import androidx.compose.material.icons.filled.Headset
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.HowToReg
import androidx.compose.material.icons.filled.Hub
import androidx.compose.material.icons.filled.Inbox
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.Layers
import androidx.compose.material.icons.filled.LocalOffer
import androidx.compose.material.icons.filled.LocalShipping
import androidx.compose.material.icons.filled.LocationOn
import androidx.compose.material.icons.filled.Loyalty
import androidx.compose.material.icons.filled.MedicalServices
import androidx.compose.material.icons.filled.Medication
import androidx.compose.material.icons.filled.MeetingRoom
import androidx.compose.material.icons.automirrored.filled.MenuBook
import androidx.compose.material.icons.filled.MoveToInbox
import androidx.compose.material.icons.filled.People
import androidx.compose.material.icons.filled.PersonAdd
import androidx.compose.material.icons.filled.Place
import androidx.compose.material.icons.filled.PointOfSale
import androidx.compose.material.icons.filled.Poll
import androidx.compose.material.icons.filled.Receipt
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material.icons.filled.Security
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Store
import androidx.compose.material.icons.filled.TaskAlt
import androidx.compose.material.icons.filled.Timeline
import androidx.compose.material.icons.automirrored.filled.TrendingUp
import androidx.compose.material.icons.filled.Tune
import androidx.compose.material.icons.filled.Web
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.globussoft.wellness.core.data.datastore.UserSession
import com.globussoft.wellness.core.designsystem.theme.WellnessAccent
import com.globussoft.wellness.core.designsystem.theme.WellnessPrimary
import com.globussoft.wellness.core.designsystem.theme.WellnessPrimaryDark
import com.globussoft.wellness.core.designsystem.theme.WellnessSectionHeader
import com.globussoft.wellness.core.designsystem.theme.WellnessSidebarActive
import com.globussoft.wellness.core.designsystem.theme.WellnessSidebarText
import com.globussoft.wellness.core.domain.model.UserRole
import com.globussoft.wellness.core.domain.model.WellnessRole

// ─── Data models ─────────────────────────────────────────────────────────────

data class SidebarItem(
    val route: String,
    val label: String,
    val icon: ImageVector,
    val requiresRole: UserRole? = null,
    val requiresWellnessRole: WellnessRole? = null,
)

data class SidebarSection(
    val title: String,
    val items: List<SidebarItem>,
    val defaultExpanded: Boolean = true,
)

/** Back-compat alias kept so any old call-sites continue to compile. */
data class NavItem(
    val route: String,
    val label: String,
    val selectedIcon: ImageVector,
    val unselectedIcon: ImageVector,
    val requiresRole: UserRole? = null,
    val requiresWellnessRole: WellnessRole? = null,
)

// ─── Full sidebar navigation tree (mirrors web Sidebar.jsx) ──────────────────

private val allSections = listOf(

    // ── Management ───────────────────────────────────────────────────────────
    // Owner Dashboard + Recommendations are management-only views. Clinical
    // staff (doctor/professional/telecaller/helper) don't see them.
    SidebarSection(
        title = "Management",
        items = listOf(
            SidebarItem("dashboard",       "Owner Dashboard",    Icons.Filled.Dashboard,   requiresRole = UserRole.MANAGER),
            SidebarItem("recommendations", "Recommendations",    Icons.Filled.AutoAwesome,  requiresRole = UserRole.MANAGER),
        ),
    ),

    // ── Clinical ─────────────────────────────────────────────────────────────
    SidebarSection(
        title = "Clinical",
        items = listOf(
            SidebarItem("patients",           "Patients",            Icons.Filled.People),
            SidebarItem("calendar",           "Calendar",            Icons.Filled.CalendarMonth),
            SidebarItem("waitlist",           "Waitlist",            Icons.Filled.Schedule),
            SidebarItem("services",           "Service Catalog",     Icons.Filled.MedicalServices,  requiresRole = UserRole.MANAGER),
            SidebarItem("service-categories", "Service Categories",  Icons.Filled.Category,          requiresRole = UserRole.MANAGER),
            SidebarItem("drugs",              "Drug Catalogue",      Icons.Filled.Medication,        requiresRole = UserRole.MANAGER),
            SidebarItem("memberships",        "Memberships",         Icons.Filled.CardMembership,    requiresRole = UserRole.MANAGER),
            SidebarItem("visits",             "Visits",              Icons.AutoMirrored.Filled.Assignment, requiresRole = UserRole.MANAGER),
            SidebarItem("resources",          "Resources",           Icons.Filled.MeetingRoom,       requiresRole = UserRole.MANAGER),
            SidebarItem("holidays",           "Holidays",            Icons.Filled.EmojiEvents,       requiresRole = UserRole.MANAGER),
            SidebarItem("working-hours",      "Working Hours",       Icons.Filled.AccessTime,        requiresRole = UserRole.MANAGER),
        ),
    ),

    // ── Staff ────────────────────────────────────────────────────────────────
    SidebarSection(
        title = "Staff",
        items = listOf(
            SidebarItem("attendance", "Attendance",    Icons.Filled.Fingerprint),
            SidebarItem("leave",      "Leave",         Icons.Filled.BeachAccess),
        ),
    ),

    // ── Leads & Revenue ──────────────────────────────────────────────────────
    SidebarSection(
        title = "Leads & Revenue",
        items = listOf(
            SidebarItem("inbox",            "Unified Inbox",       Icons.Filled.Inbox),
            SidebarItem("whatsapp",         "WhatsApp Threads",    Icons.AutoMirrored.Filled.Chat),
            SidebarItem("telecaller",       "Telecaller Queue",    Icons.Filled.Headset),
            SidebarItem("leads",            "All Leads",           Icons.Filled.PersonAdd,  requiresRole = UserRole.MANAGER),
            SidebarItem("converted-leads",  "Converted Leads",     Icons.Filled.HowToReg,   requiresRole = UserRole.MANAGER),
            SidebarItem("tasks",            "Tasks",               Icons.Filled.TaskAlt),
            SidebarItem("marketplace-leads","Marketplace Leads",   Icons.Filled.Store,      requiresRole = UserRole.MANAGER),
            SidebarItem("lead-routing",     "Routing Rules",       Icons.Filled.AccountTree, requiresRole = UserRole.MANAGER),
        ),
    ),

    // ── Finance ──────────────────────────────────────────────────────────────
    SidebarSection(
        title = "Finance",
        items = listOf(
            SidebarItem("finance",     "Point of Sale",   Icons.Filled.PointOfSale),
            SidebarItem("invoices",    "Invoices",        Icons.Filled.Receipt),
            SidebarItem("estimates",   "Estimates",       Icons.Filled.Description),
            SidebarItem("expenses",    "Expenses",        Icons.Filled.AttachMoney),
            SidebarItem("payments",    "Payments",        Icons.Filled.CreditCard,            requiresRole = UserRole.MANAGER),
            SidebarItem("wallet",      "Patient Wallets", Icons.Filled.AccountBalanceWallet,  requiresRole = UserRole.MANAGER),
            SidebarItem("gift-cards",  "Gift Cards",      Icons.Filled.CardGiftcard,          requiresRole = UserRole.MANAGER),
            SidebarItem("coupons",     "Coupons",         Icons.Filled.LocalOffer,            requiresRole = UserRole.MANAGER),
            SidebarItem("cashback-rules", "Cashback Rules", Icons.Filled.Loyalty,            requiresRole = UserRole.MANAGER),
        ),
    ),

    // ── Marketing (manager+ only — section auto-hidden for non-managers) ─────
    SidebarSection(
        title = "Marketing",
        items = listOf(
            SidebarItem("marketing",     "SMS / Email Blasts", Icons.Filled.Campaign,  requiresRole = UserRole.MANAGER),
            SidebarItem("sequences",     "Drip Sequences",     Icons.Filled.Timeline,  requiresRole = UserRole.MANAGER),
            SidebarItem("landing-pages", "Landing Pages",      Icons.Filled.Web,       requiresRole = UserRole.MANAGER),
        ),
    ),

    // ── Reports (manager+ only) ───────────────────────────────────────────────
    SidebarSection(
        title = "Reports",
        items = listOf(
            SidebarItem("reports",         "P&L + Attribution",   Icons.Filled.BarChart,    requiresRole = UserRole.MANAGER),
            SidebarItem("per-location",    "Per-Location",        Icons.Filled.Place,       requiresRole = UserRole.MANAGER),
            SidebarItem("loyalty",         "Loyalty + Referrals", Icons.Filled.EmojiEvents, requiresRole = UserRole.MANAGER),
            SidebarItem("surveys",         "Patient Surveys",     Icons.Filled.Poll,        requiresRole = UserRole.MANAGER),
            SidebarItem("knowledge-base",  "Knowledge Base",      Icons.AutoMirrored.Filled.MenuBook,    requiresRole = UserRole.MANAGER),
        ),
    ),

    // ── Inventory (manager+; nested under Admin on web) ───────────────────────
    SidebarSection(
        title = "Inventory",
        items = listOf(
            SidebarItem("product-categories",      "Categories",       Icons.Filled.Layers,       requiresRole = UserRole.MANAGER),
            SidebarItem("vendors",                 "Vendors",          Icons.Filled.LocalShipping, requiresRole = UserRole.MANAGER),
            SidebarItem("inventory-receipts",      "Receipts",         Icons.Filled.MoveToInbox,  requiresRole = UserRole.MANAGER),
            SidebarItem("inventory-adjustments",   "Adjustments",      Icons.Filled.Tune,         requiresRole = UserRole.MANAGER),
            SidebarItem("auto-consumption-rules",  "Auto-consumption", Icons.Filled.Autorenew,    requiresRole = UserRole.MANAGER),
        ),
    ),

    // ── Admin (ADMIN role only) ───────────────────────────────────────────────
    SidebarSection(
        title = "Admin",
        items = listOf(
            SidebarItem("locations",           "Locations",           Icons.Filled.LocationOn,       requiresRole = UserRole.ADMIN),
            SidebarItem("staff",               "Staff",               Icons.Filled.Groups,           requiresRole = UserRole.ADMIN),
            SidebarItem("commission-profiles", "Commission Profiles", Icons.Filled.Calculate,        requiresRole = UserRole.ADMIN),
            SidebarItem("revenue-goals",       "Revenue Goals",       Icons.AutoMirrored.Filled.TrendingUp, requiresRole = UserRole.ADMIN),
            SidebarItem("channels",            "Channels",            Icons.Filled.Hub,              requiresRole = UserRole.ADMIN),
            SidebarItem("audit-log",           "Audit Log",           Icons.Filled.History,          requiresRole = UserRole.ADMIN),
            SidebarItem("privacy",             "Privacy",             Icons.Filled.Security,         requiresRole = UserRole.ADMIN),
            SidebarItem("admin",               "Admin Panel",         Icons.Filled.AdminPanelSettings, requiresRole = UserRole.ADMIN),
        ),
    ),

    // ── Settings (visible to everyone) ───────────────────────────────────────
    SidebarSection(
        title = "Settings",
        items = listOf(
            SidebarItem("settings", "Settings", Icons.Filled.Settings),
        ),
    ),
)

private fun filteredSections(userSession: UserSession?): List<SidebarSection> =
    allSections.mapNotNull { section ->
        val visible = section.items.filter { item ->
            when {
                item.requiresWellnessRole != null -> userSession?.wellnessRole == item.requiresWellnessRole
                item.requiresRole == UserRole.ADMIN -> userSession?.isAdmin == true
                item.requiresRole == UserRole.MANAGER -> userSession?.isManager == true
                else -> true
            }
        }
        if (visible.isEmpty()) null else section.copy(items = visible)
    }

// ─── Persistent Sidebar ───────────────────────────────────────────────────────

/**
 * Always-visible left navigation pane for the tablet two-pane layout.
 *
 * Renders the clinic brand header, a scrollable grouped navigation tree with
 * collapsible sections, and the logged-in user's avatar + name at the bottom.
 * Replaces both the old NavigationRail and the BottomNavigationBar.
 *
 * The section list is derived from [allSections] after filtering out items the
 * current user's role does not permit. Sections with zero visible items are
 * suppressed entirely so no orphan section headers appear.
 */
@Composable
fun WellnessPersistentSidebar(
    currentRoute: String?,
    userSession: UserSession?,
    onNavigate: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val sections = remember(userSession) { filteredSections(userSession) }
    val expandedMap = remember(sections) {
        mutableStateMapOf<String, Boolean>().apply {
            sections.forEach { put(it.title, it.defaultExpanded) }
        }
    }

    Column(
        modifier = modifier
            .fillMaxHeight()
            .width(260.dp)
            .background(
                brush = Brush.verticalGradient(
                    colors = listOf(WellnessPrimary, WellnessPrimaryDark),
                ),
            ),
    ) {
        // ── Brand header ────────────────────────────────────────────
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(start = 20.dp, end = 20.dp, top = 28.dp, bottom = 20.dp),
        ) {
            Text(
                text          = "ENHANCED",
                color         = WellnessSidebarText.copy(alpha = 0.55f),
                fontSize      = 10.sp,
                fontWeight    = FontWeight.Bold,
                letterSpacing = 2.5.sp,
            )
            Text(
                text          = "Wellness CRM",
                color         = WellnessAccent,
                fontSize      = 17.sp,
                fontWeight    = FontWeight.Bold,
                letterSpacing = 0.3.sp,
            )
        }

        HorizontalDivider(
            color     = Color.White.copy(alpha = 0.08f),
            thickness = 1.dp,
            modifier  = Modifier.padding(horizontal = 12.dp),
        )

        // ── Scrollable nav sections ──────────────────────────────────
        Column(
            modifier = Modifier
                .weight(1f)
                .verticalScroll(rememberScrollState())
                .padding(top = 4.dp, bottom = 4.dp),
        ) {
            sections.forEach { section ->
                val expanded = expandedMap[section.title] != false
                SidebarSectionGroup(
                    section      = section,
                    currentRoute = currentRoute,
                    isExpanded   = expanded,
                    onToggle     = { expandedMap[section.title] = !expanded },
                    onNavigate   = onNavigate,
                )
            }
            Spacer(modifier = Modifier.height(8.dp))
        }

        HorizontalDivider(
            color     = Color.White.copy(alpha = 0.08f),
            thickness = 1.dp,
            modifier  = Modifier.padding(horizontal = 12.dp),
        )

        // ── User footer ──────────────────────────────────────────────
        Row(
            modifier              = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 14.dp),
            verticalAlignment     = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Box(
                modifier         = Modifier
                    .size(34.dp)
                    .clip(CircleShape)
                    .background(WellnessAccent.copy(alpha = 0.25f)),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text       = userSession?.name?.firstOrNull()?.uppercaseChar()?.toString() ?: "U",
                    color      = WellnessAccent,
                    fontSize   = 14.sp,
                    fontWeight = FontWeight.Bold,
                )
            }
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text       = userSession?.name ?: "User",
                    color      = WellnessSidebarText,
                    fontSize   = 12.sp,
                    fontWeight = FontWeight.Medium,
                    maxLines   = 1,
                )
                Text(
                    text     = userSession?.role?.name?.lowercase()?.replaceFirstChar { it.uppercaseChar() } ?: "",
                    color    = WellnessSidebarText.copy(alpha = 0.5f),
                    fontSize = 10.sp,
                )
            }
        }
    }
}

// ─── Section group ────────────────────────────────────────────────────────────

@Composable
private fun SidebarSectionGroup(
    section: SidebarSection,
    currentRoute: String?,
    isExpanded: Boolean,
    onToggle: () -> Unit,
    onNavigate: (String) -> Unit,
) {
    val chevronAngle by animateFloatAsState(
        targetValue   = if (isExpanded) 180f else 0f,
        animationSpec = tween(200),
        label         = "chevron",
    )

    // Section header row
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(
                interactionSource = remember { MutableInteractionSource() },
                indication        = null,
                onClick           = onToggle,
            )
            .padding(start = 20.dp, end = 14.dp, top = 14.dp, bottom = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text          = section.title.uppercase(),
            color         = WellnessSectionHeader,
            fontSize      = 9.sp,
            fontWeight    = FontWeight.Bold,
            letterSpacing = 1.8.sp,
            modifier      = Modifier.weight(1f),
        )
        Icon(
            imageVector        = Icons.Filled.KeyboardArrowDown,
            contentDescription = null,
            tint               = WellnessSectionHeader.copy(alpha = 0.6f),
            modifier           = Modifier
                .size(14.dp)
                .rotate(chevronAngle),
        )
    }

    // Animated items list
    AnimatedVisibility(
        visible = isExpanded,
        enter   = expandVertically(animationSpec = tween(200)),
        exit    = shrinkVertically(animationSpec = tween(200)),
    ) {
        Column {
            section.items.forEach { item ->
                SidebarNavItem(
                    item       = item,
                    isSelected = currentRoute != null && isRouteActive(item.route, currentRoute),
                    onNavigate = onNavigate,
                )
            }
        }
    }
}

private fun isRouteActive(itemRoute: String, currentRoute: String): Boolean =
    currentRoute == itemRoute || currentRoute.startsWith("$itemRoute/")

// ─── Individual nav item ──────────────────────────────────────────────────────

@Composable
private fun SidebarNavItem(
    item: SidebarItem,
    isSelected: Boolean,
    onNavigate: (String) -> Unit,
) {
    val bgColor   = if (isSelected) WellnessSidebarActive else Color.Transparent
    val textColor = if (isSelected) WellnessAccent else WellnessSidebarText.copy(alpha = 0.85f)
    val iconTint  = if (isSelected) WellnessAccent else WellnessSidebarText.copy(alpha = 0.6f)

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 8.dp, vertical = 1.dp)
            .clip(RoundedCornerShape(8.dp))
            .background(bgColor)
            .clickable { onNavigate(item.route) }
            .padding(start = 8.dp, end = 12.dp, top = 9.dp, bottom = 9.dp),
        verticalAlignment     = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        // Active indicator bar
        Box(
            modifier = Modifier
                .width(3.dp)
                .height(18.dp)
                .clip(RoundedCornerShape(2.dp))
                .background(if (isSelected) WellnessAccent else Color.Transparent),
        )

        Icon(
            imageVector        = item.icon,
            contentDescription = item.label,
            tint               = iconTint,
            modifier           = Modifier.size(17.dp),
        )

        Text(
            text       = item.label,
            color      = textColor,
            fontSize   = 13.sp,
            fontWeight = if (isSelected) FontWeight.SemiBold else FontWeight.Normal,
            modifier   = Modifier.weight(1f),
        )
    }
}
