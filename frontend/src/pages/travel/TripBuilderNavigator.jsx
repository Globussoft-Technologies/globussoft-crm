import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { fetchApi } from "../../utils/api";
import { useNotify } from "../../utils/notify";
import { SetupNavigator, isPublishedTripPage, setupSteps, tripStepPath } from "./TripSetupNavigation";

export default function TripBuilderNavigator({ tripId, page, dirty }) {
  const [trip, setTrip] = useState(null);
  const navigate = useNavigate();
  const notify = useNotify();
  useEffect(() => {
    let active = true;
    fetchApi(`/api/travel/trips/${tripId}`).then(data => {
      if (active) setTrip(data);
    }).catch(() => {});
    return () => { active = false; };
  }, [tripId]);
  if (!trip) return null;

  async function leave(path, options) {
    if (dirty && !await notify.confirm({
      title: "Leave the landing page editor?",
      message: "Your unsaved edits will be lost.",
      confirmText: "Leave editor",
    })) return;
    navigate(path, options);
  }
  const published = String(page.tripId) === String(trip.id) && isPublishedTripPage(page);
  return <SetupNavigator trip={trip} flags={setupSteps(trip, published)} viewed={3}
    jump={index => leave(tripStepPath(trip.id, index))}
    switchTrip={(row, index) => leave(tripStepPath(row.id, index))}
    newTrip={() => leave("/travel/trips", {state: {createTrip: true}})} />;
}
