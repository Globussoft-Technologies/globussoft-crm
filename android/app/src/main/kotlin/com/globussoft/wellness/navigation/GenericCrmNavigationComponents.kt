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
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Assignment
import androidx.compose.material.icons.automirrored.filled.TrendingUp
import androidx.compose.material.icons.filled.AccountTree
import androidx.compose.material.icons.filled.AdminPanelSettings
import androidx.compose.material.icons.filled.Analytics
import androidx.compose.material.icons.filled.Approval
import androidx.compose.material.icons.filled.AttachMoney
import androidx.compose.material.icons.filled.BarChart
import androidx.compose.material.icons.filled.Campaign
import androidx.compose.material.icons.filled.CreditCard
import androidx.compose.material.icons.filled.Dashboard
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Groups
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.Hub
import androidx.compose.material.icons.filled.Inbox
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.Layers
import androidx.compose.material.icons.filled.Lightbulb
import androidx.compose.material.icons.filled.LocalOffer
import androidx.compose.material.icons.filled.MoveToInbox
import androidx.compose.material.icons.filled.People
import androidx.compose.material.icons.filled.PersonAdd
import androidx.compose.material.icons.filled.PieChart
import androidx.compose.material.icons.filled.Polyline
import androidx.compose.material.icons.filled.Poll
import androidx.compose.material.icons.filled.Receipt
import androidx.compose.material.icons.filled.Security
import androidx.compose.material.icons.filled.Logout
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.ShowChart
import androidx.compose.material.icons.filled.Store
import androidx.compose.material.icons.filled.SupportAgent
import androidx.compose.material.icons.filled.SwapHoriz
import androidx.compose.material.icons.filled.TableChart
import androidx.compose.material.icons.filled.TaskAlt
import androidx.compose.material.icons.filled.Timeline
import androidx.compose.material.icons.filled.TravelExplore
import androidx.compose.material.icons.filled.ViewKanban
import androidx.compose.material.icons.filled.Web
import androidx.compose.material.icons.filled.Extension
import androidx.compose.material.icons.filled.Public
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.globussoft.wellness.core.data.datastore.UserSession
import com.globussoft.wellness.core.designsystem.theme.GenericAccent
import com.globussoft.wellness.core.designsystem.theme.GenericPrimary
import com.globussoft.wellness.core.designsystem.theme.GenericPrimaryDark
import com.globussoft.wellness.core.designsystem.theme.GenericSectionHeader
import com.globussoft.wellness.core.designsystem.theme.GenericSidebarActive
import com.globussoft.wellness.core.designsystem.theme.GenericSidebarBg
import com.globussoft.wellness.core.designsystem.theme.GenericSidebarBgEnd
import com.globussoft.wellness.core.designsystem.theme.GenericSidebarText
import com.globussoft.wellness.core.domain.model.UserRole

// ─── Generic CRM sidebar navigation tree ─────────────────────────────────────
// Mirrors the web app's generic renderGenericNav() sidebar (Sidebar.jsx).

