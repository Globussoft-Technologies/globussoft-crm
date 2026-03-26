import React from 'react';
export default function Dashboard() {
  return (<div style={{padding: '2rem'}}>
    <h1>Enterprise CRM Overview</h1>
    <div className='glass' style={{marginTop: '2rem', padding: '2rem', display: 'flex', gap: '2rem'}}>
      <div style={{flex: 1, height: '150px', border: '1px solid var(--border-color)', borderRadius: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center'}}>Revenue Chart (Chart.js Stub)</div>
      <div style={{flex: 1, height: '150px', border: '1px solid var(--border-color)', borderRadius: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center'}}>Lead Velocity Graph</div>
    </div>
  </div>);
}