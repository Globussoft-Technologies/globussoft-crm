import React, { useContext, useEffect, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Check, ArrowRight, Loader, Moon, Sun, Monitor, Building2, Briefcase, Plane } from 'lucide-react';
import { AuthContext, ThemeContext } from '../App';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';
import PasswordInput from '../components/PasswordInput';

const C = {
  bg: '#f8fafc', bg2: '#ffffff', text: '#1e293b', text2: '#334155', text3: '#64748b', text4: '#94a3b8',
  accent: '#2563eb', accentLight: '#3b82f6', accentBg: '#eff6ff',
  border: '#e2e8f0', borderLight: '#f1f5f9', card: '#ffffff',
  shadow: '0 1px 3px rgba(0,0,0,0.06), 0 4px 12px rgba(0,0,0,0.04)',
  green: '#059669', greenBg: '#ecfdf5',
  red: '#dc2626',
};

const CURRENCY_SYM = { usd: '$', inr: '₹' };

const THEME_ICONS = {
  light: <Sun size={18} />,
  dark: <Moon size={18} />,
  system: <Monitor size={18} />,
};

const VERTICAL_ICONS = {
  generic: <Briefcase size={18} />,
  wellness: <Building2 size={18} />,
  travel: <Plane size={18} />,
};

const STEPS = [
  { key: 'email', label: 'Email' },
  { key: 'profile', label: 'Profile' },
  { key: 'plan', label: 'Plan' },
  { key: 'pay', label: 'Payment' },
];

const STORAGE_KEY = 'get-started-state';

function persistState(state) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {}
}

function readPersistedState() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function clearPersistedState() {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {}
}