private val crmAllSections = listOf(

    // ── Core (all users) ─────────────────────────────────────────────────────
    SidebarSection(
        title = "Core",
        items = listOf(
            SidebarItem("crm-dashboard", "Dashboard",         Icons.Filled.Dashboard),
            SidebarItem("crm-pipeline",  "Pipeline",          Icons.Filled.ViewKanban),
            SidebarItem("crm-contacts",  "Contacts",          Icons.Filled.People),
            SidebarItem("crm-leads",     "Leads",             Icons.Filled.PersonAdd),
            SidebarItem("crm-clients",   "Clients",           Icons.AutoMirrored.Filled.Assignment),
            SidebarItem("crm-tasks",     "Tasks",             Icons.Filled.TaskAlt),
            SidebarItem("crm-tickets",   "Tickets",           Icons.Filled.SupportAgent),
            SidebarItem("crm-inbox",     "Inbox",             Icons.Filled.Inbox),
        ),
    ),

    // ── Financial (all users) ─────────────────────────────────────────────────
    SidebarSection(
        title = "Financial",
        items = listOf(
            SidebarItem("crm-invoices",   "Invoices",          Icons.Filled.Receipt),
            SidebarItem("crm-estimates",  "Estimates",         Icons.Filled.Description),
            SidebarItem("crm-expenses",   "Expenses",          Icons.Filled.AttachMoney),
            SidebarItem("crm-contracts",  "Contracts",         Icons.Filled.LocalOffer),
            SidebarItem("crm-payments",   "Payments",          Icons.Filled.CreditCard,         requiresRole = UserRole.MANAGER),
        ),
    ),

    // ── Sales (manager+) ─────────────────────────────────────────────────────
    SidebarSection(
        title = "Sales",
        items = listOf(
            SidebarItem("crm-pipelines",    "Pipelines",      Icons.Filled.Layers,             requiresRole = UserRole.MANAGER),
            SidebarItem("crm-forecasting",  "Forecasting",    Icons.Filled.ShowChart,          requiresRole = UserRole.MANAGER),
            SidebarItem("crm-quotas",       "Quotas",         Icons.AutoMirrored.Filled.TrendingUp, requiresRole = UserRole.MANAGER),
            SidebarItem("crm-win-loss",     "Win / Loss",     Icons.Filled.SwapHoriz,          requiresRole = UserRole.MANAGER),
            SidebarItem("crm-funnel",       "Funnel",         Icons.Filled.Polyline,           requiresRole = UserRole.MANAGER),
        ),
    ),

    // ── Analytics (manager+) ─────────────────────────────────────────────────
    SidebarSection(
        title = "Analytics",
        items = listOf(
            SidebarItem("crm-reports",         "Reports",         Icons.Filled.BarChart,           requiresRole = UserRole.MANAGER),
            SidebarItem("crm-agent-reports",   "Agent Reports",   Icons.Filled.TableChart,         requiresRole = UserRole.MANAGER),
            SidebarItem("crm-dashboards",      "Dashboards",      Icons.Filled.PieChart,           requiresRole = UserRole.MANAGER),
            SidebarItem("crm-deal-insights",   "Deal Insights",   Icons.Filled.Lightbulb,          requiresRole = UserRole.MANAGER),
            SidebarItem("crm-approvals",       "Approvals",       Icons.Filled.Approval,           requiresRole = UserRole.MANAGER),
            SidebarItem("crm-custom-reports",  "Custom Reports",  Icons.Filled.TableChart,         requiresRole = UserRole.MANAGER),
        ),
    ),

    // ── Marketing (manager+) ─────────────────────────────────────────────────
    SidebarSection(
        title = "Marketing",
        items = listOf(
            SidebarItem("crm-marketing",      "Campaigns",      Icons.Filled.Campaign,           requiresRole = UserRole.MANAGER),
            SidebarItem("crm-sequences",      "Sequences",      Icons.Filled.Timeline,           requiresRole = UserRole.MANAGER),
            SidebarItem("crm-landing-pages",  "Landing Pages",  Icons.Filled.Web,                requiresRole = UserRole.MANAGER),
            SidebarItem("crm-marketplace",    "Marketplace",    Icons.Filled.Store,              requiresRole = UserRole.MANAGER),
            SidebarItem("crm-ab-tests",       "A/B Tests",      Icons.Filled.BarChart,           requiresRole = UserRole.MANAGER),
        ),
    ),

    // ── Operations (manager+) ─────────────────────────────────────────────────
    SidebarSection(
        title = "Operations",
        items = listOf(
            SidebarItem("crm-projects",       "Projects",       Icons.Filled.Analytics,          requiresRole = UserRole.MANAGER),
            SidebarItem("crm-lead-routing",   "Lead Routing",   Icons.Filled.AccountTree,        requiresRole = UserRole.MANAGER),
            SidebarItem("crm-territories",    "Territories",    Icons.Filled.TravelExplore,      requiresRole = UserRole.MANAGER),
            SidebarItem("crm-knowledge-base", "Knowledge Base", Icons.Filled.MoveToInbox,        requiresRole = UserRole.MANAGER),
            SidebarItem("crm-surveys",        "Surveys",        Icons.Filled.Poll,               requiresRole = UserRole.MANAGER),
            SidebarItem("crm-shared-inbox",   "Shared Inbox",   Icons.Filled.Groups,             requiresRole = UserRole.MANAGER),
            SidebarItem("crm-support",        "Support",        Icons.Filled.SupportAgent,       requiresRole = UserRole.MANAGER),
            SidebarItem("crm-doc-tracking",   "Doc Tracking",   Icons.Filled.Visibility,         requiresRole = UserRole.MANAGER),
            SidebarItem("crm-doc-templates",  "Doc Templates",  Icons.Filled.Description,        requiresRole = UserRole.MANAGER),
            SidebarItem("crm-playbooks",      "Playbooks",      Icons.Filled.Lightbulb,          requiresRole = UserRole.MANAGER),
            SidebarItem("crm-lead-scoring",   "Lead Scoring",   Icons.Filled.Analytics,          requiresRole = UserRole.MANAGER),
        ),
    ),

    // ── Admin (admin only) ────────────────────────────────────────────────────
    SidebarSection(
        title = "Admin",
        items = listOf(
            SidebarItem("crm-staff",         "Staff",         Icons.Filled.Groups,              requiresRole = UserRole.ADMIN),
            SidebarItem("crm-settings",      "Settings",      Icons.Filled.Settings,            requiresRole = UserRole.ADMIN),
            SidebarItem("crm-channels",      "Channels",      Icons.Filled.Hub,                 requiresRole = UserRole.ADMIN),
            SidebarItem("crm-integrations",  "Integrations",  Icons.Filled.Extension,           requiresRole = UserRole.ADMIN),
            SidebarItem("crm-portal",        "Portal",        Icons.Filled.Public,              requiresRole = UserRole.ADMIN),
            SidebarItem("crm-audit-log",     "Audit Log",     Icons.Filled.History,             requiresRole = UserRole.ADMIN),
            SidebarItem("crm-privacy",       "Privacy",       Icons.Filled.Security,            requiresRole = UserRole.ADMIN),
            SidebarItem("crm-developer",     "Developer",     Icons.Filled.AdminPanelSettings,  requiresRole = UserRole.ADMIN),
        ),
    ),
)

