import React, { useState, useEffect } from 'react';
import { fetchApi } from '../utils/api';
import { Plus, Calculator, FileCheck, Layers, Package, Trash2 } from 'lucide-react';

export default function CPQBuilder({ dealId }) {
  const [quotes, setQuotes] = useState([]);
  const [products, setProducts] = useState([]);
  const [isBuilding, setIsBuilding] = useState(false);
  const [newQuote, setNewQuote] = useState({ title: '', lineItems: [] });

  useEffect(() => {
    loadQuotes();
    loadProducts();
  }, [dealId]);

  const loadQuotes = async () => {
    try {
      const data = await fetchApi(`/api/cpq/quotes/${dealId}`);
      setQuotes(Array.isArray(data) ? data : []);
    } catch(err) {}
  };

  const loadProducts = async () => {
    try {
      const data = await fetchApi('/api/cpq/products');
      setProducts(Array.isArray(data) ? data : []);
    } catch(err) {}
  };

  const addLineItem = () => {
    setNewQuote({
      ...newQuote,
      lineItems: [...newQuote.lineItems, { productName: '', quantity: 1, unitPrice: 0, isRecurring: true }]
    });
  };

  const updateLine = (i, field, val) => {
    const nl = [...newQuote.lineItems];
    nl[i][field] = val;
    setNewQuote({ ...newQuote, lineItems: nl });
  };

  const removeLine = (i) => {
    const nl = [...newQuote.lineItems];
    nl.splice(i, 1);
    setNewQuote({ ...newQuote, lineItems: nl });
  };

  const saveQuote = async () => {
    if (!newQuote.title) return alert("Quote needs a string title mapping.");
    try {
      await fetchApi('/api/cpq/quotes', {
        method: 'POST',
        body: JSON.stringify({ dealId, ...newQuote })
      });
      setIsBuilding(false);
      setNewQuote({ title: '', lineItems: [] });
      loadQuotes();
    } catch(err) {
      alert("Failed to build CPQ Quote Database Array");
    }
  };

  return (
    <div style={{ marginTop: '3rem', borderTop: '1px solid var(--border-color)', paddingTop: '2.5rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
        <h3 style={{ fontSize: '1.25rem', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '0.75rem' }}><Calculator size={22} color="#8b5cf6" /> Configure, Price, Quote (CPQ)</h3>
        {!isBuilding && (
          <button onClick={() => setIsBuilding(true)} className="btn-secondary" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', borderColor: 'rgba(139, 92, 246, 0.4)', color: '#8b5cf6' }}>
            <Plus size={16} /> Mint SaaS Quote
          </button>
        )}
      </div>

      {isBuilding && (
        <div style={{ background: 'var(--surface-color)', padding: '1.5rem', borderRadius: '12px', border: '1px solid rgba(139, 92, 246, 0.4)', marginBottom: '2rem', boxShadow: 'inset 0 0 20px rgba(0,0,0,0.5)' }}>
          <input 
            type="text" 
            placeholder="Quote Contract Title (e.g. Enterprise SLA Agreement Array)" 
            value={newQuote.title} 
            onChange={e=>setNewQuote({...newQuote, title: e.target.value})} 
            className="input-field" 
            style={{ marginBottom: '1.5rem', background: 'var(--input-bg)', fontSize: '1.1rem', fontWeight: 'bold' }} 
          />

          <div style={{ marginBottom: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div style={{ display: 'flex', gap: '1rem', color: 'var(--text-secondary)', fontSize: '0.75rem', fontWeight: 'bold', textTransform: 'uppercase', padding: '0 0.5rem', letterSpacing: '0.05em' }}>
              <span style={{flex: 3}}>SaaS Product Identity</span>
              <span style={{flex: 1}}>Quantity Vector</span>
              <span style={{flex: 1}}>Unit Price</span>
              <span style={{flex: 1}}>Billing Topology</span>
              <span style={{width: '20px'}}></span>
            </div>
            
            {newQuote.lineItems.map((line, i) => (
              <div key={i} style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
                <input type="text" placeholder="Custom Configuration" value={line.productName} onChange={e=>updateLine(i, 'productName', e.target.value)} className="input-field" style={{ flex: 3, background: 'var(--input-bg)', borderColor: 'var(--border-color)' }} />
                <input type="number" value={line.quantity} onChange={e=>updateLine(i, 'quantity', parseInt(e.target.value))} className="input-field" style={{ flex: 1, background: 'var(--input-bg)', borderColor: 'var(--border-color)' }} />
                <div style={{ flex: 1, position: 'relative' }}>
                  <span style={{position:'absolute', left:'10px', top:'10px', color:'var(--text-secondary)', fontWeight: 'bold'}}>$</span>
                  <input type="number" value={line.unitPrice} onChange={e=>updateLine(i, 'unitPrice', parseFloat(e.target.value))} className="input-field" style={{ width: '100%', paddingLeft: '25px', background: 'var(--input-bg)', borderColor: 'var(--border-color)' }} />
                </div>
                <select value={line.isRecurring} onChange={e=>updateLine(i, 'isRecurring', e.target.value === 'true')} className="input-field" style={{ flex: 1, background: 'var(--input-bg)', borderColor: 'var(--border-color)', color: line.isRecurring ? '#8b5cf6' : 'var(--text-primary)' }}>
                  <option value="true" style={{background:'var(--input-bg)'}}>Monthly (MRR)</option>
                  <option value="false" style={{background:'var(--input-bg)'}}>One-Time Payload</option>
                </select>
                <button onClick={() => removeLine(i)} style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer' }}><Trash2 size={20} /></button>
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <button onClick={addLineItem} type="button" style={{ background: 'transparent', color: '#8b5cf6', border: '1px dashed rgba(139, 92, 246, 0.4)', padding: '0.75rem 1rem', borderRadius: '8px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: 'bold' }}>
              <Package size={16} /> Append Contract Line Object
            </button>
            
            <div style={{ display: 'flex', gap: '1rem' }}>
              <button onClick={() => setIsBuilding(false)} className="btn-secondary" style={{ border: 'none', color: 'var(--text-secondary)' }}>Abort Schema</button>
              <button onClick={saveQuote} className="btn-primary" style={{ background: '#8b5cf6', color: 'var(--text-primary)', border: 'none', boxShadow: '0 4px 15px rgba(139, 92, 246, 0.5)' }}>Commit Active CPQ Engine</button>
            </div>
          </div>
        </div>
      )}

      {/* Render Active Deal Quotes */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        {quotes.length === 0 && !isBuilding && <p style={{ color: 'var(--text-secondary)', fontStyle: 'italic', padding: '1rem 0', opacity: 0.5 }}>No Configure, Price, Quote schemas established upon this database entity.</p>}
        {quotes.map(q => (
          <div key={q.id} style={{ background: 'var(--subtle-bg-2)', padding: '1.5rem', borderRadius: '12px', border: '1px solid var(--border-color)', position: 'relative', overflow: 'hidden' }}>
            <div style={{ position: 'absolute', top: 0, left: 0, bottom: 0, width: '4px', background: '#8b5cf6' }}></div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1.25rem' }}>
              <div>
                <h4 style={{ fontSize: '1.1rem', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '0.5rem' }}><FileCheck size={18} color="#10b981" /> {q.title}</h4>
                <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: '0.25rem' }}>Constructed {new Date(q.createdAt).toLocaleDateString()} • State: {q.status}</p>
              </div>
              <div style={{ textAlign: 'right' }}>
                <p style={{ fontSize: '1.25rem', fontWeight: 'bold', color: '#8b5cf6' }}>${q.mrr.toLocaleString()} <span style={{fontSize: '0.7rem', color:'var(--text-secondary)'}}>MRR</span></p>
                {q.totalAmount > 0 && <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginTop: '0.25rem' }}>+ ${(q.totalAmount).toLocaleString()} One-time payload</p>}
              </div>
            </div>
            
            <div style={{ background: 'var(--surface-color)', borderRadius: '8px', overflow: 'hidden', border: '1px solid var(--border-color)' }}>
              {q.lineItems.map(li => (
                <div key={li.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '0.75rem 1rem', borderBottom: '1px solid var(--border-color)', fontSize: '0.875rem' }}>
                  <span style={{ color: 'var(--text-primary)' }}>{li.quantity}x {li.productName}</span>
                  <span style={{ color: li.isRecurring ? '#8b5cf6' : 'var(--text-secondary)', fontWeight: li.isRecurring ? 'bold' : 'normal' }}>${li.unitPrice.toLocaleString()}{li.isRecurring ? '/mo' : ''}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
