import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, ArrowRight, X, Plus } from 'lucide-react';

const C = {
  bg: '#f8fafc', bg2: '#ffffff', text: '#1e293b', text2: '#334155', text3: '#64748b', text4: '#94a3b8',
  accent: '#4f46e5', accentLight: '#6366f1', accentBg: '#eef2ff', accentRing: 'rgba(79,70,229,0.15)',
  pro: '#7c3aed', proBg: '#f5f3ff', proRing: 'rgba(124,58,237,0.12)',
  ent: '#d97706', entBg: '#fffbeb', entRing: 'rgba(217,119,6,0.1)',
  green: '#059669', greenBg: '#ecfdf5',
  border: '#e2e8f0', borderLight: '#f1f5f9', card: '#ffffff',
  shadow: '0 1px 3px rgba(0,0,0,0.06), 0 4px 12px rgba(0,0,0,0.04)',
};

const PRICES = {
  usd: { sym: '$', starter: { annual: 6, monthly: 8, yearAnnual: '$72 /user/year', yearMonthly: '$96 /user/year' }, pro: { annual: 18, monthly: 22, yearAnnual: '$216 /user/year', yearMonthly: '$264 /user/year' }, ent: { annual: 29, monthly: 36, yearAnnual: '$348 /user/year', yearMonthly: '$432 /user/year' } },
  inr: { sym: '\u20B9', starter: { annual: 499, monthly: 649, yearAnnual: '\u20B95,988 /user/year', yearMonthly: '\u20B97,788 /user/year' }, pro: { annual: '1,499', monthly: '1,899', yearAnnual: '\u20B917,988 /user/year', yearMonthly: '\u20B922,788 /user/year' }, ent: { annual: '2,499', monthly: '2,999', yearAnnual: '\u20B929,988 /user/year', yearMonthly: '\u20B935,988 /user/year' } },
};

const PLANS = [
  {
    key: 'starter', name: 'Starter', desc: 'For startups & SMBs seeking efficient pipeline management.',
    priceKey: 'starter', checkColor: '#4f46e5',
    features: ['Contact, Account & Deal Management', 'Contact Lifecycle Stages', 'Built-in Chat, Email & Phone', 'Email Templates & Tracking', 'Custom Fields & Kanban Views', 'Basic Workflows (20)', 'Visual Sales Pipeline', 'Product Catalog', 'Curated Reports & Dashboards', 'Slack Integration & Marketplace', 'Mobile App & 24\u00d75 Support'],
    cta: 'Start Free Trial', popular: false,
  },
  {
    key: 'pro', name: 'Professional', desc: 'For growing teams needing AI, automation & multi-pipeline.',
    priceKey: 'pro', checkColor: '#7c3aed',
    features: ['AI-Powered Contact Scoring', 'Multiple Sales Pipelines', 'Sales Sequences & Automation', 'Territory Management', 'Auto-assignment Rules', 'AI Email Writing & Enhancement', 'Deal Insights by AI', 'Advanced Workflows (50)', 'Custom Reports & Dashboards', 'Account Hierarchy & BYOC'],
    featuresLabel: 'Everything in Starter, plus',
    cta: 'Start Free Trial', popular: true,
  },
  {
    key: 'ent', name: 'Enterprise', desc: 'For large teams needing customization, governance & AI forecasting.',
    priceKey: 'ent', checkColor: '#d97706',
    features: ['Custom Modules', 'AI Forecasting Insights', 'Field-level Permissions', 'Sandbox Environment', 'Audit Logs & Compliance', 'Auto Profile Enrichment', 'Deal Teams & Advanced Metrics', '5,000 Bulk Emails/user/day', '100 GB Storage/user', 'Dedicated Account Manager', 'Priority 24\u00d77 Support'],
    featuresLabel: 'Everything in Professional, plus',
    cta: 'Contact Sales', popular: false,
  },
];

