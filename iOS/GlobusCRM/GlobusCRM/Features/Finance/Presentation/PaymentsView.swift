import SwiftUI
import Combine

// MARK: - ViewModel

@MainActor
final class PaymentsViewModel: ObservableObject {
    @Published var payments: [Payment] = []
    @Published var isLoading = false
    @Published var hasLoaded = false
    @Published var error: String?
    @Published var isRefunding = false
    @Published var refundError: String?
    @Published var refundSuccessId: String?

    private let getPaymentsUseCase: GetPaymentsUseCase
    private let refundPaymentUseCase: RefundPaymentUseCase

    init(getPaymentsUseCase: GetPaymentsUseCase, refundPaymentUseCase: RefundPaymentUseCase) {
        self.getPaymentsUseCase = getPaymentsUseCase
        self.refundPaymentUseCase = refundPaymentUseCase
    }

    func load() async {
        guard !isLoading else { return }
        isLoading = true
        error = nil
        let result = await getPaymentsUseCase()
        isLoading = false
        hasLoaded = true
        switch result {
        case .success(let items):
            payments = items
            error = nil
        case .failure(let e):
            if !Task.isCancelled {
                error = e.errorDescription
            }
        }
    }

    func refund(payment: Payment) async {
        isRefunding = true
        refundError = nil
        let result = await refundPaymentUseCase(id: payment.id)
        isRefunding = false
        switch result {
        case .success:
            refundSuccessId = payment.id
            await load()
        case .failure(let e):
            refundError = e.errorDescription
        }
    }

    // MARK: - KPI stats

    var totalCollected: Double { payments.filter { $0.status == .paid }.reduce(0) { $0 + $1.amount } }
    var totalPending:   Double { payments.filter { $0.status == .pending }.reduce(0) { $0 + $1.amount } }
    var totalFailed:    Double { payments.filter { $0.status == .failed }.reduce(0) { $0 + $1.amount } }
    var currency: String { payments.first?.currency ?? "INR" }
}

// MARK: - View

struct PaymentsView: View {
    @ObservedObject var viewModel: PaymentsViewModel
    @State private var selectedPayment: Payment?
    @State private var paymentToRefund: Payment?
    @State private var showRefundConfirm = false

    var body: some View {
        Group {
            if !viewModel.hasLoaded {
                SkeletonListView()
            } else if let error = viewModel.error {
                ErrorStateView(message: error) { Task { await viewModel.load() } }
            } else if viewModel.payments.isEmpty {
                EmptyStateView(
                    icon: Symbols.creditCard,
                    title: "No Payments",
                    subtitle: "Your payment history will appear here after your first transaction."
                )
            } else {
                ScrollView {
                    VStack(spacing: 0) {
                        kpiSummaryRow
                            .padding(.horizontal, Layout.pagePadding)
                            .padding(.vertical, WellnessSpacing.md)

                        if let refundError = viewModel.refundError {
                            Text(refundError)
                                .font(.wellnessCaption)
                                .foregroundColor(.wellnessError)
                                .padding(.horizontal, Layout.pagePadding)
                                .padding(.bottom, WellnessSpacing.sm)
                        }

                        LazyVStack(spacing: WellnessSpacing.sm) {
                            ForEach(viewModel.payments) { payment in
                                Button { selectedPayment = payment } label: {
                                    PaymentRowView(payment: payment)
                                }
                                .buttonStyle(.plain)
                                .padding(.horizontal, Layout.pagePadding)
                                .contextMenu {
                                    if payment.refundable {
                                        Button(role: .destructive) {
                                            paymentToRefund = payment
                                            showRefundConfirm = true
                                        } label: {
                                            Label("Request Refund", systemImage: "arrow.uturn.backward.circle")
                                        }
                                    }
                                }
                            }
                        }
                        .padding(.bottom, WellnessSpacing.xl)
                    }
                }
                .scrollContentBackground(.hidden)
            }
        }
        .background(Color.wellnessBackground)
        .task { await viewModel.load() }
        .refreshable { await viewModel.load() }
        .sheet(item: $selectedPayment) { payment in
            PaymentDetailSheet(payment: payment, onRefund: payment.refundable ? {
                selectedPayment = nil
                paymentToRefund = payment
                showRefundConfirm = true
            } : nil)
        }
        .confirmationDialog(
            "Request Refund",
            isPresented: $showRefundConfirm,
            titleVisibility: .visible
        ) {
            Button("Confirm Refund", role: .destructive) {
                if let p = paymentToRefund {
                    Task { await viewModel.refund(payment: p) }
                }
            }
            Button("Cancel", role: .cancel) { paymentToRefund = nil }
        } message: {
            if let p = paymentToRefund {
                Text("Refund \(CurrencyUtil.formatAmount(p.amount, currency: p.currency)) for \(p.description.isEmpty ? "this payment" : p.description)?")
            }
        }
        .overlay {
            if viewModel.isRefunding {
                Color.black.opacity(0.25).ignoresSafeArea()
                    .overlay(ProgressView().tint(.white))
            }
        }
    }

