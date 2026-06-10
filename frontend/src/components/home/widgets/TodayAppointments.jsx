import { CalendarDays } from 'lucide-react';
import WidgetCard, { Metric } from '../WidgetCard.jsx';
import { useWidgetData, todayLocalDayWindow } from '../useWidgetData.js';

export default function TodayAppointments({ meta }) {
  const { from, to } = todayLocalDayWindow();
  const { data, loading, error } = useWidgetData(
    `/api/wellness/visits?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=500`,
    [from, to],
  );

  // /api/wellness/visits returns a bare array of Visit rows. The endpoint
  // auto-scopes to the signed-in doctor's own visits (wellness.js
  // doctorId = req.user.userId), so the count we render here is "today's
  // bookings for me", which matches the widget's stated purpose.
  const list = Array.isArray(data)
    ? data
    : Array.isArray(data?.visits)
      ? data.visits
      : [];
  const total = list.length;
  const nowMs = Date.now();
  const upcomingCount = list.filter(
    (v) => v.visitDate && new Date(v.visitDate).getTime() >= nowMs,
  ).length;

  return (
    <WidgetCard
      title={meta?.title || "Today's appointments"}
      description={meta?.description}
      icon={CalendarDays}
      loading={loading}
      error={error}
      empty={!loading && !error && total === 0}
      emptyMessage="No appointments today."
      emptyHint="Patients you're booked for will show up here."
      linkTo="/wellness/calendar"
      linkLabel="View calendar"
    >
      <Metric
        value={total}
        label={total === 1 ? 'appointment' : 'appointments'}
        sub={`${upcomingCount} upcoming today`}
      />
    </WidgetCard>
  );
}
