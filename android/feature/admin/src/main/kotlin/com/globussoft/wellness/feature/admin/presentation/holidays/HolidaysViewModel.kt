package com.globussoft.wellness.feature.admin.presentation.holidays

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.globussoft.wellness.core.common.result.WResult
import com.globussoft.wellness.core.domain.model.Location
import com.globussoft.wellness.feature.admin.domain.repository.AdminRepository
import com.globussoft.wellness.feature.admin.domain.repository.HolidayItem
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.time.LocalDate
import javax.inject.Inject

data class HolidaysUiState(
    val isLoading: Boolean = false,
    val holidays: List<HolidayItem> = emptyList(),
    val locations: List<Location> = emptyList(),
    val error: String? = null,
    val showSheet: Boolean = false,
    val form: HolidayForm = HolidayForm(),
    val isSaving: Boolean = false,
    val saveError: String? = null,
    val showDeleteConfirm: Boolean = false,
    val deletingId: String? = null,
)

data class HolidayForm(
    val date: String = "",
    val name: String = "",
    val locationId: String = "",
)

sealed class HolidaysEvent {
    data object OpenNewSheet : HolidaysEvent()
    data class FieldChanged(val field: String, val value: String) : HolidaysEvent()
    data object Save : HolidaysEvent()
    data object DismissSheet : HolidaysEvent()
    data class RequestDelete(val id: String) : HolidaysEvent()
    data object ConfirmDelete : HolidaysEvent()
    data object DismissDelete : HolidaysEvent()
    data object Refresh : HolidaysEvent()
}

sealed class HolidaysEffect {
    data class ShowSnackbar(val message: String) : HolidaysEffect()
}

@HiltViewModel
class HolidaysViewModel @Inject constructor(
    private val repository: AdminRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(HolidaysUiState())
    val state: StateFlow<HolidaysUiState> = _state.asStateFlow()

    private val _effects = Channel<HolidaysEffect>(Channel.BUFFERED)
    val effects: Flow<HolidaysEffect> = _effects.receiveAsFlow()

    init { load() }

    fun onEvent(event: HolidaysEvent) {
        when (event) {
            HolidaysEvent.OpenNewSheet -> _state.update {
                it.copy(showSheet = true, form = HolidayForm(date = LocalDate.now().toString()), saveError = null)
            }
            is HolidaysEvent.FieldChanged -> _state.update { s ->
                s.copy(form = when (event.field) {
                    "date"       -> s.form.copy(date = event.value)
                    "name"       -> s.form.copy(name = event.value)
                    "locationId" -> s.form.copy(locationId = event.value)
                    else         -> s.form
                })
            }
            HolidaysEvent.Save -> save()
            HolidaysEvent.DismissSheet -> _state.update {
                it.copy(showSheet = false, form = HolidayForm(), saveError = null)
            }
            is HolidaysEvent.RequestDelete -> _state.update {
                it.copy(showDeleteConfirm = true, deletingId = event.id)
            }
            HolidaysEvent.ConfirmDelete -> delete()
            HolidaysEvent.DismissDelete -> _state.update {
                it.copy(showDeleteConfirm = false, deletingId = null)
            }
            HolidaysEvent.Refresh -> load()
        }
    }

    private fun load() {
        viewModelScope.launch {
            _state.update { it.copy(isLoading = true, error = null) }
            val year = LocalDate.now().year
            val from = "$year-01-01"
            val to   = "$year-12-31"
            when (val r = repository.getHolidays(from, to)) {
                is WResult.Success -> {
                    _state.update { it.copy(isLoading = false, holidays = r.data) }
                    loadLocations()
                }
                is WResult.Error   -> _state.update { it.copy(isLoading = false, error = r.message ?: r.exception.message ?: "Failed to load") }
                WResult.Loading    -> Unit
            }
        }
    }

    private fun loadLocations() {
        viewModelScope.launch {
            if ((repository.getLocations() as? WResult.Success)?.data != null) {
                val r = repository.getLocations()
                if (r is WResult.Success) _state.update { it.copy(locations = r.data) }
            }
        }
    }

    private fun save() {
        val form = _state.value.form
        if (form.date.isBlank()) { _state.update { it.copy(saveError = "Date is required") }; return }
        if (form.name.isBlank()) { _state.update { it.copy(saveError = "Holiday name is required") }; return }
        val params = buildMap<String, Any> {
            put("date", form.date)
            put("name", form.name.trim())
            if (form.locationId.isNotBlank()) put("locationId", form.locationId)
        }
        viewModelScope.launch {
            _state.update { it.copy(isSaving = true, saveError = null) }
            when (val result = repository.createHoliday(params)) {
                is WResult.Success -> {
                    _state.update { it.copy(isSaving = false, showSheet = false, form = HolidayForm()) }
                    _effects.send(HolidaysEffect.ShowSnackbar("Holiday added"))
                    load()
                }
                is WResult.Error -> _state.update {
                    it.copy(isSaving = false, saveError = result.message ?: result.exception.message ?: "Save failed")
                }
                WResult.Loading -> Unit
            }
        }
    }

    private fun delete() {
        val id = _state.value.deletingId ?: return
        viewModelScope.launch {
            _state.update { it.copy(showDeleteConfirm = false, deletingId = null) }
            when (val r = repository.deleteHoliday(id)) {
                is WResult.Success -> { _effects.send(HolidaysEffect.ShowSnackbar("Holiday removed")); load() }
                is WResult.Error   -> _effects.send(HolidaysEffect.ShowSnackbar(r.message ?: r.exception.message ?: "Delete failed"))
                WResult.Loading    -> Unit
            }
        }
    }
}
