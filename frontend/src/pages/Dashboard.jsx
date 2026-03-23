import React, { useContext } from 'react';
import { AuthContext } from '../App';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar } from 'recharts';

const revenueData = [
  { month: 'Jan', revenue: 4000 },
  { month: 'Feb', revenue: 7000 },
  { month: 'Mar', revenue: 5500 },
  { month: 'Apr', revenue: 9000 },
  { month: 'May', revenue: 12500 },
  { month: 'Jun', revenue: 15000 },
];

const leadsData = [
  { name: 'Organic', value: 400 },
  { name: 'Referral', value: 300 },
  { name: 'Social', value: 300 },
  { name: 'Email', value: 200 },
];

const Dashboard = () => {
  const { user, setUser } = useContext(AuthContext);

  const handleLogout = () => {
    setUser(null);
  };

  return (
    <div style={{ padding: '2rem' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
        <div>
          <h2 style={{ fontSize: '1.5rem', fontWeight: 'bold' }}>Dashboard</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>Welcome back to Globussoft CRM</p>
        </div>
        <div>
          <span style={{ marginRight: '1rem', color: 'var(--text-secondary)' }}>{user?.email}</span>
          <button onClick={handleLogout} className="btn-primary" style={{ backgroundColor: 'transparent', border: '1px solid var(--border-color)', color: 'var(--text-primary)' }}>
            Logout
          </button>
        </div>
      </header>
      
      {/* KPI Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: '1.5rem', marginBottom: '2rem' }}>
        <div className="card glass" style={{ padding: '1.5rem' }}>
          <h3 style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', marginBottom: '0.5rem' }}>Active Deals</h3>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '1rem' }}>
            <p style={{ fontSize: '2rem', fontWeight: 'bold' }}>24</p>
            <span style={{ color: 'var(--success-color)', fontSize: '0.875rem' }}>+12%</span>
          </div>
        </div>
        <div className="card glass" style={{ padding: '1.5rem' }}>
          <h3 style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', marginBottom: '0.5rem' }}>Revenue YTD</h3>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '1rem' }}>
            <p style={{ fontSize: '2rem', fontWeight: 'bold' }}>$142,500</p>
            <span style={{ color: 'var(--success-color)', fontSize: '0.875rem' }}>+24%</span>
          </div>
        </div>
        <div className="card glass" style={{ padding: '1.5rem' }}>
          <h3 style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', marginBottom: '0.5rem' }}>New Leads</h3>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '1rem' }}>
            <p style={{ fontSize: '2rem', fontWeight: 'bold' }}>184</p>
            <span style={{ color: 'var(--danger-color)', fontSize: '0.875rem' }}>-5%</span>
          </div>
        </div>
      </div>

      {/* Charts Section */}
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '1.5rem' }}>
        
        {/* Revenue Chart */}
        <div className="card glass" style={{ padding: '1.5rem', height: '400px' }}>
          <h3 style={{ marginBottom: '1.5rem', fontWeight: '500' }}>Revenue Growth</h3>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={revenueData} margin={{ top: 10, right: 10, left: 0, bottom: 20 }}>
              <defs>
                <linearGradient id="colorRevenue" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--accent-color)" stopOpacity={0.4}/>
                  <stop offset="95%" stopColor="var(--accent-color)" stopOpacity={0}/>
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" vertical={false} />
              <XAxis dataKey="month" stroke="var(--text-secondary)" fontSize={12} tickLine={false} axisLine={false} />
              <YAxis stroke="var(--text-secondary)" fontSize={12} tickLine={false} axisLine={false} tickFormatter={(value) => `$${value/1000}k`} />
              <Tooltip 
                contentStyle={{ backgroundColor: 'var(--surface-color)', border: '1px solid var(--border-color)', borderRadius: '8px' }}
                itemStyle={{ color: 'var(--text-primary)' }}
              />
              <Area type="monotone" dataKey="revenue" stroke="var(--accent-color)" strokeWidth={3} fillOpacity={1} fill="url(#colorRevenue)" />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        {/* Lead Sources Chart */}
        <div className="card glass" style={{ padding: '1.5rem', height: '400px' }}>
          <h3 style={{ marginBottom: '1.5rem', fontWeight: '500' }}>Lead Sources</h3>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={leadsData} layout="vertical" margin={{ top: 0, right: 20, left: 0, bottom: 20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" horizontal={false} />
              <XAxis type="number" stroke="var(--text-secondary)" fontSize={12} tickLine={false} axisLine={false} />
              <YAxis dataKey="name" type="category" stroke="var(--text-secondary)" fontSize={12} tickLine={false} axisLine={false} width={70} />
              <Tooltip 
                contentStyle={{ backgroundColor: 'var(--surface-color)', border: '1px solid var(--border-color)', borderRadius: '8px' }}
                itemStyle={{ color: 'var(--text-primary)' }}
                cursor={{ fill: 'rgba(255,255,255,0.05)' }}
              />
              <Bar dataKey="value" fill="var(--warning-color)" radius={[0, 4, 4, 0]} barSize={24} />
            </BarChart>
          </ResponsiveContainer>
        </div>

      </div>
    </div>
  );
};

export default Dashboard;
