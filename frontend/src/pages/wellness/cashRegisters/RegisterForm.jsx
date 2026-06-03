import { inputStyle, primaryButtonStyle, formStyle } from './sharedStyles';

export default function RegisterForm({
  show,
  isAdminOrManager,
  editingId,
  form,
  saving,
  locations,
  onSubmit,
  setForm,
}) {
  if (!show || !isAdminOrManager) return null;
  return (
    <form onSubmit={onSubmit} className="glass" style={formStyle}>
      {editingId && (
        <div
          style={{
            gridColumn: '1 / -1',
            fontSize: '0.85rem',
            color: 'var(--text-secondary)',
            marginBottom: '0.25rem',
          }}
        >
          Editing <strong>{form.name}</strong>
        </div>
      )}
      <input
        placeholder="Register name — e.g. Front Desk"
        required
        value={form.name}
        onChange={(e) => setForm({ ...form, name: e.target.value })}
        style={inputStyle}
        aria-label="Register name"
      />
      <select
        required
        value={form.locationId}
        onChange={(e) => setForm({ ...form, locationId: e.target.value })}
        style={inputStyle}
        aria-label="Location"
      >
        <option value="">Pick a location…</option>
        {locations.map((l) => (
          <option key={l.id} value={l.id}>
            {l.name}
            {l.city ? ` — ${l.city}` : ''}
          </option>
        ))}
      </select>
      <input
        type="number"
        min="0"
        step="0.01"
        placeholder="Opening float — e.g. 500"
        value={form.openingFloat}
        onChange={(e) => setForm({ ...form, openingFloat: e.target.value })}
        style={inputStyle}
        aria-label="Opening float"
      />
      <button
        type="submit"
        disabled={saving}
        style={{
          ...primaryButtonStyle,
          gridColumn: '1 / -1',
          justifyContent: 'center',
        }}
      >
        {saving
          ? 'Saving…'
          : editingId
          ? 'Save changes'
          : 'Create register'}
      </button>
    </form>
  );
}
