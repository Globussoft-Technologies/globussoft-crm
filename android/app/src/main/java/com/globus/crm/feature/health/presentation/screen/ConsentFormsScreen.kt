package com.globus.crm.feature.health.presentation.screen

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.PictureAsPdf
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.globus.crm.core.ui.WellnessCard
import com.globus.crm.core.util.DateUtil
import com.globus.crm.feature.health.domain.model.ConsentForm
import com.globus.crm.feature.health.presentation.state.ConsentFormsUiEvent
import com.globus.crm.feature.health.presentation.state.ConsentFormsUiState

@Composable
fun ConsentFormsScreen(
    state: ConsentFormsUiState,
    onEvent: (ConsentFormsUiEvent) -> Unit,
) {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background),
    ) {
        when {
            state.isLoading -> CircularProgressIndicator(modifier = Modifier.align(Alignment.Center))
            state.error != null -> Column(
                modifier = Modifier.align(Alignment.Center),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text(state.error, color = MaterialTheme.colorScheme.error)
                Spacer(Modifier.height(12.dp))
                Button(onClick = { onEvent(ConsentFormsUiEvent.Refresh) }, shape = MaterialTheme.shapes.extraLarge) { Text("Retry") }
            }
            state.forms.isEmpty() -> Text(
                text = "No consent forms found",
                modifier = Modifier.align(Alignment.Center),
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            else -> LazyColumn(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(horizontal = 16.dp, vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                items(state.forms, key = { it.id }) { form ->
                    ConsentFormCard(
                        form = form,
                        onViewPdf = { onEvent(ConsentFormsUiEvent.ViewPdf(form.id)) },
                    )
                }
            }
        }
    }
}

@Composable
private fun ConsentFormCard(form: ConsentForm, onViewPdf: () -> Unit) {
    WellnessCard(modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = form.templateName,
                    style = MaterialTheme.typography.titleSmall,
                )
                if (form.serviceName != null) {
                    Spacer(Modifier.height(2.dp))
                    Text(
                        text = form.serviceName,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Spacer(Modifier.height(4.dp))
                Text(
                    text = "Signed: ${DateUtil.toDisplayDate(form.signedAt)}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            if (form.hasPdfBlob) {
                IconButton(onClick = onViewPdf) {
                    Icon(
                        imageVector = Icons.Default.PictureAsPdf,
                        contentDescription = "View PDF",
                        tint = MaterialTheme.colorScheme.primary,
                    )
                }
            }
        }
    }
}
