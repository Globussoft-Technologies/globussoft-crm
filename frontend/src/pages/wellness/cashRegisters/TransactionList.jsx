import {
  Receipt,
  Plus,
  ArrowUpFromLine,
  IndianRupee,
  UserCircle2,
  UserX,
} from 'lucide-react';
import { formatMoney } from '../../../utils/money';
import { formatDateTime } from '../../../utils/date';
import { DateRangeFilter } from '../../../components/wellness/DateRangeFilter';
import { inputStyle, primaryButtonStyle, emptyStateStyle } from './sharedStyles';

const TX_TABS = [
  { key: 'bookings', label: 'Bookings Cash' },
  { key: 'partial', label: 'Partial Cash' },
  { key: 'expenses', label: 'Expenses Cash' },
];

export default function TransactionList({
  txTab,
  txDateFilter,
  transactions,
  visibleTransactions,
  shiftLoading,
  selectedShift,
  isAdminOrManager,
  expenseForm,
  savingExpense,
  onTabChange,
  onDateFilterChange,
  onAddExpense,
  onExpenseFormChange,
}) {
  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '0.75rem',
          flexWrap: 'wrap',
          marginBottom: '0.5rem',
        }}
      >
        <h3
          style={{
            fontSize: '1rem',
            fontWeight: 600,
            display: 'flex',
            alignItems: 'center',
            gap: '0.4rem',
            margin: 0,
          }}
        >
          <Receipt size={16} /> Recent transactions
        </h3>
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.4rem',
            flexWrap: 'wrap',
          }}
        >
          <DateRangeFilter
            value={txDateFilter}
            onChange={onDateFilterChange}
            label={null}
          />
        </div>
      </div>
      <div
        role="tablist"
        style={{
          display: 'flex',
          gap: '0.3rem',
          borderBottom: '1px solid rgba(255,255,255,0.08)',
          marginBottom: '0.75rem',
        }}
      >
        {TX_TABS.map((t) => {
          const active = txTab === t.key;
          const count = transactions[t.key]?.length ?? 0;
          return (
            <button
              key={t.key}
              role="tab"
              aria-selected={active}
              onClick={() => onTabChange(t.key)}
              style={{
                background: 'transparent',
                border: 'none',
                padding: '0.5rem 0.85rem',
                cursor: 'pointer',
                color: active
                  ? 'var(--primary-color, var(--accent-color))'
                  : 'var(--text-secondary)',
                borderBottom: active
                  ? '2px solid var(--primary-color, var(--accent-color))'
                  : '2px solid transparent',
                fontSize: '0.85rem',
                fontWeight: active ? 600 : 500,
              }}
            >
              {t.label}{' '}
              <span
                style={{
                  opacity: 0.7,
                  marginLeft: '0.25rem',
                }}
              >
                ({count})
              </span>
            </button>
          );
        })}
      </div>

      {/* Add-expense form — Expenses tab, open shift, admin/manager. */}
      {txTab === 'expenses' &&
        isAdminOrManager &&
        selectedShift &&
        selectedShift.status === 'OPEN' && (
          <form
            onSubmit={onAddExpense}
            style={{
              display: 'flex',
              gap: '0.5rem',
              flexWrap: 'wrap',
              marginBottom: '0.75rem',
              alignItems: 'center',
            }}
          >
            <input
              type="number"
              min="0"
              step="0.01"
              placeholder="Amount"
              value={expenseForm.amount}
              onChange={(e) =>
                onExpenseFormChange((f) => ({ ...f, amount: e.target.value }))
              }
              style={{ ...inputStyle, flex: '1 1 110px' }}
              aria-label="Expense amount"
            />
            <input
              placeholder="Reason — e.g. Pro plan"
              value={expenseForm.reason}
              onChange={(e) =>
                onExpenseFormChange((f) => ({ ...f, reason: e.target.value }))
              }
              style={{ ...inputStyle, flex: '2 1 200px' }}
              aria-label="Expense reason"
            />
            <select
              value={expenseForm.category}
              onChange={(e) =>
                onExpenseFormChange((f) => ({ ...f, category: e.target.value }))
              }
              style={{ ...inputStyle, flex: '1 1 140px' }}
              aria-label="Expense type"
            >
              <option value="GENERAL">General</option>
              <option value="SUBSCRIPTION">Subscription</option>
            </select>
            <button
              type="submit"
              disabled={savingExpense}
              style={primaryButtonStyle}
            >
              <Plus size={14} /> {savingExpense ? 'Adding…' : 'Add expense'}
            </button>
          </form>
        )}

      {shiftLoading && <div>Loading transactions…</div>}

      {!shiftLoading && !selectedShift && (
        <div style={emptyStateStyle}>
          Open a shift to start recording transactions.
        </div>
      )}

      {!shiftLoading &&
        selectedShift &&
        visibleTransactions.length === 0 && (
          <div style={emptyStateStyle}>
            {txTab === 'expenses' ? (
              'No expenses recorded on this shift yet. Add one below, or a subscription purchase will appear here automatically.'
            ) : (
              <>
                No {txTab === 'bookings' ? 'cash bookings' : 'partial-cash sales'}{' '}
                {txDateFilter && txDateFilter.preset !== 'all'
                  ? 'in the selected date range.'
                  : 'yet on this shift.'}
              </>
            )}
          </div>
        )}

      {!shiftLoading && visibleTransactions.length > 0 && (
        <ul
          style={{
            listStyle: 'none',
            padding: 0,
            margin: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: '0.4rem',
          }}
        >
          {txTab === 'expenses'
            ? visibleTransactions.map((exp) => (
                <li
                  key={exp.id}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '0.6rem 0.75rem',
                    background: 'rgba(255,255,255,0.03)',
                    borderRadius: 8,
                    fontSize: '0.85rem',
                  }}
                  data-testid={`expense-row-${exp.id}`}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.5rem',
                    }}
                  >
                    <ArrowUpFromLine size={14} color="var(--accent-color)" />
                    <div>
                      <div
                        style={{
                          fontWeight: 500,
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.4rem',
                        }}
                      >
                        {exp.reason || 'Expense'}
                        {exp.category && exp.category !== 'GENERAL' && (
                          <span
                            style={{
                              fontSize: '0.65rem',
                              fontWeight: 600,
                              textTransform: 'capitalize',
                              padding: '0.1rem 0.45rem',
                              borderRadius: 999,
                              background: 'rgba(124,196,180,0.18)',
                              color: 'var(--primary-color, var(--accent-color))',
                            }}
                          >
                            {exp.category.toLowerCase()}
                          </span>
                        )}
                      </div>
                      {exp.createdAt && (
                        <div
                          style={{
                            fontSize: '0.7rem',
                            color: 'var(--text-secondary)',
                          }}
                        >
                          {formatDateTime(exp.createdAt)}
                        </div>
                      )}
                    </div>
                  </div>
                  <div style={{ fontWeight: 600, color: 'var(--accent-color)' }}>
                    −{formatMoney(exp.amount)}
                  </div>
                </li>
              ))
            : visibleTransactions.map((sale) => (
                <li
                  key={sale.id}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '0.6rem 0.75rem',
                    background: 'rgba(255,255,255,0.03)',
                    borderRadius: 8,
                    fontSize: '0.85rem',
                  }}
                  data-testid={`tx-row-${sale.id}`}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.5rem',
                    }}
                  >
                    <IndianRupee
                      size={14}
                      color="var(--success-color)"
                    />
                    <div>
                      <div style={{ fontWeight: 500 }}>
                        {sale.invoiceNumber || `Sale #${sale.id}`}
                      </div>
                      <div
                        style={{
                          fontSize: '0.7rem',
                          color: 'var(--text-secondary)',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.25rem',
                        }}
                      >
                        {sale.patientId ? (
                          <>
                            <UserCircle2 size={10} />
                            Patient #{sale.patientId}
                          </>
                        ) : (
                          <>
                            <UserX size={10} />
                            Walk-in
                          </>
                        )}
                        {sale.createdAt && (
                          <span>· {formatDateTime(sale.createdAt)}</span>
                        )}
                        <span>· {sale.paymentMethod}</span>
                      </div>
                    </div>
                  </div>
                  <div style={{ fontWeight: 600 }}>
                    {formatMoney(sale.total)}
                  </div>
                </li>
              ))}
        </ul>
      )}
    </div>
  );
}
