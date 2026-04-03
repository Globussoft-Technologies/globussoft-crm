import React from 'react';
import { Link } from 'react-router-dom';
import { Users, BarChart3, FileText, Mail, Brain, GripVertical, CheckCircle2, ArrowRight, ChevronRight, Shield, Zap, Globe } from 'lucide-react';

const FEATURES = [
  { icon: <Users size={26} />, title: 'Agent Assignment', desc: 'Assign sales agents to leads and contacts with one click. Bulk-assign multiple leads. Round-robin distribution.', gradient: 'linear-gradient(135deg, #3b82f6, #8b5cf6)', highlight: true },
  { icon: <BarChart3 size={26} />, title: 'Agent-wise Reports', desc: 'Performance leaderboard ranking agents by revenue, deals won, win rate, tasks, calls, and emails.', gradient: 'linear-gradient(135deg, #f59e0b, #ef4444)' },
  { icon: <FileText size={26} />, title: 'Detailed Reports + Download', desc: '8 metric types, date range filters, chart + table views. Export any report as PDF or CSV.', gradient: 'linear-gradient(135deg, #10b981, #059669)' },
  { icon: <Mail size={26} />, title: 'Auto Email Reports', desc: 'Schedule daily, weekly, or monthly reports delivered via email as PDF or CSV to any recipient.', gradient: 'linear-gradient(135deg, #ec4899, #8b5cf6)' },
  { icon: <Brain size={26} />, title: 'AI Lead Scoring', desc: 'ML engine scores every contact 1-100 based on engagement, company profile, and deal history.', gradient: 'linear-gradient(135deg, #6366f1, #3b82f6)' },
  { icon: <GripVertical size={26} />, title: 'Drag-Drop Pipeline', desc: 'Kanban board with real-time Socket.io sync. All connected users see changes instantly.', gradient: 'linear-gradient(135deg, #14b8a6, #10b981)' },
];

const MODULES = [
  'Dashboard', 'Pipeline (Kanban)', 'Contacts 360', 'Leads', 'Clients', 'Agent Reports',
  'BI Analytics', 'Auto Email Reports', 'AI Lead Scoring', 'Sequences', 'Workflows', 'Inbox',
  'Marketing', 'Invoices', 'Estimates', 'Expenses', 'Contracts', 'CPQ Builder', 'Projects',
  'Task Queue', 'Tickets', 'Support', 'App Builder', 'Developer Portal', 'Staff / RBAC',
  'Notifications', 'Audit Log', 'CSV Import', 'Softphone', 'Command Palette',
];

const SCREENSHOTS = [
  { src: '/screenshots/feature-dashboard.png', label: 'Executive Dashboard' },
  { src: '/screenshots/feature-agent-reports.png', label: 'Agent Performance Reports' },
  { src: '/screenshots/feature-reports-charts.png', label: 'Reports & Analytics' },
  { src: '/screenshots/feature-reports-detailed.png', label: 'Detailed Data Tables' },
  { src: '/screenshots/feature-agent-assignment-leads.png', label: 'Agent Assignment' },
  { src: '/screenshots/feature-auto-email-schedule.png', label: 'Schedule Email Reports' },
];

