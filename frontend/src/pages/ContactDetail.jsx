import { fetchApi } from '../utils/api';
import React, { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Phone, Mail, Calendar } from 'lucide-react';

const ContactDetail = () => {
  const { id } = useParams();
  const [contact, setContact] = useState(null);

  useEffect(() => {
    // Mock fetch for specific user
    fetchApi('/api/contacts').then(data => {
        const found = data.find(c => c.id.toString() === id);
        setContact(found || data[0]); // fallback to first if not found
      });
  }, [id]);

  if (!contact) return <div style={{ padding: '2rem' }}>Loading...</div>;

  return (
    <div style={{ padding: '2rem' }}>
      <Link to="/contacts" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem', color: 'var(--text-secondary)', marginBottom: '1.5rem', textDecoration: 'none' }}>
        <ArrowLeft size={16} /> Back to Contacts
      </Link>
      
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(300px, 1fr) 2fr', gap: '1.5rem' }}>
        {/* Profile Card */}
        <div className="card glass" style={{ padding: '1.5rem', height: 'fit-content' }}>
          <div style={{ width: '80px', height: '80px', borderRadius: '50%', backgroundColor: 'var(--accent-color)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '2rem', fontWeight: 'bold', marginBottom: '1rem' }}>
            {contact.name.charAt(0)}
          </div>
          <h2 style={{ fontSize: '1.5rem', fontWeight: 'bold' }}>{contact.name}</h2>
          <p style={{ color: 'var(--text-secondary)', marginBottom: '1.5rem' }}>{contact.title} at {contact.company}</p>
          
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', color: 'var(--text-secondary)' }}>
              <Mail size={16} /> {contact.email}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', color: 'var(--text-secondary)' }}>
              <Phone size={16} /> +1 (555) 012-3456
            </div>
          </div>
        </div>
        
        {/* Activity Log */}
        <div className="card glass" style={{ padding: '1.5rem' }}>
          <h3 style={{ fontSize: '1.125rem', fontWeight: 'bold', marginBottom: '1.5rem' }}>Activity Timeline</h3>
          
          <div style={{ borderLeft: '2px solid var(--border-color)', paddingLeft: '1.5rem', position: 'relative' }}>
            
            <div style={{ marginBottom: '1.5rem' }}>
              <div style={{ position: 'absolute', left: '-9px', width: '16px', height: '16px', borderRadius: '50%', backgroundColor: 'var(--success-color)' }}></div>
              <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)' }}>Today, 10:30 AM</p>
              <p style={{ fontWeight: '500' }}>Email Sent: "Proposal Attached"</p>
            </div>
            
            <div style={{ marginBottom: '1.5rem' }}>
              <div style={{ position: 'absolute', left: '-9px', width: '16px', height: '16px', borderRadius: '50%', backgroundColor: 'var(--warning-color)' }}></div>
              <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)' }}>Yesterday, 2:15 PM</p>
              <p style={{ fontWeight: '500' }}>Discovery Call Completed</p>
              <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', marginTop: '0.5rem', padding: '0.75rem', backgroundColor: 'var(--subtle-bg)', borderRadius: '6px' }}>
                Discussed enterprise tier pricing. High interest.
              </p>
            </div>

            <div>
              <div style={{ position: 'absolute', left: '-9px', width: '16px', height: '16px', borderRadius: '50%', backgroundColor: 'var(--accent-color)' }}></div>
              <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)' }}>Oct 12, 2026</p>
              <p style={{ fontWeight: '500' }}>Lead Created</p>
            </div>
            
          </div>
        </div>
      </div>
    </div>
  );
};

export default ContactDetail;
