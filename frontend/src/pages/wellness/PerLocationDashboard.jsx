import React, { useEffect, useState } from 'react';
import { Building2, Calendar, IndianRupee, Activity, Users, UsersRound, Stethoscope } from 'lucide-react';
import { fetchApi } from '../../utils/api';

const formatRupees = (n) => `\u20B9${Math.round(n || 0).toLocaleString('en-IN')}`;

// One column = one location. Pulls /api/wellness/dashboard?locationId=X for
// most KPIs and /api/wellness/reports/pnl-by-service?locationId=X for top
// services. Designed to scroll horizontally on narrow screens.
export default function PerLocationDashboard() {
  const [locations, setLocations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [columns, setColumns] = useState([]); // [{ location, dashboard, topServices, staffCount, weekRevenue }]

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchApi('/api/wellness/locations')
      .then(async (locs) => {
        if (cancelled) return;
        const list = Array.isArray(locs) ? locs.filter((l) => l.isActive !== false) : [];
        setLocations(list);
        if (list.length < 2) {
          setColumns([]);
          setLoading(false);
          return;
        }

        // Fetch all per-location data in parallel.
        const results = await Promise.all(
          list.map(async (loc) => {
            const [dashboard, pnl, weekVisits] = await Promise.all([
              fetchApi(`/api/wellness/dashboard?locationId=${loc.id}`).catch(() => null),
              fetchApi(`/api/wellness/reports/pnl-by-service?locationId=${loc.id}`).catch(() => null),
              fetchApi(
                `/api/wellness/visits?from=${encodeURIComponent(weekStart().toISOString())}&limit=500`
              ).catch(() => []),
            ]);

            // Filter visits to this location for week revenue + staff count.
            const visitsAtLoc = Array.isArray(weekVisits)
              ? weekVisits.filter((v) => v.locationId === loc.id)
              : [];
            const weekRevenue = visitsAtLoc.reduce(
              (s, v) => s + (parseFloat(v.amountCharged) || 0), 0
            );
            const staffIds = new Set(
              visitsAtLoc.filter((v) => v.doctorId).map((v) => v.doctorId)
            );

            const topServices = (pnl?.rows || []).slice(0, 3);

            return {
              location: loc,
              dashboard,
              topServices,
              staffCount: staffIds.size,
              weekRevenue,
            };
          })
        );

        if (!cancelled) {
          setColumns(results);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLocations([]);
          setColumns([]);
          setLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return <div style={{ padding: '2rem' }}>Loading per-location comparison\u2026</div>;
  }

  if (locations.length < 2) {
    return (
      <div style={{ padding: '2rem', animation: 'fadeIn 0.5s ease-out' }}>
        <header style={{ marginBottom: '1.5rem' }}>
          <h1 style={{ fontFamily: 'var(--font-family)', fontSize: '1.75rem', fontWeight: 600 }}>
            Per-Location Dashboard
          </h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
            Side-by-side comparison of every clinic you operate.
          </p>
        </header>
        <div className="glass" style={{ padding: '2rem', textAlign: 'center' }}>
          <Building2 size={36} color="var(--accent-color)" style={{ marginBottom: '0.75rem' }} />
          <h3 style={{ fontSize: '1.1rem', fontWeight: 600, marginBottom: '0.5rem' }}>
            Add a second clinic to compare
          </h3>
          <p style={{ color: 'var(--text-secondary)', maxWidth: 480, margin: '0 auto' }}>
            You currently have {locations.length === 1 ? 'one location' : 'no locations'}.
            This screen lights up once you add another clinic in
            {' '}<span style={{ color: 'var(--accent-color)' }}>Admin &rarr; Locations</span>.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.5s ease-out' }}>
      <header style={{ marginBottom: '1.5rem' }}>
        <h1 style={{ fontFamily: 'var(--font-family)', fontSize: '1.75rem', fontWeight: 600 }}>
          Per-Location Dashboard
        </h1>
        <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
          Comparing {columns.length} clinics &mdash; today&rsquo;s ops + this week&rsquo;s revenue + this month&rsquo;s top services.
        </p>
      </header>

      <div style={{ overflowX: 'auto' }}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${columns.length}, minmax(260px, 1fr))`,
            gap: '1rem',
            minWidth: columns.length * 280,
          }}
        >
          {columns.map(({ location, dashboard, topServices, staffCount, weekRevenue }) => (
            <LocationColumn
              key={location.id}
              location={location}
              dashboard={dashboard}
              topServices={topServices}
              staffCount={staffCount}
              weekRevenue={weekRevenue}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function LocationColumn({ location, dashboard, topServices, staffCount, weekRevenue }) {
  const today = dashboard?.today || {};
  const totals = dashboard?.totals || {};
  return (
    <div className="glass" style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      {/* Header */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Building2 size={18} color="var(--accent-color)" />
          <h3 style={{ fontSize: '1.05rem', fontWeight: 600, margin: 0 }}>{location.name}</h3>
        </div>
        <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: '0.2rem' }}>
          {location.city}{location.state ? `, ${location.state}` : ''}
        </div>
      </div>

      {/* Today */}
      <Section title="Today">
        <Row icon={Calendar} label="Visits" value={today.visits ?? 0} />
        <Row icon={Activity} label="Completed" value={today.completed ?? 0} />
        <Row
          icon={Activity}
          label="Occupancy"
          value={`${today.occupancyPct ?? 0}%`}
          accent={(today.occupancyPct ?? 0) >= 60 ? 'var(--success-color)' : 'var(--warning-color)'}
        />
      </Section>

      {/* This week */}
      <Section title="This week">
        <Row icon={IndianRupee} label="Revenue" value={formatRupees(weekRevenue)} accent="var(--success-color)" />
      </Section>

      {/* People */}
      <Section title="People">
        <Row icon={Users} label="Active patients" value={totals.patients ?? 0} />
        <Row icon={UsersRound} label="Staff (this week)" value={staffCount} />
      </Section>

      {/* Top 3 services this month */}
      <Section title="Top services (last 30 days)">
        {topServices.length === 0 ? (
          <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>No completed visits yet.</div>
        ) : (
          topServices.map((s, idx) => (
            <div
              key={s.id}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '0.4rem 0',
                borderBottom: idx < topServices.length - 1 ? '1px solid rgba(255,255,255,0.05)' : 'none',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', minWidth: 0 }}>
                <Stethoscope size={14} color="var(--accent-color)" style={{ flexShrink: 0 }} />
                <span style={{ fontSize: '0.85rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {s.name}
                </span>
              </div>
              <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>{formatRupees(s.revenue)}</span>
            </div>
          ))
        )}
      </Section>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div>
      <div
        style={{
          fontSize: '0.65rem',
          fontWeight: 600,
          color: 'var(--text-secondary)',
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          marginBottom: '0.4rem',
        }}
      >
        {title}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>{children}</div>
    </div>
  );
}

function Row({ icon: Icon, label, value, accent }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
        <Icon size={14} color={accent || 'var(--text-secondary)'} /> {label}
      </span>
      <span style={{ fontSize: '0.95rem', fontWeight: 600, color: accent || 'var(--text-primary)' }}>{value}</span>
    </div>
  );
}

function weekStart() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - 7);
  return d;
}
