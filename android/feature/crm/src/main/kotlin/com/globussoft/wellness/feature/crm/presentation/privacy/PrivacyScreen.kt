package com.globussoft.wellness.feature.crm.presentation.privacy

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.globussoft.wellness.core.designsystem.components.WellnessCard
import com.globussoft.wellness.core.designsystem.theme.Dimens
import com.globussoft.wellness.core.designsystem.theme.GenericPrimary

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PrivacyScreen() {
    Scaffold(
        topBar = {
            TopAppBar(
                title  = { Text("Privacy & Compliance") },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.surface),
            )
        },
        containerColor = MaterialTheme.colorScheme.background,
    ) { contentPadding ->
        LazyColumn(
            modifier       = Modifier
                .fillMaxSize()
                .padding(contentPadding),
            contentPadding = PaddingValues(horizontal = Dimens.SpacingLg, vertical = Dimens.SpacingSm),
            verticalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
        ) {
            item {
                PrivacySectionCard(
                    title       = "GDPR Data Export",
                    description = "Export all personal data held for a specific contact or user in a machine-readable format (JSON/CSV). Required under GDPR Article 20.",
                    buttonLabel = "Request Data Export",
                )
            }
            item {
                PrivacySectionCard(
                    title       = "Data Retention Policy",
                    description = "Configure how long different types of data are retained. Inactive leads are purged after 90 days by default. Retention rules are enforced nightly.",
                    buttonLabel = "Manage Retention Rules",
                )
            }
            item {
                PrivacySectionCard(
                    title       = "Consent Records",
                    description = "View and manage consent records collected from contacts and patients. Each record includes the consent type, timestamp, and IP address.",
                    buttonLabel = "View Consent Records",
                )
            }
            item {
                PrivacySectionCard(
                    title       = "Right to Erasure",
                    description = "Process data deletion requests. Once confirmed, all personal data for the subject is anonymized across Contacts, Leads, Visits, and Prescriptions.",
                    buttonLabel = "Process Erasure Request",
                )
            }
        }
    }
}

@Composable
private fun PrivacySectionCard(
    title: String,
    description: String,
    buttonLabel: String,
    modifier: Modifier = Modifier,
) {
    WellnessCard(modifier = modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(Dimens.SpacingLg),
        ) {
            Text(text = title, style = MaterialTheme.typography.titleSmall)
            Spacer(Modifier.height(6.dp))
            Text(
                text  = description,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(12.dp))
            Button(
                onClick  = { /* non-functional placeholder */ },
                modifier = Modifier.fillMaxWidth(),
                colors   = ButtonDefaults.buttonColors(containerColor = GenericPrimary),
            ) {
                Text(buttonLabel)
            }
        }
    }
}
