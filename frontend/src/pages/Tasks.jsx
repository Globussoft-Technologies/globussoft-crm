import React, { useState, useEffect } from 'react';
import { fetchApi } from '../utils/api';
import { CheckCircle2, Phone, Calendar, Search, Plus } from 'lucide-react';

export default function Tasks() {
  const [tasks, setTasks] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [newTask, setNewTask] = useState({ title: '', dueDate: '', contactId: '', notes: '' });

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      const t = await fetchApi('/api/tasks');
      setTasks(Array.isArray(t) ? t : []);
      const c = await fetchApi('/api/contacts');
      setContacts(Array.isArray(c) ? c : []);
    } catch (err) {
      console.error(err);
    }
  };

  const createTask = async (e) => {
    e.preventDefault();
    try {
      await fetchApi('/api/tasks', { method: 'POST', body: JSON.stringify(newTask) });
      setNewTask({ title: '', dueDate: '', contactId: '', notes: '' });
      loadData();
    } catch (err) {
      alert("Failed to enqueue task");
    }
  };

  const markComplete = async (id) => {
    try {
      await fetchApi(`/api/tasks/${id}/complete`, { method: 'PUT' });
      loadData();
    } catch (err) {
      console.error(err);
    }
  };

  const activeTasks = tasks.filter(t => t.status !== 'Completed');
  const completedTasks = tasks.filter(t => t.status === 'Completed');

  return (
    <div style={{ padding: '2rem', height: '100%', overflowY: 'auto', animation: 'fadeIn 0.5s ease-out' }}>
      <header style={{ marginBottom: '2.5rem' }}>
        <h1 style={{ fontSize: '2rem', fontWeight: 'bold' }}>Agent Task Queue</h1>
        <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>Organize daily follow-ups and instantly queue outbound dials to high-priority targets.</p>
      </header>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '2rem' }}>
        
        {/* Enqueue Panel */}
        <div className="card" style={{ padding: '2rem', height: 'fit-content' }}>
          <h3 style={{ fontSize: '1.25rem', fontWeight: '600', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Plus size={20} color="var(--accent-color)" /> Enqueue Activity
          </h3>
          <form onSubmit={createTask} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            <div>
              <label style={{ display: 'block', fontSize: '0.875rem', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>Directive Title</label>
              <input type="text" required className="input-field" placeholder="e.g. Q3 Renewal Call" value={newTask.title} onChange={e => setNewTask({...newTask, title: e.target.value})} />
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.875rem', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>Associated Entity (Contact)</label>
              <select className="input-field" value={newTask.contactId} onChange={e => setNewTask({...newTask, contactId: e.target.value})} style={{ background: '#0f172a' }}>
                <option value="">-- Unassigned --</option>
                {contacts.map(c => <option key={c.id} value={c.id}>{c.name} ({c.email})</option>)}
              </select>
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.875rem', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>Execution Deadline</label>
              <input type="datetime-local" className="input-field" value={newTask.dueDate} onChange={e => setNewTask({...newTask, dueDate: e.target.value})} />
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.875rem', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>Execution Notes</label>
              <textarea className="input-field" rows="3" placeholder="Briefing notes for the agent..." value={newTask.notes} onChange={e => setNewTask({...newTask, notes: e.target.value})}></textarea>
            </div>

            <button type="submit" className="btn-primary" style={{ padding: '1rem' }}>Assign Task</button>
          </form>
        </div>

        {/* Priority Queue Log */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
          
          <div className="card" style={{ padding: '2rem' }}>
            <h3 style={{ fontSize: '1.25rem', fontWeight: '600', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Phone size={20} color="var(--danger-color)" /> Active Priority Queue
            </h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              {activeTasks.length === 0 ? (
                <p style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '2rem' }}>Queue is currently empty. Excellent work.</p>
              ) : activeTasks.map(t => (
                <div key={t.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '1.25rem', background: 'rgba(255,255,255,0.02)', borderLeft: '4px solid var(--accent-color)', borderRadius: '0 8px 8px 0', transition: '0.2s' }}>
                  <div>
                    <h4 style={{ fontWeight: '600', fontSize: '1.1rem', marginBottom: '0.25rem' }}>{t.title}</h4>
                    {t.contact && (
                      <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
                        <Search size={14}/> Entity Target: <strong style={{color: '#fff'}}>{t.contact.name}</strong> • {t.contact.email}
                      </p>
                    )}
                    {t.dueDate && (
                      <p style={{ fontSize: '0.875rem', color: 'var(--danger-color)', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <Calendar size={14}/> Execute by: {new Date(t.dueDate).toLocaleString()}
                      </p>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    {t.contact && t.contact.phone && (
                      <button className="btn-secondary" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: 'var(--accent-color)', color: '#fff', border: 'none' }} onClick={() => alert(`Calling ${t.contact.phone}...`)}>
                        <Phone size={16}/> Connect
                      </button>
                    )}
                    <button onClick={() => markComplete(t.id)} className="btn-secondary" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: 'var(--success-color)', color: '#fff', border: 'none' }}>
                      <CheckCircle2 size={16}/> Resolve
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="card" style={{ padding: '2rem', opacity: 0.7 }}>
            <h3 style={{ fontSize: '1.25rem', fontWeight: '600', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <CheckCircle2 size={20} color="var(--success-color)" /> Completed Log
            </h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {completedTasks.slice(0, 5).map(t => (
                <div key={t.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '0.75rem 1rem', background: 'rgba(255,255,255,0.01)', borderRadius: '4px' }}>
                  <span style={{ textDecoration: 'line-through', color: 'var(--text-secondary)' }}>{t.title}</span>
                  <span style={{ fontSize: '0.75rem', color: 'var(--success-color)' }}>Resolved</span>
                </div>
              ))}
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
