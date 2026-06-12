package com.globus.crm.feature.catalog.presentation.screen

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.ui.layout.ContentScale
import coil.compose.AsyncImage
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.ScrollableTabRow
import androidx.compose.material3.Surface
import androidx.compose.material3.SuggestionChip
import androidx.compose.material3.Tab
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.globus.crm.core.ui.EmptyState
import com.globus.crm.core.ui.ErrorState
import com.globus.crm.core.ui.WellnessCard
import com.globus.crm.feature.catalog.domain.model.Service
import com.globus.crm.feature.catalog.domain.model.ServiceCategory
import com.globus.crm.feature.catalog.presentation.state.CatalogUiEvent
import com.globus.crm.feature.catalog.presentation.state.CatalogUiState

private val TAB_LABELS = listOf("Services", "Categories", "Memberships")

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CatalogTabScreen(
    state: CatalogUiState,
    onEvent: (CatalogUiEvent) -> Unit,
    membershipsContent: @Composable () -> Unit = {},
) {
    var selectedTab by remember { mutableIntStateOf(0) }
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background),
    ) {
        ScrollableTabRow(
            selectedTabIndex = selectedTab,
            edgePadding = 0.dp,
        ) {
            TAB_LABELS.forEachIndexed { index, label ->
                Tab(
                    selected = selectedTab == index,
                    onClick = { selectedTab = index },
                    text = { Text(label) },
                )
            }
        }

        when (selectedTab) {
            0 -> ServiceCatalogContent(state = state, onEvent = onEvent)
            1 -> ServiceCategoriesContent(
                state = state,
                onEvent = { event ->
                    if (event is CatalogUiEvent.SelectCategory) {
                        onEvent(event)
                        selectedTab = 0
                    } else {
                        onEvent(event)
                    }
                },
            )
            2 -> membershipsContent()
        }
    }

    // Service detail bottom sheet
    if (state.showServiceDetail && state.selectedService != null) {
        ModalBottomSheet(
            onDismissRequest = { onEvent(CatalogUiEvent.DismissServiceDetail) },
            sheetState = sheetState,
        ) {
            ServiceDetailSheet(
                service = state.selectedService,
                onBook = { onEvent(CatalogUiEvent.BookService(state.selectedService.id)) },
                onDismiss = { onEvent(CatalogUiEvent.DismissServiceDetail) },
            )
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ServiceCatalogContent(
    state: CatalogUiState,
    onEvent: (CatalogUiEvent) -> Unit,
) {
    val filteredServices = remember(state.services, state.searchQuery, state.selectedCategoryId) {
        state.services.filter { service ->
            val matchesSearch = state.searchQuery.isBlank() ||
                service.name.contains(state.searchQuery, ignoreCase = true) ||
                service.description?.contains(state.searchQuery, ignoreCase = true) == true
            val matchesCategory = state.selectedCategoryId == null ||
                state.categories.find { it.id == state.selectedCategoryId }?.name == service.categoryName
            matchesSearch && matchesCategory
        }
    }

    PullToRefreshBox(
        isRefreshing = state.isLoading,
        onRefresh = { onEvent(CatalogUiEvent.LoadServices) },
        modifier = Modifier.fillMaxSize(),
    ) {
        Column(modifier = Modifier.fillMaxSize()) {
            OutlinedTextField(
                value = state.searchQuery,
                onValueChange = { onEvent(CatalogUiEvent.UpdateSearch(it)) },
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp, vertical = 12.dp),
                placeholder = { Text("Search services…") },
                leadingIcon = { Icon(Icons.Default.Search, contentDescription = null) },
                singleLine = true,
                shape = RoundedCornerShape(12.dp),
            )

            if (state.selectedCategoryId != null) {
                val activeName = state.categories.find { it.id == state.selectedCategoryId }?.name
                if (activeName != null) {
                    FilterChip(
                        selected = true,
                        onClick = { onEvent(CatalogUiEvent.ClearCategoryFilter) },
                        label = { Text("Showing: $activeName") },
                        trailingIcon = {
                            Icon(
                                imageVector = Icons.Default.Close,
                                contentDescription = "Clear filter",
                                modifier = Modifier.size(14.dp),
                            )
                        },
                        modifier = Modifier
                            .padding(horizontal = 16.dp)
                            .widthIn(max = 280.dp),
                    )
                }
            }

            when {
                state.error != null -> Box(
                    modifier = Modifier.fillMaxSize(),
                    contentAlignment = Alignment.Center,
                ) {
                    ErrorState(message = state.error, onRetry = { onEvent(CatalogUiEvent.LoadServices) })
                }

                filteredServices.isEmpty() && !state.isLoading -> Box(
                    modifier = Modifier.fillMaxSize(),
                    contentAlignment = Alignment.Center,
                ) {
                    EmptyState(message = "No services found.")
                }

                else -> LazyVerticalGrid(
                    columns = GridCells.Adaptive(minSize = 156.dp),
                    contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp),
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                    modifier = Modifier.fillMaxSize(),
                ) {
                    items(filteredServices) { service ->
                        ServiceCard(
                            service = service,
                            onClick = { onEvent(CatalogUiEvent.ShowServiceDetail(service)) },
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun ServiceCard(service: Service, onClick: () -> Unit) {
    WellnessCard(modifier = Modifier.fillMaxWidth(), onClick = onClick) {
        Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(
                text = service.name,
                style = MaterialTheme.typography.titleSmall,
            )

            if (service.categoryName != null) {
                Spacer(modifier = Modifier.height(4.dp))
                SuggestionChip(
                    onClick = {},
                    label = { Text(service.categoryName, style = MaterialTheme.typography.labelSmall) },
                )
            }

            Spacer(modifier = Modifier.height(6.dp))

            if (service.discountedPrice != null) {
                Text(
                    text = "₹${service.discountedPrice.toInt()}",
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.Bold,
                    color = MaterialTheme.colorScheme.primary,
                )
                Text(
                    text = "₹${service.price?.toInt() ?: ""}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            } else if (service.price != null) {
                Text(
                    text = "₹${service.price.toInt()}",
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.Bold,
                    color = MaterialTheme.colorScheme.primary,
                )
            }

            if (service.duration != null) {
                Spacer(modifier = Modifier.height(4.dp))
                Text(
                    text = "${service.duration} min",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@Composable
private fun ServiceDetailSheet(service: Service, onBook: () -> Unit, onDismiss: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 20.dp)
            .padding(top = 8.dp, bottom = 28.dp),
    ) {
        // Category label
        if (service.categoryName != null) {
            Text(
                text = service.categoryName.uppercase(),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                fontWeight = FontWeight.Medium,
                letterSpacing = 1.sp,
            )
            Spacer(Modifier.height(6.dp))
        }

        // Title + severity pill
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Text(
                text = service.name,
                style = MaterialTheme.typography.headlineSmall,
                fontWeight = FontWeight.Bold,
                modifier = Modifier.weight(1f),
            )
            val severity = when {
                (service.price ?: 0.0) >= 25000.0 -> Pair("HIGH", Color(0xFFE63946))
                (service.price ?: 0.0) >= 10000.0 -> Pair("MEDIUM", Color(0xFFE09B2D))
                else -> null
            }
            if (severity != null) {
                Spacer(Modifier.width(8.dp))
                Surface(
                    shape = RoundedCornerShape(4.dp),
                    color = severity.second.copy(alpha = 0.15f),
                ) {
                    Text(
                        text = severity.first,
                        modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
                        style = MaterialTheme.typography.labelSmall,
                        fontWeight = FontWeight.Bold,
                        color = severity.second,
                    )
                }
            }
        }

        Spacer(Modifier.height(16.dp))

        // 3-box stat row
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            ServiceStatBox(
                modifier = Modifier.weight(1f),
                label = "₹ BASE PRICE",
                value = if (service.price != null) "₹${service.price.toInt()}" else "—",
            )
            ServiceStatBox(
                modifier = Modifier.weight(1f),
                label = "DURATION",
                value = if (service.duration != null) "${service.duration} min" else "—",
            )
            ServiceStatBox(
                modifier = Modifier.weight(1f),
                label = "STATUS",
                value = if (service.isActive) "Active" else "Inactive",
            )
        }

        // Description
        if (!service.description.isNullOrBlank()) {
            Spacer(Modifier.height(16.dp))
            Text(
                text = "DESCRIPTION",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                fontWeight = FontWeight.Medium,
                letterSpacing = 1.sp,
            )
            Spacer(Modifier.height(4.dp))
            Text(
                text = service.description,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        Spacer(Modifier.height(20.dp))

        // Book service button
        Button(
            onClick = onBook,
            modifier = Modifier.fillMaxWidth(),
            shape = MaterialTheme.shapes.extraLarge,
        ) {
            Text("📅  Book service")
        }

        Spacer(Modifier.height(10.dp))

        // Footer
        Text(
            text = "Service ID: ${service.id}",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        Spacer(Modifier.height(12.dp))

        // Got it / close
        OutlinedButton(
            onClick = onDismiss,
            modifier = Modifier.fillMaxWidth(),
            shape = MaterialTheme.shapes.extraLarge,
        ) {
            Text("Got it")
        }
    }
}

@Composable
private fun ServiceStatBox(label: String, value: String, modifier: Modifier = Modifier) {
    Surface(
        modifier = modifier,
        shape = RoundedCornerShape(8.dp),
        color = MaterialTheme.colorScheme.surfaceVariant,
    ) {
        Column(
            modifier = Modifier.padding(horizontal = 6.dp, vertical = 12.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(
                text = label,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                letterSpacing = 0.5.sp,
            )
            Spacer(Modifier.height(4.dp))
            Text(
                text = value,
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.Bold,
            )
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ServiceCategoriesContent(
    state: CatalogUiState,
    onEvent: (CatalogUiEvent) -> Unit,
) {
    val filteredCategories = remember(state.categories, state.searchQuery) {
        state.categories.filter { category ->
            state.searchQuery.isBlank() ||
                category.name.contains(state.searchQuery, ignoreCase = true)
        }
    }

    PullToRefreshBox(
        isRefreshing = state.isLoading,
        onRefresh = { onEvent(CatalogUiEvent.LoadCategories) },
        modifier = Modifier.fillMaxSize(),
    ) {
        Column(modifier = Modifier.fillMaxSize()) {
            OutlinedTextField(
                value = state.searchQuery,
                onValueChange = { onEvent(CatalogUiEvent.UpdateSearch(it)) },
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp, vertical = 12.dp),
                placeholder = { Text("Search categories…") },
                leadingIcon = { Icon(Icons.Default.Search, contentDescription = null) },
                singleLine = true,
                shape = RoundedCornerShape(12.dp),
            )

            when {
                state.error != null -> Box(
                    modifier = Modifier.fillMaxSize(),
                    contentAlignment = Alignment.Center,
                ) {
                    ErrorState(message = state.error, onRetry = { onEvent(CatalogUiEvent.LoadCategories) })
                }

                filteredCategories.isEmpty() && !state.isLoading -> Box(
                    modifier = Modifier.fillMaxSize(),
                    contentAlignment = Alignment.Center,
                ) {
                    EmptyState(message = "No categories found.")
                }

                else -> LazyColumn(
                    contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                    modifier = Modifier.fillMaxSize(),
                ) {
                    items(filteredCategories) { category ->
                        CategoryCard(
                            category = category,
                            onClick = { onEvent(CatalogUiEvent.SelectCategory(category.id)) },
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun CategoryCard(category: ServiceCategory, onClick: () -> Unit = {}) {
    WellnessCard(modifier = Modifier.fillMaxWidth(), onClick = onClick) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .height(80.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            // Image on the left — padded + rounded
            Box(
                modifier = Modifier
                    .padding(10.dp)
                    .width(90.dp)
                    .fillMaxHeight()
                    .clip(RoundedCornerShape(10.dp)),
                contentAlignment = Alignment.Center,
            ) {
                if (!category.imageUrl.isNullOrBlank()) {
                    AsyncImage(
                        model = category.imageUrl,
                        contentDescription = category.name,
                        contentScale = ContentScale.Crop,
                        modifier = Modifier.fillMaxSize(),
                    )
                } else {
                    val bgColor = category.color?.let {
                        runCatching { Color(android.graphics.Color.parseColor(it)) }.getOrNull()
                    } ?: MaterialTheme.colorScheme.primaryContainer
                    Box(
                        modifier = Modifier
                            .fillMaxSize()
                            .background(bgColor),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            text = category.name.take(1).uppercase(),
                            style = MaterialTheme.typography.titleLarge,
                            fontWeight = FontWeight.Bold,
                            color = MaterialTheme.colorScheme.primary,
                        )
                    }
                }
            }

            // Name + count to the right
            Row(
                modifier = Modifier
                    .weight(1f)
                    .padding(horizontal = 16.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(
                    text = category.name,
                    style = MaterialTheme.typography.bodyLarge,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.weight(1f),
                )
                Spacer(modifier = Modifier.width(8.dp))
                SuggestionChip(
                    onClick = {},
                    label = {
                        Text(
                            text = "${category.servicesCount} services",
                            style = MaterialTheme.typography.labelSmall,
                        )
                    },
                )
            }
        }
    }
}
