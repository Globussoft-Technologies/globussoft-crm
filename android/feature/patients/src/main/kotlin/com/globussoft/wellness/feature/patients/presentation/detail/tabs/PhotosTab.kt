package com.globussoft.wellness.feature.patients.presentation.detail.tabs

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.PhotoLibrary
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.dp
import androidx.compose.ui.platform.LocalContext
import coil3.compose.AsyncImage
import coil3.request.ImageRequest
import coil3.request.crossfade
import com.globussoft.wellness.core.designsystem.components.EmptyState
import com.globussoft.wellness.core.designsystem.theme.Dimens
import com.globussoft.wellness.core.designsystem.theme.WellnessPrimary
import com.globussoft.wellness.core.domain.model.Patient

/**
 * Tab 5 — Photos.
 *
 * Shows a grid of patient progress/clinical photos using an adaptive
 * [LazyVerticalGrid] with 120 dp cells. Each cell renders via Coil 3's
 * [AsyncImage] for efficient network loading with crossfade.
 *
 * An "Upload Photo" FAB is provided. The actual photo upload flow (camera /
 * gallery picker → multipart POST) requires a future feature sprint; the FAB
 * is present in the UI to reflect the intended UX.
 */
@Composable
fun PhotosTab(patient: Patient) {
    // Photo URLs would come from GET /wellness/patients/{id}/photos.
    // Populated with placeholder Pravatar images for UI demonstration.
    val photoUrls = buildList {
        repeat(patient.visitsCount.coerceAtMost(12)) { index ->
            add("https://picsum.photos/seed/${patient.id}-$index/300/300")
        }
    }

    Scaffold(
        floatingActionButton = {
            FloatingActionButton(
                onClick        = {
                    // TODO: launch camera/gallery picker for photo upload.
                },
                containerColor = WellnessPrimary,
            ) {
                Icon(
                    imageVector        = Icons.Default.Add,
                    contentDescription = "Upload Photo",
                    tint               = Color.White,
                )
            }
        },
        containerColor = Color.Transparent,
    ) { contentPadding ->
        if (photoUrls.isEmpty()) {
            EmptyState(
                message  = "No photos uploaded yet.\nTap + to add a clinical photo.",
                icon     = Icons.Default.PhotoLibrary,
                modifier = Modifier
                    .fillMaxSize()
                    .padding(contentPadding),
            )
        } else {
            LazyVerticalGrid(
                columns         = GridCells.Adaptive(minSize = 120.dp),
                contentPadding  = PaddingValues(Dimens.SpacingMd),
                modifier        = Modifier
                    .fillMaxSize()
                    .padding(contentPadding),
            ) {
                items(count = photoUrls.size) { index ->
                    PhotoGridItem(url = photoUrls[index])
                }
            }
        }
    }
}

@Composable
private fun PhotoGridItem(url: String) {
    Box(
        modifier = Modifier
            .aspectRatio(1f)
            .padding(Dimens.SpacingXs)
            .clip(MaterialTheme.shapes.small)
            .background(MaterialTheme.colorScheme.surfaceVariant),
    ) {
        AsyncImage(
            model = ImageRequest.Builder(LocalContext.current)
                .data(url)
                .crossfade(true)
                .build(),
            contentDescription = "Patient photo",
            contentScale       = ContentScale.Crop,
            modifier           = Modifier.fillMaxSize(),
        )
    }
}
