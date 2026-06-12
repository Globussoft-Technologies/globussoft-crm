package com.globus.crm.core.util

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.flow.Flow

@Composable
fun <T> Flow<T>.CollectWithLifecycle(
    lifecycleOwner: LifecycleOwner = LocalLifecycleOwner.current,
    minActiveState: Lifecycle.State = Lifecycle.State.STARTED,
    collector: suspend (T) -> Unit,
) {
    LaunchedEffect(this, lifecycleOwner) {
        lifecycleOwner.repeatOnLifecycle(minActiveState) {
            collect { collector(it) }
        }
    }
}

fun String.isValidEmail(): Boolean =
    android.util.Patterns.EMAIL_ADDRESS.matcher(this).matches()

fun String.toInitials(): String =
    trim().split(" ").filter { it.isNotEmpty() }.take(2).joinToString("") { it.first().uppercaseChar().toString() }
