/**
 * Frontend widget registry. Each entry maps a stable `key` (matching the
 * backend's widgetCatalog.js + the saved RoleWidget.widgetKey) to a React
 * component that renders the widget body.
 *
 * The /home page fetches /api/widgets/me, gets back a permission-filtered
 * list of { widgetKey, meta, settings, ... }, and looks up the matching
 * component here. Unknown keys (e.g. a widget removed from the registry
 * after a layout was saved) render nothing.
 *
 * Widget components receive props: { meta, settings, role }.
 * Each component is responsible for its own data fetch + empty / error /
 * loading states. Keep them small + self-contained — they're loaded all
 * at once on /home, so heavy widgets should lazy-load their heavy sub-
 * components themselves.
 */

import TodayAppointments from './TodayAppointments.jsx';
import NextPatient from './NextPatient.jsx';
import PendingPrescriptions from './PendingPrescriptions.jsx';
import ConsentInbox from './ConsentInbox.jsx';
import WaitingRoom from './WaitingRoom.jsx';
import FullClinicCalendar from './FullClinicCalendar.jsx';
import Waitlist from './Waitlist.jsx';
import PendingPayments from './PendingPayments.jsx';
import BirthdayAnniversary from './BirthdayAnniversary.jsx';
import TelecallerQueue from './TelecallerQueue.jsx';
import MissedCalls from './MissedCalls.jsx';
import ConversionStats from './ConversionStats.jsx';
import RevenueVsTarget from './RevenueVsTarget.jsx';
import OccupancyByPractitioner from './OccupancyByPractitioner.jsx';
import LowStockAlerts from './LowStockAlerts.jsx';
import PendingApprovals from './PendingApprovals.jsx';
import NextAppointment from './NextAppointment.jsx';
import MyPrescriptions from './MyPrescriptions.jsx';
import QuickLinks from './QuickLinks.jsx';

// Component registry — the `key` field MUST match the backend's
// widgetCatalog.js entry.key, and the corresponding RoleWidget.widgetKey.
const WIDGET_COMPONENTS = {
  'today-appointments': TodayAppointments,
  'next-patient': NextPatient,
  'pending-prescriptions': PendingPrescriptions,
  'consent-inbox': ConsentInbox,
  'waiting-room': WaitingRoom,
  'full-clinic-calendar': FullClinicCalendar,
  waitlist: Waitlist,
  'pending-payments': PendingPayments,
  'birthday-anniversary': BirthdayAnniversary,
  'telecaller-queue': TelecallerQueue,
  'missed-calls': MissedCalls,
  'conversion-stats': ConversionStats,
  'revenue-vs-target': RevenueVsTarget,
  'occupancy-by-practitioner': OccupancyByPractitioner,
  'low-stock-alerts': LowStockAlerts,
  'pending-approvals': PendingApprovals,
  'next-appointment': NextAppointment,
  'my-prescriptions': MyPrescriptions,
  'quick-links': QuickLinks,
};

export function getWidgetComponent(widgetKey) {
  return WIDGET_COMPONENTS[widgetKey] || null;
}

export function listKnownWidgetKeys() {
  return Object.keys(WIDGET_COMPONENTS);
}
