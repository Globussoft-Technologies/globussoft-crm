import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, ArrowRight, X } from 'lucide-react';

const PLANS = [
  {
    name: 'Starter',
    desc: 'For small teams getting started with CRM',
    priceMonthly: 29,
    priceYearly: 24,
    features: [
      'Up to 5 users',
      '1,000 contacts',
      'Pipeline management',
      'Lead & contact management',
      'Task queue',
      'Email inbox',
      'Basic reports',
      'CSV import',
    ],
    notIncluded: ['AI lead scoring', 'Agent reports', 'Auto email reports', 'Custom objects', 'API access', 'Sequences & workflows'],
    cta: 'Start Free Trial',
    popular: false,
  },
  {
    name: 'Professional',
    desc: 'For growing sales teams that need analytics',
    priceMonthly: 79,
    priceYearly: 66,
    features: [
      'Up to 25 users',
      '25,000 contacts',
      'Everything in Starter',
      'AI lead scoring',
      'Agent assignment & reports',
      'Detailed reports with PDF/CSV export',
      'Auto email reports (weekly)',
      'Sequences & workflows',
      'Invoices & estimates',
      'Expense tracking',
      'Contract management',
      'Project management',
    ],
    notIncluded: ['Custom objects', 'API access & webhooks', 'Softphone integration'],
    cta: 'Start Free Trial',
    popular: true,
  },
  {
    name: 'Enterprise',
    desc: 'For large organizations with custom needs',
    priceMonthly: 149,
    priceYearly: 124,
    features: [
      'Unlimited users',
      'Unlimited contacts',
      'Everything in Professional',
      'Custom objects (App Builder)',
      'Developer portal (API keys & webhooks)',
      'Auto email reports (daily/weekly/monthly)',
      'Softphone (Twilio VoIP)',
      'Real-time presence & collaboration',
      'Audit log',
      'RBAC role management',
      'Priority support',
      'Custom integrations',
    ],
    notIncluded: [],
    cta: 'Contact Sales',
    popular: false,
  },
];

