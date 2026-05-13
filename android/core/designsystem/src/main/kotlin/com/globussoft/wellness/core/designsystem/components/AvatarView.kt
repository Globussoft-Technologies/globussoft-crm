package com.globussoft.wellness.core.designsystem.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil3.compose.AsyncImage
import coil3.request.ImageRequest
import coil3.request.crossfade
import com.globussoft.wellness.core.designsystem.theme.Dimens
import com.globussoft.wellness.core.designsystem.theme.WellnessPrimary
import com.globussoft.wellness.core.designsystem.theme.WellnessTheme

// ─── Initials helper ──────────────────────────────────────────────────────────

/**
 * Extracts up to 2 uppercase initials from [name].
 *
 * Examples:
 * - "Ramesh Kumar" → "RK"
 * - "Dr. Harsh"   → "DH"
 * - "Anjali"      → "AN"  (first 2 chars when single word)
 */
private fun initials(name: String): String {
    val parts = name.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }
    return when {
        parts.size >= 2 -> "${parts[0][0]}${parts[1][0]}"
        parts.size == 1 && parts[0].length >= 2 -> parts[0].substring(0, 2)
        parts.size == 1 -> parts[0].take(1)
        else            -> "?"
    }.uppercase()
}

// ─── Composable ───────────────────────────────────────────────────────────────

/**
 * A circular avatar that loads a remote image via Coil 3 when [imageUrl] is
 * provided, or falls back to an initials badge on a teal background.
 *
 * The initials fallback mirrors the frontend's patient / staff avatar treatment
 * throughout the wellness UI.
 *
 * @param name      Full name used to derive initials for the fallback badge.
 * @param imageUrl  Optional HTTPS URL of the profile image.
 * @param size      Diameter of the avatar circle. Defaults to 40 dp.
 * @param modifier  Layout modifier.
 */
@Composable
fun WellnessAvatar(
    name: String,
    imageUrl: String? = null,
    size: Dp = 40.dp,
    modifier: Modifier = Modifier,
) {
    // Initials font size scales with the avatar size at ~38% of diameter.
    val textSize = (size.value * 0.38f).sp

    Box(
        modifier         = modifier.size(size),
        contentAlignment = Alignment.Center,
    ) {
        if (!imageUrl.isNullOrBlank()) {
            AsyncImage(
                model = ImageRequest.Builder(LocalContext.current)
                    .data(imageUrl)
                    .crossfade(true)
                    .build(),
                contentDescription = name,
                contentScale       = ContentScale.Crop,
                modifier           = Modifier
                    .size(size)
                    .clip(CircleShape),
            )
        } else {
            // Initials fallback
            Box(
                modifier         = Modifier
                    .size(size)
                    .clip(CircleShape)
                    .background(WellnessPrimary),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text  = initials(name),
                    color = Color.White,
                    fontSize = textSize,
                    fontWeight = FontWeight.SemiBold,
                )
            }
        }
    }
}

// ─── Previews ─────────────────────────────────────────────────────────────────

@Preview(name = "WellnessAvatar – initials (various sizes)", showBackground = true)
@Composable
private fun WellnessAvatarInitialsPreview() {
    WellnessTheme {
        Row(
            modifier          = Modifier.padding(Dimens.SpacingLg),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            WellnessAvatar(name = "Ramesh Kumar", size = 32.dp)
            Spacer(Modifier.width(Dimens.SpacingSm))
            WellnessAvatar(name = "Dr. Harsh Mehta", size = 40.dp)
            Spacer(Modifier.width(Dimens.SpacingSm))
            WellnessAvatar(name = "Anjali", size = 56.dp)
            Spacer(Modifier.width(Dimens.SpacingSm))
            WellnessAvatar(name = "Priya Singh", size = 72.dp)
        }
    }
}

@Preview(name = "WellnessAvatar – with image URL", showBackground = true)
@Composable
private fun WellnessAvatarImagePreview() {
    WellnessTheme {
        WellnessAvatar(
            name     = "Ramesh Kumar",
            imageUrl = "https://i.pravatar.cc/150?u=ramesh",
            size     = 56.dp,
            modifier = Modifier.padding(Dimens.SpacingLg),
        )
    }
}