    private var kpiSummaryRow: some View {
        HStack(spacing: Layout.itemSpacing) {
            PaymentsKpiCell(label: "Collected",
                            value: CurrencyUtil.formatAmount(viewModel.totalCollected, currency: viewModel.currency),
                            color: .wellnessTeal)
            PaymentsKpiCell(label: "Pending",
                            value: CurrencyUtil.formatAmount(viewModel.totalPending, currency: viewModel.currency),
                            color: .wellnessGold)
            PaymentsKpiCell(label: "Failed",
                            value: CurrencyUtil.formatAmount(viewModel.totalFailed, currency: viewModel.currency),
                            color: .wellnessError)
        }
    }
}

private struct PaymentsKpiCell: View {
    let label: String
    let value: String
    let color: Color

    var body: some View {
        VStack(alignment: .leading, spacing: WellnessSpacing.xs) {
            Text(value)
                .font(.wellnessSubheadline)
                .fontWeight(.bold)
                .foregroundColor(color)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
            Text(label)
                .font(.wellnessCaption2)
                .foregroundColor(.wellnessMuted)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(Layout.cardPadding)
        .background(color.opacity(0.07))
        .clipShape(RoundedRectangle(cornerRadius: WellnessRadius.medium))
    }
}

// MARK: - Row

private struct PaymentRowView: View {
    let payment: Payment

    var body: some View {
        WellnessCard {
            HStack(spacing: WellnessSpacing.md) {
                // Status indicator circle
                Circle()
                    .fill(statusColor.opacity(0.15))
                    .frame(width: 40, height: 40)
                    .overlay(
                        Image(systemName: statusIcon)
                            .font(.system(size: IconSize.badge))
                            .foregroundColor(statusColor)
                    )

                VStack(alignment: .leading, spacing: WellnessSpacing.xs) {
                    MarqueeText(
                        text: payment.description.isEmpty ? "Payment" : payment.description,
                        font: .wellnessSubheadline,
                        foregroundColor: .wellnessOnSurface
                    )
                    HStack(spacing: WellnessSpacing.xs) {
                        Text(payment.method)
                            .font(.wellnessCaption)
                            .foregroundColor(.wellnessMuted)
                        if let invoice = payment.invoiceNumber {
                            Text("·")
                                .foregroundColor(.wellnessMuted)
                            Text(invoice)
                                .font(.wellnessCaption)
                                .foregroundColor(.wellnessMuted)
                        }
                    }
                    Text(DateUtil.formatDate(iso: payment.date))
                        .font(.wellnessCaption2)
                        .foregroundColor(.wellnessMuted)
                }

                Spacer()

                VStack(alignment: .trailing, spacing: WellnessSpacing.xs) {
                    Text(CurrencyUtil.formatAmount(payment.amount, currency: payment.currency))
                        .font(.wellnessSubheadline)
                        .fontWeight(.semibold)
                        .foregroundColor(statusColor)

                    StatusPill(label: payment.status.displayLabel, color: statusColor)
                }
            }
            .padding(Layout.cardPadding)
        }
    }

