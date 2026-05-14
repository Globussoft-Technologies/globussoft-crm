package com.globussoft.wellness.feature.finance.navigation

import androidx.navigation.NavController
import androidx.navigation.NavGraphBuilder
import androidx.navigation.compose.composable
import androidx.hilt.navigation.compose.hiltViewModel
import com.globussoft.wellness.core.data.datastore.UserSession
import com.globussoft.wellness.feature.finance.presentation.FinanceHubScreen
import com.globussoft.wellness.feature.finance.presentation.coupons.CouponsScreen
import com.globussoft.wellness.feature.finance.presentation.estimates.EstimatesScreen
import com.globussoft.wellness.feature.finance.presentation.expenses.ExpensesScreen
import com.globussoft.wellness.feature.finance.presentation.giftcards.GiftCardsScreen
import com.globussoft.wellness.feature.finance.presentation.invoices.InvoicesScreen
import com.globussoft.wellness.feature.finance.presentation.payments.PaymentsScreen
import com.globussoft.wellness.feature.finance.presentation.pos.PosScreen
import com.globussoft.wellness.feature.finance.presentation.wallet.WalletScreen

/**
 * Route constants for the finance feature graph.
 *
 * All navigation call sites should use these constants rather than inline
 * strings to make renames safe and auditable.
 */
object FinanceDestinations {
    const val Pos       = "finance"
    const val Wallet    = "wallet"
    const val GiftCards = "gift-cards"
    const val Coupons   = "coupons"
    const val Payments  = "payments"
    const val Invoices  = "invoices"
    const val Estimates = "estimates"
    const val Expenses  = "expenses"
}

/**
 * Registers the four finance-feature composable destinations into the caller's
 * [NavGraphBuilder].
 *
 * ### Routes
 * - `"finance"` → [FinanceHubScreen] — Tab hub: POS / Gift Cards / Coupons / Wallet.
 * - `"wallet"` → [WalletScreen] — Patient wallet balance + ledger (deep-link).
 * - `"gift-cards"` → [GiftCardsScreen] — Gift card issuance + status list (deep-link).
 * - `"coupons"` → [CouponsScreen] — Coupon CRUD + discount preview (deep-link).
 *
 * [userSession] is threaded through so screens can gate actions behind
 * role checks (e.g. only ADMIN / MANAGER can manage coupons).
 *
 * @param navController Shared nav controller for cross-graph navigation.
 * @param userSession   The currently signed-in user session; null on cold start
 *                      before auth resolves (destinations will show loading state).
 */
fun NavGraphBuilder.financeGraph(
    navController: NavController,
    userSession: UserSession?,
) {
    composable(route = FinanceDestinations.Pos) {
        FinanceHubScreen()
    }

    composable(route = FinanceDestinations.Wallet) {
        WalletScreen(viewModel = hiltViewModel())
    }

    composable(route = FinanceDestinations.GiftCards) {
        GiftCardsScreen(viewModel = hiltViewModel())
    }

    composable(route = FinanceDestinations.Coupons) {
        CouponsScreen(viewModel = hiltViewModel())
    }

    composable(route = FinanceDestinations.Payments) {
        PaymentsScreen(
            viewModel      = hiltViewModel(),
            onNavigateBack = { navController.popBackStack() },
        )
    }

    composable(route = FinanceDestinations.Invoices) {
        InvoicesScreen(viewModel = hiltViewModel())
    }

    composable(route = FinanceDestinations.Estimates) {
        EstimatesScreen(viewModel = hiltViewModel())
    }

    composable(route = FinanceDestinations.Expenses) {
        ExpensesScreen(viewModel = hiltViewModel())
    }
}
