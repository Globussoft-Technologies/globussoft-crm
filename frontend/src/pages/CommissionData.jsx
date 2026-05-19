import React, { useState, useEffect } from 'react';
import { DollarSign, Download, Filter, Search } from 'lucide-react';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';

export default function CommissionData() {
  const notify = useNotify();
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filterEmployee, setFilterEmployee] = useState('');
  const [sortBy, setSortBy] = useState('date'); // date, employee, revenue

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
    if (sortBy === 'employee') {
      return a.employeeName.localeCompare(b.employeeName);
    }
    if (sortBy === 'revenue') {
      return (parseFloat(b.totalSales) || 0) - (parseFloat(a.totalSales) || 0);
    }
    // date (default)
    return new Date(b.periodStart) - new Date(a.periodStart);
  });

  const calculateTotals = () => {
    return sortedRecords.reduce(
      (acc, r) => ({
        serviceRevenue: acc.serviceRevenue + (parseFloat(r.serviceRevenue) || 0),
        productRevenue: acc.productRevenue + (parseFloat(r.productRevenue) || 0),
        packageRevenue: acc.packageRevenue + (parseFloat(r.packageRevenue) || 0),
        totalSales: acc.totalSales + (parseFloat(r.totalSales) || 0),
        count: acc.count + 1,
      }),
      { serviceRevenue: 0, productRevenue: 0, packageRevenue: 0, totalSales: 0, count: 0 }
    );
  };

  const totals = calculateTotals();

  const formatDate = (date) => {
    return new Date(date).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  const exportCSV = () => {
    const headers = [
      'Period Start',
      'Period End',
      'Employee',
      'Service Revenue',
      'Product Revenue',
      'Package Revenue',
      'Total Sales',
      'Discount',
      'Net Sales',
      'Tax',
    ];
    const rows = sortedRecords.map((r) => [
      formatDate(r.periodStart),
      formatDate(r.periodEnd),
      r.employeeName,
      r.serviceRevenue,
      r.productRevenue,
      r.packageRevenue,
      r.totalSales,
      r.discount,
      r.netSales,
      r.tax,
    ]);

    const csv = [headers, ...rows].map((row) => row.map((cell) => `"${cell}"`).join(',')).join('\n');
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
      <div style={{ padding: '2rem', textAlign: 'center', color: '#999' }}>
        <p>Loading commission data...</p>
      </div>
    );
  }

  return (
    <div style={{ padding: '2rem' }}>
      <div style={{ marginBottom: '2rem' }}>
        <h1 style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.5rem' }}>
          <DollarSign size={32} />
          Commission Data
        </h1>
        <p style={{ color: '#999', margin: 0 }}>Historical payroll and commission records</p>
      </div>

      {records.length === 0 ? (
        <div
          style={{
            padding: '2rem',
            border: '1px solid #333',
            borderRadius: '0.5rem',
            textAlign: 'center',
            color: '#999',
          }}
        >
          <p>No commission data found.</p>
        </div>
      ) : (
        <>
          <div style={{ marginBottom: '1.5rem', display: 'flex', gap: '1rem', alignItems: 'flex-end' }}>
            <div style={{ flex: 1 }}>
              <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.875rem', color: '#ccc' }}>
                Filter by Employee
              </label>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <Search size={18} style={{ color: '#999' }} />
                <input
                  type="text"
                  placeholder="Search employee..."
                  value={filterEmployee}
                  onChange={(e) => setFilterEmployee(e.target.value)}
                  style={{
                    flex: 1,
                    padding: '0.5rem',
                    background: '#1a1a1a',
                    border: '1px solid #333',
                    borderRadius: '0.25rem',
                    color: '#fff',
                    fontFamily: 'inherit',
                  }}
                />
              </div>
            </div>

            <div>
              <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.875rem', color: '#ccc' }}>
                Sort By
              </label>
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value)}
                style={{
                  padding: '0.5rem',
                  background: '#1a1a1a',
                  border: '1px solid #333',
                  borderRadius: '0.25rem',
                  color: '#fff',
                  fontFamily: 'inherit',
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
                padding: '0.5rem 1rem',
                background: '#8b5cf6',
                border: 'none',
                borderRadius: '0.25rem',
                color: '#fff',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                fontFamily: 'inherit',
              }}
            >
              <Download size={16} />
              Export CSV
            </button>
          </div>

          <div style={{ overflowX: 'auto', marginBottom: '2rem' }}>
            <table
              style={{
                width: '100%',
                borderCollapse: 'collapse',
                fontSize: '0.875rem',
              }}
            >
              <thead>
                <tr style={{ borderBottom: '1px solid #333', backgroundColor: '#0a0a0a' }}>
                  <th style={{ padding: '0.75rem', textAlign: 'left', color: '#999', fontWeight: '500' }}>
                    Period
                  </th>
                  <th style={{ padding: '0.75rem', textAlign: 'left', color: '#999', fontWeight: '500' }}>
                    Employee
                  </th>
                  <th style={{ padding: '0.75rem', textAlign: 'right', color: '#999', fontWeight: '500' }}>
                    Service
                  </th>
                  <th style={{ padding: '0.75rem', textAlign: 'right', color: '#999', fontWeight: '500' }}>
                    Product
                  </th>
                  <th style={{ padding: '0.75rem', textAlign: 'right', color: '#999', fontWeight: '500' }}>
                    Package
                  </th>
                  <th style={{ padding: '0.75rem', textAlign: 'right', color: '#999', fontWeight: '500' }}>
                    Discount
                  </th>
                  <th style={{ padding: '0.75rem', textAlign: 'right', color: '#999', fontWeight: '500' }}>
                    Net Sales
                  </th>
                  <th style={{ padding: '0.75rem', textAlign: 'right', color: '#999', fontWeight: '500' }}>
                    Tax
                  </th>
                  <th style={{ padding: '0.75rem', textAlign: 'right', color: '#999', fontWeight: '500' }}>
                    Total
                  </th>
                </tr>
              </thead>
              <tbody>
                {sortedRecords.map((record, idx) => (
                  <tr
                    key={record.id}
                    style={{
                      borderBottom: '1px solid #222',
                      backgroundColor: idx % 2 === 0 ? 'transparent' : '#0a0a0a',
                    }}
                  >
                    <td style={{ padding: '0.75rem', color: '#ccc' }}>
                      {formatDate(record.periodStart)} - {formatDate(record.periodEnd)}
                    </td>
                    <td style={{ padding: '0.75rem', color: '#fff', fontWeight: '500' }}>{record.employeeName}</td>
                    <td style={{ padding: '0.75rem', textAlign: 'right', color: '#ccc' }}>
                      ₹{parseFloat(record.serviceRevenue || 0).toFixed(2)}
                    </td>
                    <td style={{ padding: '0.75rem', textAlign: 'right', color: '#ccc' }}>
                      ₹{parseFloat(record.productRevenue || 0).toFixed(2)}
                    </td>
                    <td style={{ padding: '0.75rem', textAlign: 'right', color: '#ccc' }}>
                      ₹{parseFloat(record.packageRevenue || 0).toFixed(2)}
                    </td>
                    <td style={{ padding: '0.75rem', textAlign: 'right', color: '#ff6b6b' }}>
                      -₹{parseFloat(record.discount || 0).toFixed(2)}
                    </td>
                    <td style={{ padding: '0.75rem', textAlign: 'right', color: '#51cf66' }}>
                      ₹{parseFloat(record.netSales || 0).toFixed(2)}
                    </td>
                    <td style={{ padding: '0.75rem', textAlign: 'right', color: '#ccc' }}>
                      ₹{parseFloat(record.tax || 0).toFixed(2)}
                    </td>
                    <td style={{ padding: '0.75rem', textAlign: 'right', color: '#ffd700', fontWeight: '500' }}>
                      ₹{parseFloat(record.totalSales || 0).toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div
            style={{
              padding: '1.5rem',
              background: '#0a0a0a',
              border: '1px solid #333',
              borderRadius: '0.5rem',
            }}
          >
            <h3 style={{ marginTop: 0, marginBottom: '1rem' }}>Summary</h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem' }}>
              <div>
                <div style={{ color: '#999', fontSize: '0.875rem', marginBottom: '0.25rem' }}>Total Records</div>
                <div style={{ fontSize: '1.5rem', fontWeight: 'bold', color: '#fff' }}>{totals.count}</div>
              </div>
              <div>
                <div style={{ color: '#999', fontSize: '0.875rem', marginBottom: '0.25rem' }}>Service Revenue</div>
                <div style={{ fontSize: '1.5rem', fontWeight: 'bold', color: '#51cf66' }}>
                  ₹{totals.serviceRevenue.toFixed(2)}
                </div>
              </div>
              <div>
                <div style={{ color: '#999', fontSize: '0.875rem', marginBottom: '0.25rem' }}>Product Revenue</div>
                <div style={{ fontSize: '1.5rem', fontWeight: 'bold', color: '#51cf66' }}>
                  ₹{totals.productRevenue.toFixed(2)}
                </div>
              </div>
              <div>
                <div style={{ color: '#999', fontSize: '0.875rem', marginBottom: '0.25rem' }}>Package Revenue</div>
                <div style={{ fontSize: '1.5rem', fontWeight: 'bold', color: '#51cf66' }}>
                  ₹{totals.packageRevenue.toFixed(2)}
                </div>
              </div>
              <div>
                <div style={{ color: '#999', fontSize: '0.875rem', marginBottom: '0.25rem' }}>Total Sales</div>
                <div style={{ fontSize: '1.5rem', fontWeight: 'bold', color: '#ffd700' }}>
                  ₹{totals.totalSales.toFixed(2)}
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