const COMPARE_SECTIONS = [
  {
    category: 'Contact & Account Management',
    rows: [
      ['Contact Management', true, true, true],
      ['Account Management', true, true, true],
      ['Contact Lifecycle Stages', true, true, true],
      ['Auto Profile Enrichment', false, false, true],
      ['Account Hierarchy', false, true, true],
    ],
  },
  {
    category: 'Sales Pipeline & Automation',
    rows: [
      ['Visual Sales Pipeline', true, true, true],
      ['Multiple Sales Pipelines', false, true, true],
      ['Sales Sequences', false, true, true],
      ['Territory Management', false, true, true],
      ['Workflows', '20', '50', '100'],
      ['Auto-assignment Rules', false, true, true],
    ],
  },
  {
    category: 'Email & Communication',
    rows: [
      ['2-Way Email Sync', true, true, true],
      ['Bulk Emails / user / day', '250', '1,000', '5,000'],
      ['AI Sales Emails', false, true, true],
      ['Built-in Phone & Chat', true, true, true],
      ['WhatsApp & SMS', false, true, true],
    ],
  },
  {
    category: 'AI & Intelligence',
    rows: [
      ['AI Contact Scoring', false, true, true],
      ['AI Deal Insights', false, true, true],
      ['AI Forecasting', false, false, true],
    ],
  },
  {
    category: 'Reports, Security & Support',
    rows: [
      ['Custom Reports & Dashboards', false, true, true],
      ['Field-level Permissions', false, false, true],
      ['Audit Logs & Sandbox', false, false, true],
      ['File Storage / user', '2 GB', '5 GB', '100 GB'],
      ['Mobile App', true, true, true],
      ['Support', '24\u00d75', '24\u00d75', '24\u00d77 Priority'],
      ['Dedicated Account Manager', false, false, true],
    ],
  },
];

const FAQ_ITEMS = [
  ['How does the 14-day free trial work?', 'Sign up and get instant access to GlobusCRM Professional for 14 days \u2014 no credit card required. When the trial ends, choose the plan that fits your needs.'],
  ['Can I switch plans anytime?', 'Yes! Upgrade or downgrade anytime. When upgrading, you pay only the prorated difference. Downgrades take effect at the next billing cycle.'],
  ['What payment methods do you accept?', 'We accept Visa, Mastercard, American Express, PayPal, UPI, and Net Banking (INR). Enterprise plans also support wire transfers and purchase orders.'],
  ['Is my data secure?', 'All data is encrypted with AES-256 at rest and TLS 1.3 in transit. We maintain SOC 2 Type II compliance with SSO, MFA, and RBAC on all plans.'],
  ['Do you offer volume discounts?', 'Teams with 25+ users are eligible for custom volume pricing. Contact our sales team and we\'ll create a tailored package for your organization.'],
];

