package com.globus.crm.feature.booking.presentation.screen

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
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CalendarToday
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TimePicker
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.material3.rememberTimePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.globus.crm.core.ui.ErrorState
import com.globus.crm.core.ui.WellnessCard
import com.globus.crm.core.util.CurrencyUtil
import com.globus.crm.core.util.DateUtil
import com.globus.crm.feature.booking.domain.model.Product
import com.globus.crm.feature.booking.presentation.state.BookAppointmentUiEvent
import com.globus.crm.feature.booking.presentation.state.BookAppointmentUiState
import com.globus.crm.feature.booking.presentation.state.DoctorOption

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BookAppointmentScreen(
    state: BookAppointmentUiState,
    onEvent: (BookAppointmentUiEvent) -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background),
    ) {
        LinearProgressIndicator(
            progress = { state.step / 4f },
            modifier = Modifier.fillMaxWidth(),
        )

        when {
            state.isLoading -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                CircularProgressIndicator()
            }
            state.error != null && state.products.isEmpty() -> Box(
                Modifier.fillMaxSize(),
                contentAlignment = Alignment.Center,
            ) {
                ErrorState(
                    message = state.error,
                    onRetry = { onEvent(BookAppointmentUiEvent.LoadProducts) },
                )
            }
            else -> when (state.step) {
                1 -> Step1Products(state = state, onEvent = onEvent)
                2 -> Step2DoctorSelection(state = state, onEvent = onEvent)
                3 -> Step3DateTime(state = state, onEvent = onEvent)
                else -> Step4Confirm(state = state, onEvent = onEvent)
            }
        }
    }
}