export default function Landing() {
  return (
    <div style={{ background: '#06070b', color: '#f0f0f5', fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif", overflowX: 'hidden' }}>
      {/* Navbar */}
      <nav style={{ position: 'fixed', top: 0, left: 0, right: 0, zIndex: 100, background: 'rgba(6,7,11,0.85)', backdropFilter: 'blur(20px)', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
        <div style={{ maxWidth: 1200, margin: '0 auto', padding: '0 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: 64 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: '1.2rem' }}>
            <div style={{ width: 28, height: 28, borderRadius: 8, background: 'linear-gradient(135deg, #3b82f6, #8b5cf6)', boxShadow: '0 0 12px rgba(59,130,246,0.35)' }} />
            <span>Globus <strong style={{ color: '#3b82f6' }}>CRM</strong></span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 28 }}>
            <a href="#features" style={{ fontSize: '0.9rem', color: '#9ca3af', textDecoration: 'none' }}>Features</a>
            <a href="#screenshots" style={{ fontSize: '0.9rem', color: '#9ca3af', textDecoration: 'none' }}>Screenshots</a>
            <Link to="/pricing" style={{ fontSize: '0.9rem', color: '#9ca3af', textDecoration: 'none' }}>Pricing</Link>
            <Link to="/login" style={{ fontSize: '0.9rem', color: '#9ca3af', textDecoration: 'none' }}>Login</Link>
            <Link to="/signup" className="btn-primary" style={{ padding: '8px 20px', fontSize: '0.85rem', borderRadius: 10, textDecoration: 'none' }}>Get Started Free</Link>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section style={{ position: 'relative', padding: '160px 0 80px', textAlign: 'center', overflow: 'hidden' }}>
        <div style={{ position: 'absolute', width: 600, height: 600, top: -200, left: -100, background: 'rgba(59,130,246,0.15)', borderRadius: '50%', filter: 'blur(120px)', pointerEvents: 'none' }} />
        <div style={{ position: 'absolute', width: 500, height: 500, top: -100, right: -150, background: 'rgba(139,92,246,0.12)', borderRadius: '50%', filter: 'blur(120px)', pointerEvents: 'none' }} />
        <div style={{ position: 'relative', zIndex: 1, maxWidth: 1200, margin: '0 auto', padding: '0 24px' }}>
          <div style={{ display: 'inline-block', padding: '6px 16px', borderRadius: 50, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)', fontSize: '0.8rem', color: '#3b82f6', fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', marginBottom: 24 }}>
            Enterprise-Grade CRM Platform
          </div>
          <h1 style={{ fontSize: 'clamp(2.5rem, 5.5vw, 4.2rem)', fontWeight: 800, lineHeight: 1.15, marginBottom: 24, letterSpacing: '-0.02em' }}>
            Close more deals.<br />Know every customer.<br />
            <span style={{ background: 'linear-gradient(135deg, #3b82f6, #8b5cf6, #ec4899)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>Powered by AI.</span>
          </h1>
          <p style={{ maxWidth: 680, margin: '0 auto 40px', fontSize: '1.15rem', color: '#9ca3af', lineHeight: 1.7 }}>
            Globus CRM gives your sales team a 360-degree view of every lead, deal, and customer — with AI scoring, automated reports, and real-time pipeline analytics across 25+ integrated modules.
          </p>
          <div style={{ display: 'flex', gap: 16, justifyContent: 'center', marginBottom: 60, flexWrap: 'wrap' }}>
            <Link to="/signup" className="btn-primary" style={{ padding: '16px 36px', fontSize: '1.05rem', borderRadius: 10, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              Start Free Trial <ArrowRight size={18} />
            </Link>
            <a href="#features" style={{ padding: '16px 36px', fontSize: '1.05rem', borderRadius: 10, border: '1px solid rgba(255,255,255,0.08)', color: '#f0f0f5', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              Explore Features
            </a>
          </div>
          <div style={{ display: 'flex', justifyContent: 'center', gap: 48, flexWrap: 'wrap' }}>
            {[['25+', 'Modules'], ['313', 'E2E Tests'], ['30+', 'API Endpoints'], ['100%', 'Pass Rate']].map(([num, label]) => (
              <div key={label} style={{ textAlign: 'center' }}>
                <div style={{ fontSize: '2rem', fontWeight: 800 }}>{num}</div>
                <div style={{ fontSize: '0.8rem', color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{label}</div>
              </div>
            ))}
          </div>
        </div>
        <div style={{ position: 'relative', maxWidth: 1100, margin: '60px auto 0', padding: '0 24px' }}>
          <div style={{ position: 'absolute', inset: 20, borderRadius: 20, background: 'linear-gradient(135deg, #3b82f6, #8b5cf6)', opacity: 0.15, filter: 'blur(40px)' }} />
          <img src="/screenshots/feature-dashboard.png" alt="Globus CRM Dashboard" style={{ position: 'relative', borderRadius: 16, border: '1px solid rgba(255,255,255,0.08)', boxShadow: '0 20px 80px rgba(0,0,0,0.6)', width: '100%' }} />
        </div>
      </section>

      {/* Features */}
      <section id="features" style={{ padding: '100px 0' }}>
        <div style={{ maxWidth: 1200, margin: '0 auto', padding: '0 24px' }}>
          <div style={{ textAlign: 'center', maxWidth: 640, margin: '0 auto 60px' }}>
            <div style={{ display: 'inline-block', padding: '5px 14px', borderRadius: 50, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)', fontSize: '0.75rem', color: '#3b82f6', fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', marginBottom: 16 }}>Core Capabilities</div>
            <h2 style={{ fontSize: 'clamp(1.8rem, 3.5vw, 2.8rem)', fontWeight: 800, marginBottom: 16 }}>Everything your sales team needs</h2>
            <p style={{ color: '#9ca3af', fontSize: '1.1rem' }}>From first contact to closed deal — Globus CRM covers the entire customer lifecycle.</p>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 24 }}>
            {FEATURES.map((f, i) => (
              <div key={i} style={{ background: f.highlight ? 'linear-gradient(135deg, rgba(59,130,246,0.08), rgba(139,92,246,0.06))' : 'rgba(255,255,255,0.04)', border: `1px solid ${f.highlight ? 'rgba(59,130,246,0.2)' : 'rgba(255,255,255,0.08)'}`, borderRadius: 16, padding: 32, transition: 'all 0.3s ease' }}>
                <div style={{ width: 52, height: 52, borderRadius: 14, background: f.gradient, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 20, color: '#fff' }}>{f.icon}</div>
                <h3 style={{ fontSize: '1.2rem', fontWeight: 700, marginBottom: 10 }}>{f.title}</h3>
                <p style={{ color: '#9ca3af', fontSize: '0.92rem', lineHeight: 1.6 }}>{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Screenshots */}
      <section id="screenshots" style={{ padding: '100px 0', background: '#0c0e14' }}>
        <div style={{ maxWidth: 1200, margin: '0 auto', padding: '0 24px' }}>
          <div style={{ textAlign: 'center', maxWidth: 640, margin: '0 auto 60px' }}>
            <div style={{ display: 'inline-block', padding: '5px 14px', borderRadius: 50, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)', fontSize: '0.75rem', color: '#3b82f6', fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', marginBottom: 16 }}>Product Tour</div>
            <h2 style={{ fontSize: 'clamp(1.8rem, 3.5vw, 2.8rem)', fontWeight: 800, marginBottom: 16 }}>See it in action</h2>
            <p style={{ color: '#9ca3af', fontSize: '1.1rem' }}>Every screen is production-ready with glassmorphism design and dark/light theme.</p>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(400px, 1fr))', gap: 24 }}>
            {SCREENSHOTS.map((s, i) => (
              <div key={i} style={{ borderRadius: 16, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.08)', background: 'rgba(255,255,255,0.04)', position: 'relative' }}>
                <img src={s.src} alt={s.label} style={{ width: '100%', display: 'block' }} loading="lazy" />
                <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, background: 'linear-gradient(transparent, rgba(0,0,0,0.85))', padding: '40px 20px 16px', fontWeight: 600, fontSize: '0.9rem' }}>{s.label}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Modules */}
      <section style={{ padding: '100px 0' }}>
        <div style={{ maxWidth: 1200, margin: '0 auto', padding: '0 24px' }}>
          <div style={{ textAlign: 'center', margin: '0 auto 60px' }}>
            <h2 style={{ fontSize: 'clamp(1.8rem, 3.5vw, 2.8rem)', fontWeight: 800, marginBottom: 16 }}>25+ Integrated Modules</h2>
            <p style={{ color: '#9ca3af', fontSize: '1.1rem' }}>One platform. Every department. No silos.</p>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, justifyContent: 'center' }}>
            {MODULES.map(m => (
              <span key={m} style={{ padding: '10px 20px', borderRadius: 50, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', fontSize: '0.88rem', fontWeight: 500, color: '#9ca3af' }}>{m}</span>
            ))}
          </div>
        </div>
      </section>

      {/* Trust / Tech */}
      <section style={{ padding: '80px 0', background: '#0c0e14' }}>
        <div style={{ maxWidth: 1200, margin: '0 auto', padding: '0 24px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 24 }}>
            {[
              { icon: <Shield size={24} />, title: 'Enterprise Security', desc: 'JWT auth, bcrypt hashing, RBAC roles, rate limiting, CORS protection' },
              { icon: <Zap size={24} />, title: 'Real-time Sync', desc: 'Socket.io live collaboration with presence cursors and instant deal updates' },
              { icon: <Globe size={24} />, title: 'REST API + Swagger', desc: '30+ documented endpoints, API key provisioning, webhook streams' },
              { icon: <CheckCircle2 size={24} />, title: '313 E2E Tests', desc: '100% pass rate. 10 deep workflow verifications. Production-validated.' },
            ].map((t, i) => (
              <div key={i} style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 16, padding: 28, textAlign: 'center' }}>
                <div style={{ color: '#3b82f6', marginBottom: 12 }}>{t.icon}</div>
                <h4 style={{ fontSize: '1rem', fontWeight: 700, marginBottom: 8 }}>{t.title}</h4>
                <p style={{ fontSize: '0.85rem', color: '#9ca3af', lineHeight: 1.6 }}>{t.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section style={{ padding: '100px 0', textAlign: 'center', background: 'linear-gradient(180deg, #06070b, rgba(59,130,246,0.06), #06070b)' }}>
        <div style={{ maxWidth: 1200, margin: '0 auto', padding: '0 24px' }}>
          <h2 style={{ fontSize: 'clamp(1.8rem, 3.5vw, 2.8rem)', fontWeight: 800, marginBottom: 16 }}>Ready to transform your sales process?</h2>
          <p style={{ color: '#9ca3af', fontSize: '1.1rem', marginBottom: 32 }}>Start your free trial today. No credit card required.</p>
          <div style={{ display: 'flex', gap: 16, justifyContent: 'center', flexWrap: 'wrap' }}>
            <Link to="/signup" className="btn-primary" style={{ padding: '16px 36px', fontSize: '1.05rem', borderRadius: 10, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              Get Started Free <ArrowRight size={18} />
            </Link>
            <Link to="/pricing" style={{ padding: '16px 36px', fontSize: '1.05rem', borderRadius: 10, border: '1px solid rgba(255,255,255,0.08)', color: '#f0f0f5', textDecoration: 'none' }}>
              View Pricing
            </Link>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer style={{ padding: '60px 0 40px', borderTop: '1px solid rgba(255,255,255,0.08)' }}>
        <div style={{ maxWidth: 1200, margin: '0 auto', padding: '0 24px', display: 'flex', flexWrap: 'wrap', gap: 48 }}>
          <div style={{ flex: 1, minWidth: 250 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: '1.2rem', marginBottom: 12 }}>
              <div style={{ width: 28, height: 28, borderRadius: 8, background: 'linear-gradient(135deg, #3b82f6, #8b5cf6)' }} />
              <span>Globus <strong style={{ color: '#3b82f6' }}>CRM</strong></span>
            </div>
            <p style={{ color: '#9ca3af', fontSize: '0.88rem', maxWidth: 300 }}>Enterprise sales intelligence platform built by Globussoft Technologies.</p>
          </div>
          <div style={{ display: 'flex', gap: 64 }}>
            <div>
              <h4 style={{ fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: '#9ca3af', marginBottom: 16 }}>Product</h4>
              <a href="#features" style={{ display: 'block', fontSize: '0.88rem', color: '#9ca3af', marginBottom: 10, textDecoration: 'none' }}>Features</a>
              <a href="#screenshots" style={{ display: 'block', fontSize: '0.88rem', color: '#9ca3af', marginBottom: 10, textDecoration: 'none' }}>Screenshots</a>
              <Link to="/pricing" style={{ display: 'block', fontSize: '0.88rem', color: '#9ca3af', marginBottom: 10, textDecoration: 'none' }}>Pricing</Link>
            </div>
            <div>
              <h4 style={{ fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: '#9ca3af', marginBottom: 16 }}>Account</h4>
              <Link to="/login" style={{ display: 'block', fontSize: '0.88rem', color: '#9ca3af', marginBottom: 10, textDecoration: 'none' }}>Login</Link>
              <Link to="/signup" style={{ display: 'block', fontSize: '0.88rem', color: '#9ca3af', marginBottom: 10, textDecoration: 'none' }}>Sign Up</Link>
              <Link to="/portal" style={{ display: 'block', fontSize: '0.88rem', color: '#9ca3af', marginBottom: 10, textDecoration: 'none' }}>Support Portal</Link>
            </div>
          </div>
        </div>
        <div style={{ maxWidth: 1200, margin: '48px auto 0', padding: '24px 24px 0', borderTop: '1px solid rgba(255,255,255,0.08)', textAlign: 'center', fontSize: '0.8rem', color: '#9ca3af' }}>
          &copy; 2026 Globussoft Technologies. All rights reserved.
        </div>
      </footer>
    </div>
  );
}
