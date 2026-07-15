import React, { useState, useContext } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { AuthContext } from '../App';
import PasswordInput from '../components/PasswordInput';
import ContactVerificationField from '../components/ContactVerificationField';

const Signup = () => {
  const [name, setName] = useState('');
  const [organizationName, setOrganizationName] = useState('');
  const [verifiedContact, setVerifiedContact] = useState(null); // { type: 'email'|'phone', value }
  const [verificationToken, setVerificationToken] = useState(null);
  const [accountEmail, setAccountEmail] = useState(''); // only shown when phone verification is used
  const [password, setPassword] = useState('');
  const [vertical, setVertical] = useState('generic');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { setUser, setToken, setTenant } = useContext(AuthContext);
  const navigate = useNavigate();

  const isPhoneVerified = verifiedContact?.type === 'phone';

  const handleSignup = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      // Determine the email for the account. When email verification was used
      // the verified contact IS the email. When phone verification was used the
      // user supplies a separate account email via the extra input below.
      const email = verifiedContact?.type === 'email'
        ? verifiedContact.value
        : accountEmail.trim();

      if (!email || !email.includes('@')) {
        setError('A valid email address is required for your account.');
        setLoading(false);
        return;
      }

      const payload = {
        name,
        email,
        password,
        organizationName,
        vertical,
        verificationToken,
      };
      // Include phone when that was the verified contact so the backend can
      // validate the phone-verified token against it.
      if (verifiedContact?.type === 'phone') {
        payload.phone = verifiedContact.value;
      }

      const response = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const data = await response.json();

      if (response.ok && data.token) {
        setUser(data.user);
        setToken(data.token);
        if (data.tenant && setTenant) setTenant(data.tenant);
        const v = data.tenant?.vertical;
        const destination = v === 'wellness' ? '/wellness' : v === 'travel' ? '/travel' : '/dashboard';
        navigate(destination);
      } else {
        setError(data.message || data.error || 'Registration failed securely. Please verify fields.');
      }
    } catch (err) {
      setError('Network synchronization failed. Please check your connection.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh', padding: '1rem' }}>
      <div className="card glass" style={{ width: '100%', maxWidth: '420px', padding: '2rem' }}>
        <div style={{ textAlign: 'center', marginBottom: '2rem' }}>
          <img
            src="/globussoft-logo-pdf.png"
            alt="Globussoft CRM"
            style={{
              maxWidth: '280px',
              height: 'auto',
              marginBottom: '1rem',
              display: 'block',
              margin: '0 auto 1rem auto',
            }}
          />
          <p style={{ color: 'var(--text-secondary)', marginTop: '0.5rem' }}>Create your organization</p>
        </div>

        {error && (
          <div style={{ backgroundColor: 'var(--danger-color)', color: 'white', padding: '0.75rem', borderRadius: '8px', marginBottom: '1rem', fontSize: '0.875rem' }}>
            {error}
          </div>
        )}

        <form onSubmit={handleSignup}>
          <div style={{ marginBottom: '1rem' }}>
            <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>Organization Name</label>
            <input
              type="text"
              className="input-field"
              placeholder="Acme Inc."
              value={organizationName}
              onChange={(e) => setOrganizationName(e.target.value)}
              required
            />
          </div>
          <div style={{ marginBottom: '1rem' }}>
            <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>Organization Type</label>
            <div style={{ display: 'flex', gap: '1rem' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', fontSize: '0.875rem' }}>
                <input
                  type="radio"
                  name="vertical"
                  value="generic"
                  checked={vertical === 'generic'}
                  onChange={(e) => setVertical(e.target.value)}
                />
                Generic CRM
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', fontSize: '0.875rem' }}>
                <input
                  type="radio"
                  name="vertical"
                  value="wellness"
                  checked={vertical === 'wellness'}
                  onChange={(e) => setVertical(e.target.value)}
                />
                Wellness (Clinic/Salon)
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', fontSize: '0.875rem' }}>
                <input
                  type="radio"
                  name="vertical"
                  value="travel"
                  checked={vertical === 'travel'}
                  onChange={(e) => setVertical(e.target.value)}
                />
                Travel (Agency)
              </label>
            </div>
          </div>
          <div style={{ marginBottom: '1rem' }}>
            <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>Your Full Name</label>
            <input
              type="text"
              className="input-field"
              placeholder="John Doe"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>
          <div style={{ marginBottom: '1rem' }}>
            <ContactVerificationField
              purpose="signup"
              onVerifiedChange={setVerificationToken}
              onContactChange={setVerifiedContact}
              inputClassName="input-field"
            />
          </div>
          {isPhoneVerified && (
            <div style={{ marginBottom: '1rem' }}>
              <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>Account Email</label>
              <input
                type="email"
                className="input-field"
                placeholder="name@company.com"
                value={accountEmail}
                onChange={(e) => setAccountEmail(e.target.value)}
                required
                autoComplete="email"
              />
              <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
                Your email is used for account login and notifications.
              </p>
            </div>
          )}
          <div style={{ marginBottom: '1.5rem' }}>
            <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>Secure Password</label>
            <PasswordInput
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={6}
              autoComplete="new-password"
            />
          </div>
          <button type="submit" className="btn-primary" style={{ width: '100%', opacity: !verificationToken ? 0.6 : 1 }} disabled={loading || !verificationToken}>
            {loading ? 'Creating organization...' : !verificationToken ? 'Verify your email or phone to continue' : 'Create Organization'}
          </button>
        </form>

        <div style={{ marginTop: '1.5rem', textAlign: 'center', fontSize: '0.875rem' }}>
          <span style={{ color: 'var(--text-secondary)' }}>Already have an account? </span>
          <Link to="/login" style={{ color: 'var(--primary-color)', textDecoration: 'none', fontWeight: '500' }}>
            Sign in
          </Link>
        </div>
      </div>
    </div>
  );
};

export default Signup;
