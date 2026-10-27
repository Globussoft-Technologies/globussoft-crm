import { useState, useEffect } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, Legend, Label, LineChart, Line } from 'recharts';
import { fetchApi, getAuthToken } from '../utils/api';
import { formatMoney, formatMoneyCompact, currencySymbol, tenantCurrency, tenantLocale } from '../utils/money';
import { convertCurrency } from '../utils/currency';
import { formatDateMedium } from '../utils/date';
import { useNotify } from '../utils/notify';
import { useSearchParams } from "react-router-dom";
import { readDateRange, setDateRangeParams } from '../utils/dateRangeNavigation';

import { PieChart as PieChartIcon, CircleDot, Upload, Filter, Calendar, Table, BarChart3, AreaChart as AreaChartIcon, Clock, Mail } from 'lucide-react';

const COLORS = ['#3b82f6', '#a855f7', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#6366f1', '#14b8a6'];
const STAGE_COLORS = {
  lead: '#3b82f6', 'new-lead': '#3b82f6', contacted: '#0891b2', negotiation: '#7c3aed',
  proposal: '#f59e0b', 'proposal-sent': '#f59e0b', won: '#10b981', 'closed-won': '#10b981',
  lost: '#ef4444', 'closed-lost': '#ef4444',
};
function chartColor(name, index) {
  return STAGE_COLORS[String(name || '').toLowerCase().trim().replace(/\s+/g, '-')] || COLORS[index % COLORS.length];
}
function normalizeReportStage(name) {
  const key = String(name || '').toLowerCase().trim().replace(/[_\s]+/g, '-');
  if (key === 'proposal' || key === 'proposal-sent') return 'PROPOSAL-SENT';
  if (key === 'won' || key === 'closed-won') return 'WON';
  if (key === 'lost' || key === 'closed-lost') return 'LOST';
  return name;
}
function reportStageKey(name) {
  return String(normalizeReportStage(name) || '').toLowerCase().trim().replace(/[_\s]+/g, '-');
}
const REPORT_STAGE_ORDER = ['NEW-LEAD', 'LEAD', 'CONTACTED', 'NEGOTIATION', 'PROPOSAL-SENT', 'WON', 'LOST'];
const INVOICE_STATUS_VALUES = new Set(['UNPAID', 'PAID', 'OVERDUE', 'VOIDED']);

function openDatePicker(event) {
  try {
    event.currentTarget.showPicker?.();
  } catch {
    // Unsupported browsers still retain the native calendar button.
  }
}

function preventManualDateEntry(event) {
  if (event.key === 'Tab' || event.key === 'Escape') return;
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    openDatePicker(event);
    return;
  }
  event.preventDefault();
}

// #127 followup: respect tenant currency rather than hard-coding "$".
const METRIC_OPTIONS = [
  { value: 'revenue', label: `Revenue (${currencySymbol()})`, group: 'Deals' },
  { value: 'count', label: 'Deal Count', group: 'Deals' },
  { value: 'win_rate', label: 'Win/Loss Rate', group: 'Deals' },
  { value: 'invoices', label: 'Invoice Status', group: 'Financial' },
];

const PIE_VISUALIZATION_OPTIONS = [
  { value: 'pie', label: 'Pie Chart', Icon: PieChartIcon },
  { value: 'donut', label: 'Donut Chart', Icon: CircleDot },
];

const VISUALIZATION_OPTIONS_BY_METRIC = {
  revenue: [
    { value: 'bar', label: 'Bar Chart', Icon: BarChart3 },
    { value: 'line', label: 'Line Chart', Icon: AreaChartIcon },
    { value: 'horizontal_bar', label: 'Horizontal Bar', Icon: BarChart3, iconStyle: { transform: 'rotate(90deg)' } },
    ...PIE_VISUALIZATION_OPTIONS,
  ],
  count: [
    { value: 'bar', label: 'Bar Chart', Icon: BarChart3 },
    { value: 'line', label: 'Line Chart', Icon: AreaChartIcon },
    { value: 'horizontal_bar', label: 'Horizontal Bar', Icon: BarChart3, iconStyle: { transform: 'rotate(90deg)' } },
    ...PIE_VISUALIZATION_OPTIONS,
  ],
  win_rate: [
    { value: 'line', label: 'Line Chart', Icon: AreaChartIcon },
    { value: 'bar', label: 'Bar Chart', Icon: BarChart3 },
    ...PIE_VISUALIZATION_OPTIONS,
  ],
  contacts_by_source: [
    { value: 'pie', label: 'Pie Chart', Icon: PieChartIcon },
    { value: 'bar', label: 'Bar Chart', Icon: BarChart3 },
    { value: 'horizontal_bar', label: 'Horizontal Bar', Icon: BarChart3, iconStyle: { transform: 'rotate(90deg)' } },
    { value: 'donut', label: 'Donut Chart', Icon: CircleDot },
  ],
  invoices: [
    { value: 'pie', label: 'Pie Chart', Icon: PieChartIcon },
    { value: 'bar', label: 'Bar Chart', Icon: BarChart3 },
    { value: 'donut', label: 'Donut Chart', Icon: CircleDot },
  ],
};

const DETAIL_TYPES = [
  { value: 'deals', label: 'Deals' },
  { value: 'contacts', label: 'Contacts' },
  { value: 'calls', label: 'Call Logs' },
  { value: 'invoices', label: 'Invoices' },
  { value: 'expenses', label: 'Expenses' },
];

const REPORT_DATE_PRESETS = [
  { value: 'all', label: 'All time' },
  { value: 'last7', label: 'Last 7 days' },
  { value: 'last30', label: 'Last 30 days' },
  { value: 'last90', label: 'Last 90 days' },
  { value: 'thisMonth', label: 'This month' },
  { value: 'thisYear', label: 'This year' },
  { value: 'custom', label: 'Custom range...' },
];

function formatReportDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function reportPresetRange(preset) {
  if (preset === 'all') return { from: '', to: '' };

  const end = new Date();
  end.setHours(23, 59, 59, 999);
  const start = new Date(end);
  start.setHours(0, 0, 0, 0);

  if (preset === 'last7') start.setDate(start.getDate() - 6);
  if (preset === 'last30') start.setDate(start.getDate() - 29);
  if (preset === 'last90') start.setDate(start.getDate() - 89);
  if (preset === 'thisMonth') start.setDate(1);
  if (preset === 'thisYear') start.setMonth(0, 1);

  return { from: formatReportDate(start), to: formatReportDate(end) };
}

function reportDatePresetForRange(from, to) {
  if (!from && !to) return 'all';
  if (!from || !to) return 'custom';
  const matchingPreset = REPORT_DATE_PRESETS.find(({ value }) => {
    if (value === 'custom') return false;
    const range = reportPresetRange(value);
    return range.from === from && range.to === to;
  });
  return matchingPreset?.value || 'custom';
}

