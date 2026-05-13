package com.globussoft.wellness.feature.auth.presentation

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.LocalHospital
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.windowsizeclass.ExperimentalMaterial3WindowSizeClassApi
import androidx.compose.material3.windowsizeclass.WindowWidthSizeClass
import androidx.compose.material3.windowsizeclass.calculateWindowSizeClass
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.tooling.preview.PreviewParameter
import androidx.compose.ui.tooling.preview.PreviewParameterProvider
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.globussoft.wellness.core.designsystem.components.WellnessButton
import com.globussoft.wellness.core.designsystem.components.WellnessTextField
import com.globussoft.wellness.core.designsystem.theme.Dimens
import com.globussoft.wellness.core.designsystem.theme.WellnessPrimary
import com.globussoft.wellness.core.designsystem.theme.WellnessPrimaryDark
import com.globussoft.wellness.core.designsystem.theme.WellnessTextPrimary
import com.globussoft.wellness.core.designsystem.theme.WellnessTheme
import kotlinx.coroutines.launch

// ─── Teal brand gradient used for the two-panel left column ──────────────────
private val BrandGradient = Brush.verticalGradient(
    colors = listOf(WellnessPrimary, WellnessPrimaryDark),
)

// ─── Root screen composable ───────────────────────────────────────────────────

/**
 * Login screen composable.
 *
 * Layout adapts to window width:
 * - **Expanded (tablet)** — two-pane: 40 % teal brand panel + 60 % form panel.
 * - **Compact (phone portrait)** — single pane with a teal header strip + form.
 *
 * The screen collects [LoginEffect.NavigateToDashboard] in a [LaunchedEffect]
 * and calls [onLoginSuccess] exactly once on success; the navigation is
 * managed by the parent [com.globussoft.wellness.feature.auth.navigation.AuthNavigation].
 *
 * A debug-only quick-login hint is rendered in non-release builds (detected via
 * [BuildConfig.DEBUG]) to allow one-tap demo credential fill.
 *
 * @param viewModel      Hilt-injected [LoginViewModel] (default).
 * @param onLoginSuccess Invoked after the login effect fires; navigate to main graph.
 */
@Composable
fun LoginScreen(
    viewModel: LoginViewModel = hiltViewModel(),
    onLoginSuccess: () -> Unit,
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val snackbarHostState = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()

    // Consume one-shot effects.
    LaunchedEffect(Unit) {
        viewModel.effects.collect { effect ->
            when (effect) {
                is LoginEffect.NavigateToDashboard -> onLoginSuccess()
                is LoginEffect.ShowError -> scope.launch {
                    snackbarHostState.showSnackbar(effect.message)
                }
            }
        }
    }

    Scaffold(
        snackbarHost = { SnackbarHost(snackbarHostState) },
        containerColor = MaterialTheme.colorScheme.background,
    ) { contentPadding ->
        LoginScreenContent(
            state       = state,
            onEvent     = viewModel::onEvent,
            modifier    = Modifier.padding(contentPadding),
        )
    }
}

// ─── Adaptive content layout ──────────────────────────────────────────────────

@Composable
private fun LoginScreenContent(
    state: LoginUiState,
    onEvent: (LoginEvent) -> Unit,
    modifier: Modifier = Modifier,
) {
    // Infer window width class from the current LocalContext.
    // On API < 30 we fall back to Compact (phone-only portrait layout).
    val isWideLayout = rememberIsWideLayout()

    if (isWideLayout) {
        Row(
            modifier = modifier
                .fillMaxSize()
                .statusBarsPadding(),
        ) {
            // Left brand panel — 40 % of the total width.
            BrandPanel(
                modifier = Modifier
                    .weight(0.4f)
                    .fillMaxHeight(),
            )
            // Right form panel — remaining 60 %.
            FormPanel(
                state    = state,
                onEvent  = onEvent,
                modifier = Modifier
                    .weight(0.6f)
                    .fillMaxHeight(),
            )
        }
    } else {
        Column(
            modifier = modifier
                .fillMaxSize()
                .statusBarsPadding(),
        ) {
            // Compact teal header strip.
            CompactHeaderStrip()
            // Form fills the remainder.
            FormPanel(
                state    = state,
                onEvent  = onEvent,
                modifier = Modifier.weight(1f),
            )
        }
    }
}

