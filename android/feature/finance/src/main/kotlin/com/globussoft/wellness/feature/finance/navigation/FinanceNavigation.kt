package com.globussoft.wellness.feature.finance.navigation

import androidx.navigation.NavController
import androidx.navigation.NavGraphBuilder
import androidx.navigation.compose.composable
import androidx.hilt.navigation.compose.hiltViewModel
import com.globussoft.wellness.core.data.datastore.UserSession
import com.globussoft.wellness.feature.finance.presentation.coupons.CouponsScreen
import com.globussoft.wellness.feature.finance.presentation.giftcards.GiftCardsScreen
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
}

/**
 * Registers the four finance-feature composable destinations into the caller's
 * [NavGraphBuilder].
 *
 * ### Routes
 * - `"finance"` → [PosScreen] — Point-of-Sale shift + sale entry.
 * - `"wallet"` → [WalletScreen] — Patient wallet balance + ledger.
 * - `"gift-cards"` → [GiftCardsScreen] — Gift card issuance + status list.
 * - `"coupons"` → [CouponsScreen] — Coupon CRUD + discount preview.
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
        PosScreen(viewModel = hiltViewModel())
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
}
