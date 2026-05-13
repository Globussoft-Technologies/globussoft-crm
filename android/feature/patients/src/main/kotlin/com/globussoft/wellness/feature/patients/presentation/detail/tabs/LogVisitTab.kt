package com.globussoft.wellness.feature.patients.presentation.detail.tabs

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import com.globussoft.wellness.core.designsystem.components.WellnessButton
import com.globussoft.wellness.core.designsystem.components.WellnessCard
import com.globussoft.wellness.core.designsystem.components.WellnessDropdown
import com.globussoft.wellness.core.designsystem.components.WellnessTextField
import com.globussoft.wellness.core.designsystem.theme.Dimens
import com.globussoft.wellness.core.designsystem.theme.WellnessPrimary
import com.globussoft.wellness.core.designsystem.theme.WellnessTextSecondary
import com.globussoft.wellness.feature.patients.presentation.detail.PatientDetailEvent
import com.globussoft.wellness.feature.patients.presentation.detail.PatientDetailUiState
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

private val BOOKING_TYPES = listOf(
    "CLINIC_VISIT" to "Clinic",
    "AT_HOME"      to "Home",
    "VIDEO"        to "Video",
    "PHONE"        to "Phone",
)

/**
 * Tab 4 — Log Visit.
 *
 * A form that submits to `POST /api/wellness/visits` via [PatientDetailEvent.LogVisit].
 *
 * Fields:
 * - Service dropdown (populated from [PatientDetailUiState.services])
 * - Doctor dropdown (populated from [PatientDetailUiState.doctors])
 * - Date field (defaults to today, accepts YYYY-MM-DD input)
 * - Booking type radio chips (Clinic / Home / Video / Phone)
 * - Notes textarea
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun LogVisitTab(
    state: PatientDetailUiState,
    onEvent: (PatientDetailEvent) -> Unit,
) {
    var selectedServiceId by remember { mutableStateOf("") }
    var selectedDoctorId  by remember { mutableStateOf("") }
    var date              by remember { mutableStateOf(todayDateString()) }
    var bookingType       by remember { mutableStateOf("CLINIC_VISIT") }
    var notes             by remember { mutableStateOf("") }
    var serviceError      by remember { mutableStateOf<String?>(null) }

    val serviceOptions = state.services.map { it.id to it.name }
    val doctorOptions  = listOf("" to "No doctor assigned") +
        state.doctors.map { it.id to it.name }

    LazyColumn(
        contentPadding  = PaddingValues(Dimens.SpacingLg),
        verticalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
        modifier = Modifier.fillMaxSize(),
    ) {
        item {
            WellnessCard(modifier = Modifier.fillMaxWidth()) {
                Column(
                    modifier = Modifier.padding(Dimens.SpacingLg),
                    verticalArrangement = Arrangement.spacedBy(Dimens.SpacingMd),
                ) {
                    Text(
                        text  = "Log a New Visit",
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.SemiBold,
                        color = WellnessPrimary,
                    )

                    // Service
                    if (serviceOptions.isEmpty()) {
                        Text(
                            text  = "No services configured. Add services in the Services module.",
                            style = MaterialTheme.typography.bodySmall,
                            color = WellnessTextSecondary,
                        )
                    } else {
                        WellnessDropdown(
                            value         = selectedServiceId,
                            onValueChange = { selectedServiceId = it; serviceError = null },
                            label         = "Service *",
                            options       = serviceOptions,
                        )
                        if (serviceError != null) {
                            Text(
                                text  = serviceError!!,
                                color = MaterialTheme.colorScheme.error,
                                style = MaterialTheme.typography.bodySmall,
                                modifier = Modifier.padding(start = Dimens.SpacingLg),
                            )
                        }
                    }

                    // Doctor
                    WellnessDropdown(
                        value         = selectedDoctorId,
                        onValueChange = { selectedDoctorId = it },
                        label         = "Doctor / Professional",
                        options       = doctorOptions,
                    )

                    // Date
                    WellnessTextField(
                        value         = date,
                        onValueChange = { date = it },
                        label         = "Visit Date (YYYY-MM-DD)",
                        placeholder   = "2026-05-13",
                        imeAction     = ImeAction.Next,
                    )

                    // Booking type chips
                    Text(
                        text  = "Booking Type",
                        style = MaterialTheme.typography.labelMedium,
                        color = WellnessTextSecondary,
                    )
                    FlowRow(
                        modifier              = Modifier
                            .fillMaxWidth()
                            .selectableGroup(),
                        horizontalArrangement = Arrangement.spacedBy(Dimens.SpacingSm),
                    ) {
                        BOOKING_TYPES.forEach { (value, label) ->
                            FilterChip(
                                selected = bookingType == value,
                                onClick  = { bookingType = value },
                                label    = { Text(label, style = MaterialTheme.typography.labelSmall) },
                                colors   = FilterChipDefaults.filterChipColors(
                                    selectedContainerColor = WellnessPrimary,
                                    selectedLabelColor     = androidx.compose.ui.graphics.Color.White,
                                ),
                            )
                        }
                    }

                    // Notes
                    WellnessTextField(
                        value         = notes,
                        onValueChange = { notes = it },
                        label         = "Notes (optional)",
                        singleLine    = false,
                        maxLines      = 4,
                        imeAction     = ImeAction.Default,
                    )

                    Spacer(Modifier.height(Dimens.SpacingXs))

                    WellnessButton(
                        text      = "Log Visit",
                        onClick   = {
                            if (selectedServiceId.isBlank() && serviceOptions.isNotEmpty()) {
                                serviceError = "Please select a service"
                                return@WellnessButton
                            }
                            onEvent(
                                PatientDetailEvent.LogVisit(
                                    serviceId   = selectedServiceId,
                                    doctorId    = selectedDoctorId,
                                    date        = date,
                                    bookingType = bookingType,
                                    notes       = notes,
                                )
                            )
                            // Reset form on submission.
                            selectedServiceId = ""
                            selectedDoctorId  = ""
                            date              = todayDateString()
                            bookingType       = "CLINIC_VISIT"
                            notes             = ""
                        },
                        isLoading = state.isLoggingVisit,
                        modifier  = Modifier.fillMaxWidth(),
                    )

                    if (state.logVisitError != null) {
                        Text(
                            text  = state.logVisitError,
                            color = MaterialTheme.colorScheme.error,
                            style = MaterialTheme.typography.bodySmall,
                        )
                    }
                }
            }
        }
    }
}

private fun todayDateString(): String =
    SimpleDateFormat("yyyy-MM-dd", Locale.getDefault()).format(Date())