// ─── Brand panel (tablet left column) ────────────────────────────────────────

@Composable
private fun BrandPanel(modifier: Modifier = Modifier) {
    Box(
        modifier          = modifier.background(brush = BrandGradient),
        contentAlignment  = Alignment.Center,
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
            modifier            = Modifier.padding(Dimens.SpacingXxl),
        ) {
            Icon(
                imageVector        = Icons.Default.LocalHospital,
                contentDescription = null,
                tint               = Color.White.copy(alpha = 0.9f),
                modifier           = Modifier.size(72.dp),
            )
            Spacer(modifier = Modifier.height(Dimens.SpacingXl))
            Text(
                text      = "Wellness CRM",
                style     = MaterialTheme.typography.displaySmall,
                color     = Color.White,
                textAlign = TextAlign.Center,
            )
            Spacer(modifier = Modifier.height(Dimens.SpacingMd))
            Text(
                text      = "Enterprise Practice Management",
                style     = MaterialTheme.typography.bodyLarge,
                color     = Color.White.copy(alpha = 0.8f),
                textAlign = TextAlign.Center,
            )
            Spacer(modifier = Modifier.height(Dimens.SpacingXxl))
            Text(
                text      = "Manage patients, visits, revenue\nand your entire clinic from one\npowerful mobile dashboard.",
                style     = MaterialTheme.typography.bodyMedium,
                color     = Color.White.copy(alpha = 0.7f),
                textAlign = TextAlign.Center,
                fontStyle = FontStyle.Italic,
            )
        }
    }
}

// ─── Compact header strip (phone portrait) ───────────────────────────────────

@Composable
private fun CompactHeaderStrip() {
    Box(
        modifier         = Modifier
            .fillMaxWidth()
            .background(brush = BrandGradient)
            .padding(vertical = Dimens.SpacingXl, horizontal = Dimens.SpacingXxl),
        contentAlignment = Alignment.Center,
    ) {
        Row(
            verticalAlignment    = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.Center,
        ) {
            Icon(
                imageVector        = Icons.Default.LocalHospital,
                contentDescription = null,
                tint               = Color.White,
                modifier           = Modifier.size(32.dp),
            )
            Spacer(modifier = Modifier.width(Dimens.SpacingMd))
            Text(
                text  = "Wellness CRM",
                style = MaterialTheme.typography.titleLarge,
                color = Color.White,
            )
        }
    }
}

// ─── Form panel ───────────────────────────────────────────────────────────────

