import React, { useEffect, useMemo, useState } from 'react';
import { Shield, Eye, EyeOff, Edit, Save, Check, Grid3X3, ListChecks } from 'lucide-react';
import { fetchApi } from '../utils/api';

const ROLES = ['ADMIN', 'MANAGER', 'USER'];
// PRD Gap §1.3 — module × action permissions matrix. Modules with field='*'
// only (no per-field gates) are rendered in the matrix view; entities with
// real fields keep their existing per-field view.
const ACTIONS = ['READ', 'WRITE', 'DELETE', 'EXPORT'];
// All roles supported by the backend (RBAC + wellness sub-roles). The matrix
// view exposes them as columns; the per-field view stays on the canonical
// RBAC trio because field-level rules pre-date the wellness sub-roles.
const MATRIX_ROLES = ['ADMIN', 'MANAGER', 'USER', 'doctor', 'professional', 'telecaller', 'helper'];

// Fallback used if /entities endpoint is unreachable — keeps the UI usable.
const FALLBACK_ENTITIES = {
  Deal: ['title', 'amount', 'currency', 'probability', 'stage', 'expectedClose', 'ownerId', 'lostReason'],
  Contact: ['name', 'email', 'phone', 'company', 'title', 'status', 'source', 'aiScore', 'industry', 'linkedin'],
  Invoice: ['amount', 'status', 'dueDate'],
  Quote: ['totalAmount', 'mrr', 'status'],
  Patient: ['*'],
  Visit: ['*'],
  Prescription: ['*'],
  ConsentForm: ['*'],
  Staff: ['*'],
  Settings: ['*'],
  Audit: ['*'],
  Reports: ['*'],
};

const roleColors = {
  ADMIN: '#a855f7',
  MANAGER: '#3b82f6',
  USER: '#22c55e',
  doctor: '#0ea5e9',
  professional: '#10b981',
  telecaller: '#f59e0b',
  helper: '#6b7280',
};

