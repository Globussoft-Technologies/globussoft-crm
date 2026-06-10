import RegisterCard from './RegisterCard';

export default function RegisterGrid({
  registers,
  openShifts,
  loading,
  selectedRegisterId,
  isAdminOrManager,
  onSelectRegister,
  onEdit,
  onToggleActive,
}) {
  return (
    <>
      {loading && <div>Loading…</div>}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns:
            'repeat(auto-fit, minmax(min(100%, 280px), 1fr))',
          gap: '1rem',
          marginBottom: '1.5rem',
        }}
      >
        {registers.map((reg) => (
          <RegisterCard
            key={reg.id}
            reg={reg}
            openShift={openShifts[reg.id]}
            isSelected={selectedRegisterId === reg.id}
            isAdminOrManager={isAdminOrManager}
            onSelect={() => onSelectRegister(reg.id)}
            onEdit={() => onEdit(reg)}
            onToggleActive={() => onToggleActive(reg)}
          />
        ))}

        {!loading && registers.length === 0 && (
          <div
            className="glass"
            style={{
              padding: '2rem',
              textAlign: 'center',
              color: 'var(--text-secondary)',
              gridColumn: '1 / -1',
            }}
          >
            No cash registers yet.{' '}
            {isAdminOrManager
              ? 'Create one to start ringing up sales at the POS.'
              : 'Ask an admin to create the first one.'}
          </div>
        )}
      </div>
    </>
  );
}
