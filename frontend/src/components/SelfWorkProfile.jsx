import { useEffect, useMemo, useState } from 'react';
import { BriefcaseBusiness, MapPin, Save, Truck } from 'lucide-react';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';
import MultiSelectDropdown from './MultiSelectDropdown';
import { isAssignablePlot } from '../utils/plotAvailability';

const ROLE_LABELS = {
  transport: 'Transport profile',
  broker: 'Sales Executive profile',
  billing: 'Billing profile',
};

const EMPTY_FORM = {
  alternatePhone: '',
  vehicleType: '',
  vehicleNumber: '',
  agency: '',
  notes: '',
  plotSiteIds: [],
  pickupLocationIds: [],
};

function formFromPayload(payload) {
  return {
    ...EMPTY_FORM,
    alternatePhone: payload?.profile?.alternatePhone || '',
    vehicleType: payload?.profile?.vehicleType || '',
    vehicleNumber: payload?.profile?.vehicleNumber || '',
    agency: payload?.profile?.agency || '',
    notes: payload?.profile?.notes || '',
    plotSiteIds: (payload?.assignedPlots || []).map((plot) => Number(plot.id)),
    pickupLocationIds: (payload?.assignedPickupLocations || []).map((location) => Number(location.id)),
  };
}

export default function SelfWorkProfile() {
  const notify = useNotify();
  const [data, setData] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchApi('/api/pickup-plot-inventory/people/me', { silent: true })
      .then((payload) => {
        if (cancelled) return;
        setData(payload);
        setForm(formFromPayload(payload));
      })
      .catch(() => {
        if (!cancelled) setData(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  const customerMap = useMemo(
    () => new Map((data?.assignments || []).map((row) => [Number(row.customerId), row.customer])),
    [data?.assignments],
  );

  const assignablePlotOptions = useMemo(() => (data?.plotOptions || [])
    .filter(isAssignablePlot)
    .map((plot) => ({
      value: Number(plot.id),
      label: `${plot.name}${plot.referenceCode ? ` (${plot.referenceCode})` : ''}`,
    })), [data?.plotOptions]);

  const pickupLocationOptions = useMemo(() => (data?.pickupLocationOptions || []).map((location) => ({
    value: Number(location.id),
    label: [location.name, location.address].filter(Boolean).join(' · '),
  })), [data?.pickupLocationOptions]);

  const hasIncompleteAssignments = (data?.assignments || []).length > 0;

  if (loading) {
    return <div className="card glass" style={cardStyle}>Loading work profile...</div>;
  }
  if (!data?.roleType) return null;

  const save = async (event) => {
    event.preventDefault();
    setSaving(true);
    try {
      const payload = {
        roleType: data.roleType,
        alternatePhone: form.alternatePhone,
        vehicleType: form.vehicleType,
        vehicleNumber: form.vehicleNumber,
        agency: form.agency,
        notes: form.notes,
        plotSiteIds: form.plotSiteIds,
      };
      if (data.roleType === 'transport') payload.pickupLocationIds = form.pickupLocationIds;
      const updated = await fetchApi('/api/pickup-plot-inventory/people/me', {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
      const next = { ...data, ...updated };
      setData(next);
      setForm(formFromPayload(next));
      notify.success('Work profile updated');
    } catch (error) {
      notify.error(error?.message || 'Failed to update work profile');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card glass" data-testid="self-work-profile" style={cardStyle}>
      <div style={headingRowStyle}>
        <span style={iconStyle}>{data.roleType === 'transport' ? <Truck size={19} /> : <BriefcaseBusiness size={19} />}</span>
        <div>
          <h3 style={{ margin: 0, fontSize: '1rem' }}>{ROLE_LABELS[data.roleType]}</h3>
          <p style={{ margin: '0.2rem 0 0', color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
            View your assigned customers, manage your assigned plots, and keep your work details up to date.
          </p>
        </div>
      </div>

      <form onSubmit={save}>
        <div style={fieldGridStyle}>
          {data.roleType === 'transport' && <>
            <Field label="Alternate phone">
              <input className="input-field" type="tel" value={form.alternatePhone} onChange={(event) => setForm({ ...form, alternatePhone: event.target.value })} />
            </Field>
            <Field label="Vehicle type">
              <input className="input-field" value={form.vehicleType} onChange={(event) => setForm({ ...form, vehicleType: event.target.value })} />
            </Field>
            <Field label="Vehicle number">
              <input className="input-field" value={form.vehicleNumber} onChange={(event) => setForm({ ...form, vehicleNumber: event.target.value })} />
            </Field>
          </>}
          {data.roleType === 'broker' && <>
            <Field label="Agency">
              <input className="input-field" value={form.agency} onChange={(event) => setForm({ ...form, agency: event.target.value })} />
            </Field>
            <Field label="Commission">
              <input className="input-field" value={data.profile?.commissionPercent == null ? 'Not set' : `${data.profile.commissionPercent}%`} disabled />
            </Field>
          </>}
          <Field label="Notes" full>
            <textarea className="input-field" rows="3" maxLength="4000" value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} />
          </Field>
        </div>

        <div style={{ marginTop: '1.25rem' }}>
          <h4 style={sectionTitleStyle}><MapPin size={16} /> Assigned customers</h4>
          {(data.assignments || []).length === 0 ? (
            <p style={emptyStyle}>No customer has been assigned yet.</p>
          ) : (
            <div style={{ display: 'grid', gap: 10 }}>
              {(data.assignments || []).map((assignment) => {
                const customer = customerMap.get(assignment.customerId);
                return (
                  <div key={assignment.customerId} style={assignmentStyle}>
                    <span style={{ minWidth: 0 }}>
                      <strong style={{ display: 'block', overflowWrap: 'anywhere' }}>{customer?.name || `Customer ${assignment.customerId}`}</strong>
                      <small style={{ color: 'var(--text-secondary)' }}>{customer?.company || customer?.phone || customer?.email || 'Assigned customer'}</small>
                    </span>
                    <div aria-label={`Customer plot for ${customer?.name || assignment.customerId}`} style={readOnlyPlotStyle}>
                      <strong>{assignment.plot?.name || `Plot ${assignment.plotSiteId}`}</strong>
                      <small style={{ color: 'var(--text-secondary)' }}>Customer assignment</small>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div style={{ marginTop: '1.25rem' }}>
          <h4 style={sectionTitleStyle}><MapPin size={16} /> Assigned plots</h4>
          <MultiSelectDropdown
            ariaLabel="Assigned plots (select multiple)"
            searchable
            options={assignablePlotOptions}
            selected={form.plotSiteIds.map(Number)}
            onChange={(plotSiteIds) => setForm((current) => ({ ...current, plotSiteIds }))}
            placeholder="Select assigned plots"
            disabled={hasIncompleteAssignments}
          />
          {hasIncompleteAssignments && <p style={lockNoticeStyle}>Complete all assigned customer steps before changing plots.</p>}
        </div>

        {data.roleType === 'transport' && <div style={{ marginTop: '1.25rem' }}>
          <h4 style={sectionTitleStyle}><MapPin size={16} /> Assigned pickup locations</h4>
          <MultiSelectDropdown
            ariaLabel="Assigned pickup locations (select multiple)"
            searchable
            options={pickupLocationOptions}
            selected={form.pickupLocationIds.map(Number)}
            onChange={(pickupLocationIds) => setForm((current) => ({ ...current, pickupLocationIds }))}
            placeholder="Select assigned pickup locations"
            disabled={hasIncompleteAssignments}
          />
          {hasIncompleteAssignments && <p style={lockNoticeStyle}>Complete all assigned customer steps before changing pickup locations.</p>}
        </div>}

        <button type="submit" className="btn-primary" disabled={saving} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, marginTop: '1.25rem' }}>
          <Save size={16} /> {saving ? 'Saving...' : 'Save work profile'}
        </button>
      </form>
    </div>
  );
}

function Field({ label, full = false, children }) {
  return (
    <label style={{ display: 'grid', gap: 6, gridColumn: full ? '1 / -1' : undefined, fontSize: '0.82rem', color: 'var(--text-secondary)' }}>
      <span>{label}</span>
      {children}
    </label>
  );
}

const cardStyle = { padding: '1.5rem', marginBottom: '1.5rem' };
const headingRowStyle = { display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: '1.25rem' };
const iconStyle = { width: 38, height: 38, borderRadius: 10, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, color: 'var(--primary-color, var(--accent-color))', background: 'color-mix(in srgb, var(--primary-color, var(--accent-color)) 14%, transparent)' };
const fieldGridStyle = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))', gap: 14 };
const sectionTitleStyle = { display: 'flex', alignItems: 'center', gap: 7, margin: '0 0 0.75rem', fontSize: '0.9rem' };
const assignmentStyle = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))', alignItems: 'center', gap: 12, padding: 12, border: '1px solid var(--border-color)', borderRadius: 10 };
const readOnlyPlotStyle = { display: 'grid', gap: 2, minHeight: 42, padding: '0.65rem 0.75rem', border: '1px solid var(--border-color)', borderRadius: 8, background: 'var(--subtle-bg, rgba(148,163,184,.08))' };
const emptyStyle = { margin: 0, padding: 12, border: '1px dashed var(--border-color)', borderRadius: 10, color: 'var(--text-secondary)', fontSize: '0.82rem' };
const lockNoticeStyle = { margin: '0.45rem 0 0', color: 'var(--text-secondary)', fontSize: '0.76rem' };