export default function Pricing() {
  const [annual, setAnnual] = useState(true);
  // Auto-detect currency: India → INR, else USD. Manual toggle below overrides.
  // Check stored preference first so a user who clicked the toggle stays on it.
  const [currency, setCurrency] = useState(() => {
    try {
      const stored = localStorage.getItem('pricingCurrency');
      if (stored === 'inr' || stored === 'usd') return stored;
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
      const lang = (navigator.language || '').toLowerCase();
      const isIndia = /Asia\/(Kolkata|Calcutta)/i.test(tz) || /-in\b|^hi-/.test(lang);
      return isIndia ? 'inr' : 'usd';
    } catch { return 'usd'; }
  });

  // Persist when the user clicks the toggle
  React.useEffect(() => { try { localStorage.setItem('pricingCurrency', currency); } catch {} }, [currency]);
  const [openFaq, setOpenFaq] = useState(null);

  const prices = PRICES[currency];

  const getPrice = (planKey) => {
    const p = prices[planKey];
    return annual ? p.annual : p.monthly;
  };

  const getYearLabel = (planKey) => {
    const p = prices[planKey];
    return annual ? p.yearAnnual : p.yearMonthly;
  };

  const getCardStyle = (plan) => {
    if (plan.key === 'pro') return { background: C.card, border: `2px solid ${C.pro}`, borderRadius: 12, padding: '32px 28px', position: 'relative', boxShadow: `0 8px 30px ${C.proRing}`, display: 'flex', flexDirection: 'column' };
    const topColor = plan.key === 'starter' ? C.accent : C.ent;
    return { background: C.card, border: `1px solid ${C.border}`, borderTop: `3px solid ${topColor}`, borderRadius: 12, padding: '32px 28px', position: 'relative', boxShadow: C.shadow, display: 'flex', flexDirection: 'column', transition: 'all 0.25s' };
  };

  const getCtaStyle = (plan) => {
    if (plan.key === 'starter') return { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, width: '100%', padding: '12px 0', borderRadius: 8, textDecoration: 'none', fontSize: '0.88rem', fontWeight: 600, background: C.accentBg, color: C.accent, border: `1px solid rgba(79,70,229,0.15)` };
    if (plan.key === 'pro') return { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, width: '100%', padding: '12px 0', borderRadius: 8, textDecoration: 'none', fontSize: '0.88rem', fontWeight: 600, background: C.pro, color: '#fff', border: 'none', boxShadow: `0 2px 8px ${C.proRing}` };
    return { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, width: '100%', padding: '12px 0', borderRadius: 8, textDecoration: 'none', fontSize: '0.88rem', fontWeight: 600, background: C.entBg, color: C.ent, border: '1px solid rgba(217,119,6,0.15)' };
  };

  const renderCell = (val) => {
    if (val === true) return <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 20, height: 20, borderRadius: '50%', background: C.greenBg, color: C.green }}><Check size={12} /></span>;
    if (val === false) return <span style={{ color: C.text4, opacity: 0.3 }}><X size={12} /></span>;
    return <span style={{ fontSize: '0.8rem', color: C.text2, fontWeight: 500 }}>{val}</span>;
  };

  return (
    <div style={{ background: C.bg, color: C.text, fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif", minHeight: '100vh' }}>
      {/* Navbar */}
      <nav style={{ position: 'sticky', top: 0, left: 0, right: 0, zIndex: 100, background: C.card, borderBottom: `1px solid ${C.border}` }}>
        <div style={{ maxWidth: 1200, margin: '0 auto', padding: '14px 28px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Link to="/" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '1.1rem', textDecoration: 'none', color: C.text }}>
            <div style={{ width: 32, height: 32, borderRadius: 8, background: 'linear-gradient(135deg, #4f46e5, #7c3aed)', display: 'grid', placeItems: 'center' }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" width="18" height="18"><circle cx="12" cy="12" r="10" /><path d="M2 12h20" /><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10A15.3 15.3 0 0 1 12 2z" /></svg>
            </div>
            <span style={{ fontWeight: 700, letterSpacing: '-0.02em' }}>Globus<strong style={{ color: C.accent }}>CRM</strong></span>
          </Link>
          <div style={{ display: 'flex', alignItems: 'center', gap: 28 }}>
            <Link to="/" style={{ fontSize: '0.88rem', color: C.text3, textDecoration: 'none', fontWeight: 500 }}>Home</Link>
            <Link to="/login" style={{ fontSize: '0.88rem', color: C.text3, textDecoration: 'none', fontWeight: 500 }}>Login</Link>
            <Link to="/signup" style={{ padding: '8px 20px', fontSize: '0.82rem', borderRadius: 8, textDecoration: 'none', background: C.accent, color: '#fff', fontWeight: 600 }}>Start Free Trial</Link>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section style={{ padding: '56px 28px 16px', textAlign: 'center' }}>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: C.greenBg, color: C.green, padding: '4px 14px', borderRadius: 100, fontSize: '0.75rem', fontWeight: 600, marginBottom: 20, border: '1px solid rgba(5,150,105,0.12)' }}>
          <span style={{ width: 5, height: 5, borderRadius: '50%', background: C.green }} />
          14-day free trial &middot; No credit card required
        </div>
        <h1 style={{ fontSize: 'clamp(1.75rem, 4vw, 2.6rem)', fontWeight: 800, marginBottom: 12, letterSpacing: '-0.04em', lineHeight: 1.15, color: C.text }}>
          Choose the right plan<br />for <span style={{ color: C.accent }}>your team</span>
        </h1>
        <p style={{ color: C.text3, fontSize: '1rem', maxWidth: 480, margin: '0 auto 32px', lineHeight: 1.6 }}>
          Simple, transparent pricing for teams of every size. Start free, upgrade when you're ready.
        </p>
      </section>

      {/* Controls */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 28, marginBottom: 44, flexWrap: 'wrap', padding: '0 20px' }}>
        {/* Billing toggle */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: '0.82rem', fontWeight: annual ? 600 : 500, color: annual ? C.text : C.text4, cursor: 'pointer', userSelect: 'none' }} onClick={() => setAnnual(true)}>Annual</span>
          <div onClick={() => setAnnual(!annual)} style={{ width: 44, height: 24, background: C.accent, borderRadius: 100, cursor: 'pointer', position: 'relative', transition: 'background 0.25s' }}>
            <div style={{ position: 'absolute', top: 2, left: annual ? 2 : 22, width: 20, height: 20, borderRadius: '50%', background: '#fff', transition: 'left 0.25s cubic-bezier(0.4,0.2,0.2,1)', boxShadow: '0 1px 3px rgba(0,0,0,0.15)' }} />
          </div>
          <span style={{ fontSize: '0.82rem', fontWeight: !annual ? 600 : 500, color: !annual ? C.text : C.text4, cursor: 'pointer', userSelect: 'none' }} onClick={() => setAnnual(false)}>Monthly</span>
          <span style={{ background: C.greenBg, color: C.green, padding: '2px 8px', borderRadius: 100, fontSize: '0.69rem', fontWeight: 700, border: '1px solid rgba(5,150,105,0.1)' }}>SAVE 20%</span>
        </div>
        {/* Currency toggle */}
        <div style={{ display: 'flex', background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, overflow: 'hidden' }}>
          <button onClick={() => setCurrency('usd')} style={{ padding: '6px 16px', fontSize: '0.82rem', fontWeight: 600, border: 'none', cursor: 'pointer', background: currency === 'usd' ? C.accent : 'transparent', color: currency === 'usd' ? '#fff' : C.text4, transition: 'all 0.15s', fontFamily: 'inherit' }}>$ USD</button>
          <button onClick={() => setCurrency('inr')} style={{ padding: '6px 16px', fontSize: '0.82rem', fontWeight: 600, border: 'none', cursor: 'pointer', background: currency === 'inr' ? C.accent : 'transparent', color: currency === 'inr' ? '#fff' : C.text4, transition: 'all 0.15s', fontFamily: 'inherit' }}>{'\u20B9'} INR</button>
        </div>
      </div>

      {/* Plans */}
      <section style={{ maxWidth: 1120, margin: '0 auto', padding: '0 20px 64px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 24, alignItems: 'start' }}>
          {PLANS.map((plan) => (
            <div key={plan.name} style={getCardStyle(plan)}>
              {plan.popular && (
                <div style={{ position: 'absolute', top: -12, left: '50%', transform: 'translateX(-50%)', padding: '4px 14px', borderRadius: 100, background: C.pro, fontSize: '0.69rem', fontWeight: 700, color: '#fff', letterSpacing: '0.03em', whiteSpace: 'nowrap' }}>
                  MOST POPULAR
                </div>
              )}
              <h3 style={{ fontSize: '1.12rem', fontWeight: 700, marginBottom: 4, color: C.text }}>{plan.name}</h3>
              <p style={{ color: C.text3, fontSize: '0.82rem', lineHeight: 1.5, marginBottom: 24, minHeight: 36 }}>{plan.desc}</p>

              {/* Price card */}
              <div style={{ background: C.bg, border: `1px solid ${C.borderLight}`, borderRadius: 10, padding: '20px 16px', textAlign: 'center', marginBottom: 24 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'center', gap: 2 }}>
                  <span style={{ fontSize: '1.35rem', fontWeight: 700, color: C.text3, alignSelf: 'flex-start', marginTop: 4 }}>{prices.sym}</span>
                  <span style={{ fontSize: '3.25rem', fontWeight: 800, color: C.text, lineHeight: 1, letterSpacing: '-0.04em' }}>{getPrice(plan.priceKey)}</span>
                </div>
                <div style={{ fontSize: '0.75rem', color: C.text4, marginTop: 6 }}>/user/month, billed {annual ? 'annually' : 'monthly'}</div>
                <div style={{ fontSize: '0.69rem', color: C.text4, marginTop: 3, opacity: 0.8 }}>{getYearLabel(plan.priceKey)}</div>
              </div>

              <Link to="/signup" style={getCtaStyle(plan)}>
                {plan.cta} <ArrowRight size={14} />
              </Link>

              {/* Separator */}
              <div style={{ height: 1, background: C.borderLight, margin: '24px 0 16px' }} />

              <div style={{ fontSize: '0.69rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: C.text4, marginBottom: 14 }}>
                {plan.featuresLabel || 'Includes'}
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, flex: 1 }}>
                {plan.features.map(f => (
                  <div key={f} style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                    <Check size={14} style={{ color: plan.checkColor, marginTop: 2, flexShrink: 0 }} />
                    <span style={{ fontSize: '0.82rem', color: C.text2, lineHeight: 1.45 }}>{f}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Comparison Table */}
      <section style={{ maxWidth: 1120, margin: '0 auto', padding: '0 20px 64px' }}>
        <h2 style={{ fontSize: '1.75rem', fontWeight: 800, color: C.text, textAlign: 'center', marginBottom: 8, letterSpacing: '-0.03em' }}>Compare all features</h2>
        <p style={{ textAlign: 'center', color: C.text3, fontSize: '0.88rem', marginBottom: 36 }}>Everything you need to know, side by side</p>
        <div style={{ border: `1px solid ${C.border}`, borderRadius: 12, overflow: 'hidden', background: C.card }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
            <thead>
              <tr>
                <th style={{ background: C.bg, padding: '14px 16px', textAlign: 'left', fontWeight: 700, fontSize: '0.82rem', color: C.text, borderBottom: `1px solid ${C.border}`, width: '38%' }}>Features</th>
                <th style={{ background: C.bg, padding: '14px 16px', textAlign: 'center', fontWeight: 700, fontSize: '0.82rem', color: C.text, borderBottom: `1px solid ${C.border}` }}>
                  Starter<br /><span style={{ display: 'block', fontSize: '0.69rem', fontWeight: 500, color: C.text4, marginTop: 2 }}>{prices.sym}{getPrice('starter')}/mo</span>
                </th>
                <th style={{ background: C.proBg, padding: '14px 16px', textAlign: 'center', fontWeight: 700, fontSize: '0.82rem', color: C.pro, borderBottom: `1px solid ${C.border}` }}>
                  Professional<br /><span style={{ display: 'block', fontSize: '0.69rem', fontWeight: 500, color: 'rgba(124,58,237,0.5)', marginTop: 2 }}>{prices.sym}{getPrice('pro')}/mo</span>
                </th>
                <th style={{ background: C.bg, padding: '14px 16px', textAlign: 'center', fontWeight: 700, fontSize: '0.82rem', color: C.text, borderBottom: `1px solid ${C.border}` }}>
                  Enterprise<br /><span style={{ display: 'block', fontSize: '0.69rem', fontWeight: 500, color: C.text4, marginTop: 2 }}>{prices.sym}{getPrice('ent')}/mo</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {COMPARE_SECTIONS.map((section) => (
                <React.Fragment key={section.category}>
                  <tr>
                    <td colSpan={4} style={{ background: C.bg, fontWeight: 700, color: C.accent, fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.07em', padding: '14px 16px 8px', borderBottom: `1px solid ${C.border}` }}>{section.category}</td>
                  </tr>
                  {section.rows.map(([feature, starter, pro, ent]) => (
                    <tr key={feature} style={{ borderBottom: `1px solid ${C.borderLight}` }}>
                      <td style={{ padding: '11px 16px', fontWeight: 500, color: C.text2 }}>{feature}</td>
                      <td style={{ padding: '11px 16px', textAlign: 'center' }}>{renderCell(starter)}</td>
                      <td style={{ padding: '11px 16px', textAlign: 'center' }}>{renderCell(pro)}</td>
                      <td style={{ padding: '11px 16px', textAlign: 'center' }}>{renderCell(ent)}</td>
                    </tr>
                  ))}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* FAQ */}
      <section style={{ maxWidth: 680, margin: '0 auto', padding: '0 20px 72px' }}>
        <h2 style={{ fontSize: '1.6rem', fontWeight: 800, textAlign: 'center', marginBottom: 32, color: C.text, letterSpacing: '-0.02em' }}>Frequently Asked Questions</h2>
        {FAQ_ITEMS.map(([q, a], i) => (
          <div key={q} style={{ borderBottom: `1px solid ${C.borderLight}` }}>
            <button
              onClick={() => setOpenFaq(openFaq === i ? null : i)}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 0', cursor: 'pointer',
                fontSize: '0.88rem', fontWeight: 600, color: C.text, background: 'none', border: 'none', width: '100%', textAlign: 'left', fontFamily: 'inherit',
              }}
            >
              {q}
              <Plus size={16} style={{ transition: 'transform 0.25s', flexShrink: 0, marginLeft: 12, color: openFaq === i ? C.accent : C.text4, transform: openFaq === i ? 'rotate(45deg)' : 'none' }} />
            </button>
            <div style={{
              maxHeight: openFaq === i ? 200 : 0, overflow: 'hidden', transition: 'max-height 0.3s ease, padding 0.3s',
              fontSize: '0.85rem', color: C.text3, lineHeight: 1.65, paddingBottom: openFaq === i ? 16 : 0,
            }}>
              {a}
            </div>
          </div>
        ))}
      </section>

      {/* Footer */}
      <footer style={{ background: C.card, borderTop: `1px solid ${C.border}`, padding: '24px 28px' }}>
        <div style={{ maxWidth: 1200, margin: '0 auto', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <p style={{ fontSize: '0.75rem', color: C.text4 }}>&copy; 2026 GlobusCRM by Globussoft. All rights reserved.</p>
          <Link to="/" style={{ color: C.accent, textDecoration: 'none', fontSize: '0.75rem', fontWeight: 500 }}>crm.globusdemos.com</Link>
        </div>
      </footer>
    </div>
  );
}
