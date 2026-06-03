import { CalendarIcon, ChevronLeft, ChevronRight } from 'lucide-react';
import CsvImportExportToolbar from '../../../components/wellness/CsvImportExportToolbar';
import PageHeader from '../../../components/PageHeader';
import { dateField, dateInput, ALL_ROLES_KEY } from './constants';

export default function CalendarHeader({
  practitionerRoleOptions,
  selectedRoleKey,
  onRoleChange,
  totalPractitionerCount,
  visiblePractitionerCount,
  selectedRoleLabel,
  showAll,
  onToggleShowAll,
  from,
  onDateChange,
  onPrevDay,
  onNextDay,
  csvFilters,
  onCsvImported,
  dayLabel,
}) {
  return (
    <PageHeader
      icon={CalendarIcon}
      title="Calendar"
      description={`Day view by practitioner — ${dayLabel}`}
    >
      {/* Option B: role-filter dropdown. Reads the per-tenant catalog
          (Settings → Wellness Role Types). "All staff" is the default
          and shows every catalog role with canTakeVisits=true. Hidden
          when the catalog is empty (catalog not seeded, generic tenant,
          or API error). */}
      {practitionerRoleOptions.length > 0 && (
        <select
          value={selectedRoleKey}
          onChange={(e) => onRoleChange(e.target.value)}
          aria-label="Filter by staff role"
          className="glass"
          style={{
            padding: '0.4rem 0.65rem', fontSize: '0.8rem',
            borderRadius: 8, cursor: 'pointer',
            border: '1px solid rgba(255,255,255,0.1)',
            background: 'transparent',
            color: 'var(--text-primary)',
          }}
        >
          <option value={ALL_ROLES_KEY}>All staff</option>
          {practitionerRoleOptions.map((r) => (
            <option key={r.key} value={r.key}>{r.label}</option>
          ))}
        </select>
      )}
      {totalPractitionerCount > 0 && (
        <button
          type="button"
          onClick={onToggleShowAll}
          className="glass"
          style={{
            padding: '0.4rem 0.8rem', fontSize: '0.8rem',
            borderRadius: 8, cursor: 'pointer',
            border: `1px solid ${showAll ? 'rgba(99,102,241,0.5)' : 'rgba(255,255,255,0.1)'}`,
            background: showAll ? 'rgba(99,102,241,0.15)' : 'transparent',
            color: 'var(--text-primary)',
          }}
          title={showAll ? `Showing all ${totalPractitionerCount} ${selectedRoleLabel}` : `Showing ${visiblePractitionerCount} with visits today (click to show all)`}
        >
          {/* #307: pre-fix copy was "1 of 16" with no unit, which sat right
              next to the date chevrons and was widely misread as
              "day 1 of 16" — i.e. the chevrons advanced practitioners.
              Add the explicit noun (practitioners / nurses / stylists)
              so the chip is unambiguously about the column filter,
              not navigation. The noun comes from the dropdown's
              selected label (Option B). */}
          {showAll
            ? `All ${selectedRoleLabel} (${totalPractitionerCount})`
            : `${visiblePractitionerCount} of ${totalPractitionerCount} ${selectedRoleLabel}`}
        </button>
      )}
      {/* Single Day picker — the grid renders THIS day only. Prev/Next
          arrows for quick day-by-day navigation; the native <input
          type="date"> opens the system calendar popover for jumping
          further. CSV export filters to the same day. */}
      <div style={dateField}>
        <button
          type="button"
          onClick={onPrevDay}
          aria-label="Previous day"
          className="glass"
          style={{ padding: '0.3rem 0.4rem', borderRadius: 6, border: '1px solid rgba(255,255,255,0.1)', background: 'transparent', color: 'var(--text-primary)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center' }}
        >
          <ChevronLeft size={16} />
        </button>
        <input
          type="date"
          value={from}
          onChange={(e) => {
            const v = e.target.value;
            if (!v) return;
            onDateChange(v);
          }}
          aria-label="Day shown on grid"
          className="glass"
          style={dateInput}
          data-testid="calendar-day-picker"
        />
        <button
          type="button"
          onClick={onNextDay}
          aria-label="Next day"
          className="glass"
          style={{ padding: '0.3rem 0.4rem', borderRadius: 6, border: '1px solid rgba(255,255,255,0.1)', background: 'transparent', color: 'var(--text-primary)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center' }}
        >
          <ChevronRight size={16} />
        </button>
      </div>
      {/* Issue #816: CSV Import / Export of bookings. Export window is
          scoped to the selected day — wider-range exports live on the
          staff Appointments page (which has explicit range controls). */}
      <CsvImportExportToolbar
        entity="bookings"
        label="Bookings"
        filters={csvFilters}
        formats={['csv', 'xlsx']}
        onImported={onCsvImported}
      />
    </PageHeader>
  );
}
