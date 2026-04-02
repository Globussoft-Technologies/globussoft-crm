import React, { useState, useEffect, useContext } from 'react';
import { User, Mail, Key, Save } from 'lucide-react';
import { fetchApi } from '../utils/api';
import { AuthContext } from '../App';

const Profile = () => {
  const { user: authUser, setUser: setAuthUser } = useContext(AuthContext);
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

  useEffect(() => {
    loadProfile();
  }, []);

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

  const handleUpdateProfile = async (e) => {
    e.preventDefault();
    setSaving(true);
    setProfileMsg({ text: '', type: '' });
    try {
      const updated = await fetchApi('/api/auth/me', {
        method: 'PUT',
        body: JSON.stringify({ name, email })
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

      {/* Profile Info Card */}
      <div className="card glass" style={{ padding: '1.5rem', marginBottom: '1.5rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1.5rem' }}>
          <div style={{
            width: 56, height: 56, borderRadius: '50%',
            background: 'linear-gradient(135deg, var(--accent-color), var(--primary-color))',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: '1.25rem', fontWeight: 'bold', color: '#fff'
          }}>
            {(profile?.name || '?').charAt(0).toUpperCase()}
          </div>
          <div>
            <h2 style={{ fontSize: '1.15rem', fontWeight: '600', color: 'var(--text-primary)', margin: 0 }}>
              {profile?.name || 'Unknown'}
            </h2>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', margin: '0.15rem 0 0' }}>
              {profile?.email}
            </p>
            <span style={{
              display: 'inline-block', marginTop: '0.35rem',
              padding: '2px 10px', borderRadius: '12px', fontSize: '0.75rem', fontWeight: '600',
              background: profile?.role === 'ADMIN' ? 'rgba(239,68,68,0.15)' : profile?.role === 'MANAGER' ? 'rgba(245,158,11,0.15)' : 'rgba(59,130,246,0.15)',
              color: profile?.role === 'ADMIN' ? '#ef4444' : profile?.role === 'MANAGER' ? '#f59e0b' : '#3b82f6'
            }}>
              {profile?.role}
            </span>
          </div>
        </div>

        {profile?.createdAt && (
          <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
            Member since {new Date(profile.createdAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}
          </p>
        )}
      </div>

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
              background: profileMsg.type === 'success' ? 'rgba(16,185,129,0.12)' : 'rgba(239,68,68,0.12)',
              color: profileMsg.type === 'success' ? '#10b981' : '#ef4444'
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
            <input
              type="password"
              className="input-field"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              placeholder="Enter current password"
            />
          </div>
          <div style={{ marginBottom: '1rem' }}>
            <label style={{ display: 'block', marginBottom: '0.4rem', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
              New Password
            </label>
            <input
              type="password"
              className="input-field"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="Enter new password"
            />
          </div>
          <div style={{ marginBottom: '1rem' }}>
            <label style={{ display: 'block', marginBottom: '0.4rem', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
              Confirm New Password
            </label>
            <input
              type="password"
              className="input-field"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Confirm new password"
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
    </div>
  );
};

export default Profile;
