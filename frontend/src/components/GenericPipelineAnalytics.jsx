import { useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, Legend } from 'recharts';
import { formatMoney, formatMoneyCompact } from '../utils/money';
import './GenericPipelineAnalytics.css';

const VIEWS = [
  ['Stage value bars', 'Compare deal value across the current pipeline stages.'],
  ['Stage funnel', 'Current deal counts by stage — a snapshot, not historical conversion.'],
  ['Weighted pipeline', 'Total value compared with deal-probability-weighted value.'],
  ['Revenue momentum', 'Track revenue over time.'],
  ['Pipeline composition', 'How deal value is distributed across stages.'],
  ['Pipeline health', 'Identify aging and stalled deals.'],
];
const COLORS = ['#5596ff', '#9980ff', '#30cfb0', '#f0b958', '#ed7898', '#66becf'];

export default function GenericPipelineAnalytics({ stats }) {
  const [view, setView] = useState(0);
  const [title, description] = VIEWS[view];
  const data = (stats.byStage || []).map(row => ({
    name: String(row.stage || 'Other').replace(/_/g, ' '),
    value: Number(row.value) || 0,
    count: Number(row.count) || 0,
    weighted: Number.isFinite(Number(row.expectedValue)) ? Number(row.expectedValue) : null,
  }));
  const empty = !data.some(row => row.count > 0 || row.value > 0);
  const moneyOptions = stats.fx?.baseCurrency ? { currency: stats.fx.baseCurrency } : {};
  const tooltip = <Tooltip contentStyle={{ background: 'var(--surface-color, #fff)', borderColor: 'var(--border-color)', borderRadius: 8 }} formatter={value => formatMoney(value, moneyOptions)} />;
  const moneyChart = weighted => (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 12, right: 12, bottom: 12, left: 0 }}>
        <CartesianGrid stroke="var(--border-color)" strokeDasharray="4 6" vertical={false} />
        <XAxis dataKey="name" stroke="var(--text-secondary)" fontSize={12} />
        <YAxis tickFormatter={value => formatMoneyCompact(value, moneyOptions)} stroke="var(--text-secondary)" fontSize={12} />
        {tooltip}
        {weighted && <Legend />}
        <Bar dataKey="value" name="Total value" fill={weighted ? '#405878' : '#5596ff'} radius={[5, 5, 0, 0]} />
        {weighted && <Bar dataKey="weighted" name="Weighted value" fill="#5596ff" radius={[5, 5, 0, 0]} />}
      </BarChart>
    </ResponsiveContainer>
  );
  let content;
  if (stats.fx?.incomplete) {
    content = <div className="generic-pipeline-empty">Pipeline valuation unavailable until exchange rates are available for every deal currency.</div>;
  } else if (view === 3 || view === 5) {
    content = <div className="generic-pipeline-empty">{view === 3
      ? 'Revenue history is not available from the current analytics API. A time-series dataset is needed to show this view accurately.'
      : 'Stage-entry dates and aging aggregates are not available from the current analytics API. These are needed to identify stalled deals accurately.'}</div>;
  } else if (empty) {
    content = <div className="generic-pipeline-empty">No pipeline data yet. Create a deal to see your analytics.</div>;
  } else if (view === 0) {
    content = moneyChart(false);
  } else if (view === 1) {
    const max = Math.max(...data.map(row => row.count), 1);
    content = <div className="generic-pipeline-funnel">{data.map((row, index) => (
      <div className="generic-pipeline-funnel-row" key={row.name}>
        <span>{row.name}</span>
        <div><span style={{ width: `${row.count / max * 100}%`, background: COLORS[index % COLORS.length] }} /></div>
        <strong>{row.count}</strong>
      </div>
    ))}</div>;
  } else if (view === 2) {
    content = data.some(row => row.weighted === null)
      ? <div className="generic-pipeline-empty">Weighted stage values are not available yet.</div>
      : moneyChart(true);
  } else {
    content = data.some(row => row.value > 0) ? <ResponsiveContainer width="100%" height="100%">
      <PieChart><Pie data={data} dataKey="value" nameKey="name" innerRadius="50%" outerRadius="78%" paddingAngle={3}>
        {data.map((row, index) => <Cell key={row.name} fill={COLORS[index % COLORS.length]} />)}
      </Pie>{tooltip}<Legend /></PieChart>
    </ResponsiveContainer> : <div className="generic-pipeline-empty">No deal value to display yet.</div>;
  }
  return <section className="generic-pipeline-analytics" aria-label="Pipeline analytics views">
    <div className="generic-pipeline-heading" aria-live="polite" aria-atomic="true">
      <h4>{title}</h4><p>{description}</p>
    </div>
    <div className="generic-pipeline-canvas" role="group" aria-label={title}>{content}</div>
    <nav className="generic-pipeline-navigation" aria-label="Pipeline chart navigation">
      <button type="button" className="btn-secondary" disabled={view === 0} onClick={() => setView(value => value - 1)}>Previous</button>
      <span aria-live="polite">{view + 1} / {VIEWS.length}</span>
      <button type="button" className="btn-secondary" disabled={view === VIEWS.length - 1} onClick={() => setView(value => value + 1)}>Next</button>
    </nav>
  </section>;
}