export default function GetStarted() {
  const navigate = useNavigate();
  const notify = useNotify();
  const { setUser, setToken, setTenant } = useContext(AuthContext);
  const { setTheme } = useContext(ThemeContext);

  const persisted = readPersistedState();

  const [step, setStep] = useState(persisted?.step || 'email');
  const [email, setEmail] = useState(persisted?.email || '');
  const [name, setName] = useState(persisted?.name || '');
  const [organizationName, setOrganizationName] = useState(persisted?.organizationName || '');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [vertical, setVertical] = useState(persisted?.vertical || 'generic');
  const [themePreference, setThemePreference] = useState(persisted?.themePreference || 'system');

  const [plans, setPlans] = useState([]);
  const [selectedPlan, setSelectedPlan] = useState(persisted?.selectedPlan || null);
  const [currency, setCurrency] = useState(persisted?.currency || 'usd');
  const [annual, setAnnual] = useState(persisted?.annual !== undefined ? persisted.annual : true);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [emailChecked, setEmailChecked] = useState(persisted?.emailChecked || false);

  // Load Razorpay SDK once
  useEffect(() => {
    if (!document.getElementById('razorpay-checkout')) {
      const script = document.createElement('script');
      script.id = 'razorpay-checkout';
      script.src = 'https://checkout.razorpay.com/v1/checkout.js';
      script.async = true;
      document.body.appendChild(script);
    }
  }, []);

  // Fetch plans when reaching plan step
  useEffect(() => {
    if (step !== 'plan') return;
    fetchApi('/api/subscriptions/plans', { silent: true })
      .then((data) => {
        if (Array.isArray(data) && data.length > 0) setPlans(data);
      })
      .catch(() => {
        // Fallback silent; the page will show an empty state rather than a toast storm
      });
  }, [step]);

  // Persist wizard state so a refresh doesn't lose progress
  useEffect(() => {
    persistState({
      step, email, name, organizationName, vertical, themePreference,
      selectedPlan, currency, annual, emailChecked,
    });
  }, [step, email, name, organizationName, vertical, themePreference, selectedPlan, currency, annual, emailChecked]);

  const validatePassword = (pw) => {
    if (!pw || pw.length < 8) return 'Password must be at least 8 characters';
    if (!/[A-Za-z]/.test(pw)) return 'Password must contain at least one letter';
    if (!/[0-9]/.test(pw)) return 'Password must contain at least one number';
    return null;
  };

  const handleCheckEmail = async (e) => {
    e.preventDefault();
    setError('');
    if (!email || !email.includes('@')) {
      setError('Please enter a valid email address');
      return;
    }
    setLoading(true);
    try {
      const res = await fetch('/api/auth/check-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (data.exists) {
        navigate(`/login?email=${encodeURIComponent(email)}`);
        return;
      }
      setEmailChecked(true);
      setStep('profile');
    } catch (err) {
      setError('Unable to verify email. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleRegister = async (e) => {
    e.preventDefault();
    setError('');

    const pwErr = validatePassword(password);
    if (pwErr) {
      setError(pwErr);
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    if (!name.trim() || !organizationName.trim()) {
      setError('Please fill in all fields');
      return;
    }

    setLoading(true);
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          password,
          name: name.trim(),
          organizationName: organizationName.trim(),
          vertical,
          themePreference,
        }),
      });
      const data = await res.json();
      if (res.ok && data.token) {
        setToken(data.token);
        setUser(data.user);
        if (data.tenant) setTenant(data.tenant);

        // Apply chosen visual theme immediately
        const chosenTheme = data.user?.themePreference || themePreference || 'system';
        setTheme(chosenTheme);
        try { localStorage.setItem('theme', chosenTheme); } catch {}

        // Apply vertical attribute immediately
        const v = data.tenant?.vertical || vertical || 'generic';
        document.documentElement.setAttribute('data-vertical', v);
        document.body.setAttribute('data-vertical', v);

        setStep('plan');
      } else {
        setError(data.error || 'Registration failed. Please try again.');
      }
    } catch (err) {
      setError('Network error. Please check your connection.');
    } finally {
      setLoading(false);
    }
  };

  const handleSelectPlan = (plan) => {
    setSelectedPlan(plan);
    setStep('pay');
  };

  const handlePayment = async () => {
    if (!selectedPlan || !selectedPlan.id) {
      notify.error('Please select a valid plan');
      return;
    }
    if (!window.Razorpay) {
      notify.error('Payment system is still loading. Please try again in a moment.');
      return;
    }

    setLoading(true);
    try {
      const orderData = await fetchApi('/api/subscriptions/create-order', {
        method: 'POST',
        body: JSON.stringify({
          planId: parseInt(selectedPlan.id, 10),
          currency,
          billingPeriod: annual ? 'annual' : 'monthly',
        }),
      });

      const razorpayKeyId = import.meta.env.VITE_RAZORPAY_KEY_ID;
      if (!razorpayKeyId) {
        throw new Error('Razorpay Key ID not configured (VITE_RAZORPAY_KEY_ID)');
      }
      if (!orderData.orderId || !orderData.amount || !orderData.currency) {
        throw new Error('Invalid order data from server');
      }

      const options = {
        key: razorpayKeyId,
        amount: orderData.amount,
        currency: orderData.currency,
        order_id: orderData.orderId,
        name: 'GlobusCRM',
        description: `${selectedPlan.name} Plan`,
        handler: async (response) => {
          try {
            const verifyData = await fetchApi('/api/subscriptions/verify-payment', {
              method: 'POST',
              body: JSON.stringify({
                razorpayOrderId: orderData.orderId,
                razorpayPaymentId: response.razorpay_payment_id,
                razorpaySignature: response.razorpay_signature,
                planId: parseInt(selectedPlan.id, 10),
              }),
            });

            if (verifyData?.success) {
              clearPersistedState();
              navigate('/register-success', {
                state: {
                  planName: selectedPlan.name,
                  subscription: verifyData.subscription,
                  email,
                },
              });
            } else {
              notify.error('Payment verification failed. Please retry.');
            }
          } catch (err) {
            notify.error('Payment verification failed. Please retry.');
          }
        },
        modal: {
          ondismiss: () => setLoading(false),
        },
        prefill: {
          name: name || '',
          email: email || '',
        },
        theme: { color: selectedPlan.accentColor || C.accent },
      };

      const rzp = new window.Razorpay(options);
      rzp.open();
    } catch (err) {
      notify.error(err?.message || 'Unable to start payment. Please try again.');
      setLoading(false);
    }
  };

  const getPrice = (plan) => {
    const bucket = plan?.pricing && plan.pricing[currency];
    if (bucket) return annual ? bucket.annual : bucket.monthly;
    if (plan?.currency && plan.currency.toLowerCase() === currency) return plan.price;
    return plan?.price ?? '';
  };

  const getYearLabel = (plan) => {
    const bucket = plan?.pricing && plan.pricing[currency];
    if (bucket) return annual ? bucket.yearAnnualLabel : bucket.yearMonthlyLabel;
    return '';
  };

  const renderStepIndicator = () => (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginBottom: 32 }}>
      {STEPS.map((s, idx) => {
        const isActive = s.key === step;
        const isPast = STEPS.findIndex((x) => x.key === step) > idx;
        return (
          <React.Fragment key={s.key}>
            <div
              style={{
                width: 32, height: 32, borderRadius: '50%',
                display: 'grid', placeItems: 'center',
                background: isActive ? C.accent : isPast ? C.green : C.borderLight,
                color: isActive || isPast ? '#fff' : C.text3,
                fontSize: '0.8rem', fontWeight: 700,
                border: `2px solid ${isActive ? C.accent : isPast ? C.green : C.border}`,
              }}
            >
              {isPast ? <Check size={14} /> : idx + 1}
            </div>
            {idx < STEPS.length - 1 && (
              <div style={{ width: 40, height: 2, background: isPast ? C.green : C.border }} />
            )}
          </React.Fragment>
        );
      })}
    </div>
  );

  return (
    <div style={{ minHeight: '100vh', background: C.bg, color: C.text, fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif" }}>
      {/* Navbar */}
      <nav style={{ position: 'sticky', top: 0, left: 0, right: 0, zIndex: 100, background: C.card, borderBottom: `1px solid ${C.border}` }}>
        <div style={{ maxWidth: 1200, margin: '0 auto', padding: '14px 28px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Link to="/" style={{ display: 'flex', alignItems: 'center' }}>
            <img
              src="/globussoft-logo.png"
              alt="Globus CRM"
              style={{ height: 34, width: 'auto', maxWidth: 160, objectFit: 'contain' }}
            />
          </Link>
          <Link to="/login" style={{ fontSize: '0.88rem', color: C.text3, textDecoration: 'none', fontWeight: 500 }}>
            Already have an account? Sign in
          </Link>
        </div>
      </nav>

      {/* Main */}
      <main style={{ maxWidth: 720, margin: '0 auto', padding: '48px 24px 80px' }}>
        {renderStepIndicator()}

        <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 16, padding: '36px 32px', boxShadow: C.shadow }}>
          {error && (
            <div style={{ background: '#fef2f2', color: C.red, padding: '12px 16px', borderRadius: 8, fontSize: '0.88rem', marginBottom: 20, border: '1px solid #fecaca' }}>
              {error}
            </div>
          )}

          {step === 'email' && (
            <>
              <h1 style={{ fontSize: '1.5rem', fontWeight: 700, marginBottom: 8 }}>Let's get started</h1>
              <p style={{ color: C.text3, marginBottom: 28 }}>Enter your work email to check if you already have an account.</p>
              <form onSubmit={handleCheckEmail}>
                <label style={{ display: 'block', fontSize: '0.82rem', fontWeight: 500, color: C.text2, marginBottom: 8 }}>Work email</label>
                <input
                  type="email"
                  autoFocus
                  required
                  placeholder="you@company.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  style={{
                    width: '100%', padding: '12px 14px', borderRadius: 10, border: `1px solid ${C.border}`,
                    fontSize: '1rem', marginBottom: 20, outline: 'none', fontFamily: 'inherit',
                  }}
                />
                <button
                  type="submit"
                  disabled={loading}
                  style={{
                    width: '100%', padding: '12px', borderRadius: 10, border: 'none',
                    background: C.accent, color: '#fff', fontWeight: 600, fontSize: '0.95rem',
                    cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.7 : 1,
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                  }}
                >
                  {loading ? <Loader size={18} className="spin" /> : <>Continue <ArrowRight size={18} /></>}
                </button>
              </form>
            </>
          )}

          {step === 'profile' && (
            <>
              <h1 style={{ fontSize: '1.5rem', fontWeight: 700, marginBottom: 8 }}>Create your account</h1>
              <p style={{ color: C.text3, marginBottom: 28 }}>Tell us a bit about your organization.</p>
              <form onSubmit={handleRegister}>
                <div style={{ marginBottom: 16 }}>
                  <label style={labelStyle}>Full name</label>
                  <input
                    type="text"
                    required
                    placeholder="John Doe"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    style={inputStyle}
                  />
                </div>
                <div style={{ marginBottom: 16 }}>
                  <label style={labelStyle}>Organization name</label>
                  <input
                    type="text"
                    required
                    placeholder="Acme Inc."
                    value={organizationName}
                    onChange={(e) => setOrganizationName(e.target.value)}
                    style={inputStyle}
                  />
                </div>

                <div style={{ marginBottom: 16 }}>
                  <label style={labelStyle}>Password</label>
                  <PasswordInput
                    required
                    placeholder="••••••••"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    wrapperStyle={{ width: '100%' }}
                  />
                  <div style={{ fontSize: '0.75rem', color: C.text4, marginTop: 6 }}>
                    At least 8 characters with 1 letter and 1 number.
                  </div>
                </div>
                <div style={{ marginBottom: 20 }}>
                  <label style={labelStyle}>Confirm password</label>
                  <PasswordInput
                    required
                    placeholder="••••••••"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    wrapperStyle={{ width: '100%' }}
                  />
                </div>

                <div style={{ marginBottom: 20 }}>
                  <label style={labelStyle}>CRM type</label>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
                    {[
                      { key: 'generic', label: 'Generic CRM' },
                      { key: 'wellness', label: 'Wellness' },
                      { key: 'travel', label: 'Travel' },
                    ].map((v) => (
                      <button
                        key={v.key}
                        type="button"
                        onClick={() => setVertical(v.key)}
                        style={{
                          padding: '12px', borderRadius: 10, border: `1.5px solid ${vertical === v.key ? C.accent : C.border}`,
                          background: vertical === v.key ? C.accentBg : C.card, color: vertical === v.key ? C.accent : C.text2,
                          fontWeight: 500, fontSize: '0.85rem', cursor: 'pointer', display: 'flex', flexDirection: 'column',
                          alignItems: 'center', gap: 6,
                        }}
                      >
                        {VERTICAL_ICONS[v.key]}
                        {v.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div style={{ marginBottom: 24 }}>
                  <label style={labelStyle}>Visual theme</label>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
                    {[
                      { key: 'light', label: 'Light' },
                      { key: 'dark', label: 'Dark' },
                      { key: 'system', label: 'System' },
                    ].map((t) => (
                      <button
                        key={t.key}
                        type="button"
                        onClick={() => setThemePreference(t.key)}
                        style={{
                          padding: '12px', borderRadius: 10, border: `1.5px solid ${themePreference === t.key ? C.accent : C.border}`,
                          background: themePreference === t.key ? C.accentBg : C.card, color: themePreference === t.key ? C.accent : C.text2,
                          fontWeight: 500, fontSize: '0.85rem', cursor: 'pointer', display: 'flex', flexDirection: 'column',
                          alignItems: 'center', gap: 6,
                        }}
                      >
                        {THEME_ICONS[t.key]}
                        {t.label}
                      </button>
                    ))}
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  style={{
                    width: '100%', padding: '12px', borderRadius: 10, border: 'none',
                    background: C.accent, color: '#fff', fontWeight: 600, fontSize: '0.95rem',
                    cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.7 : 1,
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                  }}
                >
                  {loading ? <Loader size={18} className="spin" /> : <>Create account <ArrowRight size={18} /></>}
                </button>
              </form>
            </>
          )}

          {step === 'plan' && (
            <>
              <h1 style={{ fontSize: '1.5rem', fontWeight: 700, marginBottom: 8 }}>Choose your plan</h1>
              <p style={{ color: C.text3, marginBottom: 24 }}>Start with a 14-day free trial. Upgrade anytime.</p>

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 16, marginBottom: 28, flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontSize: '0.82rem', fontWeight: annual ? 600 : 500, color: annual ? C.text : C.text4, cursor: 'pointer' }} onClick={() => setAnnual(true)}>Annual</span>
                  <div onClick={() => setAnnual(!annual)} style={{ width: 44, height: 24, background: C.accent, borderRadius: 100, cursor: 'pointer', position: 'relative' }}>
                    <div style={{ position: 'absolute', top: 2, left: annual ? 2 : 22, width: 20, height: 20, borderRadius: '50%', background: '#fff', transition: 'left 0.25s' }} />
                  </div>
                  <span style={{ fontSize: '0.82rem', fontWeight: !annual ? 600 : 500, color: !annual ? C.text : C.text4, cursor: 'pointer' }} onClick={() => setAnnual(false)}>Monthly</span>
                </div>
                <div style={{ display: 'flex', background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, overflow: 'hidden' }}>
                  <button onClick={() => setCurrency('usd')} style={{ padding: '6px 16px', fontSize: '0.82rem', fontWeight: 600, border: 'none', cursor: 'pointer', background: currency === 'usd' ? C.accent : 'transparent', color: currency === 'usd' ? '#fff' : C.text4 }}>$ USD</button>
                  <button onClick={() => setCurrency('inr')} style={{ padding: '6px 16px', fontSize: '0.82rem', fontWeight: 600, border: 'none', cursor: 'pointer', background: currency === 'inr' ? C.accent : 'transparent', color: currency === 'inr' ? '#fff' : C.text4 }}>{'₹'} INR</button>
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16 }}>
                {plans.length === 0 && (
                  <div style={{ textAlign: 'center', color: C.text3, padding: 32 }}>Loading plans…</div>
                )}
                {plans.map((plan) => {
                  const accent = plan.accentColor || C.accent;
                  const selected = selectedPlan?.id === plan.id;
                  return (
                    <div
                      key={plan.id || plan.planKey}
                      onClick={() => handleSelectPlan(plan)}
                      style={{
                        border: `2px solid ${selected ? accent : C.border}`,
                        borderTop: `4px solid ${accent}`,
                        borderRadius: 12, padding: '22px 18px', cursor: 'pointer',
                        background: selected ? '#fafafa' : C.card,
                        transition: 'all 0.2s',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                        <h3 style={{ fontSize: '1.05rem', fontWeight: 700, margin: 0 }}>{plan.name}</h3>
                        {plan.popular && (
                          <span style={{ background: accent, color: '#fff', padding: '2px 8px', borderRadius: 100, fontSize: '0.65rem', fontWeight: 700 }}>POPULAR</span>
                        )}
                      </div>
                      <p style={{ fontSize: '0.8rem', color: C.text3, minHeight: 36, marginBottom: 12 }}>{plan.description}</p>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: 2, marginBottom: 4 }}>
                        <span style={{ fontSize: '1.1rem', fontWeight: 700, color: C.text3 }}>{CURRENCY_SYM[currency]}</span>
                        <span style={{ fontSize: '2.4rem', fontWeight: 800, color: C.text, lineHeight: 1 }}>{getPrice(plan)}</span>
                      </div>
                      <div style={{ fontSize: '0.75rem', color: C.text4 }}>/user/month, billed {annual ? 'annually' : 'monthly'}</div>
                      <div style={{ fontSize: '0.7rem', color: C.text4, marginTop: 2, opacity: 0.85 }}>{getYearLabel(plan)}</div>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {step === 'pay' && selectedPlan && (
            <>
              <h1 style={{ fontSize: '1.5rem', fontWeight: 700, marginBottom: 8 }}>Complete payment</h1>
              <p style={{ color: C.text3, marginBottom: 24 }}>You're subscribing to the <strong>{selectedPlan.name}</strong> plan.</p>

              <div style={{ background: C.accentBg, border: `1px solid ${C.border}`, borderRadius: 12, padding: 20, marginBottom: 24 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                  <span style={{ color: C.text2 }}>Plan</span>
                  <span style={{ fontWeight: 600 }}>{selectedPlan.name}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                  <span style={{ color: C.text2 }}>Billing</span>
                  <span style={{ fontWeight: 600 }}>{annual ? 'Annual' : 'Monthly'}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: C.text2 }}>Price</span>
                  <span style={{ fontWeight: 600 }}>{CURRENCY_SYM[currency]}{getPrice(selectedPlan)} /user/month</span>
                </div>
              </div>

              <button
                onClick={handlePayment}
                disabled={loading}
                style={{
                  width: '100%', padding: '14px', borderRadius: 10, border: 'none',
                  background: C.accent, color: '#fff', fontWeight: 600, fontSize: '1rem',
                  cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.7 : 1,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                }}
              >
                {loading ? <Loader size={18} className="spin" /> : <>Pay with Razorpay <ArrowRight size={18} /></>}
              </button>

              <button
                type="button"
                onClick={() => setStep('plan')}
                disabled={loading}
                style={{
                  width: '100%', marginTop: 12, padding: '10px', borderRadius: 10, border: 'none',
                  background: 'transparent', color: C.text3, fontWeight: 500, fontSize: '0.9rem',
                  cursor: loading ? 'not-allowed' : 'pointer',
                }}
              >
                Choose a different plan
              </button>
            </>
          )}
        </div>
      </main>

      <style>{`
        .spin { animation: spin 1s linear infinite; }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}

const labelStyle = { display: 'block', fontSize: '0.82rem', fontWeight: 500, color: C.text2, marginBottom: 6 };
const inputStyle = {
  width: '100%', padding: '11px 13px', borderRadius: 10, border: `1px solid ${C.border}`,
  fontSize: '0.95rem', outline: 'none', fontFamily: 'inherit',
};
