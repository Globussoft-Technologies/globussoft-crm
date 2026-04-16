import React, { useState, useEffect, useContext } from 'react';
import { Shield, UserPlus, Trash2, Key, Sun, Moon, Plus, ArrowUp, ArrowDown, Layers, Building2 } from 'lucide-react';
import { fetchApi } from '../utils/api';
import { ThemeContext, AuthContext } from '../App';

export default function Settings() {
  const { theme, toggleTheme } = useContext(ThemeContext);
  const { tenant: ctxTenant, setTenant } = useContext(AuthContext);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [newUser, setNewUser] = useState({ name: '', email: '', password: '', role: 'USER' });
  const [pipelineStages, setPipelineStages] = useState([]);
  const [newStage, setNewStage] = useState({ name: '', color: '#3b82f6' });
  const [stagesLoading, setStagesLoading] = useState(true);
  const [tenant, setTenantState] = useState(ctxTenant || null);
  const [tenantSaving, setTenantSaving] = useState(false);

  useEffect(() => {
    fetchApi('/api/tenants/current')
      .then((res) => { setTenantState(res); if (setTenant) setTenant(res); })
      .catch(() => { /* tenant endpoint may not be reachable */ });
  }, []);

  const handleSaveTenant = async (e) => {
    e.preventDefault();
    setTenantSaving(true);
    try {
      const updated = await fetchApi('/api/tenants/current', {
        method: 'PUT',
        body: JSON.stringify({ name: tenant.name, ownerEmail: tenant.ownerEmail }),
      });
      setTenantState(updated);
      if (setTenant) setTenant(updated);
    } catch (err) {
      alert('Failed to update organization');
    }
    setTenantSaving(false);
  };

  const fetchStages = () => {
    fetchApi('/api/pipeline_stages')
      .then(res => { setPipelineStages(Array.isArray(res) ? res : []); setStagesLoading(false); })
      .catch(() => setStagesLoading(false));
  };

  useEffect(() => {
    fetchApi('/api/auth/users')
      .then(res => { setUsers(res); setLoading(false); })
      .catch(err => console.error(err));
    fetchStages();
  }, []);

  const handleAddStage = async (e) => {
    e.preventDefault();
    if (!newStage.name.trim()) return;
    try {
      await fetchApi('/api/pipeline_stages', {
        method: 'POST',
        body: JSON.stringify({ name: newStage.name, color: newStage.color, position: pipelineStages.length })
      });
      setNewStage({ name: '', color: '#3b82f6' });
      fetchStages();
    } catch (err) {
      alert('Failed to add stage');
    }
  };

  const handleDeleteStage = async (id) => {
    if (window.confirm('Delete this pipeline stage?')) {
      await fetchApi(`/api/pipeline_stages/${id}`, { method: 'DELETE' });
      fetchStages();
    }
  };

  const handleMoveStage = async (index, direction) => {
    const newStages = [...pipelineStages];
    const swapIndex = index + direction;
    if (swapIndex < 0 || swapIndex >= newStages.length) return;
    [newStages[index], newStages[swapIndex]] = [newStages[swapIndex], newStages[index]];
    const reordered = newStages.map((s, i) => ({ id: s.id, position: i }));
    setPipelineStages(newStages);
    try {
      await fetchApi('/api/pipeline_stages/reorder', {
        method: 'PUT',
        body: JSON.stringify({ stages: reordered })
      });
      fetchStages();
    } catch (err) {
      fetchStages();
    }
  };

  const handleCreateUser = async (e) => {
    e.preventDefault();
    try {
      await fetchApi('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify(newUser)
      });
      const data = await fetchApi('/api/auth/users');
      setUsers(data);
      setNewUser({ name: '', email: '', password: '', role: 'USER' });
    } catch (err) {
      alert("Failed to create user.");
    }
  };

  const handleDelete = async (id) => {
    if (window.confirm("Delete this user?")) {
      await fetchApi(`/api/auth/users/${id}`, { method: 'DELETE' });
      setUsers(users.filter(u => u.id !== id));
    }
  };

  const handleChangeRole = async (id, newRole) => {
    await fetchApi(`/api/auth/users/${id}/role`, { method: 'PUT', body: JSON.stringify({ role: newRole }) });
    setUsers(users.map(u => u.id === id ? { ...u, role: newRole } : u));
  };

  return (
    <div style={{ padding: '2rem', height: '100%', overflowY: 'auto', animation: 'fadeIn 0.5s ease-out' }}>
      <header style={{ marginBottom: '2.5rem' }}>
        <h1 style={{ fontSize: '2rem', fontWeight: 'bold' }}>Organization Settings</h1>
        <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>Manage team members, roles, and administrative security.</p>
      </header>

      <div style={{ display: 'grid', gridTemplateColumns: 'revert', gap: '2rem', maxWidth: '1000px' }}>

        {/* Organization Card */}
        <div className="card" style={{ padding: '2rem' }}>
          <h3 style={{ fontSize: '1.25rem', fontWeight: '600', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Building2 size={20} color="var(--accent-color)" /> Organization
          </h3>
          {tenant ? (
            <form onSubmit={handleSaveTenant} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
              <div>
                <label style={{ display: 'block', marginBottom: '0.4rem', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>Organization Name</label>
                <input type="text" required className="input-field" value={tenant.name || ''} onChange={e => setTenantState({ ...tenant, name: e.target.value })} />
              </div>
              <div>
                <label style={{ display: 'block', marginBottom: '0.4rem', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>Slug</label>
                <input type="text" disabled className="input-field" value={tenant.slug || ''} title="Organization slug is permanent" />
              </div>
              <div>
                <label style={{ display: 'block', marginBottom: '0.4rem', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>Owner Email</label>
                <input type="email" className="input-field" value={tenant.ownerEmail || ''} onChange={e => setTenantState({ ...tenant, ownerEmail: e.target.value })} />
              </div>
              <div>
                <label style={{ display: 'block', marginBottom: '0.4rem', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>Plan</label>
                <input type="text" disabled className="input-field" value={tenant.plan || 'starter'} />
              </div>
              <button type="submit" className="btn-primary" disabled={tenantSaving} style={{ gridColumn: 'span 2' }}>
                {tenantSaving ? 'Saving...' : 'Save Organization Details'}
              </button>
            </form>
          ) : (
            <p style={{ color: 'var(--text-secondary)' }}>Loading organization details…</p>
          )}
        </div>

        {/* Appearance Card */}
        <div className="card" style={{ padding: '2rem' }}>
          <h3 style={{ fontSize: '1.25rem', fontWeight: '600', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            {theme === 'dark' ? <Moon size={20} color="var(--accent-color)" /> : <Sun size={20} color="var(--warning-color)" />} Appearance
          </h3>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <p style={{ fontWeight: '500', fontSize: '1rem' }}>Theme</p>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', marginTop: '0.25rem' }}>
                Switch between dark and light mode
              </p>
            </div>
            <button
              onClick={toggleTheme}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.75rem',
                padding: '0.6rem 1.25rem',
                borderRadius: '10px',
                border: '1px solid var(--border-color)',
                background: theme === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)',
                color: 'var(--text-primary)',
                cursor: 'pointer',
                transition: 'var(--transition)',
                fontFamily: 'var(--font-family)',
                fontWeight: '500',
                fontSize: '0.9rem',
              }}
            >
              {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
              Switch to {theme === 'dark' ? 'Light' : 'Dark'} Mode
            </button>
          </div>
        </div>

        {/* Pipeline Stages Card */}
        <div className="card" style={{ padding: '2rem' }}>
          <h3 style={{ fontSize: '1.25rem', fontWeight: '600', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Layers size={20} color="var(--accent-color)" /> Pipeline Stages
          </h3>

          {stagesLoading ? <p>Loading stages...</p> : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginBottom: '1.5rem' }}>
              {pipelineStages.length === 0 && (
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>No custom stages configured. The pipeline uses default stages.</p>
              )}
              {pipelineStages.map((stage, index) => (
                <div key={stage.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--surface-color)', border: '1px solid var(--border-color)', padding: '1rem 1.25rem', borderRadius: '8px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                    <div style={{ width: '20px', height: '20px', borderRadius: '6px', backgroundColor: stage.color, flexShrink: 0 }} />
                    <span style={{ fontWeight: '500' }}>{stage.name}</span>
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Position {index + 1}</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <button onClick={() => handleMoveStage(index, -1)} disabled={index === 0} style={{ background: 'none', border: 'none', color: index === 0 ? 'var(--border-color)' : 'var(--text-secondary)', cursor: index === 0 ? 'default' : 'pointer', padding: '0.25rem' }}>
                      <ArrowUp size={16} />
                    </button>
                    <button onClick={() => handleMoveStage(index, 1)} disabled={index === pipelineStages.length - 1} style={{ background: 'none', border: 'none', color: index === pipelineStages.length - 1 ? 'var(--border-color)' : 'var(--text-secondary)', cursor: index === pipelineStages.length - 1 ? 'default' : 'pointer', padding: '0.25rem' }}>
                      <ArrowDown size={16} />
                    </button>
                    <button onClick={() => handleDeleteStage(stage.id)} style={{ background: 'none', border: 'none', color: 'var(--danger-color)', cursor: 'pointer', padding: '0.25rem' }}>
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <form onSubmit={handleAddStage} style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
            <input type="text" placeholder="Stage name" required className="input-field" style={{ flex: 1 }} value={newStage.name} onChange={e => setNewStage({ ...newStage, name: e.target.value })} />
            <input type="color" value={newStage.color} onChange={e => setNewStage({ ...newStage, color: e.target.value })} style={{ width: '40px', height: '40px', border: '1px solid var(--border-color)', borderRadius: '8px', cursor: 'pointer', padding: '2px', background: 'var(--input-bg)' }} />
            <button type="submit" className="btn-primary" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', whiteSpace: 'nowrap' }}>
              <Plus size={16} /> Add Stage
            </button>
          </form>
        </div>

        {/* Invite User Card */}
        <div className="card" style={{ padding: '2rem' }}>
          <h3 style={{ fontSize: '1.25rem', fontWeight: '600', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <UserPlus size={20} color="var(--accent-color)" /> Invite Team Member
          </h3>
          <form onSubmit={handleCreateUser} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
             <input type="text" placeholder="Full Name" required className="input-field" value={newUser.name} onChange={e => setNewUser({...newUser, name: e.target.value})} />
             <input type="email" placeholder="Email Address" required className="input-field" value={newUser.email} onChange={e => setNewUser({...newUser, email: e.target.value})} />
             <input type="password" placeholder="Temporary Password" required className="input-field" value={newUser.password} onChange={e => setNewUser({...newUser, password: e.target.value})} />
             <select className="input-field" value={newUser.role} onChange={e => setNewUser({...newUser, role: e.target.value})} style={{ background: 'var(--input-bg)' }}>
               <option value="USER">Standard Rep</option>
               <option value="MANAGER">Sales Manager</option>
               <option value="ADMIN">System Administrator</option>
             </select>
             <button type="submit" className="btn-primary" style={{ gridColumn: 'span 2' }}>Send Invitation & Create Account</button>
          </form>
        </div>

        {/* User Roster */}
        <div className="card" style={{ padding: '2rem' }}>
          <h3 style={{ fontSize: '1.25rem', fontWeight: '600', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Shield size={20} color="var(--success-color)" /> Access Control Roster
          </h3>

          {loading ? <p>Loading team...</p> : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              {users.map(u => (
                <div key={u.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--surface-color)', border: '1px solid var(--border-color)', padding: '1.25rem', borderRadius: '8px' }}>
                  <div>
                    <h4 style={{ fontWeight: '600', fontSize: '1.1rem' }}>{u.name || 'Unknown User'} <span style={{ fontSize: '0.75rem', padding: '0.2rem 0.6rem', background: u.role === 'ADMIN' ? 'rgba(239, 68, 68, 0.2)' : 'rgba(59, 130, 246, 0.2)', color: u.role === 'ADMIN' ? '#ef4444' : '#3b82f6', borderRadius: '12px', marginLeft: '0.5rem' }}>{u.role}</span></h4>
                    <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', marginTop: '0.25rem' }}>{u.email}</p>
                  </div>
                  
                  <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                    <select value={u.role} onChange={(e) => handleChangeRole(u.id, e.target.value)} style={{ padding: '0.5rem', borderRadius: '4px', background: 'var(--input-bg)', color: 'var(--text-primary)', border: '1px solid var(--border-color)' }}>
                      <option value="USER">Standard Rep</option>
                      <option value="MANAGER">Manager</option>
                      <option value="ADMIN">Admin</option>
                    </select>
                    <button onClick={() => handleDelete(u.id)} style={{ background: 'transparent', border: 'none', color: 'var(--danger-color)', cursor: 'pointer', padding: '0.5rem' }}>
                      <Trash2 size={18} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

      </div>
    </div>
  );
}