@Composable
private fun FormPanel(
    state: LoginUiState,
    onEvent: (LoginEvent) -> Unit,
    modifier: Modifier = Modifier,
) {
    var passwordVisible by remember { mutableStateOf(false) }

    Column(
        modifier = modifier
            .background(MaterialTheme.colorScheme.background)
            .verticalScroll(rememberScrollState())
            .padding(horizontal = Dimens.SpacingXxl)
            .imePadding(),
        verticalArrangement = Arrangement.Center,
    ) {
        Spacer(modifier = Modifier.height(Dimens.SpacingHuge))

        Text(
            text  = "Sign in to your account",
            style = MaterialTheme.typography.headlineMedium,
            color = WellnessTextPrimary,
        )
        Spacer(modifier = Modifier.height(Dimens.SpacingXs))
        Text(
            text  = "Enter your credentials to continue",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        Spacer(modifier = Modifier.height(Dimens.SpacingXxl))

        // Email field.
        WellnessTextField(
            value         = state.email,
            onValueChange = { onEvent(LoginEvent.EmailChanged(it)) },
            label         = "Email address",
            placeholder   = "doctor@clinic.com",
            keyboardType  = KeyboardType.Email,
            imeAction     = ImeAction.Next,
            isError       = state.emailError != null,
            errorMessage  = state.emailError,
            modifier      = Modifier.fillMaxWidth(),
        )

        Spacer(modifier = Modifier.height(Dimens.SpacingLg))

        // Password field.
        WellnessTextField(
            value         = state.password,
            onValueChange = { onEvent(LoginEvent.PasswordChanged(it)) },
            label         = "Password",
            keyboardType  = KeyboardType.Password,
            imeAction     = ImeAction.Done,
            isError       = state.passwordError != null,
            errorMessage  = state.passwordError,
            visualTransformation = if (passwordVisible)
                VisualTransformation.None
            else
                PasswordVisualTransformation(),
            trailingIcon  = {
                IconButton(onClick = { passwordVisible = !passwordVisible }) {
                    Icon(
                        imageVector        = if (passwordVisible)
                            Icons.Default.Visibility
                        else
                            Icons.Default.VisibilityOff,
                        contentDescription = if (passwordVisible)
                            "Hide password"
                        else
                            "Show password",
                        tint               = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            },
            modifier = Modifier.fillMaxWidth(),
        )

        // General server-side error (wrong password, account locked, etc.).
        if (state.generalError != null) {
            Spacer(modifier = Modifier.height(Dimens.SpacingSm))
            Text(
                text  = state.generalError,
                color = MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.bodySmall,
            )
        }

        Spacer(modifier = Modifier.height(Dimens.SpacingXl))

        WellnessButton(
            text      = "Sign In",
            onClick   = { onEvent(LoginEvent.Submit) },
            isLoading = state.isLoading,
            enabled   = !state.isLoading,
            modifier  = Modifier
                .fillMaxWidth()
                .height(52.dp),
        )

        // Debug-only quick-login hint — stripped from release builds by R8.
        if (isDebugBuild()) {
            Spacer(modifier = Modifier.height(Dimens.SpacingXl))
            Text(
                text     = "Demo: rishu@enhancedwellness.in",
                style    = MaterialTheme.typography.labelSmall,
                color    = MaterialTheme.colorScheme.primary.copy(alpha = 0.7f),
                modifier = Modifier
                    .align(Alignment.CenterHorizontally)
                    .clickable {
                        onEvent(LoginEvent.EmailChanged("rishu@enhancedwellness.in"))
                        onEvent(LoginEvent.PasswordChanged("password123"))
                    },
            )
        }

        Spacer(modifier = Modifier.height(Dimens.SpacingHuge))
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns true when the window width is Expanded (tablet landscape).
 * Uses [calculateWindowSizeClass] when available; falls back to `false` on
 * preview / headless environments where no Activity is present.
 */
@OptIn(ExperimentalMaterial3WindowSizeClassApi::class)
@Composable
private fun rememberIsWideLayout(): Boolean {
    val context = LocalContext.current
    return try {
        val activity = context as? android.app.Activity ?: return false
        val wsc = calculateWindowSizeClass(activity)
        wsc.widthSizeClass == WindowWidthSizeClass.Expanded
    } catch (_: Exception) {
        false
    }
}

/**
 * Returns `true` in debug builds.  Inlined so R8 can eliminate the debug-only
 * block in release builds without keeping the branch.
 */
@Suppress("NOTHING_TO_INLINE")
private inline fun isDebugBuild(): Boolean = com.globussoft.wellness.feature.auth.BuildConfig.DEBUG

// ─── Previews ─────────────────────────────────────────────────────────────────

private class LoginStateProvider : PreviewParameterProvider<LoginUiState> {
    override val values = sequenceOf(
        LoginUiState(),
        LoginUiState(email = "rishu@enhancedwellness.in", isLoading = true),
        LoginUiState(
            email         = "bad-email",
            emailError    = "Enter a valid email address",
            passwordError = "Password must be at least 6 characters",
        ),
        LoginUiState(generalError = "Invalid email or password"),
    )
}

@Preview(
    name      = "LoginScreen – phone portrait",
    showBackground = true,
    widthDp   = 400,
    heightDp  = 800,
)
@Composable
private fun LoginScreenPortraitPreview(
    @PreviewParameter(LoginStateProvider::class) state: LoginUiState,
) {
    WellnessTheme {
        LoginScreenContent(
            state   = state,
            onEvent = {},
        )
    }
}

@Preview(
    name      = "LoginScreen – tablet landscape",
    showBackground = true,
    widthDp   = 1024,
    heightDp  = 768,
)
@Composable
private fun LoginScreenLandscapePreview() {
    WellnessTheme {
        // Force wide layout for the tablet preview.
        Row(modifier = Modifier.fillMaxSize()) {
            BrandPanel(modifier = Modifier.weight(0.4f).fillMaxHeight())
            FormPanel(
                state    = LoginUiState(email = "rishu@enhancedwellness.in"),
                onEvent  = {},
                modifier = Modifier.weight(0.6f).fillMaxHeight(),
            )
        }
    }
}