export default function Reports() {
  const notify = useNotify();
  const [searchParams, setSearchParams] = useSearchParams();
  const { from: startDate, to: endDate } = readDateRange(searchParams);
  const [datePreset, setDatePreset] = useState(() => reportDatePresetForRange(startDate, endDate));
  const updateDate = (key, value) => setSearchParams(
    setDateRangeParams(searchParams, { from: startDate, to: endDate, [key]: value }),
    { replace: true },
  );
  const updateDatePreset = (preset) => {
    setDatePreset(preset);
    if (preset === 'custom') return;
    setSearchParams(setDateRangeParams(searchParams, reportPresetRange(preset)), { replace: true });
  };
  const [data, setData] = useState([]);
  const [metric, setMetric] = useState('revenue');
  const groupBy = 'stage';
  const [dealType, setDealType] = useState('');
  const [dealTypes, setDealTypes] = useState([]);
  const [currencies, setCurrencies] = useState([]);
  const [displayCurrency, setDisplayCurrency] = useState(() => tenantCurrency());
  const [chartType, setChartType] = useState('bar');
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState('chart'); // chart | table
  const [detailType, setDetailType] = useState('deals');
  const [detailData, setDetailData] = useState([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailPage, setDetailPage] = useState(1);
  const [detailLimit, setDetailLimit] = useState(10);
  const [detailTotal, setDetailTotal] = useState(0);
  const [detailTotalPages, setDetailTotalPages] = useState(1);
  const [showScheduleModal, setShowScheduleModal] = useState(false);
  const [schedules, setSchedules] = useState([]);
  const [schedPage, setSchedPage] = useState(1);
  const [schedLimit, setSchedLimit] = useState(10);
  const [schedTotal, setSchedTotal] = useState(0);
  const [schedTotalPages, setSchedTotalPages] = useState(1);
  const [newSchedule, setNewSchedule] = useState({ name: '', reportType: 'deals', frequency: 'weekly', recipients: '', format: 'PDF' });

  // #117: skip queries entirely if the range is inverted — the backend rejects
  // these now, but bailing on the client also avoids spurious red flashes.
  const rangeInverted = !!(startDate && endDate && new Date(startDate) > new Date(endDate));

  useEffect(() => {
    fetchApi('/api/tenant-settings/generic.dealTypes', { silent: true })
      .then(setting => {
        try {
          const parsed = typeof setting?.value === 'string' ? JSON.parse(setting.value) : setting?.value;
          setDealTypes(Array.isArray(parsed) ? parsed.filter(type => type?.name) : []);
        } catch {
          setDealTypes([]);
        }
      })
      .catch(() => setDealTypes([]));
  }, []);

  useEffect(() => {
    fetchApi('/api/currencies', { silent: true })
      .then(result => {
        const rows = Array.isArray(result) ? result.filter(currency => currency?.code) : [];
        setCurrencies(rows);
        if (rows.length) {
          setDisplayCurrency(current => rows.some(currency => currency.code === current) ? current : rows[0].code);
        }
      })
      .catch(() => setCurrencies([]));
  }, []);

  const dateParams = () => {
    if (rangeInverted) return '';
    // #117: backend reports endpoints accept ?from= / ?to= (and the legacy
    // ?startDate= / ?endDate= aliases). Send both so old + new server builds
    // both filter correctly — sending just startDate/endDate was being
    // ignored on the v3.2.x reports route, which is why the date picker
    // appeared to have no effect.
    let params = '';
    if (startDate) params += `&from=${startDate}&startDate=${startDate}`;
    if (endDate) params += `&to=${endDate}&endDate=${endDate}`;
    return params;
  };

  useEffect(() => {
    setLoading(true);
    const dealTypeParam = needsGroupBy && dealType ? `&dealType=${encodeURIComponent(dealType)}` : '';
    fetchApi(`/api/reports/query?metric=${metric}&groupBy=${groupBy}${dealTypeParam}${dateParams()}`)
      .then(res => {
        // Pre-fix the empty-response branch injected a fake
        // [Lead, Contacted, Proposal, Won] dataset so the chart looked
        // alive on a new tenant. That fabricated stages the tenant doesn't
        // have (e.g. a Travel tenant whose pipeline is New / Diagnostic
        // Complete / Qualifying / Quoted / Negotiating / Won / Lost /
        // Dormant) — the chart silently lied about its data model.
        // Empty now stays empty; the empty-state placeholder below the
        // chart explains the situation to the user.
        const rows = Array.isArray(res) ? res : [];
        const isDealMetric = metric === 'revenue' || metric === 'count';
        if (groupBy === 'stage' && isDealMetric) {
          const merged = new Map();
          rows.forEach((row) => {
            const stage = normalizeReportStage(row.name);
            const key = reportStageKey(stage);
            const current = merged.get(key) || { ...row, name: stage, value: 0 };
            current.value += Number(row.value || 0);
            merged.set(key, current);
          });
          const selectedType = dealTypes.find(type => type.name === dealType);
          const configuredStages = dealType ? (selectedType?.stages || []) : [];
          const stageData = configuredStages.length
            ? [
                ...configuredStages.map(stage => {
                  const existing = merged.get(reportStageKey(stage.name));
                  return existing || { name: stage.name, value: 0 };
                }),
                ...[...merged.entries()]
                  .filter(([key]) => !configuredStages.some(stage => reportStageKey(stage.name) === key))
                  .map(([, value]) => value),
              ]
            : [...merged.values()];
          setData(configuredStages.length ? stageData : stageData.sort((a, b) => {
            const ai = REPORT_STAGE_ORDER.indexOf(String(a.name).toUpperCase());
            const bi = REPORT_STAGE_ORDER.indexOf(String(b.name).toUpperCase());
            return (ai < 0 ? REPORT_STAGE_ORDER.length : ai) - (bi < 0 ? REPORT_STAGE_ORDER.length : bi);
          }));
        } else if (metric === 'invoices') {
          setData(rows.filter(row => INVOICE_STATUS_VALUES.has(String(row.name || '').toUpperCase())));
        } else setData(rows);
        setLoading(false);
      })
      .catch(err => {
        console.error(err);
        setData([]);
        setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- dateParams is derived from the listed state deps
  }, [metric, groupBy, dealType, dealTypes, startDate, endDate]);

  useEffect(() => {
    if (viewMode === 'table') {
      setDetailLoading(true);
      const offset = (detailPage - 1) * detailLimit;
      fetchApi(`/api/reports/detailed/${detailType}?limit=${detailLimit}&offset=${offset}&page=${detailPage}${dateParams()}`)
        .then(res => {
          if (res && Array.isArray(res.data)) {
            setDetailData(res.data);
            setDetailTotal(res.total ?? res.data.length);
            setDetailTotalPages(res.totalPages ?? 1);
          } else { setDetailData(Array.isArray(res) ? res : []); setDetailTotal(Array.isArray(res) ? res.length : 0); setDetailTotalPages(1); }
          setDetailLoading(false);
        })
        .catch(() => { setDetailData([]); setDetailTotal(0); setDetailTotalPages(1); setDetailLoading(false); });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- dateParams is derived from the listed state deps
  }, [viewMode, detailType, startDate, endDate, detailPage, detailLimit]);

  const applySchedulesResponse = (data) => {
    if (data && Array.isArray(data.data)) {
      setSchedules(data.data);
      setSchedTotal(data.total ?? data.data.length);
      setSchedTotalPages(data.totalPages ?? 1);
    } else { setSchedules(Array.isArray(data) ? data : []); setSchedTotal(Array.isArray(data) ? data.length : 0); setSchedTotalPages(1); }
  };

  // Schedules
  useEffect(() => {
    const offset = (schedPage - 1) * schedLimit;
    fetchApi(`/api/report-schedules?limit=${schedLimit}&offset=${offset}&page=${schedPage}`).then(d => {
      // Legacy fallback: very old server builds ignore page/limit and tests
      // mock only the bare path — retry it when the paginated shape is null.
      if (d == null && schedPage === 1) {
        fetchApi('/api/report-schedules').then(applySchedulesResponse).catch(() => { });
      } else applySchedulesResponse(d);
    }).catch(() => { fetchApi('/api/report-schedules').then(applySchedulesResponse).catch(() => { }); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schedPage, schedLimit]);

  const refreshSchedules = () => {
    const offset = (schedPage - 1) * schedLimit;
    fetchApi(`/api/report-schedules?limit=${schedLimit}&offset=${offset}&page=${schedPage}`).then(applySchedulesResponse).catch(() => { });
  };

  // #127: pragmatic email check — same regex used server-side in report_schedules.js
  const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]{2,}$/;

  const handleCreateSchedule = async (e) => {
    e.preventDefault();
    const recipients = newSchedule.recipients.split(',').map(r => r.trim()).filter(Boolean);
    if (recipients.length === 0) {
      notify.error('Add at least one recipient email.');
      return;
    }
    const invalid = recipients.filter(r => !EMAIL_RE.test(r));
    if (invalid.length) {
      notify.error(`Invalid email address(es): ${invalid.join(', ')}\n\nFix these before creating the schedule.`);
      return;
    }
    try {
      await fetchApi('/api/report-schedules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...newSchedule, recipients }),
      });
    } catch (err) {
      notify.error(`Failed to create schedule: ${err.message || err}`);
      return;
    }
    setNewSchedule({ name: '', reportType: 'deals', frequency: 'weekly', recipients: '', format: 'PDF' });
    refreshSchedules();
    setShowScheduleModal(false);
  };

  const handleToggleSchedule = async (id) => {
    await fetchApi(`/api/report-schedules/${id}/toggle`, { method: 'PUT' });
    refreshSchedules();
  };

  const handleDeleteSchedule = async (id) => {
    // #129: confirm before destructive action
    const sched = schedules.find(s => s.id === id);
    const name = sched?.name || `schedule #${id}`;
    if (!await notify.confirm(`Delete scheduled email report "${name}"?\n\nThis cancels future deliveries to its recipients. The action cannot be undone.`)) return;
    await fetchApi(`/api/report-schedules/${id}`, { method: 'DELETE' });
    refreshSchedules();
  };

  const totalValue = data.reduce((sum, item) => sum + (item.value || 0), 0);
  const isMoneyMetric = metric === 'revenue' || metric === 'invoices';
  const sourceCurrency = tenantCurrency();
  const conversionCurrencies = currencies.length ? currencies : [{ code: sourceCurrency, exchangeRate: 1 }];
  const convertedTotalValue = isMoneyMetric
    ? convertCurrency(totalValue, sourceCurrency, displayCurrency, conversionCurrencies)
    : totalValue;
  const formattedTotalValue = isMoneyMetric
    ? formatMoney(convertedTotalValue, { currency: displayCurrency, locale: tenantLocale() })
    : totalValue;
  const donutTotalValue = isMoneyMetric
    ? formatMoneyCompact(convertedTotalValue, { currency: displayCurrency, locale: tenantLocale() })
    : totalValue;

  const exportFile = (format) => {
    const token = getAuthToken();
    // Relative path → same-origin via Vite's /api proxy. A VITE_API_URL
    // prefix would make this cross-origin (CORS preflight 401 + mixed-content
    // over HTTPS). See Invoices.jsx downloadPdf for the canonical note.
    const endpoint = format === 'pdf' ? 'export-pdf' : 'export-csv';
    const params = viewMode === 'table'
      ? `type=${detailType}${dateParams()}`
      : `metric=${metric}&groupBy=${groupBy}${needsGroupBy && dealType ? `&dealType=${encodeURIComponent(dealType)}` : ''}${dateParams()}`;
    fetch(`/api/reports/${endpoint}?${params}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(res => {
        if (!res.ok) throw new Error(`${format.toUpperCase()} export failed`);
        return res.blob();
      })
      .then(blob => {
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `report.${format}`;
        link.click();
        URL.revokeObjectURL(link.href);
      })
      .catch(() => notify.error(`Failed to export ${format.toUpperCase()}`));
  };

  const needsGroupBy = metric === 'revenue' || metric === 'count' || metric === 'win_rate';
  const visualizationOptions = VISUALIZATION_OPTIONS_BY_METRIC[metric] || VISUALIZATION_OPTIONS_BY_METRIC.revenue;

  useEffect(() => {
    const options = VISUALIZATION_OPTIONS_BY_METRIC[metric] || VISUALIZATION_OPTIONS_BY_METRIC.revenue;
    if (!options.some(option => option.value === chartType)) setChartType(options[0].value);
  }, [metric, chartType]);

  return (
    <div className="reports-page" style={{ padding: '0 2rem 0.5rem', minHeight: '100%', display: 'flex', flexDirection: 'column', animation: 'fadeIn 0.5s ease-out' }}>
      <header className="reports-page__header" style={{ marginBottom: '0.75rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.75rem' }}>
        <div>
          <h1 style={{ fontSize: '2rem', fontWeight: 'bold', margin: 0 }}>Reports & Analytics</h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>Business intelligence dashboard — real-time revenue, pipeline, and deal analytics.</p>
        </div>
        <div className="reports-page__header-actions" style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
          <div className="reports-page__date-group" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexDirection: 'column' }}>
            <select aria-label="Date range" value={datePreset} onChange={e => updateDatePreset(e.target.value)} className="input-field" style={{ padding: '0.5rem', fontSize: '0.8rem', minWidth: '150px' }}>
              {REPORT_DATE_PRESETS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
            {datePreset === 'custom' && (
              <div className="reports-page__date-row" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <Calendar size={16} color="var(--text-secondary)" style={{ flexShrink: 0 }} />
                <input type="date" className="input-field" aria-label="Start date" aria-invalid={rangeInverted} value={startDate} onChange={e => { setDatePreset('custom'); updateDate('from', e.target.value); }} onClick={openDatePicker} onKeyDown={preventManualDateEntry} onPaste={e => e.preventDefault()} onDrop={e => e.preventDefault()} style={{ padding: '0.5rem', fontSize: '0.8rem', borderColor: rangeInverted ? '#ef4444' : undefined }} />
                <span style={{ color: 'var(--text-secondary)' }}>to</span>
                <input type="date" className="input-field" aria-label="End date" aria-invalid={rangeInverted} value={endDate} onChange={e => { setDatePreset('custom'); updateDate('to', e.target.value); }} onClick={openDatePicker} onKeyDown={preventManualDateEntry} onPaste={e => e.preventDefault()} onDrop={e => e.preventDefault()} style={{ padding: '0.5rem', fontSize: '0.8rem', borderColor: rangeInverted ? '#ef4444' : undefined }} />
              </div>
            )}
            {rangeInverted && (
              <span className="report-error-text" style={{ fontSize: '0.7rem', alignSelf: 'flex-start' }}>
                Start date must be on or before end date
              </span>
            )}
          </div>
          <button className="btn-secondary" onClick={() => exportFile('csv')} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Upload size={16} /> CSV
          </button>
          <button className="btn-primary" onClick={() => exportFile('pdf')} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Upload size={16} /> PDF
          </button>
          <button className="btn-secondary" onClick={() => setShowScheduleModal(true)} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Clock size={16} /> Schedule
          </button>
        </div>
      </header>

      {/* View Mode Tabs */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem', flexWrap: 'wrap', marginBottom: '1.5rem' }}>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button onClick={() => setViewMode('chart')} style={{ padding: '0.5rem 1.25rem', borderRadius: '8px', border: 'none', cursor: 'pointer', fontWeight: '500', background: viewMode === 'chart' ? 'var(--primary-color, var(--accent-color))' : 'var(--subtle-bg)', color: viewMode === 'chart' ? '#fff' : 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '0.4rem', transition: 'var(--transition)' }}>
            <BarChart3 size={16} /> Charts
          </button>
          <button onClick={() => setViewMode('table')} style={{ padding: '0.5rem 1.25rem', borderRadius: '8px', border: 'none', cursor: 'pointer', fontWeight: '500', background: viewMode === 'table' ? 'var(--primary-color, var(--accent-color))' : 'var(--subtle-bg)', color: viewMode === 'table' ? '#fff' : 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '0.4rem', transition: 'var(--transition)' }}>
            <Table size={16} /> Detailed Data
          </button>
        </div>

        {viewMode === 'chart' && needsGroupBy && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: '600', whiteSpace: 'nowrap' }}>Deal Type</label>
            <select className="input-field" value={dealType} onChange={e => setDealType(e.target.value)} style={{ padding: '0.65rem 0.75rem', background: 'var(--input-bg)', minWidth: '150px', outline: 'none' }}>
              <option value="">All Deal Types</option>
              {dealTypes.map(type => <option key={type.id || type.name} value={type.name}>{type.name}</option>)}
            </select>
          </div>
        )}
      </div>

      {viewMode === 'chart' ? (
        <div className="reports-page__overview">
          {/* Controls Sidebar */}
          <div className="card" style={{ minWidth: 0, padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
            <h3 style={{ fontSize: '1.25rem', fontWeight: '600', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Filter size={20} color="var(--primary-color, var(--accent-color))" /> Query Builder
            </h3>

            <div>
              <label style={{ display: 'block', marginBottom: '0.75rem', fontSize: '0.875rem', color: 'var(--text-secondary)', fontWeight: '600' }}>Select Metric</label>
              <div role="group" aria-label="Select Metric" style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '0.5rem' }}>
                {METRIC_OPTIONS.map(m => (
                  <button
                    key={m.value}
                    type="button"
                    aria-pressed={metric === m.value}
                    onClick={() => setMetric(m.value)}
                    style={{
                      padding: '0.7rem 0.6rem',
                      borderRadius: '8px',
                      border: `1px solid ${metric === m.value ? 'var(--primary-color, var(--accent-color))' : 'var(--border-color)'}`,
                      background: metric === m.value ? 'var(--primary-color, var(--accent-color))' : 'var(--input-bg)',
                      color: metric === m.value ? '#fff' : 'var(--text-primary)',
                      cursor: 'pointer',
                      fontWeight: metric === m.value ? '600' : '500',
                      fontSize: '0.8rem',
                      minHeight: '42px',
                    }}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="report-aggregate-card" style={{ marginTop: 'auto', padding: '1.5rem', borderRadius: '12px' }}>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', margin: '0 0 0.75rem' }}>Aggregate Total</p>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', minWidth: 0, flexWrap: 'wrap' }}>
                {isMoneyMetric && currencies.length > 1 && (
                  <select aria-label="Display currency" value={displayCurrency} onChange={e => setDisplayCurrency(e.target.value)} style={{ flex: '0 0 auto', padding: '0.3rem 0.35rem', border: '1px solid var(--border-color)', borderRadius: '6px', background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '0.7rem' }}>
                    {conversionCurrencies.map(currency => <option key={currency.code} value={currency.code}>{currency.code}</option>)}
                  </select>
                )}
                <h2 style={{ minWidth: 0, margin: 0, whiteSpace: 'nowrap', fontSize: '1.1rem', letterSpacing: '-0.03em', fontWeight: 'bold', color: 'var(--accent-color)' }}>
                  {formattedTotalValue}
                </h2>
              </div>
            </div>
          </div>

          {/* Chart View */}
          {/* #462: `flex: 1` on the parent card paired with `flexWrap: 'wrap'`
              on the grandparent (so the controls sidebar can wrap on narrow
              viewports) leaves the card's flex-basis ambiguous during the
              first layout pass — Recharts ResponsiveContainer measures parent
              dims and gets width=-1 / height=-1, which it then logs as a
              warning AND draws the SVG outside its bounds (overlapping the
              Scheduled Email Reports table beneath). Fix: pin a deterministic
              pixel height on the chart wrapper instead of `flex: 1` height,
              and add `minWidth: 0` so the card can shrink below its content
              width without forcing a -1 measurement. Mirrors the
              OwnerDashboard.jsx revenue-trend pattern (`<div style={{ height: 220 }}>`). */}
          <div className="card" style={{ minWidth: 0, padding: '2rem', display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '2rem' }}>
              <h3 style={{ fontSize: '1.25rem', fontWeight: '600', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <PieChartIcon size={20} color="var(--success-color)" /> Data Projection
              </h3>
              <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'flex-start', gap: '1rem', flexWrap: 'wrap' }}>
                <div>
                  <div role="group" aria-label="Visualization" style={{ display: 'flex', gap: '0.5rem' }}>
                    {visualizationOptions.map(({ value, label, Icon, iconStyle }) => (
                      <button
                        key={value}
                        type="button"
                        aria-label={label}
                        aria-pressed={chartType === value}
                        title={label}
                        onClick={() => setChartType(value)}
                        style={{
                          width: '42px',
                          height: '42px',
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          borderRadius: '8px',
                          border: `1px solid ${chartType === value ? 'var(--primary-color, var(--accent-color))' : 'var(--border-color)'}`,
                          background: chartType === value ? 'var(--primary-color, var(--accent-color))' : 'var(--input-bg)',
                          color: chartType === value ? '#fff' : 'var(--text-primary)',
                          cursor: 'pointer',
                        }}
                      >
                        <Icon size={18} style={iconStyle} />
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            <div className="reports-page__chart-scroll">
            <div className="reports-page__chart-stage" style={{ position: 'relative', height: '450px', minHeight: '350px', minWidth: 0 }}>
              {loading && data.length > 0 && (
                <div style={{ position: 'absolute', top: '0.5rem', left: '50%', transform: 'translateX(-50%)', zIndex: 2, padding: '0.35rem 0.7rem', borderRadius: '999px', background: 'var(--surface-color)', color: 'var(--text-secondary)', fontSize: '0.75rem', boxShadow: '0 2px 8px rgba(0, 0, 0, 0.08)', pointerEvents: 'none' }}>
                  Refreshing data...
                </div>
              )}
              {loading && data.length === 0 ? (
                <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)' }}>Crunching metrics...</div>
              ) : data.length === 0 ? (
                <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)' }}>No data available for this query.</div>
              ) : (
                <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
                  {chartType === 'bar' ? (
                    <BarChart data={data} margin={{ top: 20, right: 30, left: 20, bottom: 20 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" vertical={false} />
                      <XAxis dataKey="name" stroke="var(--text-secondary)" tickLine={false} axisLine={false} />
                      {/* #462 follow-up: mirror the #439 OwnerDashboard fix —
                          all metrics here (revenue/count/win-rate/expenses) are
                          non-negative; pinning domain=[0,'auto'] silences the
                          Recharts negative-domain warning on all-zero data. */}
                      <YAxis stroke="var(--text-secondary)" tickLine={false} axisLine={false} width={104} tickMargin={8} domain={[0, 'auto']} tickFormatter={val => metric === 'revenue' ? formatMoneyCompact(val) : val} />
                      <Tooltip wrapperStyle={{ zIndex: 9999 }} contentStyle={{ background: 'var(--tooltip-bg)', border: '1px solid var(--border-color)', borderRadius: '8px' }} itemStyle={{ color: 'var(--text-primary)' }} />
                      <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                        {data.map((entry, index) => (
                          <Cell key={`cell-${index}`} fill={chartColor(entry.name, index)} />
                        ))}
                      </Bar>
                    </BarChart>
                  ) : chartType === 'horizontal_bar' ? (
                    <BarChart layout="vertical" data={data} margin={{ top: 20, right: 30, left: 20, bottom: 20 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" horizontal={false} />
                      <XAxis type="number" stroke="var(--text-secondary)" tickLine={false} axisLine={false} domain={[0, 'auto']} tickFormatter={val => metric === 'revenue' ? formatMoneyCompact(val) : val} />
                      <YAxis type="category" dataKey="name" stroke="var(--text-secondary)" tickLine={false} axisLine={false} width={120} />
                      <Tooltip wrapperStyle={{ zIndex: 9999 }} contentStyle={{ background: 'var(--tooltip-bg)', border: '1px solid var(--border-color)', borderRadius: '8px' }} itemStyle={{ color: 'var(--text-primary)' }} />
                      <Bar dataKey="value" radius={[0, 4, 4, 0]}>
                        {data.map((entry, index) => (
                          <Cell key={`cell-${index}`} fill={chartColor(entry.name, index)} />
                        ))}
                      </Bar>
                    </BarChart>
                  ) : chartType === 'pie' || chartType === 'donut' ? (
                    <PieChart>
                      <Pie data={data} cx="36%" cy="50%" innerRadius={chartType === 'donut' ? 112 : 0} outerRadius={165} paddingAngle={5} dataKey="value" nameKey="name" label={false}>
                        {data.map((entry, index) => (
                          <Cell key={`cell-${index}`} fill={chartColor(entry.name, index)} />
                        ))}
                      </Pie>
                      {chartType === 'donut' && (
                        <Label
                          position="center"
                          content={({ viewBox }) => {
                            const { cx, cy } = viewBox || {};
                            if (cx == null || cy == null) return null;
                            return (
                              <g>
                                <text x={cx} y={cy - 7} textAnchor="middle" fill="var(--text-secondary)" fontSize="11">Total</text>
                                <text x={cx} y={cy + 15} textAnchor="middle" fill="var(--text-primary)" fontSize="16" fontWeight="700">{donutTotalValue}</text>
                              </g>
                            );
                          }}
                        />
                      )}
                      <Legend
                        layout="vertical"
                        align="right"
                        verticalAlign="middle"
                        wrapperStyle={{ fontSize: '0.8rem', maxWidth: '42%', overflow: 'hidden' }}
                        formatter={(name) => {
                          const row = data.find((entry) => String(entry.name) === String(name));
                          const value = Math.max(0, Number(row?.value) || 0);
                          const total = data.reduce((sum, entry) => sum + Math.max(0, Number(entry.value) || 0), 0);
                          const percent = total > 0 ? Math.round((value / total) * 100) : 0;
                          const groupLabel = 'Deal Stage';
                          const label = `${groupLabel}: ${String(name || 'Unknown')}`;
                          const shortLabel = label.length > 30 ? `${label.slice(0, 29)}…` : label;
                          return `${shortLabel}${total > 0 ? ` (${percent}%)` : ''}`;
                        }}
                      />
                      <Tooltip wrapperStyle={{ zIndex: 9999 }} contentStyle={{ background: 'var(--tooltip-bg)', border: '1px solid var(--border-color)', borderRadius: '8px' }} itemStyle={{ color: 'var(--text-primary)' }} />
                    </PieChart>
                  ) : (
                    <LineChart data={data} margin={{ top: 20, right: 30, left: 20, bottom: 20 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" vertical={false} />
                      <XAxis dataKey="name" stroke="var(--text-secondary)" tickLine={false} axisLine={false} />
                      {/* #462 follow-up: mirror the #439 OwnerDashboard fix —
                          all metrics here (revenue/count/win-rate/expenses) are
                          non-negative; pinning domain=[0,'auto'] silences the
                          Recharts negative-domain warning on all-zero data. */}
                      <YAxis stroke="var(--text-secondary)" tickLine={false} axisLine={false} width={104} tickMargin={8} domain={[0, 'auto']} tickFormatter={val => metric === 'revenue' ? formatMoneyCompact(val) : val} />
                      <Tooltip wrapperStyle={{ zIndex: 9999 }} contentStyle={{ background: 'var(--tooltip-bg)', border: '1px solid var(--border-color)', borderRadius: '8px' }} />
                      <Line type="monotone" dataKey="value" stroke="#10b981" strokeWidth={3} dot={{ r: 4 }} />
                    </LineChart>
                  )}
                </ResponsiveContainer>
              )}
            </div>
            </div>
          </div>
        </div>
      ) : (
        /* Detailed Data Table View */
        <div>
          <div style={{ marginBottom: '1rem', display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            {DETAIL_TYPES.map(t => (
              <button key={t.value} onClick={() => { setDetailType(t.value); setDetailPage(1); }} style={{
                padding: '0.5rem 1rem', borderRadius: '8px', border: 'none', cursor: 'pointer', fontWeight: '500', fontSize: '0.85rem',
                background: detailType === t.value ? 'var(--primary-color, var(--accent-color))' : 'var(--subtle-bg)',
                color: detailType === t.value ? '#fff' : 'var(--text-primary)', transition: 'var(--transition)'
              }}>
                {t.label}
              </button>
            ))}
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '0.6rem' }}>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: '0.45rem', background: 'var(--subtle-bg)', border: '1px solid var(--border-color)', borderRadius: '10px', padding: '0.3rem 0.4rem 0.3rem 0.7rem', fontSize: '0.75rem', width: 'fit-content', maxWidth: '100%' }}>
              <span style={{ color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                {detailTotal === 0 ? 'No records' : `${(detailPage - 1) * detailLimit + 1}–${Math.min(detailPage * detailLimit, detailTotal)} of ${detailTotal}`}
              </span>
              <select className="input-field" aria-label="Rows per page" value={detailLimit} onChange={e => { setDetailLimit(parseInt(e.target.value) || 10); setDetailPage(1); }} style={{ padding: '0.2rem 0.35rem', fontSize: '0.75rem', borderRadius: '7px', width: 'auto' }}>
                {[5, 10, 20, 50].map(n => <option key={n} value={n}>{n} / page</option>)}
              </select>
              <button className="btn-secondary" aria-label="Previous page" disabled={detailPage <= 1} onClick={() => setDetailPage(p => Math.max(p - 1, 1))} style={{ padding: '0.2rem 0.55rem', fontSize: '0.75rem', borderRadius: '7px', opacity: detailPage <= 1 ? 0.45 : 1, cursor: detailPage <= 1 ? 'not-allowed' : 'pointer' }}>‹ Prev</button>
              <span style={{ fontSize: '0.75rem', color: 'var(--text-primary)', fontWeight: '600', whiteSpace: 'nowrap' }}>{detailPage} / {detailTotalPages}</span>
              <button className="btn-secondary" aria-label="Next page" disabled={detailPage >= detailTotalPages} onClick={() => setDetailPage(p => Math.min(p + 1, detailTotalPages))} style={{ padding: '0.2rem 0.55rem', fontSize: '0.75rem', borderRadius: '7px', opacity: detailPage >= detailTotalPages ? 0.45 : 1, cursor: detailPage >= detailTotalPages ? 'not-allowed' : 'pointer' }}>Next ›</button>
            </div>
          </div>
          <div className="reports-page__table-shell card"
            style={{
              maxHeight: '400px',
              overflowY: 'auto',
              overflowX: 'auto',
              position: 'relative',
              isolation: 'isolate',
            }}
          >
            {detailLoading ? (
              <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>Loading data...</div>
            ) : detailData.length === 0 ? (
              <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>No records found for the selected period.</div>
            ) : (
              <table className="stable-table" style={{ width: '100%', minWidth: 0, borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.85rem' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border-color)', backgroundColor: 'var(--table-header-bg)' }}>
                    {detailType === 'deals' && <>
                      <th
                        style={{
                          ...thStyle,
                          position: 'sticky',
                          top: 0,
                          zIndex: 10,
                          backgroundColor: 'var(--modal-bg)',
                        }}
                      >
                        Title
                      </th>

                      <th
                        style={{
                          ...numericThStyle,
                          position: 'sticky',
                          top: 0,
                          zIndex: 10,
                          backgroundColor: 'var(--modal-bg)',
                        }}
                      >
                        Amount
                      </th>
                      <th
                        style={{
                          ...thStyle,
                          position: 'sticky',
                          top: 0,
                          zIndex: 10,
                          backgroundColor: 'var(--modal-bg)',
                        }}
                      >
                        Stage
                      </th>

                      <th
                        style={{
                          ...thStyle,
                          position: 'sticky',
                          top: 0,
                          zIndex: 10,
                          backgroundColor: 'var(--modal-bg)',
                        }}
                      >
                        Owner
                      </th>
                      <th
                        style={{
                          ...thStyle,
                          position: 'sticky',
                          top: 0,
                          zIndex: 10,
                          backgroundColor: 'var(--modal-bg)',
                        }}
                      >
                        Contact
                      </th>

                      <th
                        style={{
                          ...numericThStyle,
                          position: 'sticky',
                          top: 0,
                          zIndex: 10,
                          backgroundColor: 'var(--modal-bg)',
                        }}
                      >
                        Created
                      </th>
                    </>}
                    {detailType === 'contacts' && <>
                      {/* #593: "AI Score" column → "Lead Score" — score is rules-based (leadScoringEngine.js). */}
                      <th
                        style={{
                          ...thStyle,
                          position: 'sticky',
                          top: 0,
                          zIndex: 10,
                          backgroundColor: 'var(--modal-bg)',
                        }}
                      >
                        Name
                      </th>

                      <th
                        style={{
                          ...thStyle,
                          position: 'sticky',
                          top: 0,
                          zIndex: 10,
                          backgroundColor: 'var(--modal-bg)',
                        }}
                      >
                        Email
                      </th>
                      <th
                        style={{
                          ...thStyle,
                          position: 'sticky',
                          top: 0,
                          zIndex: 10,
                          backgroundColor: 'var(--modal-bg)',
                        }}
                      >
                        Company
                      </th>

                      <th
                        style={{
                          ...thStyle,
                          position: 'sticky',
                          top: 0,
                          zIndex: 10,
                          backgroundColor: 'var(--modal-bg)',
                        }}
                      >
                        Status
                      </th>
                      <th
                        style={{
                          ...thStyle,
                          position: 'sticky',
                          top: 0,
                          zIndex: 10,
                          backgroundColor: 'var(--modal-bg)',
                        }}
                      >
                        Source
                      </th>

                      <th
                        style={{
                          ...thStyle,
                          position: 'sticky',
                          top: 0,
                          zIndex: 10,
                          backgroundColor: 'var(--modal-bg)',
                        }}
                      >
                        Assigned To
                      </th>


                      <th
                        style={{
                          ...numericThStyle,
                          position: 'sticky',
                          top: 0,
                          zIndex: 10,
                          backgroundColor: 'var(--modal-bg)',
                        }}
                      >
                        Lead Score
                      </th>

                    </>}
                    {detailType === 'tasks' && <>
                      <th
                        style={{
                          ...thStyle,
                          position: 'sticky',
                          top: 0,
                          zIndex: 10,
                          backgroundColor: 'var(--modal-bg)',
                        }}
                      >
                        Title
                      </th>

                      <th
                        style={{
                          ...thStyle,
                          position: 'sticky',
                          top: 0,
                          zIndex: 10,
                          backgroundColor: 'var(--modal-bg)',
                        }}
                      >
                        Status
                      </th>

                      <th
                        style={{
                          ...thStyle,
                          position: 'sticky',
                          top: 0,
                          zIndex: 10,
                          backgroundColor: 'var(--modal-bg)',
                        }}
                      >
                        Priority
                      </th>

                      <th
                        style={{
                          ...thStyle,
                          position: 'sticky',
                          top: 0,
                          zIndex: 10,
                          backgroundColor: 'var(--modal-bg)',
                        }}
                      >
                        Assignee
                      </th>

                      <th
                        style={{
                          ...numericThStyle,
                          position: 'sticky',
                          top: 0,
                          zIndex: 10,
                          backgroundColor: 'var(--modal-bg)',
                        }}
                      >
                        Due Date
                      </th>


                    </>}
                    {detailType === 'calls' && <>
                      <th
                        style={{
                          ...thStyle,
                          position: 'sticky',
                          top: 0,
                          zIndex: 10,
                          backgroundColor: 'var(--modal-bg)',
                        }}
                      >
                        Contact
                      </th>

                      <th
                        style={{
                          ...numericThStyle,
                          position: 'sticky',
                          top: 0,
                          zIndex: 10,
                          backgroundColor: 'var(--modal-bg)',
                        }}
                      >
                        Duration
                      </th>

                      <th
                        style={{
                          ...thStyle,
                          position: 'sticky',
                          top: 0,
                          zIndex: 10,
                          backgroundColor: 'var(--modal-bg)',
                        }}
                      >
                        Direction
                      </th>

                      <th
                        style={{
                          ...thStyle,
                          position: 'sticky',
                          top: 0,
                          zIndex: 10,
                          backgroundColor: 'var(--modal-bg)',
                        }}
                      >
                        Agent
                      </th>

                      <th
                        style={{
                          ...numericThStyle,
                          position: 'sticky',
                          top: 0,
                          zIndex: 10,
                          backgroundColor: 'var(--modal-bg)',
                        }}
                      >
                        Date
                      </th>

                    </>}
                    {detailType === 'invoices' && <>
                      <th
                        style={{
                          ...thStyle,
                          position: 'sticky',
                          top: 0,
                          zIndex: 10,
                          backgroundColor: 'var(--modal-bg)',
                        }}
                      >
                        Invoice #
                      </th>

                      <th
                        style={{
                          ...numericThStyle,
                          position: 'sticky',
                          top: 0,
                          zIndex: 10,
                          backgroundColor: 'var(--modal-bg)',
                        }}
                      >
                        Amount
                      </th>

                      <th
                        style={{
                          ...thStyle,
                          position: 'sticky',
                          top: 0,
                          zIndex: 10,
                          backgroundColor: 'var(--modal-bg)',
                        }}
                      >
                        Status
                      </th>

                      <th
                        style={{
                          ...thStyle,
                          position: 'sticky',
                          top: 0,
                          zIndex: 10,
                          backgroundColor: 'var(--modal-bg)',
                        }}
                      >
                        Contact
                      </th>

                      <th
                        style={{
                          ...numericThStyle,
                          position: 'sticky',
                          top: 0,
                          zIndex: 10,
                          backgroundColor: 'var(--modal-bg)',
                        }}
                      >
                        Due Date
                      </th>
                    </>}
                    {detailType === 'expenses' && <>
                      <th
                        style={{
                          ...thStyle,
                          position: 'sticky',
                          top: 0,
                          zIndex: 10,
                          backgroundColor: 'var(--modal-bg)',
                        }}
                      >
                        Title
                      </th>

                      <th
                        style={{
                          ...numericThStyle,
                          position: 'sticky',
                          top: 0,
                          zIndex: 10,
                          backgroundColor: 'var(--modal-bg)',
                        }}
                      >
                        Amount
                      </th>

                      <th
                        style={{
                          ...thStyle,
                          position: 'sticky',
                          top: 0,
                          zIndex: 10,
                          backgroundColor: 'var(--modal-bg)',
                        }}
                      >
                        Category
                      </th>

                      <th
                        style={{
                          ...thStyle,
                          position: 'sticky',
                          top: 0,
                          zIndex: 10,
                          backgroundColor: 'var(--modal-bg)',
                        }}
                      >
                        Status
                      </th>

                      <th
                        style={{
                          ...thStyle,
                          position: 'sticky',
                          top: 0,
                          zIndex: 10,
                          backgroundColor: 'var(--modal-bg)',
                        }}
                      >
                        Submitted By
                      </th>
                    </>}
                  </tr>
                </thead>
                <tbody>
                  {detailData.map((row, i) => (
                    <tr key={row.id || i} style={{ borderBottom: '1px solid var(--border-color)' }} className="table-row-hover">
                      {detailType === 'deals' && <>
                        <td style={tdStyle}>{row.title}</td>
                        <td style={{ ...numericTdStyle, fontWeight: '600', color: 'var(--success-color)' }}>{formatMoney(row.amount || 0)}</td>
                        <td style={tdStyle}><StageBadge stage={row.stage} /></td>
                        <td style={tdStyle}>{row.owner?.name || '—'}</td>
                        <td style={tdStyle}>{row.contact?.name || '—'}</td>
                        <td style={numericTdStyle}>{fmtDate(row.createdAt)}</td>
                      </>}
                      {detailType === 'contacts' && <>
                        <td style={{ ...tdStyle, fontWeight: '500' }}>{row.name}</td>
                        <td style={tdStyle}>{row.email}</td>
                        <td style={tdStyle}>{row.company || '—'}</td>
                        <td style={tdStyle}><StatusBadge status={row.status} /></td>
                        <td style={tdStyle}>{row.source || '—'}</td>
                        <td style={tdStyle}>{row.assignedTo?.name || '—'}</td>
                        <td style={numericTdStyle}>{row.aiScore}</td>
                      </>}
                      {detailType === 'tasks' && <>
                        <td style={tdStyle}>{row.title}</td>
                        <td style={tdStyle}><StatusBadge status={row.status} /></td>
                        <td style={tdStyle}>{row.priority}</td>
                        <td style={tdStyle}>{row.user?.name || '—'}</td>
                        <td style={numericTdStyle}>{row.dueDate ? fmtDate(row.dueDate) : '—'}</td>
                      </>}
                      {detailType === 'calls' && <>
                        <td style={tdStyle}>{row.contact?.name || '—'}</td>
                        <td style={numericTdStyle}>{Math.floor(row.duration / 60)}m {row.duration % 60}s</td>
                        <td style={tdStyle}>{row.direction}</td>
                        <td style={tdStyle}>{row.user?.name || '—'}</td>
                        <td style={numericTdStyle}>{fmtDate(row.createdAt)}</td>
                      </>}
                      {detailType === 'invoices' && <>
                        <td style={tdStyle}>{row.invoiceNum}</td>
                        <td style={{ ...numericTdStyle, fontWeight: '600' }}>{formatMoney(row.amount || 0)}</td>
                        <td style={tdStyle}><StatusBadge status={row.status} /></td>
                        <td style={tdStyle}>{row.contact?.name || '—'}</td>
                        <td style={numericTdStyle}>{fmtDate(row.dueDate)}</td>
                      </>}
                      {detailType === 'expenses' && <>
                        <td style={tdStyle}>{row.title}</td>
                        <td style={{ ...numericTdStyle, fontWeight: '600' }}>{formatMoney(row.amount || 0)}</td>
                        <td style={tdStyle}>{row.category}</td>
                        <td style={tdStyle}><StatusBadge status={row.status} /></td>
                        <td style={tdStyle}>{row.user?.name || '—'}</td>
                      </>}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* Scheduled Reports Section */}
      {viewMode === 'table' && (schedules.length > 0 || schedTotal > 0) && (
        <div className="reports-page__schedule" style={{ marginTop: '2rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
            <h3 style={{ fontSize: '1.1rem', fontWeight: '600', display: 'flex', alignItems: 'center', gap: '0.5rem', margin: 0 }}>
              <Mail size={18} color="var(--accent-color)" /> Scheduled Email Reports
            </h3>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: '0.45rem', background: 'var(--subtle-bg)', border: '1px solid var(--border-color)', borderRadius: '10px', padding: '0.3rem 0.4rem 0.3rem 0.7rem', fontSize: '0.75rem', width: 'fit-content', marginLeft: 'auto' }}>
              <span style={{ color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                {schedTotal === 0 ? 'No schedules' : `${(schedPage - 1) * schedLimit + 1}–${Math.min(schedPage * schedLimit, schedTotal)} of ${schedTotal}`}
              </span>
              <select className="input-field" aria-label="Schedules per page" value={schedLimit} onChange={e => { setSchedLimit(parseInt(e.target.value) || 10); setSchedPage(1); }} style={{ padding: '0.2rem 0.35rem', fontSize: '0.75rem', borderRadius: '7px', width: 'auto' }}>
                {[5, 10, 20, 50].map(n => <option key={n} value={n}>{n} / page</option>)}
              </select>
              <button className="btn-secondary" aria-label="Previous page" disabled={schedPage <= 1} onClick={() => setSchedPage(p => Math.max(p - 1, 1))} style={{ padding: '0.2rem 0.55rem', fontSize: '0.75rem', borderRadius: '7px', opacity: schedPage <= 1 ? 0.45 : 1, cursor: schedPage <= 1 ? 'not-allowed' : 'pointer' }}>‹ Prev</button>
              <span style={{ fontSize: '0.75rem', color: 'var(--text-primary)', fontWeight: '600', whiteSpace: 'nowrap' }}>{schedPage} / {schedTotalPages}</span>
              <button className="btn-secondary" aria-label="Next page" disabled={schedPage >= schedTotalPages} onClick={() => setSchedPage(p => Math.min(p + 1, schedTotalPages))} style={{ padding: '0.2rem 0.55rem', fontSize: '0.75rem', borderRadius: '7px', opacity: schedPage >= schedTotalPages ? 0.45 : 1, cursor: schedPage >= schedTotalPages ? 'not-allowed' : 'pointer' }}>Next ›</button>
            </div>
          </div>
          <div className="reports-page__table-shell card" style={{
            maxHeight: '400px',
            overflowY: 'auto',
            overflowX: 'auto',
            position: 'relative',
            isolation: 'isolate',
          }}>
            <table className="stable-table reports-page__schedule-table" style={{
              borderCollapse: 'separate',
              borderSpacing: 0,
              textAlign: 'left',
              tableLayout: 'fixed',
              fontSize: '0.85rem',
              width: '100%',
              minWidth: 0,
            }}>
              <colgroup>
                <col style={{ width: '14%' }} />
                <col style={{ width: '11%' }} />
                <col style={{ width: '10%' }} />
                <col style={{ width: '7%' }} />
                <col style={{ width: '18%' }} />
                <col style={{ width: '13%' }} />
                <col style={{ width: '12%' }} />
                <col style={{ width: '15%' }} />
              </colgroup>

              <thead style={{
                position: 'sticky',
                top: 0,
                zIndex: 20,
              }}>
                <tr style={{ borderBottom: '1px solid var(--border-color)', backgroundColor: 'var(--table-header-bg)' }}>
                  <th
                    style={{
                      ...thStyle,
                      position: 'sticky',
                      top: 0,
                      zIndex: 21,
                      background: 'var(--modal-bg)',
                      boxShadow: '0 1px 0 var(--border-color)',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    Name
                  </th>

                  <th
                    style={{
                      ...thStyle,
                      position: 'sticky',
                      top: 0,
                      zIndex: 21,
                      background: 'var(--modal-bg)',
                      boxShadow: '0 1px 0 var(--border-color)',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    Type
                  </th>

                  <th
                    style={{
                      ...thStyle,
                      position: 'sticky',
                      top: 0,
                      zIndex: 21,
                      background: 'var(--modal-bg)',
                      boxShadow: '0 1px 0 var(--border-color)',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    Frequency
                  </th>

                  <th
                    style={{
                      ...thStyle,
                      position: 'sticky',
                      top: 0,
                      zIndex: 21,
                      background: 'var(--modal-bg)',
                      boxShadow: '0 1px 0 var(--border-color)',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    Format
                  </th>

                  <th
                    style={{
                      ...thStyle,
                      position: 'sticky',
                      top: 0,
                      zIndex: 21,
                      background: 'var(--modal-bg)',
                      boxShadow: '0 1px 0 var(--border-color)',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    Recipients
                  </th>

                  <th
                    style={{
                      ...numericThStyle,
                      position: 'sticky',
                      top: 0,
                      zIndex: 21,
                      background: 'var(--modal-bg)',
                      boxShadow: '0 1px 0 var(--border-color)',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    Last Run
                  </th>

                  <th
                    style={{
                      ...thStyle,
                      position: 'sticky',
                      top: 0,
                      zIndex: 21,
                      background: 'var(--modal-bg)',
                      boxShadow: '0 1px 0 var(--border-color)',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    Status
                  </th>

                  <th
                    style={{
                      ...thStyle,
                      textAlign: 'center',
                      position: 'sticky',
                      top: 0,
                      zIndex: 21,
                      background: 'var(--modal-bg)',
                      boxShadow: '0 1px 0 var(--border-color)',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    Actions
                  </th>
                </tr>
              </thead>


              <tbody>
                {schedules.map(s => (
                  <tr key={s.id} style={{ borderBottom: '1px solid var(--border-color)' }} className="table-row-hover">
                    <td style={{ ...tdStyle }}>{s.name}</td>
                    <td style={tdStyle}>{s.reportType}</td>
                    <td style={tdStyle}>{s.frequency}</td>
                    <td style={tdStyle}>{s.format}</td>
                    <td style={{
                      ...tdStyle,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}>{(() => { try { return JSON.parse(s.recipients).join(', '); } catch { return s.recipients; } })()}</td>
                    <td style={numericTdStyle}>{s.lastRunAt ? fmtDate(s.lastRunAt) : 'Never'}</td>
                    <td style={tdStyle}>
                      <span
                        className={`report-schedule-status-badge ${s.enabled ? 'report-schedule-status-badge--active' : 'report-schedule-status-badge--paused'}`}
                        style={{ padding: '0.2rem 0.6rem', borderRadius: '999px', fontSize: '0.7rem', fontWeight: 'bold' }}
                      >
                        {s.enabled ? 'Active' : 'Paused'}
                      </span>
                    </td>
                    {/* #127 polish: was `display: flex` directly on the <td>, which
                        breaks the table layout (the row collapses). Move flex onto a
                        wrapping div so the cell still behaves as a table cell. */}
                    <td style={{ ...tdStyle, paddingLeft: '0.5rem', paddingRight: '0.5rem', textAlign: 'center', verticalAlign: 'middle' }}>
                      <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'nowrap', gap: '0.65rem', justifyContent: 'center', whiteSpace: 'nowrap' }}>
                        <button onClick={() => handleToggleSchedule(s.id)} style={{ display: 'inline-flex', alignItems: 'center', padding: 0, lineHeight: 1.2, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--primary-color, var(--accent-color))', fontSize: '0.8rem', whiteSpace: 'nowrap' }}>
                          {s.enabled ? 'Pause' : 'Enable'}
                        </button>
                        <button onClick={() => handleDeleteSchedule(s.id)} className="report-error-text" style={{ display: 'inline-flex', alignItems: 'center', padding: 0, lineHeight: 1.2, background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.8rem', whiteSpace: 'nowrap' }}>
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>

            </table>
          </div>
        </div>
      )}

      {/* Schedule Modal */}
      {showScheduleModal && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'var(--overlay-bg)', backdropFilter: 'blur(5px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
          <div className="card" style={{ padding: '2rem', width: '480px' }}>
            <h3 style={{ marginBottom: '1.5rem', fontSize: '1.25rem', fontWeight: 'bold' }}>Schedule Email Report</h3>
            <form onSubmit={handleCreateSchedule} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div>
                <label style={labelStyle}>Report Name</label>
                <input type="text" className="input-field" placeholder="e.g. Weekly Sales Summary" required value={newSchedule.name} onChange={e => setNewSchedule({ ...newSchedule, name: e.target.value })} />
              </div>
              <div>
                <label style={labelStyle}>Report Type</label>
                <select className="input-field" value={newSchedule.reportType} onChange={e => setNewSchedule({ ...newSchedule, reportType: e.target.value })}>
                  <option value="deals">Deals Summary</option>
                  <option value="agent-performance">Agent Performance</option>
                  <option value="pipeline">Pipeline Overview</option>
                  <option value="tasks">Tasks Summary</option>
                  <option value="contacts">Contacts Summary</option>
                </select>
              </div>
              <div>
                <label style={labelStyle}>Frequency</label>
                <select className="input-field" value={newSchedule.frequency} onChange={e => setNewSchedule({ ...newSchedule, frequency: e.target.value })}>
                  <option value="daily">Daily (8am)</option>
                  <option value="weekly">Weekly (Monday 8am)</option>
                  <option value="monthly">Monthly (1st of month)</option>
                </select>
              </div>
              <div>
                <label style={labelStyle}>Format</label>
                <select className="input-field" value={newSchedule.format} onChange={e => setNewSchedule({ ...newSchedule, format: e.target.value })}>
                  <option value="PDF">PDF</option>
                  <option value="CSV">CSV</option>
                </select>
              </div>
              <div>
                <label style={labelStyle}>Recipients (comma-separated emails)</label>
                <input type="text" className="input-field" placeholder="admin@company.com, manager@company.com" required value={newSchedule.recipients} onChange={e => setNewSchedule({ ...newSchedule, recipients: e.target.value })} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '1rem', marginTop: '0.5rem' }}>
                <button type="button" onClick={() => setShowScheduleModal(false)} style={{ background: 'transparent', color: 'var(--text-secondary)', border: 'none', cursor: 'pointer' }}>Cancel</button>
                <button type="submit" className="btn-primary">Create Schedule</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

const thStyle = { padding: '0.875rem 1rem', color: 'var(--text-secondary)', fontWeight: '500', fontSize: '0.8rem' };
const tdStyle = { padding: '0.875rem 1rem' };
// #602: numeric / currency / date cells must not wrap mid-number ("₹1,2\n34,567"
// breaks copy-paste + CSV alignment). tabular-nums also keeps digit columns
// vertically aligned across rows. min-width ensures a typical 7-digit currency
// rendered with thousand separators (e.g. "₹12,34,567") always fits on one line.
const numericTdStyle = { ...tdStyle, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums', minWidth: '7.5rem' };
const numericThStyle = { ...thStyle, whiteSpace: 'nowrap' };
const labelStyle = { display: 'block', marginBottom: '0.4rem', fontSize: '0.85rem', color: 'var(--text-secondary)', fontWeight: '500' };

// #627: locale-aware date formatter — was hardcoded en-US.
function fmtDate(d) {
  return formatDateMedium(d);
}

function StageBadge({ stage }) {
  // Pre-refactor used a stage→hex map with inline RGBA fills; refactored to
  // a `.report-pill report-pill--<variant>` class pair so the wellness/travel
  // dark-mode theme can override the foreground+background tokens. Unknown
  // stages fall through to `.report-pill--neutral`. See #873.
  const variants = { won: 'success', lost: 'danger', lead: 'info', contacted: 'warning', proposal: 'accent' };
  const variant = variants[stage] || 'neutral';
  return <span className={`report-pill report-pill--${variant}`}>{stage}</span>;
}

function StatusBadge({ status }) {
  // Pre-refactor used keyword bucketing → hex map; refactored to the same
  // `.report-pill` variants used by StageBadge so badge styling is single-
  // sourced. Status copy preserved verbatim (only the chrome flexes).
  const s = (status || '').toLowerCase();
  const variant = ['paid', 'completed', 'customer', 'active', 'approved', 'reimbursed'].some(x => s.includes(x)) ? 'success'
    : ['overdue', 'rejected', 'churned', 'lost', 'urgent'].some(x => s.includes(x)) ? 'danger'
      : ['pending', 'lead', 'draft', 'open'].some(x => s.includes(x)) ? 'warning' : 'info';
  return <span className={`report-pill report-pill--${variant}`}>{status}</span>;
}