    private var statusColor: Color {
        switch payment.status {
        case .paid:      return .wellnessTeal
        case .pending:   return .wellnessGold
        case .failed:    return .wellnessError
        case .refunded:  return .wellnessBlush
        case .partial:   return .wellnessGold
        case .cancelled: return .wellnessMuted
        }
    }

    private var statusIcon: String {
        switch payment.status {
        case .paid:      return Symbols.checkmarkCircle
        case .pending:   return Symbols.clock
        case .failed:    return Symbols.errorTriangle
        case .refunded:  return Symbols.arrowUp
        case .partial:   return Symbols.infoCircle
        case .cancelled: return Symbols.close
        }
    }
}

// MARK: - Detail Sheet

private struct PaymentDetailSheet: View {
    let payment: Payment
    var onRefund: (() -> Void)? = nil
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: WellnessSpacing.lg) {
                    ZStack {
                        Circle()
                            .fill(statusColor.opacity(0.12))
                            .frame(width: 64, height: 64)
                        Image(systemName: statusIcon)
                            .font(.system(size: IconSize.medium))
                            .foregroundColor(statusColor)
                    }
                    .padding(.top, WellnessSpacing.lg)

                    Text(CurrencyUtil.formatAmount(payment.amount, currency: payment.currency))
                        .font(.system(.largeTitle, design: .default).weight(.bold))
                        .foregroundColor(statusColor)

                    StatusPill(label: payment.status.displayLabel, color: statusColor)

                    VStack(spacing: 0) {
                        DetailRow(label: "Description", value: payment.description.isEmpty ? "Payment" : payment.description)
                        Divider().padding(.leading, Layout.cardPadding)
                        DetailRow(label: "Method", value: payment.method)
                        Divider().padding(.leading, Layout.cardPadding)
                        DetailRow(label: "Date", value: DateUtil.formatDisplay(iso: payment.date))
                        if let invoice = payment.invoiceNumber {
                            Divider().padding(.leading, Layout.cardPadding)
                            DetailRow(label: "Invoice", value: invoice)
                        }
                    }
                    .background(Color.wellnessSurface)
                    .clipShape(RoundedRectangle(cornerRadius: WellnessRadius.large))
                    .padding(.horizontal, Layout.pagePadding)

                    if let onRefund {
                        Button(role: .destructive, action: onRefund) {
                            Label("Request Refund", systemImage: "arrow.uturn.backward.circle")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.bordered)
                        .padding(.horizontal, Layout.pagePadding)
                    }
                }
                .padding(.bottom, WellnessSpacing.xl)
            }
            .background(Color.wellnessBackground.ignoresSafeArea())
            .navigationTitle("Payment Details")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium])
    }

    private var statusColor: Color {
        switch payment.status {
        case .paid:      return .wellnessTeal
        case .pending:   return .wellnessGold
        case .failed:    return .wellnessError
        case .refunded:  return .wellnessBlush
        case .partial:   return .wellnessGold
        case .cancelled: return .wellnessMuted
        }
    }

    private var statusIcon: String {
        switch payment.status {
        case .paid:      return Symbols.checkmarkCircle
        case .pending:   return Symbols.clock
        case .failed:    return Symbols.errorTriangle
        case .refunded:  return Symbols.arrowUp
        case .partial:   return Symbols.infoCircle
        case .cancelled: return Symbols.close
        }
    }
}

// MARK: - Pill badge

private struct StatusPill: View {
    let label: String
    let color: Color

    var body: some View {
        Text(label)
            .font(.wellnessCaption2)
            .fontWeight(.semibold)
            .foregroundColor(color)
            .padding(.horizontal, WellnessSpacing.sm)
            .padding(.vertical, 2)
            .background(color.opacity(0.12))
            .clipShape(Capsule())
    }
}
