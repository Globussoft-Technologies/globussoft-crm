package com.globussoft.wellness.feature.finance.presentation

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.PrimaryTabRow
import androidx.compose.material3.Tab
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.hilt.navigation.compose.hiltViewModel
import com.globussoft.wellness.feature.finance.presentation.coupons.CouponsScreen
import com.globussoft.wellness.feature.finance.presentation.giftcards.GiftCardsScreen
import com.globussoft.wellness.feature.finance.presentation.pos.PosScreen
import com.globussoft.wellness.feature.finance.presentation.wallet.WalletScreen

private val FINANCE_TABS = listOf("POS", "Gift Cards", "Coupons", "Wallet")

/**
 * Finance hub screen.
 *
 * Hosts four sub-screens — POS, Gift Cards, Coupons, and Wallet — behind a
 * [PrimaryTabRow]. Each tab renders the corresponding screen composable in-place
 * with its own [hiltViewModel], so state is preserved per-tab for the lifetime
 * of this composition.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FinanceHubScreen() {
    var selectedTab by remember { mutableIntStateOf(0) }

    Column(modifier = Modifier.fillMaxSize()) {
        PrimaryTabRow(selectedTabIndex = selectedTab) {
            FINANCE_TABS.forEachIndexed { idx, title ->
                Tab(
                    selected = selectedTab == idx,
                    onClick  = { selectedTab = idx },
                    text = {
                        Text(
                            text       = title,
                            style      = MaterialTheme.typography.labelLarge,
                            fontWeight = if (selectedTab == idx) FontWeight.SemiBold else FontWeight.Normal,
                        )
                    },
                )
            }
        }
        when (selectedTab) {
            0 -> PosScreen(viewModel = hiltViewModel())
            1 -> GiftCardsScreen(viewModel = hiltViewModel())
            2 -> CouponsScreen(viewModel = hiltViewModel())
            3 -> WalletScreen(viewModel = hiltViewModel())
        }
    }
}
