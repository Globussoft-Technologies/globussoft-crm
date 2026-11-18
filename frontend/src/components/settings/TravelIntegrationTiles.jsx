import { useContext, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Calendar, FolderOpen, Mail, MessageCircle } from "lucide-react";
import { AuthContext } from "../../appContexts";
import { fetchApi } from "../../utils/api";

const CONNECTIONS = [
  { id: "gmail", label: "Gmail", category: "Email inbox", icon: Mail, color: "rose", path: "/gmail", description: "Connect your Gmail mailbox to read and send email from the CRM." },
  { id: "drive", label: "Google Drive", category: "Travel knowledge", icon: FolderOpen, color: "amber", path: "/travel/trip-knowledge", description: "Connect Google Drive and manage the brochure folder used by Travel Knowledge." },
  { id: "calendar", label: "Google Calendar", category: "Calendar", icon: Calendar, color: "blue", path: "/calendar-sync", description: "Connect and manage your Google Calendar through the existing calendar setup." },
  { id: "whatsapp", label: "WhatsApp Web", category: "Messaging", icon: MessageCircle, color: "green", path: "/travel/whatsapp", description: "Connect WhatsApp by scanning a QR code on your Travel WhatsApp page." },
];

export default function TravelIntegrationTiles() {
  const { tenant, user } = useContext(AuthContext) || {};
  const enabled = tenant?.vertical === "travel";
  const identity = `${tenant?.id ?? ""}:${user?.id ?? user?.userId ?? ""}`;
  const [snapshot, setSnapshot] = useState(null);

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    fetchApi("/api/travel/dashboard/readiness", { silent: true })
      .then((result) => {
        if (!cancelled) setSnapshot({ identity, checks: Array.isArray(result?.checks) ? result.checks : null });
      })
      .catch(() => {
        if (!cancelled) setSnapshot({ identity, checks: null });
      });
    return () => { cancelled = true; };
  }, [enabled, identity]);

  if (!enabled) return null;
  const current = snapshot?.identity === identity ? snapshot : null;

  return CONNECTIONS.map(({ id, label, category, icon: Icon, color, path, description }) => {
    const check = current?.checks?.find((item) => item.id === id);
    const known = typeof check?.ready === "boolean";
    const connected = known && check.ready;
    const status = !current ? "Checking connection…" : !known ? "Status unavailable" : connected ? "Connected" : "Not connected";
    return (
      <Link key={id} className="gs-app" to={path}>
        <span className={`gs-app-icon gs-app-icon--${color}`}><Icon size={22} aria-hidden="true" /></span>
        <span className="gs-app-category">{category}</span>
        <span className="gs-app-title"><strong>{label}</strong><span className="gs-app-connection" data-status={known ? connected ? "connected" : "disconnected" : "unknown"}>{status}</span></span>
        <span className="gs-app-description">{description}</span>
        <span className="gs-app-action">{!known ? "Open setup" : connected ? "Manage" : "Connect"}<ArrowRight size={15} aria-hidden="true" /></span>
      </Link>
    );
  });
}