export default function FieldPermissions() {
  // 'fields' (legacy per-field view) | 'matrix' (PRD Gap §1.3 module×action view)
  const [view, setView] = useState('fields');
  const [entities, setEntities] = useState(FALLBACK_ENTITIES);
  const [activeEntity, setActiveEntity] = useState('Deal');
  // matrix[entity][role][field] = { canRead, canWrite }  — for fields view
  const [matrix, setMatrix] = useState({});
  // moduleMatrix[module][role][action] = { canRead, canWrite } — for matrix view
  const [moduleMatrix, setModuleMatrix] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(null);
  const [error, setError] = useState('');

  const buildDefaultMatrix = (entityMap) => {
    const m = {};
    Object.keys(entityMap).forEach((entity) => {
      m[entity] = {};
      ROLES.forEach((role) => {
        m[entity][role] = {};
        entityMap[entity].forEach((field) => {
          m[entity][role][field] = { canRead: true, canWrite: true };
        });
      });
    });
    return m;
  };

  const loadAll = async () => {
    setLoading(true);
    setError('');
    try {
      let entityMap = FALLBACK_ENTITIES;
      try {
        const ents = await fetchApi('/api/field-permissions/entities');
        if (ents && typeof ents === 'object' && Object.keys(ents).length) {
          entityMap = ents;
        }
      } catch {
        // use fallback
      }
      setEntities(entityMap);

      const grouped = await fetchApi('/api/field-permissions');
      const m = buildDefaultMatrix(entityMap);
      if (grouped && typeof grouped === 'object') {
        Object.keys(grouped).forEach((entity) => {
          if (!m[entity]) return;
          (grouped[entity] || []).forEach((rule) => {
            // Skip rules with action != 'WRITE' here — the per-field tab
            // operates on the legacy WRITE bucket. Action-axis rules are
            // managed via the Module × Action matrix view.
            if (rule.action && rule.action !== 'WRITE') return;
            if (!m[entity][rule.role]) return;
            if (!m[entity][rule.role][rule.field]) return;
            m[entity][rule.role][rule.field] = {
              canRead: rule.canRead,
              canWrite: rule.canWrite,
            };
          });
        });
      }
      setMatrix(m);

      // PRD Gap §1.3 — load the module × action × role topology.
      try {
        const mm = await fetchApi('/api/field-permissions/matrix');
        if (mm && typeof mm === 'object') setModuleMatrix(mm);
        else setModuleMatrix(buildDefaultModuleMatrix(entityMap));
      } catch {
        setModuleMatrix(buildDefaultModuleMatrix(entityMap));
      }
    } catch (e) {
      console.error(e);
      setError(e.message || 'Failed to load field permissions');
      setMatrix(buildDefaultMatrix(FALLBACK_ENTITIES));
      setModuleMatrix(buildDefaultModuleMatrix(FALLBACK_ENTITIES));
    } finally {
      setLoading(false);
    }
  };

  const buildDefaultModuleMatrix = (entityMap) => {
    const mm = {};
    Object.keys(entityMap).forEach((entity) => {
      mm[entity] = {};
      MATRIX_ROLES.forEach((role) => {
        mm[entity][role] = {};
        ACTIONS.forEach((action) => {
          mm[entity][role][action] = { canRead: true, canWrite: true };
        });
      });
    });
    return mm;
  };

  useEffect(() => { loadAll(); }, []);

  const entityKeys = useMemo(() => Object.keys(entities), [entities]);

  const toggle = (entity, role, field, key) => {
    setMatrix((prev) => {
      const next = { ...prev };
      const cell = (next[entity]?.[role]?.[field]) || { canRead: true, canWrite: true };
      const updated = { ...cell, [key]: !cell[key] };
      // If we revoke read, also revoke write (write without read makes no sense)
      if (key === 'canRead' && !updated.canRead) updated.canWrite = false;
      next[entity] = {
        ...next[entity],
        [role]: {
          ...next[entity][role],
          [field]: updated,
        },
      };
      return next;
    });
  };

  const buildRulesPayload = () => {
    const rules = [];
    // Per-field rules — action='WRITE' bucket (legacy semantics).
    Object.keys(matrix).forEach((entity) => {
      Object.keys(matrix[entity] || {}).forEach((role) => {
        Object.keys(matrix[entity][role] || {}).forEach((field) => {
          // Skip the synthetic '*' field — module-level rules are emitted
          // from the moduleMatrix block below with the action axis.
          if (field === '*') return;
          const cell = matrix[entity][role][field];
          rules.push({
            role,
            entity,
            field,
            action: 'WRITE',
            canRead: Boolean(cell.canRead),
            canWrite: Boolean(cell.canWrite),
          });
        });
      });
    });
    // Module × action rules — field='*' marker, all 4 actions.
    Object.keys(moduleMatrix).forEach((entity) => {
      Object.keys(moduleMatrix[entity] || {}).forEach((role) => {
        Object.keys(moduleMatrix[entity][role] || {}).forEach((action) => {
          const cell = moduleMatrix[entity][role][action];
          rules.push({
            role,
            entity,
            field: '*',
            action,
            canRead: Boolean(cell.canRead),
            canWrite: Boolean(cell.canWrite),
          });
        });
      });
    });
    return rules;
  };

  // For the matrix view: each cell is a single allow/deny toggle. READ uses
  // canRead, all other actions use canWrite. Helper to read/write the
  // effective single-bit per cell.
  const matrixCellAllowed = (entity, role, action) => {
    const cell = moduleMatrix[entity]?.[role]?.[action] || { canRead: true, canWrite: true };
    return action === 'READ' ? cell.canRead : cell.canWrite;
  };

  const flipMatrixCell = (entity, role, action) => {
    setModuleMatrix((prev) => {
      const next = { ...prev };
      const cell = (next[entity]?.[role]?.[action]) || { canRead: true, canWrite: true };
      const newVal = !(action === 'READ' ? cell.canRead : cell.canWrite);
      const updated = action === 'READ'
        ? { ...cell, canRead: newVal }
        : { ...cell, canWrite: newVal };
      next[entity] = { ...next[entity], [role]: { ...next[entity][role], [action]: updated } };
      return next;
    });
  };

  const save = async () => {
    setSaving(true);
    setError('');
    setSavedAt(null);
    try {
      const rules = buildRulesPayload();
      await fetchApi('/api/field-permissions/bulk-update', {
        method: 'POST',
        body: JSON.stringify({ rules }),
      });
      setSavedAt(new Date());
    } catch (e) {
      setError(e.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const fields = entities[activeEntity] || [];

  return (
    <div style={{ padding: '2rem', height: '100%', overflowY: 'auto', animation: 'fadeIn 0.5s ease-out' }}>
      {/* Header */}
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1.25rem', flexWrap: 'wrap', gap: '1rem' }}>
        <div>
          <h1 style={{ fontSize: '2rem', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '0.75rem', margin: 0 }}>
            <Shield size={28} color="var(--accent-color)" /> Field-Level Permissions
          </h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem', maxWidth: '720px' }}>
            Restrict read or write access to individual fields per role. Rules are scoped to your tenant.
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          {savedAt && (
            <span style={{ color: '#22c55e', fontSize: '0.85rem', display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
              <Check size={14} /> Saved {savedAt.toLocaleTimeString()}
            </span>
          )}
          <button
            onClick={save}
            disabled={saving || loading}
            className="btn-primary"
            style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem', opacity: saving ? 0.7 : 1 }}
          >
            <Save size={16} /> {saving ? 'Saving…' : 'Save Changes'}
          </button>
        </div>
      </header>

      {/* #577 — banner removed: fieldFilter is now adopted by every route
          shown in the entity tabs (Deal, Contact, Invoice, Quote). Rules
          take effect on the next request, no restart required. */}

      {error && (
        <div className="card" style={{ padding: '0.75rem 1rem', marginBottom: '1rem', borderLeft: '4px solid #ef4444', color: '#ef4444', fontSize: '0.88rem' }}>
          {error}
        </div>
      )}

      {/* PRD Gap §1.3 — view toggle: per-field (legacy) vs module × action matrix. */}
      <div style={{ display: 'inline-flex', background: 'var(--glass-bg)', border: '1px solid var(--glass-border)', borderRadius: '10px', padding: '0.3rem', marginBottom: '1rem' }}>
        <button
          onClick={() => setView('fields')}
          data-testid="fp-view-fields"
          className={view === 'fields' ? 'btn-primary' : ''}
          style={{ padding: '0.45rem 0.9rem', borderRadius: '7px', background: view === 'fields' ? undefined : 'transparent', border: 'none', color: 'var(--text-primary)', cursor: 'pointer', fontWeight: 600, fontSize: '0.85rem', display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}
        >
          <ListChecks size={14} /> Per-field
        </button>
        <button
          onClick={() => setView('matrix')}
          data-testid="fp-view-matrix"
          className={view === 'matrix' ? 'btn-primary' : ''}
          style={{ padding: '0.45rem 0.9rem', borderRadius: '7px', background: view === 'matrix' ? undefined : 'transparent', border: 'none', color: 'var(--text-primary)', cursor: 'pointer', fontWeight: 600, fontSize: '0.85rem', display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}
        >
          <Grid3X3 size={14} /> Module × action
        </button>
      </div>

      {/* Module × action matrix view */}
      {view === 'matrix' && (
        <div className="card" style={{ padding: 0, overflow: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 720 }} data-testid="fp-matrix-table">
            <thead>
              <tr style={{ background: 'rgba(255,255,255,0.04)' }}>
                <th style={{ ...th, width: 130 }}>Module</th>
                <th style={{ ...th, width: 120 }}>Role</th>
                {ACTIONS.map((a) => (
                  <th key={a} style={{ ...th, textAlign: 'center' }}>{a}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Object.keys(moduleMatrix).map((entity) => (
                MATRIX_ROLES.map((role, ri) => (
                  <tr key={`${entity}-${role}`} style={{ borderTop: ri === 0 ? '2px solid var(--border-color)' : '1px solid var(--border-color)' }}>
                    {ri === 0 && (
                      <td rowSpan={MATRIX_ROLES.length} style={{ ...td, fontWeight: 600, verticalAlign: 'top' }}>
                        {entity}
                      </td>
                    )}
                    <td style={td}>
                      <span style={{
                        display: 'inline-block',
                        padding: '0.2rem 0.55rem',
                        borderRadius: '999px',
                        border: `1px solid ${roleColors[role] || '#888'}`,
                        color: roleColors[role] || 'var(--text-secondary)',
                        fontSize: '0.72rem',
                        textTransform: role === 'ADMIN' || role === 'MANAGER' || role === 'USER' ? 'uppercase' : 'capitalize',
                        letterSpacing: '0.04em',
                      }}>{role}</span>
                    </td>
                    {ACTIONS.map((action) => {
                      const allowed = matrixCellAllowed(entity, role, action);
                      const isAdmin = role === 'ADMIN';
                      return (
                        <td key={action} style={{ ...td, textAlign: 'center' }}>
                          <button
                            type="button"
                            onClick={() => !isAdmin && flipMatrixCell(entity, role, action)}
                            disabled={isAdmin}
                            data-testid={`fp-cell-${entity}-${role}-${action}`}
                            title={isAdmin ? 'ADMIN bypass: implicit allow' : (allowed ? 'Allowed (click to deny)' : 'Denied (click to allow)')}
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: '0.3rem',
                              padding: '0.25rem 0.6rem',
                              borderRadius: '6px',
                              background: isAdmin
                                ? 'rgba(168,85,247,0.15)'
                                : allowed
                                  ? 'rgba(34,197,94,0.18)'
                                  : 'rgba(239,68,68,0.18)',
                              border: isAdmin
                                ? '1px solid #a855f7'
                                : allowed
                                  ? '1px solid #22c55e'
                                  : '1px solid #ef4444',
                              color: isAdmin ? '#a855f7' : (allowed ? '#22c55e' : '#ef4444'),
                              cursor: isAdmin ? 'not-allowed' : 'pointer',
                              fontSize: '0.72rem',
                              fontWeight: 600,
                              opacity: isAdmin ? 0.7 : 1,
                            }}
                          >
                            {isAdmin ? '∞' : (allowed ? 'Allow' : 'Deny')}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))
              ))}
            </tbody>
          </table>
        </div>
      )}

      {view === 'fields' && (
      <>
      {/* Entity selector tabs */}
      <div style={{
        display: 'inline-flex',
        background: 'var(--glass-bg)',
        border: '1px solid var(--glass-border)',
        borderRadius: '10px',
        padding: '0.3rem',
        marginBottom: '1.25rem',
        flexWrap: 'wrap',
      }}>
        {entityKeys.map((entity) => (
          <button
            key={entity}
            onClick={() => setActiveEntity(entity)}
            className={activeEntity === entity ? 'btn-primary' : ''}
            style={{
              padding: '0.5rem 1rem',
              borderRadius: '7px',
              background: activeEntity === entity ? undefined : 'transparent',
              border: 'none',
              color: 'var(--text-primary)',
              cursor: 'pointer',
              fontWeight: 600,
              fontSize: '0.9rem',
            }}
          >
            {entity}
          </button>
        ))}
      </div>

      {/* Matrix */}
      {loading ? (
        <div className="card" style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
          Loading permissions…
        </div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'rgba(255,255,255,0.04)' }}>
                <th style={{ ...th, width: '24%' }}>Field</th>
                {ROLES.map((role) => (
                  <th key={role} style={{ ...th, textAlign: 'center' }}>
                    <span style={{
                      display: 'inline-block',
                      padding: '0.2rem 0.6rem',
                      borderRadius: '999px',
                      border: `1px solid ${roleColors[role]}`,
                      color: roleColors[role],
                      fontSize: '0.72rem',
                      letterSpacing: '0.04em',
                    }}>{role}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {fields.length === 0 ? (
                <tr>
                  <td colSpan={ROLES.length + 1} style={{ ...td, textAlign: 'center', padding: '2rem', color: 'var(--text-secondary)' }}>
                    No fields configured for this entity.
                  </td>
                </tr>
              ) : fields.map((field) => (
                <tr key={field} style={{ borderTop: '1px solid var(--glass-border)' }}>
                  <td style={{ ...td, fontWeight: 500 }}>{field}</td>
                  {ROLES.map((role) => {
                    const cell = matrix[activeEntity]?.[role]?.[field] || { canRead: true, canWrite: true };
                    return (
                      <td key={role} style={{ ...td, textAlign: 'center' }}>
                        <div style={{ display: 'inline-flex', gap: '0.5rem', alignItems: 'center' }}>
                          <Toggle
                            active={cell.canRead}
                            onClick={() => toggle(activeEntity, role, field, 'canRead')}
                            icon={cell.canRead ? <Eye size={13} /> : <EyeOff size={13} />}
                            label="Read"
                          />
                          <Toggle
                            active={cell.canWrite}
                            onClick={() => toggle(activeEntity, role, field, 'canWrite')}
                            icon={<Edit size={13} />}
                            label="Write"
                            disabled={!cell.canRead}
                          />
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Legend */}
      <div style={{ display: 'flex', gap: '1.25rem', marginTop: '1.25rem', flexWrap: 'wrap', color: 'var(--text-secondary)', fontSize: '0.82rem' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>
          <span style={{ ...legendDot, background: '#22c55e' }} /> Allowed
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>
          <span style={{ ...legendDot, background: '#ef4444' }} /> Denied
        </span>
        <span>Revoking Read automatically revokes Write for that cell.</span>
      </div>
      </>
      )}
    </div>
  );
}

function Toggle({ active, onClick, icon, label, disabled }) {
  const bg = disabled
    ? 'rgba(120,120,120,0.15)'
    : active
      ? 'rgba(34, 197, 94, 0.18)'
      : 'rgba(239, 68, 68, 0.18)';
  const border = disabled
    ? '1px solid rgba(120,120,120,0.35)'
    : active
      ? '1px solid #22c55e'
      : '1px solid #ef4444';
  const color = disabled
    ? 'var(--text-secondary)'
    : active
      ? '#22c55e'
      : '#ef4444';
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      title={`${label}: ${disabled ? 'N/A (no read access)' : active ? 'Allowed' : 'Denied'}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.3rem',
        padding: '0.3rem 0.55rem',
        borderRadius: '6px',
        background: bg,
        border,
        color,
        cursor: disabled ? 'not-allowed' : 'pointer',
        fontSize: '0.75rem',
        fontWeight: 600,
        letterSpacing: '0.02em',
        opacity: disabled ? 0.5 : 1,
        transition: 'all 0.15s ease',
      }}
    >
      {icon} {label}
    </button>
  );
}

const th = {
  padding: '0.85rem 1rem',
  textAlign: 'left',
  fontSize: '0.78rem',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  color: 'var(--text-secondary)',
};
const td = { padding: '0.75rem 1rem', fontSize: '0.9rem' };
const legendDot = { display: 'inline-block', width: '10px', height: '10px', borderRadius: '999px' };