export default function Pricing() {
  const [annual, setAnnual] = useState(true);

  return (
    <div style={{ background: '#06070b', color: '#f0f0f5', fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif", minHeight: '100vh' }}>
      {/* Navbar */}
      <nav style={{ position: 'fixed', top: 0, left: 0, right: 0, zIndex: 100, background: 'rgba(6,7,11,0.85)', backdropFilter: 'blur(20px)', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
        <div style={{ maxWidth: 1200, margin: '0 auto', padding: '0 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: 64 }}>
          <Link to="/" style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: '1.2rem', textDecoration: 'none', color: '#f0f0f5' }}>
            <div style={{ width: 28, height: 28, borderRadius: 8, background: 'linear-gradient(135deg, #3b82f6, #8b5cf6)', boxShadow: '0 0 12px rgba(59,130,246,0.35)' }} />
            <span>Globus <strong style={{ color: '#3b82f6' }}>CRM</strong></span>
          </Link>
          <div style={{ display: 'flex', alignItems: 'center', gap: 28 }}>
            <Link to="/" style={{ fontSize: '0.9rem', color: '#9ca3af', textDecoration: 'none' }}>Home</Link>
            <Link to="/login" style={{ fontSize: '0.9rem', color: '#9ca3af', textDecoration: 'none' }}>Login</Link>
            <Link to="/signup" className="btn-primary" style={{ padding: '8px 20px', fontSize: '0.85rem', borderRadius: 10, textDecoration: 'none' }}>Get Started</Link>
          </div>
        </div>
      </nav>

      {/* Header */}
      <section style={{ padding: '140px 0 60px', textAlign: 'center', position: 'relative', overflow: 'hidden' }}>
        <div style={{ position: 'absolute', width: 500, height: 500, top: -150, left: '50%', transform: 'translateX(-50%)', background: 'rgba(59,130,246,0.1)', borderRadius: '50%', filter: 'blur(120px)', pointerEvents: 'none' }} />
        <div style={{ position: 'relative', zIndex: 1, maxWidth: 700, margin: '0 auto', padding: '0 24px' }}>
          <h1 style={{ fontSize: 'clamp(2rem, 4vw, 3.2rem)', fontWeight: 800, marginBottom: 16, letterSpacing: '-0.02em' }}>
            Simple, transparent pricing
          </h1>
          <p style={{ color: '#9ca3af', fontSize: '1.15rem', marginBottom: 32 }}>
            Start free for 14 days. No credit card required. Scale as you grow.
          </p>
          {/* Toggle */}
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 12, padding: '4px', background: 'rgba(255,255,255,0.06)', borderRadius: 50, border: '1px solid rgba(255,255,255,0.08)' }}>
            <button onClick={() => setAnnual(false)} style={{ padding: '8px 20px', borderRadius: 50, border: 'none', cursor: 'pointer', fontSize: '0.88rem', fontWeight: 600, fontFamily: 'inherit', background: !annual ? '#3b82f6' : 'transparent', color: !annual ? '#fff' : '#9ca3af', transition: 'all 0.2s' }}>Monthly</button>
            <button onClick={() => setAnnual(true)} style={{ padding: '8px 20px', borderRadius: 50, border: 'none', cursor: 'pointer', fontSize: '0.88rem', fontWeight: 600, fontFamily: 'inherit', background: annual ? '#3b82f6' : 'transparent', color: annual ? '#fff' : '#9ca3af', transition: 'all 0.2s' }}>
              Yearly <span style={{ fontSize: '0.75rem', marginLeft: 4, color: annual ? '#bbf7d0' : '#9ca3af' }}>Save 20%</span>
            </button>
          </div>
        </div>
      </section>

      {/* Plans */}
      <section style={{ padding: '0 0 100px' }}>
        <div style={{ maxWidth: 1200, margin: '0 auto', padding: '0 24px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 24, alignItems: 'start' }}>
          {PLANS.map((plan) => (
            <div key={plan.name} style={{
              background: plan.popular ? 'linear-gradient(135deg, rgba(59,130,246,0.1), rgba(139,92,246,0.08))' : 'rgba(255,255,255,0.04)',
              border: `1px solid ${plan.popular ? 'rgba(59,130,246,0.3)' : 'rgba(255,255,255,0.08)'}`,
              borderRadius: 20, padding: 36, position: 'relative',
              boxShadow: plan.popular ? '0 8px 40px rgba(59,130,246,0.1)' : 'none',
            }}>
              {plan.popular && (
                <div style={{ position: 'absolute', top: -12, left: '50%', transform: 'translateX(-50%)', padding: '4px 16px', borderRadius: 50, background: 'linear-gradient(135deg, #3b82f6, #8b5cf6)', fontSize: '0.75rem', fontWeight: 700, color: '#fff', letterSpacing: '0.05em' }}>
                  MOST POPULAR
                </div>
              )}
              <h3 style={{ fontSize: '1.4rem', fontWeight: 700, marginBottom: 4 }}>{plan.name}</h3>
              <p style={{ color: '#9ca3af', fontSize: '0.88rem', marginBottom: 24 }}>{plan.desc}</p>
              <div style={{ marginBottom: 24 }}>
                <span style={{ fontSize: '3rem', fontWeight: 800 }}>${annual ? plan.priceYearly : plan.priceMonthly}</span>
                <span style={{ color: '#9ca3af', fontSize: '0.9rem' }}>/user/month</span>
              </div>
              <Link to="/signup" className="btn-primary" style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                width: '100%', padding: '14px 0', borderRadius: 12, textDecoration: 'none',
                fontSize: '0.95rem', fontWeight: 600,
                background: plan.popular ? 'linear-gradient(135deg, #3b82f6, #2563eb)' : 'rgba(255,255,255,0.08)',
                color: '#fff', border: 'none',
                boxShadow: plan.popular ? '0 4px 20px rgba(59,130,246,0.35)' : 'none',
              }}>
                {plan.cta} <ArrowRight size={16} />
              </Link>
              <div style={{ marginTop: 28 }}>
                {plan.features.map(f => (
                  <div key={f} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 12 }}>
                    <Check size={16} style={{ color: '#10b981', marginTop: 2, flexShrink: 0 }} />
                    <span style={{ fontSize: '0.88rem', color: '#d1d5db' }}>{f}</span>
                  </div>
                ))}
                {plan.notIncluded.map(f => (
                  <div key={f} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 12, opacity: 0.4 }}>
                    <X size={16} style={{ color: '#9ca3af', marginTop: 2, flexShrink: 0 }} />
                    <span style={{ fontSize: '0.88rem', color: '#9ca3af' }}>{f}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* FAQ */}
      <section style={{ padding: '80px 0', background: '#0c0e14' }}>
        <div style={{ maxWidth: 700, margin: '0 auto', padding: '0 24px' }}>
          <h2 style={{ fontSize: '2rem', fontWeight: 800, textAlign: 'center', marginBottom: 48 }}>Frequently Asked Questions</h2>
          {[
            ['Is there a free trial?', 'Yes, all plans include a 14-day free trial. No credit card required. You get full access to all features in your chosen plan.'],
            ['Can I switch plans later?', 'Absolutely. You can upgrade or downgrade at any time. Changes take effect on your next billing cycle with prorated adjustments.'],
            ['What payment methods do you accept?', 'We accept all major credit cards, wire transfers for Enterprise plans, and can invoice quarterly or annually.'],
            ['Is my data secure?', 'Yes. We use JWT authentication, bcrypt password hashing, role-based access control, rate limiting, and SSL encryption. Your data is stored in encrypted MySQL databases.'],
            ['Do you offer custom integrations?', 'Enterprise plans include access to our Developer Portal with API keys and webhook streams. Our team can also build custom integrations on request.'],
          ].map(([q, a]) => (
            <div key={q} style={{ marginBottom: 24, padding: '24px', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12 }}>
              <h4 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: 8 }}>{q}</h4>
              <p style={{ color: '#9ca3af', fontSize: '0.9rem', lineHeight: 1.65 }}>{a}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Footer CTA */}
      <section style={{ padding: '80px 0', textAlign: 'center' }}>
        <h2 style={{ fontSize: 'clamp(1.5rem, 3vw, 2.2rem)', fontWeight: 800, marginBottom: 16 }}>Start closing more deals today</h2>
        <p style={{ color: '#9ca3af', marginBottom: 32 }}>Join thousands of sales teams using Globus CRM.</p>
        <Link to="/signup" className="btn-primary" style={{ padding: '16px 36px', fontSize: '1.05rem', borderRadius: 10, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          Start Free Trial <ArrowRight size={18} />
        </Link>
      </section>

      {/* Footer */}
      <footer style={{ padding: '24px 0', borderTop: '1px solid rgba(255,255,255,0.08)', textAlign: 'center', fontSize: '0.8rem', color: '#9ca3af' }}>
        &copy; 2026 Globussoft Technologies. All rights reserved.
      </footer>
    </div>
  );
}
