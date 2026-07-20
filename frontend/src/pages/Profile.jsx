import React, { useState, useEffect, useContext, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { User, Mail, Key, Save, Stethoscope, Download, FileText, Camera, Trash2, AlertTriangle } from 'lucide-react';
import { fetchApi, getAuthToken } from '../utils/api';
import { AuthContext } from '../App';
import { useNotify } from '../utils/notify';
import { formatDateLong } from '../utils/date';
import PasswordInput from '../components/PasswordInput';

// #641 — practitioner-specific profile sections (specialty, license, etc.)
// must ONLY render for users whose wellnessRole identifies them as a
// clinical practitioner. Pre-fix the Wellness Demo User saw a phantom
// "Practitioner" profile row because the seed had quietly assigned
// wellnessRole='professional' AND the page rendered the practitioner
// section unconditionally. The seed fix (seed-wellness.js Demo User
// wellnessRole=null) closes the data-side; this guard closes the
// render-side so a future seed regression can't reintroduce the bit.
const PRACTITIONER_WELLNESS_ROLES = new Set(['doctor', 'professional']);
function isPractitioner(profile) {
  return !!profile && PRACTITIONER_WELLNESS_ROLES.has(profile.wellnessRole);
}

const Profile = () => {
  const { user: authUser, setUser: setAuthUser, setToken, subscription } = useContext(AuthContext);
  const notify = useNotify();
  const navigate = useNavigate();
  const [profile, setProfile] = useState(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [profileMsg, setProfileMsg] = useState({ text: '', type: '' });
  const [passwordMsg, setPasswordMsg] = useState({ text: '', type: '' });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);
  // Billing history — paid subscriptions tied to this admin. ADMIN-only on
  // the backend; we still call it from any role's Profile page and just
  // render nothing on 403 so the page itself doesn't error.
  const [invoices, setInvoices] = useState([]);
  const [invoicesLoaded, setInvoicesLoaded] = useState(false);
  const [downloadingId, setDownloadingId] = useState(null);
  const [uploadingPicture, setUploadingPicture] = useState(false);
  const fileInputRef = useRef(null);
  // Danger zone — two-stage: "Delete account" arms the confirm area
  // (password / TOTP inputs), then a destructive modal is the final gate.
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [deletePassword, setDeletePassword] = useState('');
  const [deleteCode, setDeleteCode] = useState('');
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    loadProfile();
    loadInvoices();
  }, []);

  const loadInvoices = async () => {
    try {
      const data = await fetchApi('/api/subscriptions/invoices', { silent: true });
      setInvoices(Array.isArray(data) ? data : []);
    } catch {
      // Non-admin role gets 403 → just leave invoices empty, hide the
      // section. Network errors also silently no-op.
      setInvoices([]);
    } finally {
      setInvoicesLoaded(true);
    }
  };

  const downloadInvoicePdf = async (subId, invoiceNum) => {
    setDownloadingId(subId);
    try {
      const token = getAuthToken();
      // Relative path → same-origin via Vite's /api proxy. A VITE_API_URL
      // prefix would make this cross-origin (CORS preflight 401 + mixed-content
      // over HTTPS). See Invoices.jsx downloadPdf for the canonical note.
      const url = `/api/subscriptions/${subId}/invoice.pdf`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`Download failed (${res.status})`);
      const blob = await res.blob();
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `${invoiceNum || `subscription-${subId}`}.pdf`;
      link.click();
      URL.revokeObjectURL(link.href);
    } catch (err) {
      notify.error(`Could not download invoice: ${err.message || 'unknown error'}`);
    } finally {
      setDownloadingId(null);
    }
  };

  const loadProfile = async () => {
    try {
      const data = await fetchApi('/api/auth/me');
      setProfile(data);
      setName(data.name || '');
      setEmail(data.email || '');
    } catch (err) {
      setProfileMsg({ text: 'Failed to load profile', type: 'error' });
    }
    setLoading(false);
  };

  const formatDate = (date) => {
    if (!date) return '';
    return new Date(date).toLocaleDateString('en-IN', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
  };

  const handleUpdateProfile = async (e) => {
    e.preventDefault();
    setProfileMsg({ text: '', type: '' });

    // #606: skip the PATCH when nothing changed. Pre-fix every Save click
    // sent {name, email} unconditionally and the success toast fired even
    // when the user didn't touch the form — trains users to ignore toasts
    // and pollutes audit logs with no-op rows.
    const trimmedName = (name || '').trim();
    const trimmedEmail = (email || '').trim();
    const baselineName = (profile?.name || '').trim();
    const baselineEmail = (profile?.email || '').trim();
    const changed = {};
    if (trimmedName !== baselineName) changed.name = trimmedName;
    if (trimmedEmail !== baselineEmail) changed.email = trimmedEmail;
    if (Object.keys(changed).length === 0) {
      setProfileMsg({ text: 'No changes to save', type: 'info' });
      return;
    }

    setSaving(true);
    try {
      const updated = await fetchApi('/api/auth/me', {
        method: 'PUT',
        body: JSON.stringify(changed)
      });
      setProfile(updated);
      if (setAuthUser && authUser) {
        setAuthUser({ ...authUser, name: updated.name, email: updated.email });
      }
      setProfileMsg({ text: 'Profile updated successfully', type: 'success' });
    } catch (err) {
      setProfileMsg({ text: err.message || 'Failed to update profile', type: 'error' });
    }
    setSaving(false);
  };

  const handlePickPicture = () => {
    if (fileInputRef.current) fileInputRef.current.click();
  };

  const handlePictureSelected = async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;

    if (!/^image\//.test(file.type)) {
      notify.error('Please choose an image file (JPEG, PNG, GIF, or WebP).');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      notify.error('Image must be 5 MB or smaller.');
      return;
    }

    setUploadingPicture(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const token = getAuthToken();
      // Relative path keeps the request same-origin (see downloadInvoicePdf
      // above for the full rationale — VITE_API_URL prefix → cross-origin →
      // preflight 401 → CORS error).
      const res = await fetch(`/api/auth/me/profile-picture`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);
      setProfile((prev) => ({ ...(prev || {}), profilePicture: data.profilePicture }));
      if (setAuthUser && authUser) {
        setAuthUser({ ...authUser, profilePicture: data.profilePicture });
      }
      notify.success('Profile picture updated');
    } catch (err) {
      notify.error(err.message || 'Failed to upload profile picture');
    } finally {
      setUploadingPicture(false);
    }
  };

  const handleRemovePicture = async () => {
    if (!profile?.profilePicture) return;
    const ok = await notify.confirm({
      title: 'Remove profile picture',
      message: 'Your profile picture will be removed and replaced with your initials.',
      confirmText: 'Remove',
      cancelText: 'Cancel',
      destructive: true,
    });
    if (!ok) return;

    setUploadingPicture(true);
    try {
      const updated = await fetchApi('/api/auth/me/profile-picture', { method: 'DELETE' });
      setProfile((prev) => ({ ...(prev || {}), profilePicture: updated.profilePicture }));
      if (setAuthUser && authUser) {
        setAuthUser({ ...authUser, profilePicture: updated.profilePicture });
      }
      notify.success('Profile picture removed');
    } catch (err) {
      notify.error(err.message || 'Failed to remove profile picture');
    } finally {
      setUploadingPicture(false);
    }
  };

  const handleChangePassword = async (e) => {
    e.preventDefault();
    setPasswordMsg({ text: '', type: '' });
    if (newPassword !== confirmPassword) {
      setPasswordMsg({ text: 'New passwords do not match', type: 'error' });
      return;
    }
    if (newPassword.length < 6) {
      setPasswordMsg({ text: 'Password must be at least 6 characters', type: 'error' });
      return;
    }
    setChangingPassword(true);
    try {
      await fetchApi('/api/auth/me', {
        method: 'PUT',
        body: JSON.stringify({ currentPassword, newPassword })
      });
      setPasswordMsg({ text: 'Password changed successfully', type: 'success' });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err) {
      setPasswordMsg({ text: err.message || 'Failed to change password', type: 'error' });
    }
    setChangingPassword(false);
  };

  const handleDeleteAccount = async () => {
    // SSO accounts have no usable password (the backend skips the check for
    // them); everyone else must re-authenticate before the final modal.
    if (!profile?.ssoProvider && !deletePassword) {
      notify.error('Enter your current password to delete your account.');
      return;
    }
    if (profile?.twoFactorEnabled && !deleteCode.trim()) {
      notify.error('Enter your two-factor verification code to delete your account.');
      return;
    }

    const ok = await notify.confirm({
      title: 'Delete your account?',
      message: 'This action is irreversible. Your account and all data associated with it will be permanently deleted, and you will be signed out immediately.',
      confirmText: 'Delete my account',
      cancelText: 'Cancel',
      destructive: true,
    });
    if (!ok) return;

    setDeleting(true);
    try {
      await fetchApi('/api/auth/me/account', {
        method: 'DELETE',
        body: JSON.stringify({
          confirmDestructive: true,
          ...(profile?.ssoProvider ? {} : { password: deletePassword }),
          ...(profile?.twoFactorEnabled ? { code: deleteCode.trim() } : {}),
        }),
      });
      // The server already revoked the session jti and dropped the auth
      // cookie — mirror Layout's handleLogout local cleanup, minus the
      // POST /logout call (the token is dead and the user row is gone).
      notify.success('Your account has been permanently deleted.');
      if (setAuthUser) setAuthUser(null);
      if (setToken) setToken(null);
      try {
        localStorage.removeItem('token');
      } catch {
        /* ignore */
      }
      navigate('/login', { replace: true });
    } catch {
      // fetchApi already surfaced the server error as a toast (wrong
      // password, last admin, etc.) — just unfreeze the button.
      setDeleting(false);
    }
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%', color: 'var(--text-secondary)' }}>
        Loading profile...
      </div>
    );
  }

  return (
    <div style={{ padding: '2rem', maxWidth: '720px', margin: '0 auto' }}>
      <h1 style={{ fontSize: '1.75rem', fontWeight: 'bold', marginBottom: '0.5rem', color: 'var(--text-primary)' }}>
        My Profile
      </h1>
      <p style={{ color: 'var(--text-secondary)', marginBottom: '2rem', fontSize: '0.9rem' }}>
        Manage your account settings and change your password.
      </p>

      {/* Subscription Info Badge */}
      {subscription?.subscriptionStatus === 'TRIAL' ? (
        <div style={{
          background: 'rgba(255, 193, 7, 0.1)',
          border: '1px solid #ffc107',
          borderRadius: '8px',
          padding: '12px 16px',
          marginBottom: '1.5rem'
        }}>
          <div style={{ fontSize: '12px', color: '#ffc107', fontWeight: 'bold', marginBottom: '6px' }}>
            ⏱ FREE TRIAL
          </div>
          <div style={{ fontSize: '14px', color: 'var(--text-primary)', fontWeight: '500', marginBottom: '4px' }}>
            {subscription.trialDaysRemaining || 0} days remaining
          </div>
          {subscription.trialEndsAt && (
            <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '8px' }}>
              Trial ends {formatDate(subscription.trialEndsAt)}
            </div>
          )}
          <a href="/pricing" style={{
            color: '#ffc107',
            fontSize: '12px',
            textDecoration: 'none',
            fontWeight: '600',
            display: 'inline-block'
          }}>
            Upgrade Now →
          </a>
        </div>
      ) : subscription?.subscriptionStatus === 'ACTIVE' && subscription?.subscription ? (
        <div style={{
          background: 'rgba(34, 197, 94, 0.1)',
          border: '1px solid #22c55e',
          borderRadius: '8px',
          padding: '12px 16px',
          marginBottom: '1.5rem',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
        }}>
          <div>
            <div style={{ fontSize: '12px', color: '#888' }}>Current Plan</div>
            <div style={{ fontSize: '16px', fontWeight: 'bold', color: 'var(--text-primary)' }}>
              {subscription.subscription.planName}
            </div>
          </div>
          <div style={{ textAlign: 'right', display: 'flex', alignItems: 'center', gap: 16 }}>
            <div>
              <div style={{ fontSize: '12px', color: '#888' }}>Expires</div>
              <div style={{ fontSize: '16px', color: '#22c55e', fontWeight: '600' }}>
                {formatDate(subscription.subscription.endDate)}
              </div>
            </div>
            {/* Download the most recent paid invoice. Invoices list is
                pre-sorted newest-first so [0] is always the latest payment
                that produced the current ACTIVE subscription. Hidden for
                non-admin roles (the invoices fetch silently 403s for them
                and `invoices` stays empty). */}
            {invoices.length > 0 && (
              <button
                onClick={() => downloadInvoicePdf(invoices[0].id, invoices[0].invoiceNum)}
                disabled={downloadingId === invoices[0].id}
                title="Download the latest invoice as PDF"
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  padding: '8px 14px', fontSize: '13px', fontWeight: 600,
                  background: '#22c55e', color: '#fff', border: 'none',
                  borderRadius: 6, cursor: downloadingId === invoices[0].id ? 'wait' : 'pointer',
                  opacity: downloadingId === invoices[0].id ? 0.7 : 1,
                  fontFamily: 'inherit',
                }}
              >
                <Download size={14} />
                {downloadingId === invoices[0].id ? 'Generating…' : 'Invoice PDF'}
              </button>
            )}
          </div>
        </div>
      ) : null}

      {/* Billing history — full list of past subscription payments, each
          with its own PDF download. Hidden when invoices list is empty
          (anonymous + non-admin roles + brand-new users on TRIAL). */}
      {invoicesLoaded && invoices.length > 0 && (
        <div className="card glass" style={{ padding: '1.5rem', marginBottom: '1.5rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: '1rem' }}>
            <FileText size={18} color="var(--accent-color)" />
            <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 600 }}>Billing History</h3>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {invoices.map((inv) => (
              <div
                key={inv.id}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '12px 14px', borderRadius: 8,
                  border: '1px solid var(--border-color)',
                  background: 'var(--subtle-bg-1, transparent)',
                  gap: 12, flexWrap: 'wrap',
                }}
              >
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: '0.9rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                    {inv.invoiceNum} · {inv.planName}
                  </div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: 2 }}>
                    {formatDate(inv.startDate)}
                    {inv.endDate ? ` → ${formatDate(inv.endDate)}` : ''} · {inv.status}
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={{ fontSize: '0.9rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                    {inv.currency === 'INR' ? '₹' : (inv.currency === 'USD' ? '$' : '')}
                    {Number(inv.amount).toLocaleString()}
                  </div>
                  <button
                    onClick={() => downloadInvoicePdf(inv.id, inv.invoiceNum)}
                    disabled={downloadingId === inv.id}
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 6,
                      padding: '6px 12px', fontSize: '0.78rem', fontWeight: 600,
                      background: 'transparent', color: 'var(--accent-color)',
                      border: '1px solid var(--accent-color)', borderRadius: 6,
                      cursor: downloadingId === inv.id ? 'wait' : 'pointer',
                      opacity: downloadingId === inv.id ? 0.7 : 1,
                      fontFamily: 'inherit',
                    }}
                  >
                    <Download size={12} />
                    {downloadingId === inv.id ? 'Generating…' : 'PDF'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Profile Info Card */}
      <div className="card glass" style={{ padding: '1.5rem', marginBottom: '1.5rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1.5rem' }}>
          <div style={{ position: 'relative', width: 80, height: 80, flexShrink: 0 }}>
            {profile?.profilePicture ? (
              <img
                src={profile.profilePicture}
                alt={profile?.name || 'Profile'}
                style={{
                  width: 80, height: 80, borderRadius: '50%',
                  objectFit: 'cover', display: 'block',
                  border: '2px solid var(--border-color, rgba(255,255,255,0.15))',
                }}
              />
            ) : (
              <div style={{
                width: 80, height: 80, borderRadius: '50%',
                background: 'linear-gradient(135deg, var(--accent-color), var(--primary-color))',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: '1.75rem', fontWeight: 'bold', color: '#fff',
              }}>
                {(profile?.name || '?').charAt(0).toUpperCase()}
              </div>
            )}
            <button
              type="button"
              onClick={handlePickPicture}
              disabled={uploadingPicture}
              title={profile?.profilePicture ? 'Change profile picture' : 'Upload profile picture'}
              aria-label={profile?.profilePicture ? 'Change profile picture' : 'Upload profile picture'}
              style={{
                position: 'absolute', right: -4, bottom: -4,
                width: 28, height: 28, borderRadius: '50%',
                background: 'var(--primary-color, var(--accent-color))',
                color: '#fff', border: '2px solid var(--surface-color, #fff)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                cursor: uploadingPicture ? 'wait' : 'pointer',
                opacity: uploadingPicture ? 0.7 : 1,
                padding: 0,
              }}
            >
              <Camera size={14} />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/gif,image/webp"
              onChange={handlePictureSelected}
              style={{ display: 'none' }}
            />
          </div>
          <div>
            <h2 style={{ fontSize: '1.15rem', fontWeight: '600', color: 'var(--text-primary)', margin: 0 }}>
              {profile?.name || 'Unknown'}
            </h2>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', margin: '0.15rem 0 0' }}>
              {profile?.email}
            </p>
            {profile?.profilePicture && (
              <button
                type="button"
                onClick={handleRemovePicture}
                disabled={uploadingPicture}
                style={{
                  background: 'transparent', border: 'none', padding: 0,
                  color: '#ef4444', fontSize: '0.75rem', cursor: uploadingPicture ? 'wait' : 'pointer',
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                  marginTop: '0.25rem', fontFamily: 'inherit',
                }}
              >
                <Trash2 size={12} /> Remove picture
              </button>
            )}
            <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.35rem', flexWrap: 'wrap' }}>
              <span style={{
                display: 'inline-block',
                padding: '2px 10px', borderRadius: '12px', fontSize: '0.75rem', fontWeight: '600',
                background: profile?.role === 'ADMIN' ? 'rgba(239,68,68,0.15)' : profile?.role === 'MANAGER' ? 'rgba(245,158,11,0.15)' : 'rgba(59,130,246,0.15)',
                color: profile?.role === 'ADMIN' ? '#ef4444' : profile?.role === 'MANAGER' ? '#f59e0b' : '#3b82f6'
              }}>
                {profile?.role}
              </span>
              {/* #641: only show the wellnessRole pill when one is actually
                  set. Demo User has wellnessRole=null and previously the
                  seed had this as 'professional' — the badge would
                  mislabel them as a practitioner. Now hidden when null/empty. */}
              {profile?.wellnessRole && (
                <span
                  data-testid="profile-wellness-role-badge"
                  style={{
                    display: 'inline-block',
                    padding: '2px 10px', borderRadius: '12px', fontSize: '0.75rem', fontWeight: '600',
                    background: 'rgba(160,124,74,0.15)', color: 'var(--accent-color, #a07c4a)',
                    textTransform: 'capitalize',
                  }}
                >
                  {profile.wellnessRole}
                </span>
              )}
            </div>
          </div>
        </div>

        {profile?.createdAt && (
          <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
            Member since {formatDateLong(profile.createdAt)}
          </p>
        )}
      </div>

      {/* #641: practitioner-specific section only rendered for users with
          wellnessRole === 'doctor' or 'professional'. Pre-fix this section
          (or its seed-data equivalent) appeared for the Demo User because
          their wellnessRole was 'professional' in the seed. Both sides now
          fixed: (a) seed sets wellnessRole=null for Demo User; (b) this
          guard ensures even if a future seed regression flips it, only
          actual clinical staff see the practitioner block. */}
      {isPractitioner(profile) && (
        <div className="card glass" data-testid="profile-practitioner-section" style={{ padding: '1.5rem', marginBottom: '1.5rem' }}>
          <h3 style={{ fontSize: '1rem', fontWeight: '600', color: 'var(--text-primary)', marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Stethoscope size={18} /> Practitioner Profile
          </h3>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: '0.5rem' }}>
            Your clinical role: <strong style={{ color: 'var(--text-primary)', textTransform: 'capitalize' }}>{profile.wellnessRole}</strong>
          </p>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', margin: 0 }}>
            Practitioner-specific fields (specialty, license number, signature image) are managed by your clinic admin under Settings → Staff.
          </p>
        </div>
      )}

      {/* Edit Profile */}
      <div className="card glass" style={{ padding: '1.5rem', marginBottom: '1.5rem' }}>
        <h3 style={{ fontSize: '1rem', fontWeight: '600', color: 'var(--text-primary)', marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <User size={18} /> Edit Profile
        </h3>
        <form onSubmit={handleUpdateProfile}>
          <div style={{ marginBottom: '1rem' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.4rem', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
              <User size={14} /> Name
            </label>
            <input
              type="text"
              className="input-field"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your name"
            />
          </div>
          <div style={{ marginBottom: '1rem' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.4rem', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
              <Mail size={14} /> Email
            </label>
            <input
              type="email"
              className="input-field"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Your email"
            />
          </div>
          <div style={{ marginBottom: '1rem' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.4rem', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
              Role
            </label>
            <input
              type="text"
              className="input-field"
              value={profile?.role || ''}
              disabled
              style={{ opacity: 0.6, cursor: 'not-allowed' }}
            />
          </div>

          {profileMsg.text && (
            <div style={{
              padding: '0.6rem 0.75rem', borderRadius: '6px', marginBottom: '1rem', fontSize: '0.85rem',
              background: profileMsg.type === 'success'
                ? 'rgba(16,185,129,0.12)'
                : profileMsg.type === 'info'
                  ? 'rgba(59,130,246,0.12)'
                  : 'rgba(239,68,68,0.12)',
              color: profileMsg.type === 'success'
                ? '#10b981'
                : profileMsg.type === 'info'
                  ? '#3b82f6'
                  : '#ef4444'
            }}>
              {profileMsg.text}
            </div>
          )}

          <button type="submit" className="btn-primary" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }} disabled={saving}>
            <Save size={16} /> {saving ? 'Saving...' : 'Save Changes'}
          </button>
        </form>
      </div>

      {/* Change Password */}
      <div className="card glass" style={{ padding: '1.5rem' }}>
        <h3 style={{ fontSize: '1rem', fontWeight: '600', color: 'var(--text-primary)', marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Key size={18} /> Change Password
        </h3>
        <form onSubmit={handleChangePassword}>
          <div style={{ marginBottom: '1rem' }}>
            <label style={{ display: 'block', marginBottom: '0.4rem', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
              Current Password
            </label>
            <PasswordInput
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              placeholder="Enter current password"
              autoComplete="current-password"
            />
          </div>
          <div style={{ marginBottom: '1rem' }}>
            <label style={{ display: 'block', marginBottom: '0.4rem', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
              New Password
            </label>
            <PasswordInput
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="Enter new password"
              autoComplete="new-password"
            />
          </div>
          <div style={{ marginBottom: '1rem' }}>
            <label style={{ display: 'block', marginBottom: '0.4rem', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
              Confirm New Password
            </label>
            <PasswordInput
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Confirm new password"
              autoComplete="new-password"
            />
          </div>

          {passwordMsg.text && (
            <div style={{
              padding: '0.6rem 0.75rem', borderRadius: '6px', marginBottom: '1rem', fontSize: '0.85rem',
              background: passwordMsg.type === 'success' ? 'rgba(16,185,129,0.12)' : 'rgba(239,68,68,0.12)',
              color: passwordMsg.type === 'success' ? '#10b981' : '#ef4444'
            }}>
              {passwordMsg.text}
            </div>
          )}

          <button type="submit" className="btn-primary" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }} disabled={changingPassword}>
            <Key size={16} /> {changingPassword ? 'Changing...' : 'Change Password'}
          </button>
        </form>
      </div>

      {/* Danger Zone — self-service account deletion (privacy policy §10.1).
          Renders identically for all three verticals (generic / wellness /
          travel); --danger-color is themed per vertical in CSS. */}
      <div
        className="card glass"
        data-testid="profile-danger-zone"
        style={{ padding: '1.5rem', marginTop: '1.5rem', border: '1px solid rgba(239,68,68,0.45)' }}
      >
        <h3 style={{ fontSize: '1rem', fontWeight: '600', color: 'var(--danger-color, #ef4444)', marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <AlertTriangle size={18} /> Danger Zone
        </h3>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: '1rem' }}>
          Permanently delete your account. This action is irreversible — your account and all data
          associated with it will be deleted, and you will be signed out immediately.
        </p>

        {!deleteArmed ? (
          <button
            type="button"
            className="btn-danger"
            data-testid="profile-delete-account-button"
            onClick={() => setDeleteArmed(true)}
            style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}
          >
            <Trash2 size={16} /> Delete account
          </button>
        ) : (
          <div data-testid="profile-delete-account-confirm">
            {!profile?.ssoProvider && (
              <div style={{ marginBottom: '1rem' }}>
                <label style={{ display: 'block', marginBottom: '0.4rem', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                  Confirm with your current password
                </label>
                <PasswordInput
                  value={deletePassword}
                  onChange={(e) => setDeletePassword(e.target.value)}
                  placeholder="Current password"
                  autoComplete="current-password"
                />
              </div>
            )}
            {profile?.twoFactorEnabled && (
              <div style={{ marginBottom: '1rem' }}>
                <label style={{ display: 'block', marginBottom: '0.4rem', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                  Two-factor verification code
                </label>
                <input
                  type="text"
                  className="input-field"
                  value={deleteCode}
                  onChange={(e) => setDeleteCode(e.target.value)}
                  placeholder="6-digit code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                />
              </div>
            )}
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              <button
                type="button"
                className="btn-danger"
                data-testid="profile-delete-account-submit"
                onClick={handleDeleteAccount}
                disabled={deleting}
                style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}
              >
                <Trash2 size={16} /> {deleting ? 'Deleting…' : 'Permanently delete my account'}
              </button>
              <button
                type="button"
                className="btn-secondary"
                data-testid="profile-delete-account-cancel"
                onClick={() => {
                  setDeleteArmed(false);
                  setDeletePassword('');
                  setDeleteCode('');
                }}
                disabled={deleting}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default Profile;
