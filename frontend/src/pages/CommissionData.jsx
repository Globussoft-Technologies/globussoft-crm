import React, { useState, useEffect } from 'react';
import { IndianRupee, Download, Search } from 'lucide-react';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';

export default function CommissionData() {
  const notify = useNotify();
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filterEmployee, setFilterEmployee] = useState('');
  const [sortBy, setSortBy] = useState('date');

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      const data = await fetchApi('/api/staff/commission-data');
      setRecords(Array.isArray(data) ? data : []);
    } catch (err) {
      notify.error(err.message || 'Failed to load commission data.');
    } finally {
      setLoading(false);
    }
  };

  const filteredRecords = records.filter((r) =>
    !filterEmployee || r.employeeName.toLowerCase().includes(filterEmployee.toLowerCase())
  );

  const sortedRecords = [...filteredRecords].sort((a, b) => {
    if (sortBy === 'employee') return a.employeeName.localeCompare(b.employeeName);
    if (sortBy === 'revenue') return (parseFloat(b.totalSales) || 0) - (parseFloat(a.totalSales) || 0);
    return new Date(b.periodStart) - new Date(a.periodStart);
  });

  const totals = sortedRecords.reduce(
    (acc, r) => ({
      serviceRevenue: acc.serviceRevenue + (parseFloat(r.serviceRevenue) || 0),
      productRevenue: acc.productRevenue + (parseFloat(r.productRevenue) || 0),
      packageRevenue: acc.packageRevenue + (parseFloat(r.packageRevenue) || 0),
      totalSales: acc.totalSales + (parseFloat(r.totalSales) || 0),
      count: acc.count + 1,
    }),
    { serviceRevenue: 0, productRevenue: 0, packageRevenue: 0, totalSales: 0, count: 0 }
  );

  const formatDate = (date) =>
    new Date(date).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });

  const fmt = (val) => `₹${parseFloat(val || 0).toFixed(2)}`;

  const exportCSV = () => {
    const headers = ['Period Start', 'Period End', 'Employee', 'Service Revenue', 'Product Revenue', 'Package Revenue', 'Total Sales', 'Discount', 'Net Sales', 'Tax'];
    const rows = sortedRecords.map((r) => [
      formatDate(r.periodStart), formatDate(r.periodEnd), r.employeeName,
      r.serviceRevenue, r.productRevenue, r.packageRevenue,
      r.totalSales, r.discount, r.netSales, r.tax,
    ]);
    const csv = [headers, ...rows].map((row) => row.map((c) => `"${c}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `commission-data-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(url);
    document.body.removeChild(a);
    notify.success('CSV exported successfully!');
  };

  if (loading) {
    return (
      <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
        <p>Loading commission data...</p>
      </div>
    );
  }

  return (
    <div style={{ padding: '2rem' }}>
      {/* Header */}
      <div style={{ marginBottom: '2rem' }}>
        <h1 style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.75rem',
          marginBottom: '0.5rem',
          color: 'var(--text-primary)',
          fontSize: '1.75rem',
          fontWeight: 700,
        }}>
          <IndianRupee size={32} />
          Commission Data
        </h1>
        <p style={{ color: 'var(--text-secondary)', margin: 0, fontSize: '0.9rem' }}>
          Historical payroll and commission records
        </p>
      </div>

      {records.length === 0 ? (
        <div style={{
          padding: '3rem',
          border: '1px solid var(--border-color)',
          borderRadius: '0.75rem',
          textAlign: 'center',
          color: 'var(--text-secondary)',
          background: 'var(--surface-color)',
        }}>
          <p style={{ margin: 0 }}>No commission data found.</p>
        </div>
      ) : (
        <>
          {/* Toolbar */}
          <div style={{ marginBottom: '1.5rem', display: 'flex', gap: '1rem', alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 200 }}>
              <label style={{
                display: 'block',
                marginBottom: '0.4rem',
                fontSize: '0.8rem',
                fontWeight: 500,
                color: 'var(--text-secondary)',
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
              }}>
                Filter by Employee
              </label>
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                background: 'var(--input-bg)',
                border: '1px solid var(--border-color)',
                borderRadius: '0.5rem',
                padding: '0 0.75rem',
              }}>
                <Search size={16} style={{ color: 'var(--text-secondary)', flexShrink: 0 }} />
                <input
                  type="text"
                  placeholder="Search employee..."
                  value={filterEmployee}
                  onChange={(e) => setFilterEmployee(e.target.value)}
                  style={{
                    flex: 1,
                    padding: '0.5rem 0',
                    background: 'transparent',
                    border: 'none',
                    outline: 'none',
                    color: 'var(--text-primary)',
                    fontFamily: 'inherit',
                    fontSize: '0.875rem',
                  }}
                />
              </div>
            </div>

            <div>
              <label style={{
                display: 'block',
                marginBottom: '0.4rem',
                fontSize: '0.8rem',
                fontWeight: 500,
                color: 'var(--text-secondary)',
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
              }}>
                Sort By
              </label>
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value)}
                style={{
                  padding: '0.5rem 0.75rem',
                  background: 'var(--input-bg)',
                  border: '1px solid var(--border-color)',
                  borderRadius: '0.5rem',
                  color: 'var(--text-primary)',
                  fontFamily: 'inherit',
                  fontSize: '0.875rem',
                  cursor: 'pointer',
                }}
              >
                <option value="date">Date (Newest)</option>
                <option value="employee">Employee Name</option>
                <option value="revenue">Total Revenue</option>
              </select>
            </div>

            <button
              onClick={exportCSV}
              style={{
                padding: '0.55rem 1.1rem',
                background: 'var(--primary-color, var(--accent-color))',
                border: 'none',
                borderRadius: '0.5rem',
                color: '#fff',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                fontFamily: 'inherit',
                fontSize: '0.875rem',
                fontWeight: 500,
              }}
            >
              <Download size={15} />
              Export CSV
            </button>
          </div>

          {/* Table */}
          <div style={{ overflowX: 'auto', marginBottom: '2rem', borderRadius: '0.75rem', border: '1px solid var(--border-color)' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem' }}>
              <thead>
                <tr style={{ background: 'var(--table-header-bg)' }}>
                  {['Period', 'Employee', 'Service', 'Product', 'Package', 'Discount', 'Net Sales', 'Tax', 'Total'].map((h, i) => (
                    <th
                      key={h}
                      style={{
                        padding: '0.75rem 1rem',
                        textAlign: i < 2 ? 'left' : 'right',
                        color: 'var(--text-secondary)',
                        fontWeight: 500,
                        fontSize: '0.8rem',
                        textTransform: 'uppercase',
                        letterSpacing: '0.04em',
                        borderBottom: '1px solid var(--border-color)',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sortedRecords.map((record, idx) => (
                  <tr
                    key={record.id}
                    style={{
                      borderBottom: idx < sortedRecords.length - 1 ? '1px solid var(--border-color)' : 'none',
                      background: idx % 2 === 0 ? 'transparent' : 'var(--subtle-bg-2)',
                      transition: 'background 0.15s',
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--hover-bg)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = idx % 2 === 0 ? 'transparent' : 'var(--subtle-bg-2)'; }}
                  >
                    <td style={{ padding: '0.75rem 1rem', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                      {formatDate(record.periodStart)} – {formatDate(record.periodEnd)}
                    </td>
                    <td style={{ padding: '0.75rem 1rem', color: 'var(--text-primary)', fontWeight: 600 }}>
                      {record.employeeName}
                    </td>
                    <td style={{ padding: '0.75rem 1rem', textAlign: 'right', color: 'var(--text-primary)' }}>
                      {fmt(record.serviceRevenue)}
                    </td>
                    <td style={{ padding: '0.75rem 1rem', textAlign: 'right', color: 'var(--text-primary)' }}>
                      {fmt(record.productRevenue)}
                    </td>
                    <td style={{ padding: '0.75rem 1rem', textAlign: 'right', color: 'var(--text-primary)' }}>
                      {fmt(record.packageRevenue)}
                    </td>
                    <td style={{ padding: '0.75rem 1rem', textAlign: 'right', color: 'var(--danger-color)', fontWeight: 500 }}>
                      -{fmt(record.discount)}
                    </td>
                    <td style={{ padding: '0.75rem 1rem', textAlign: 'right', color: 'var(--success-color)', fontWeight: 500 }}>
                      {fmt(record.netSales)}
                    </td>
                    <td style={{ padding: '0.75rem 1rem', textAlign: 'right', color: 'var(--text-secondary)' }}>
                      {fmt(record.tax)}
                    </td>
                    <td style={{ padding: '0.75rem 1rem', textAlign: 'right', color: 'var(--warning-color)', fontWeight: 700 }}>
                      {fmt(record.totalSales)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Summary cards */}
          <div style={{
            padding: '1.5rem',
            background: 'var(--surface-color)',
            border: '1px solid var(--border-color)',
            borderRadius: '0.75rem',
          }}>
            <h3 style={{ marginTop: 0, marginBottom: '1.25rem', color: 'var(--text-primary)', fontWeight: 600 }}>
              Summary
            </h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 180px), 1fr))', gap: '1.25rem' }}>
              {[
                { label: 'Total Records', value: totals.count, color: 'var(--text-primary)', plain: true },
                { label: 'Service Revenue', value: `₹${totals.serviceRevenue.toFixed(2)}`, color: 'var(--success-color)' },
                { label: 'Product Revenue', value: `₹${totals.productRevenue.toFixed(2)}`, color: 'var(--success-color)' },
                { label: 'Package Revenue', value: `₹${totals.packageRevenue.toFixed(2)}`, color: 'var(--success-color)' },
                { label: 'Total Sales', value: `₹${totals.totalSales.toFixed(2)}`, color: 'var(--warning-color)' },
              ].map(({ label, value, color }) => (
                <div key={label}>
                  <div style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', marginBottom: '0.35rem', fontWeight: 500 }}>
                    {label}
                  </div>
                  <div style={{ fontSize: '1.35rem', fontWeight: 700, color }}>
                    {value}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
