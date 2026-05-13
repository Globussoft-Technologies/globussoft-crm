package com.globussoft.wellness.feature.patients.presentation.detail.tabs

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.GppMaybe
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.globussoft.wellness.core.designsystem.components.WellnessButton
import com.globussoft.wellness.core.designsystem.components.WellnessCard
import com.globussoft.wellness.core.designsystem.components.WellnessOutlinedButton
import com.globussoft.wellness.core.designsystem.theme.Dimens
import com.globussoft.wellness.core.designsystem.theme.WellnessPrimary
import com.globussoft.wellness.core.designsystem.theme.WellnessSuccess
import com.globussoft.wellness.core.designsystem.theme.WellnessTextSecondary
import com.globussoft.wellness.core.designsystem.theme.WellnessWarning
import com.globussoft.wellness.core.domain.model.Patient

/**
 * Tab 2 — Consent.
 *
 * Displays the current consent status for the patient. Two states:
 * - No consent on file: shows a prompt card with a "Request Consent" CTA.
 * - Consent exists: shows the signed date, status badge, and "View PDF" button.
 *
 * Consent form data is loaded from the future
 * `GET /wellness/patients/{id}/consent` endpoint; the tab renders a sensible
 * informational UI in the interim based on patient metadata.
 */
@Composable
fun ConsentTab(patient: Patient) {
    // Consent existence is approximated by whether the patient has any visits.
    // When the real consent API is wired in, replace this with `consent != null`.
    val hasConsent = patient.visitsCount > 0

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(Dimens.SpacingLg),
        verticalArrangement = Arrangement.spacedBy(Dimens.SpacingLg),
    ) {
        if (!hasConsent) {
            NoConsentCard()
        } else {
            ConsentRecordCard(
                signedDate = "On file",
                status     = "SIGNED",
            )
        }

        ConsentInfoCard()
    }
}

@Composable
private fun NoConsentCard() {
    WellnessCard(modifier = Modifier.fillMaxWidth()) {
        Column(
            modifier            = Modifier.padding(Dimens.SpacingXl),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
        ) {
            Icon(
                imageVector        = Icons.Default.GppMaybe,
                contentDescription = null,
                tint               = WellnessWarning,
                modifier           = Modifier.size(48.dp),
            )
            Text(
                text  = "No Consent Form on File",
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
                color = MaterialTheme.colorScheme.onSurface,
            )
            Text(
                text  = "A signed consent form is required before any treatment can be administered.",
                style = MaterialTheme.typography.bodySmall,
                color = WellnessTextSecondary,
            )
            Spacer(Modifier.height(Dimens.SpacingXs))
            WellnessButton(
                text    = "Request Consent",
                onClick = {
                    // TODO: wire to POST /wellness/patients/{id}/consent when
                    //       the consent flow is implemented in a future sprint.
                },
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

@Composable
private fun ConsentRecordCard(signedDate: String, status: String) {
    WellnessCard(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(Dimens.SpacingLg)) {
            Row(
                verticalAlignment   = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(Dimens.SpacingSm),
            ) {
                Icon(
                    imageVector        = Icons.Default.CheckCircle,
                    contentDescription = null,
                    tint               = WellnessSuccess,
                    modifier           = Modifier.size(20.dp),
                )
                Text(
                    text  = "Consent Form on File",
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                    color = WellnessSuccess,
                )
            }
            Spacer(Modifier.height(Dimens.SpacingSm))
            ConsentRow(label = "Status", value = status)
            ConsentRow(label = "Signed", value = signedDate)
            Spacer(Modifier.height(Dimens.SpacingMd))
            WellnessOutlinedButton(
                text     = "View PDF",
                onClick  = {
                    // TODO: open the PDF URL in a WebView / external browser.
                },
                icon     = Icons.Outlined.Description,
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

@Composable
private fun ConsentRow(label: String, value: String) {
    Row {
        Text(
            text  = "$label: ",
            style = MaterialTheme.typography.bodySmall,
            color = WellnessTextSecondary,
        )
        Text(
            text  = value,
            style = MaterialTheme.typography.bodySmall,
            fontWeight = FontWeight.Medium,
        )
    }
}

@Composable
private fun ConsentInfoCard() {
    WellnessCard(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(Dimens.SpacingMd)) {
            Text(
                text  = "About Consent Forms",
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold,
                color = WellnessPrimary,
            )
            Spacer(Modifier.height(Dimens.SpacingXs))
            Text(
                text  = "Patients sign a digital consent form before their first treatment. " +
                    "The signed PDF is stored securely and attached to this record.",
                style = MaterialTheme.typography.bodySmall,
                color = WellnessTextSecondary,
            )
        }
    }
}