private fun crmFilteredSections(userSession: UserSession?): List<SidebarSection> =
    crmAllSections.mapNotNull { section ->
        val visible = section.items.filter { item ->
            when {
                item.requiresRole == UserRole.ADMIN   -> userSession?.isAdmin == true
                item.requiresRole == UserRole.MANAGER -> userSession?.isManager == true
                else -> true
            }
        }
        if (visible.isEmpty()) null else section.copy(items = visible)
    }

// ─── Persistent Generic CRM Sidebar ──────────────────────────────────────────

@Composable
fun GenericCrmPersistentSidebar(
    currentRoute: String?,
    userSession: UserSession?,
    onNavigate: (String) -> Unit,
    onLogout: () -> Unit = {},
    modifier: Modifier = Modifier,
) {
    val sections = remember(userSession) { crmFilteredSections(userSession) }
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
                    colors = listOf(GenericSidebarBg, GenericSidebarBgEnd),
                ),
            ),
    ) {
        // ── Brand header ─────────────────────────────────────────────
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(
                    start  = 20.dp,
                    end    = 20.dp,
                    top    = WindowInsets.safeDrawing.asPaddingValues().calculateTopPadding() + 12.dp,
                    bottom = 20.dp,
                ),
        ) {
            Text(
                text          = "GLOBUSSOFT",
                color         = GenericSidebarText.copy(alpha = 0.55f),
                fontSize      = 10.sp,
                fontWeight    = FontWeight.Bold,
                letterSpacing = 2.5.sp,
            )
            Text(
                text          = "Enterprise CRM",
                color         = GenericAccent,
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
                CrmSidebarSectionGroup(
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
            modifier = Modifier
                .fillMaxWidth()
                .padding(
                    start  = 16.dp,
                    end    = 16.dp,
                    top    = 14.dp,
                    bottom = WindowInsets.safeDrawing.asPaddingValues().calculateBottomPadding() + 14.dp,
                ),
            verticalAlignment     = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Box(
                modifier         = Modifier
                    .size(34.dp)
                    .clip(CircleShape)
                    .background(GenericAccent.copy(alpha = 0.25f)),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text       = userSession?.name?.firstOrNull()?.uppercaseChar()?.toString() ?: "U",
                    color      = GenericAccent,
                    fontSize   = 14.sp,
                    fontWeight = FontWeight.Bold,
                )
            }
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text       = userSession?.name ?: "User",
                    color      = GenericSidebarText,
                    fontSize   = 12.sp,
                    fontWeight = FontWeight.Medium,
                    maxLines   = 1,
                )
                Text(
                    text     = userSession?.role?.name?.lowercase()?.replaceFirstChar { it.uppercaseChar() } ?: "",
                    color    = GenericSidebarText.copy(alpha = 0.5f),
                    fontSize = 10.sp,
                )
            }
            IconButton(onClick = onLogout) {
                Icon(
                    imageVector        = Icons.Default.Logout,
                    contentDescription = "Logout",
                    tint               = GenericSidebarText.copy(alpha = 0.6f),
                    modifier           = Modifier.size(20.dp),
                )
            }
        }
    }
}

// ─── Section group ────────────────────────────────────────────────────────────

@Composable
private fun CrmSidebarSectionGroup(
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
            color         = GenericSectionHeader,
            fontSize      = 9.sp,
            fontWeight    = FontWeight.Bold,
            letterSpacing = 1.8.sp,
            modifier      = Modifier.weight(1f),
        )
        Icon(
            imageVector        = Icons.Filled.KeyboardArrowDown,
            contentDescription = null,
            tint               = GenericSectionHeader.copy(alpha = 0.6f),
            modifier           = Modifier
                .size(14.dp)
                .rotate(chevronAngle),
        )
    }

    AnimatedVisibility(
        visible = isExpanded,
        enter   = expandVertically(animationSpec = tween(200)),
        exit    = shrinkVertically(animationSpec = tween(200)),
    ) {
        Column {
            section.items.forEach { item ->
                CrmSidebarNavItem(
                    item       = item,
                    isSelected = currentRoute != null && isRouteActive(item.route, currentRoute),
                    onNavigate = onNavigate,
                )
            }
        }
    }
}

// ─── Individual nav item ──────────────────────────────────────────────────────

@Composable
private fun CrmSidebarNavItem(
    item: SidebarItem,
    isSelected: Boolean,
    onNavigate: (String) -> Unit,
) {
    val bgColor   = if (isSelected) GenericSidebarActive else Color.Transparent
    val textColor = if (isSelected) GenericAccent else GenericSidebarText.copy(alpha = 0.85f)
    val iconTint  = if (isSelected) GenericAccent else GenericSidebarText.copy(alpha = 0.6f)

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
        Box(
            modifier = Modifier
                .width(3.dp)
                .height(18.dp)
                .clip(RoundedCornerShape(2.dp))
                .background(if (isSelected) GenericAccent else Color.Transparent),
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