@Composable
private fun Step1Products(state: BookAppointmentUiState, onEvent: (BookAppointmentUiEvent) -> Unit) {
    val filteredProducts = remember(state.products, state.serviceSearchQuery) {
        if (state.serviceSearchQuery.isBlank()) state.products
        else state.products.filter { p ->
            p.name.contains(state.serviceSearchQuery, ignoreCase = true) ||
                p.categoryName?.contains(state.serviceSearchQuery, ignoreCase = true) == true
        }
    }

    Column(modifier = Modifier.fillMaxSize().padding(16.dp)) {
        Text("Choose a service", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
        Spacer(modifier = Modifier.height(12.dp))
        OutlinedTextField(
            value = state.serviceSearchQuery,
            onValueChange = { onEvent(BookAppointmentUiEvent.UpdateServiceSearch(it)) },
            modifier = Modifier.fillMaxWidth(),
            placeholder = { Text("Search services…") },
            leadingIcon = { Icon(Icons.Default.Search, contentDescription = null) },
            singleLine = true,
            shape = RoundedCornerShape(12.dp),
        )
        Spacer(modifier = Modifier.height(12.dp))
        if (state.products.isEmpty()) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text("No services available", color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        } else if (filteredProducts.isEmpty()) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text("No services match \"${state.serviceSearchQuery}\"", color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        } else {
            LazyVerticalGrid(
                columns = GridCells.Adaptive(minSize = 156.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
                modifier = Modifier.weight(1f),
            ) {
                items(filteredProducts) { product ->
                    ProductCard(
                        product = product,
                        isSelected = state.selectedProduct?.id == product.id,
                        onClick = { onEvent(BookAppointmentUiEvent.SelectProduct(product)) },
                    )
                }
            }
            Spacer(modifier = Modifier.height(16.dp))
            Button(
                onClick = { onEvent(BookAppointmentUiEvent.NextStep) },
                enabled = state.selectedProduct != null,
                modifier = Modifier.fillMaxWidth(),
                shape = MaterialTheme.shapes.extraLarge,
            ) { Text("Continue") }
            if (state.error != null) {
                Text(
                    text = state.error,
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodySmall,
                )
            }
        }
    }
}

@Composable
private fun ProductCard(product: Product, isSelected: Boolean, onClick: () -> Unit) {
    if (isSelected) {
        androidx.compose.material3.Card(
            onClick = onClick,
            modifier = Modifier.fillMaxWidth(),
            shape = MaterialTheme.shapes.medium,
            colors = CardDefaults.cardColors(
                containerColor = MaterialTheme.colorScheme.primaryContainer,
            ),
            elevation = CardDefaults.cardElevation(defaultElevation = 0.dp),
            border = CardDefaults.outlinedCardBorder(),
        ) {
            ProductCardContent(product = product, isSelected = true)
        }
    } else {
        WellnessCard(modifier = Modifier.fillMaxWidth(), onClick = onClick) {
            ProductCardContent(product = product, isSelected = false)
        }
    }
}

@Composable
private fun ProductCardContent(product: Product, isSelected: Boolean) {
    Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(
            text = product.name,
            style = MaterialTheme.typography.titleSmall,
            color = if (isSelected) MaterialTheme.colorScheme.onPrimaryContainer
                    else MaterialTheme.colorScheme.onSurface,
        )
        if (!product.categoryName.isNullOrBlank()) {
            Text(
                text = product.categoryName,
                style = MaterialTheme.typography.bodySmall,
                color = if (isSelected) MaterialTheme.colorScheme.onPrimaryContainer.copy(alpha = 0.7f)
                        else MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        if (product.price != null) {
            Text(
                text = CurrencyUtil.formatRupees(product.price),
                style = MaterialTheme.typography.labelLarge,
                fontWeight = FontWeight.SemiBold,
                color = if (isSelected) MaterialTheme.colorScheme.onPrimaryContainer
                        else MaterialTheme.colorScheme.primary,
            )
        }
    }
}

@Composable
private fun Step2DoctorSelection(state: BookAppointmentUiState, onEvent: (BookAppointmentUiEvent) -> Unit) {
    val doctors = if (state.doctors.isEmpty()) {
        listOf(DoctorOption(id = null, name = "No preference"))
    } else {
        state.doctors
    }

    Column(modifier = Modifier.fillMaxSize().padding(16.dp)) {
        Text("Choose a doctor", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
        Spacer(modifier = Modifier.height(4.dp))
        WellnessCard(modifier = Modifier.fillMaxWidth()) {
            Text(
                "If you choose no preference, the clinic will assign a doctor.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(12.dp),
            )
        }
        Spacer(modifier = Modifier.height(12.dp))
        LazyColumn(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            items(doctors) { doc ->
                val isSelected = state.selectedDoctorId == doc.id
                WellnessCard(
                    modifier = Modifier.fillMaxWidth(),
                    onClick = { onEvent(BookAppointmentUiEvent.SelectDoctor(doc.id)) },
                ) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 16.dp, vertical = 14.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.SpaceBetween,
                    ) {
                        Text(
                            text = doc.name,
                            style = MaterialTheme.typography.bodyMedium,
                            fontWeight = if (isSelected) FontWeight.SemiBold else FontWeight.Normal,
                            color = if (isSelected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface,
                            modifier = Modifier.weight(1f),
                        )
                        if (isSelected) {
                            Icon(
                                imageVector = Icons.Filled.CheckCircle,
                                contentDescription = "Selected",
                                tint = MaterialTheme.colorScheme.primary,
                                modifier = Modifier.size(20.dp),
                            )
                        }
                    }
                }
            }
        }
        Spacer(modifier = Modifier.height(16.dp))
        Button(
            onClick = { onEvent(BookAppointmentUiEvent.NextStep) },
            modifier = Modifier.fillMaxWidth(),
            shape = MaterialTheme.shapes.extraLarge,
        ) { Text("Continue") }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun Step3DateTime(state: BookAppointmentUiState, onEvent: (BookAppointmentUiEvent) -> Unit) {
    var showDatePicker by remember { mutableStateOf(false) }
    var showTimePicker by remember { mutableStateOf(false) }

    val datePickerState = rememberDatePickerState(
        initialSelectedDateMillis = state.selectedDate ?: System.currentTimeMillis(),
        selectableDates = object : androidx.compose.material3.SelectableDates {
            override fun isSelectableDate(utcTimeMillis: Long) = utcTimeMillis >= System.currentTimeMillis() - 86_400_000L
        },
    )
    val timePickerState = rememberTimePickerState(initialHour = 9, initialMinute = 0, is24Hour = true)

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text("Select date & time", style = MaterialTheme.typography.titleMedium)

        // Date picker button
        OutlinedButton(
            onClick = { showDatePicker = true },
            modifier = Modifier.fillMaxWidth(),
            shape = MaterialTheme.shapes.medium,
        ) {
            Icon(Icons.Default.CalendarToday, contentDescription = null, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(8.dp))
            Text(
                text = state.selectedDate?.let { DateUtil.toDisplayDate(it) } ?: "Select appointment date",
                style = MaterialTheme.typography.bodyMedium,
            )
        }

        // Time picker button
        OutlinedButton(
            onClick = { showTimePicker = true },
            modifier = Modifier.fillMaxWidth(),
            shape = MaterialTheme.shapes.medium,
        ) {
            Icon(Icons.Default.Schedule, contentDescription = null, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(8.dp))
            Text(
                text = state.selectedTime ?: "Select appointment time",
                style = MaterialTheme.typography.bodyMedium,
            )
        }

        if (state.error != null) {
            Text(state.error, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
        }

        Spacer(modifier = Modifier.weight(1f))

        Button(
            onClick = { onEvent(BookAppointmentUiEvent.NextStep) },
            enabled = state.selectedDate != null && state.selectedTime != null,
            modifier = Modifier.fillMaxWidth(),
            shape = MaterialTheme.shapes.extraLarge,
        ) { Text("Continue") }
    }

    if (showDatePicker) {
        DatePickerDialog(
            onDismissRequest = { showDatePicker = false },
            confirmButton = {
                TextButton(onClick = {
                    datePickerState.selectedDateMillis?.let { onEvent(BookAppointmentUiEvent.SelectDate(it)) }
                    showDatePicker = false
                }) { Text("OK") }
            },
            dismissButton = {
                TextButton(onClick = { showDatePicker = false }) { Text("Cancel") }
            },
        ) {
            DatePicker(state = datePickerState, showModeToggle = false)
        }
    }

    if (showTimePicker) {
        AlertDialog(
            onDismissRequest = { showTimePicker = false },
            title = { Text("Select time", style = MaterialTheme.typography.titleMedium) },
            text = {
                Box(contentAlignment = Alignment.Center, modifier = Modifier.fillMaxWidth()) {
                    TimePicker(state = timePickerState)
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    val h = timePickerState.hour.toString().padStart(2, '0')
                    val m = timePickerState.minute.toString().padStart(2, '0')
                    onEvent(BookAppointmentUiEvent.SelectTime("$h:$m"))
                    showTimePicker = false
                }) { Text("OK") }
            },
            dismissButton = {
                TextButton(onClick = { showTimePicker = false }) { Text("Cancel") }
            },
        )
    }
}

@Composable
private fun Step4Confirm(state: BookAppointmentUiState, onEvent: (BookAppointmentUiEvent) -> Unit) {
    val doctorLabel = state.doctors.find { it.id == state.selectedDoctorId }?.name ?: "No preference"
    Column(modifier = Modifier.fillMaxSize().padding(16.dp)) {
        Text("Confirm booking", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
        Spacer(modifier = Modifier.height(16.dp))

        WellnessCard(modifier = Modifier.fillMaxWidth()) {
            Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                InfoRow("Service", state.selectedProduct?.name ?: "—")
                InfoRow("Doctor", doctorLabel)
                InfoRow("Date", DateUtil.toDisplayDate(state.selectedDate ?: 0L))
                InfoRow("Time", state.selectedTime ?: "—")
            }
        }

        Spacer(modifier = Modifier.height(16.dp))
        Text("Reason for visit", style = MaterialTheme.typography.labelMedium)
        Spacer(modifier = Modifier.height(4.dp))
        OutlinedTextField(
            value = state.reason,
            onValueChange = { onEvent(BookAppointmentUiEvent.EnterReason(it)) },
            modifier = Modifier.fillMaxWidth(),
            placeholder = { Text("e.g. Routine checkup, follow-up…") },
            minLines = 3,
            maxLines = 5,
        )

        if (state.error != null) {
            Spacer(modifier = Modifier.height(4.dp))
            Text(state.error, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
        }

        Spacer(modifier = Modifier.weight(1f))
        Button(
            onClick = { onEvent(BookAppointmentUiEvent.ConfirmBooking) },
            enabled = !state.isBooking,
            modifier = Modifier.fillMaxWidth(),
            shape = MaterialTheme.shapes.extraLarge,
        ) {
            if (state.isBooking) CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
            else Text("Book Appointment")
        }
    }
}

@Composable
private fun InfoRow(label: String, value: String) {
    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(
            text = label,
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Text(
            text = value,
            style = MaterialTheme.typography.bodyMedium,
            fontWeight = FontWeight.Medium,
        )
    }
}
