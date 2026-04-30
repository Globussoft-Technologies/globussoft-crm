import { useContext, useState, useRef, useLayoutEffect, useEffect } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  Users, LayoutDashboard, Briefcase, Settings, LifeBuoy, Send, Inbox as InboxIcon, BarChart3,
  Code, FileDigit, Database, Network, Target, CheckSquare, UserPlus, Building2, Receipt, Ticket,
  UsersRound, FileText, FileSpreadsheet, FolderKanban, DollarSign, Trophy, ShoppingBag, Radio,
  PanelTop, Calendar, Shield, ScrollText, GitBranch, TrendingUp, BookOpen, PenTool, ClipboardList,
  MessageSquare, Eye, BadgePercent, Bot, FileSignature, Award, CreditCard, Sparkles, ExternalLink,
  PhoneCall, Stethoscope, HeartPulse, Bell, Clock, Loader2,
} from 'lucide-react';
import { AuthContext } from '../App';
import { launchAdsGptAs, ADSGPT_DASHBOARD, ADSGPT_DEMO_LOGIN } from '../utils/adsgpt';
import { launchCallifiedSSO } from '../utils/callified';

const Sidebar = ({ mobileOpen = false, onMobileClose = () => {} }) => {
  const { user, tenant } = useContext(AuthContext);
  const role = user?.role || 'USER';
  const isAdmin = role === 'ADMIN';
  const isManager = role === 'ADMIN' || role === 'MANAGER';
  const isWellness = tenant?.vertical === 'wellness';
  const location = useLocation();

  // #228: ESC closes the mobile drawer (a11y). Also auto-close on route change
  // so navigating from the drawer doesn't leave it stuck open over the
  // destination page.
  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (e) => { if (e.key === 'Escape') onMobileClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [mobileOpen, onMobileClose]);

  useEffect(() => {
    if (mobileOpen) onMobileClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);

  // #151: persist sidebar scroll across re-renders. The browser usually does this
  // for free, but route-driven re-renders sometimes cause the nav to reset to top
  // (reproducible via items in the lower part of the sidebar). useLayoutEffect
  // restores the saved scrollTop synchronously after every render, so users keep
  // the position they last scrolled to.
  const navRef = useRef(null);
  const scrollRef = useRef(0);
  useLayoutEffect(() => {
    if (navRef.current && scrollRef.current > 0) {
      navRef.current.scrollTop = scrollRef.current;
    }
  });
  const brand = tenant?.name || 'Globussoft';
  const logoUrl = tenant?.logoUrl || null;
  const brandColor = tenant?.brandColor || null;
  // Inline style applied to wellness section labels — overrides the gold
  // accent (#E0A68B) defined in wellness.css when a tenant brand color is set.
  const sectionLabelStyle = brandColor
    ? { ...sectionLabel, color: brandColor }
    : sectionLabel;

  const Link = ({ to, icon: Icon, label, adminOnly, managerOnly }) => {
    if (adminOnly && !isAdmin) return null;
    if (managerOnly && !isManager) return null;
    return (
      <NavLink to={to} className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} style={navStyle}>
        <Icon size={20} /> {label}
      </NavLink>
    );
  };

  const ExtLink = ({ href, icon: Icon, label }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="nav-link" style={navStyle}>
      <Icon size={20} /> <span style={{ flex: 1 }}>{label}</span>
      <ExternalLink size={14} style={{ opacity: 0.6 }} />
    </a>
  );

  // SSO-authenticated AdsGPT launcher — does the same token + Redis-key
  // handoff as the wellness OwnerDashboard card. If the SSO flow fails
  // (network / provider down), degrade to opening the plain dashboard URL
  // so the link is never dead.
  const [adsLoading, setAdsLoading] = useState(false);
  const AdsGptLink = ({ icon: Icon = Sparkles, label = 'AdsGPT' }) => {
    const handleClick = async (e) => {
      e.preventDefault();
      if (adsLoading) return;
      setAdsLoading(true);
      try {
        await launchAdsGptAs(ADSGPT_DEMO_LOGIN);
      } catch (err) {
        console.error('[Sidebar] AdsGPT SSO error:', err.message);
      } finally {
        setAdsLoading(false);
      }
    };
    return (
      <button
        type="button"
        onClick={handleClick}
        disabled={adsLoading}
        className="nav-link"
        aria-label={`Open AdsGPT as ${ADSGPT_DEMO_LOGIN}`}
        style={{ ...navStyle, background: 'transparent', border: 'none', width: '100%', textAlign: 'left', cursor: adsLoading ? 'wait' : 'pointer', fontFamily: 'inherit', fontSize: 'inherit' }}
      >
        {adsLoading ? <Loader2 size={20} className="spin" /> : <Icon size={20} />}
        <span style={{ flex: 1 }}>{label}</span>
        <ExternalLink size={14} style={{ opacity: 0.6 }} />
      </button>
    );
  };

  // SSO-authenticated Callified launcher — generates a signed JWT and opens
  // the Callified dashboard. If SSO fails, shows an error notification.
  const [callifiedLoading, setCallifiedLoading] = useState(false);
  const CallifiedLink = ({ icon: Icon = PhoneCall, label = 'Callified' }) => {
    const handleClick = async (e) => {
      e.preventDefault();
      if (callifiedLoading) return;
      setCallifiedLoading(true);
      try {
        await launchCallifiedSSO();
      } catch (err) {
        console.error('[Sidebar] Callified SSO error:', err.message);
        alert(`Failed to open Callified: ${err.message}`);
      } finally {
        setCallifiedLoading(false);
      }
    };
    return (
      <button
        type="button"
        onClick={handleClick}
        disabled={callifiedLoading}
        className="nav-link"
        aria-label="Open Callified dashboard"
        style={{ ...navStyle, background: 'transparent', border: 'none', width: '100%', textAlign: 'left', cursor: callifiedLoading ? 'wait' : 'pointer', fontFamily: 'inherit', fontSize: 'inherit' }}
      >
        {callifiedLoading ? <Loader2 size={20} className="spin" /> : <Icon size={20} />}
        <span style={{ flex: 1 }}>{label}</span>
        <ExternalLink size={14} style={{ opacity: 0.6 }} />
      </button>
    );
  };

  return (
    <>
      {/* #228: backdrop is only visible at <=768px (responsive.css) and only
          when the drawer is open. Tap dismisses. */}
      <div
        className={`sidebar-backdrop ${mobileOpen ? 'is-open' : ''}`}
        onClick={onMobileClose}
        aria-hidden="true"
      />
      <aside
        id="app-sidebar"
        role="navigation"
        aria-label="Main navigation"
        className={`glass app-sidebar ${mobileOpen ? 'is-open' : ''}`}
        style={{ width: '250px', height: '100vh', padding: '1rem 1.25rem', display: 'flex', flexDirection: 'column', borderRadius: '0', borderLeft: 'none', borderTop: 'none', borderBottom: 'none' }}
      >
      <div style={{ marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.75rem', flexShrink: 0 }}>
        {logoUrl ? (
          <img
            src={logoUrl}
            alt={brand}
            style={{ width: 32, height: 32, borderRadius: 6, objectFit: 'cover' }}
          />
        ) : (
          <div style={{ width: '32px', height: '32px', backgroundColor: brandColor || 'var(--accent-color)', borderRadius: '8px', boxShadow: '0 0 15px var(--accent-glow)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff' }}>
            {isWellness ? <HeartPulse size={18} /> : null}
          </div>
        )}
        <h1 style={{ fontSize: '1.1rem', fontWeight: 'bold', fontFamily: 'var(--font-family)', lineHeight: 1.1 }}>{brand}</h1>
      </div>

      <nav
        ref={navRef}
        onScroll={(e) => { scrollRef.current = e.currentTarget.scrollTop; }}
        style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', flex: 1, overflowY: 'auto', minHeight: 0 }}
      >
        {isWellness ? renderWellnessNav({ Link, ExtLink, AdsGptLink, CallifiedLink, isAdmin, isManager, sectionLabelStyle }) : renderGenericNav({ Link, ExtLink, AdsGptLink, CallifiedLink, isAdmin, isManager })}
      </nav>
      </aside>
    </>
  );
};

// ── Wellness sidebar — slim, clinic-focused ───────────────────────

function renderWellnessNav({ Link, ExtLink, AdsGptLink, CallifiedLink, isAdmin, isManager, sectionLabelStyle }) {
  const labelStyle = sectionLabelStyle || sectionLabel;
  return (
    <>
      {/* Daily essentials — Owner Dashboard + Recommendations are management
          views over org-wide P&L / pending recommendation cards (#207/#216).
          Clinical staff (doctor/professional/telecaller/helper) should not see
          them in the nav. AdsGPT and Callified are external tools the whole
          team uses, so they stay visible for everyone. */}
      <Link to="/wellness" icon={LayoutDashboard} label="Owner Dashboard" managerOnly />
      <Link to="/wellness/recommendations" icon={Sparkles} label="Recommendations" managerOnly />
      <AdsGptLink icon={Sparkles} label="AdsGPT" />
      <CallifiedLink icon={PhoneCall} label="Callified" />

      {/* Clinical — Patients, Calendar, Waitlist visible to all wellness staff
          (clinical staff need their patients + day grid). Service Catalog is a
          pricing/duration config — clinical staff read it but only managers
          edit it, so we hide the nav link for non-management. */}
      <div style={labelStyle}>Clinical</div>
      <Link to="/wellness/patients" icon={HeartPulse} label="Patients" />
      <Link to="/wellness/calendar" icon={Calendar} label="Calendar" />
      <Link to="/wellness/waitlist" icon={Clock} label="Waitlist" />
      <Link to="/wellness/services" icon={Stethoscope} label="Service Catalog" managerOnly />

      {/* Lead-to-revenue */}
      <div style={labelStyle}>Leads & Revenue</div>
      <Link to="/inbox" icon={InboxIcon} label="Unified Inbox" />
      <Link to="/wellness/telecaller" icon={PhoneCall} label="Telecaller Queue" />
      <Link to="/leads" icon={UserPlus} label="All Leads" managerOnly />
      <Link to="/converted-leads" icon={UserPlus} label="Converted Leads" managerOnly />
      <Link to="/tasks" icon={CheckSquare} label="Tasks" />
      <Link to="/marketplace-leads" icon={ShoppingBag} label="Marketplace Leads" managerOnly />
      <Link to="/lead-routing" icon={Send} label="Routing Rules" managerOnly />

      {/* Money — clinic-side, in INR for Indian wellness tenants */}
      <div style={labelStyle}>Finance</div>
      <Link to="/invoices" icon={Receipt} label="Invoices" />
      <Link to="/estimates" icon={FileSpreadsheet} label="Estimates" />
      <Link to="/payments" icon={CreditCard} label="Payments" managerOnly />

      {/* Marketing — clinic-side comms (ad campaigns live in AdsGPT). All items are
          managerOnly, so the whole section is hidden for plain users — otherwise the
          header rendered as an orphan with no children (#107). */}
      {isManager && (
        <>
          <div style={labelStyle}>Marketing</div>
          <Link to="/marketing" icon={Send} label="SMS / Email Blasts" managerOnly />
          <Link to="/sequences" icon={Network} label="Drip Sequences" managerOnly />
          <Link to="/landing-pages" icon={PanelTop} label="Landing Pages" managerOnly />
        </>
      )}

      {/* Reports — wellness-tuned, generic CRM reports removed. Same orphan-header
          fix as Marketing above. */}
      {isManager && (
        <>
          <div style={labelStyle}>Reports</div>
          <Link to="/wellness/reports" icon={BarChart3} label="P&L + Attribution" managerOnly />
          <Link to="/wellness/per-location" icon={Building2} label="Per-Location" managerOnly />
          <Link to="/wellness/loyalty" icon={Award} label="Loyalty + Referrals" managerOnly />
          <Link to="/surveys" icon={ClipboardList} label="Patient Surveys" managerOnly />
          <Link to="/knowledge-base" icon={BookOpen} label="Knowledge Base" managerOnly />
        </>
      )}

      {/* Admin */}
      {isAdmin && (
        <>
          <div style={labelStyle}>Admin</div>
          <Link to="/wellness/locations" icon={Building2} label="Locations" adminOnly />
          <Link to="/staff" icon={UsersRound} label="Staff" adminOnly />
          <Link to="/audit-log" icon={ScrollText} label="Audit Log" adminOnly />
          <Link to="/privacy" icon={Shield} label="Privacy" adminOnly />
          <Link to="/settings" icon={Settings} label="Settings" adminOnly />
        </>
      )}

      {!isAdmin && isManager && (
        <>
          <div style={labelStyle}>Settings</div>
          <Link to="/settings" icon={Settings} label="Settings" />
        </>
      )}
    </>
  );
}

// ── Generic sidebar (preserved unchanged) ─────────────────────────

function renderGenericNav({ Link, ExtLink, AdsGptLink, CallifiedLink, isAdmin, isManager }) {
  return (
    <>
      {/* Core — visible to ALL roles */}
      <Link to="/dashboard" icon={LayoutDashboard} label="Dashboard" />
      <AdsGptLink icon={Sparkles} label="AdsGPT" />
      <CallifiedLink icon={PhoneCall} label="Callified" />
      <Link to="/inbox" icon={InboxIcon} label="Inbox" />
      <Link to="/contacts" icon={Users} label="Contacts" />
      <Link to="/pipeline" icon={Briefcase} label="Pipeline" />
      <Link to="/leads" icon={UserPlus} label="Leads" />
      <Link to="/converted-leads" icon={UserPlus} label="Converted Leads" />
      <Link to="/clients" icon={Building2} label="Clients" />
      <Link to="/tasks" icon={CheckSquare} label="Task Queue" />
      <Link to="/tickets" icon={Ticket} label="Tickets" />
      <Link to="/calendar-sync" icon={Calendar} label="Calendar" />
      <Link to="/live-chat" icon={MessageSquare} label="Live Chat" />

      <Link to="/deal-insights" icon={Eye} label="Deal Insights" />
      <Link to="/playbooks" icon={FileText} label="Playbooks" />
      <Link to="/booking-pages" icon={Calendar} label="Booking Pages" />
      <Link to="/signatures" icon={FileSignature} label="E-Signatures" />
      <Link to="/document-templates" icon={FileText} label="Doc Templates" />
      <Link to="/document-tracking" icon={Eye} label="Doc Tracking" />

      <Link to="/invoices" icon={Receipt} label="Invoices" />
      <Link to="/estimates" icon={FileSpreadsheet} label="Estimates" />
      <Link to="/expenses" icon={DollarSign} label="Expenses" />
      <Link to="/contracts" icon={FileText} label="Contracts" />
      <Link to="/projects" icon={FolderKanban} label="Projects" />

      <Link to="/pipelines" icon={GitBranch} label="Pipelines" managerOnly />
      <Link to="/forecasting" icon={TrendingUp} label="Forecasting" managerOnly />
      <Link to="/quotas" icon={Award} label="Quotas" managerOnly />
      <Link to="/win-loss" icon={BadgePercent} label="Win/Loss" managerOnly />
      <Link to="/funnel" icon={BarChart3} label="Funnel" managerOnly />
      <Link to="/reports" icon={BarChart3} label="Reports" managerOnly />
      <Link to="/agent-reports" icon={Trophy} label="Agent Reports" managerOnly />
      <Link to="/dashboards" icon={LayoutDashboard} label="Dashboards" managerOnly />
      <Link to="/custom-reports" icon={BarChart3} label="Custom Reports" managerOnly />
      <Link to="/approvals" icon={CheckSquare} label="Approvals" managerOnly />
      <Link to="/lead-routing" icon={Send} label="Lead Routing" managerOnly />
      <Link to="/territories" icon={Network} label="Territories" managerOnly />

      <Link to="/marketing" icon={Send} label="Marketing" managerOnly />
      <Link to="/sequences" icon={Network} label="Sequences" managerOnly />
      <Link to="/ab-tests" icon={PenTool} label="A/B Tests" managerOnly />
      <Link to="/web-visitors" icon={Eye} label="Web Visitors" managerOnly />
      <Link to="/chatbots" icon={Bot} label="Chatbots" managerOnly />
      <Link to="/social" icon={Send} label="Social Media" managerOnly />
      <Link to="/landing-pages" icon={PanelTop} label="Landing Pages" managerOnly />
      <Link to="/marketplace-leads" icon={ShoppingBag} label="Marketplace Leads" managerOnly />

      <Link to="/support" icon={LifeBuoy} label="Support" managerOnly />
      <Link to="/knowledge-base" icon={BookOpen} label="Knowledge Base" managerOnly />
      <Link to="/surveys" icon={ClipboardList} label="Surveys" managerOnly />
      <Link to="/sla" icon={Target} label="SLA Policies" managerOnly />
      <Link to="/payments" icon={CreditCard} label="Payments" managerOnly />
      <Link to="/lead-scoring" icon={Target} label="Lead Scoring" managerOnly />
      <Link to="/cpq" icon={FileDigit} label="CPQ" managerOnly />

      {isAdmin && (
        <div style={{ paddingTop: '0.75rem', marginTop: '0.5rem', borderTop: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
          <Link to="/staff" icon={UsersRound} label="Staff" adminOnly />
          <Link to="/audit-log" icon={ScrollText} label="Audit Log" adminOnly />
          <Link to="/privacy" icon={Shield} label="Privacy" adminOnly />
          <Link to="/field-permissions" icon={Shield} label="Field Permissions" adminOnly />
          <Link to="/channels" icon={Radio} label="Channels" adminOnly />
          <Link to="/industry-templates" icon={Building2} label="Industry Templates" adminOnly />
          <Link to="/sandbox" icon={Database} label="Sandbox" adminOnly />
          <Link to="/objects" icon={Database} label="App Builder" adminOnly />
          <Link to="/currencies" icon={DollarSign} label="Currencies" adminOnly />
          <Link to="/zapier" icon={Code} label="Zapier" adminOnly />
          <Link to="/developer" icon={Code} label="Developers" adminOnly />
          <Link to="/settings" icon={Settings} label="Settings" adminOnly />
        </div>
      )}

      {!isAdmin && isManager && (
        <div style={{ paddingTop: '0.75rem', marginTop: '0.5rem', borderTop: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
          <Link to="/settings" icon={Settings} label="Settings" />
        </div>
      )}
    </>
  );
}

const sectionLabel = {
  fontSize: '0.65rem', fontWeight: 600, color: 'var(--text-secondary)',
  textTransform: 'uppercase', letterSpacing: '0.08em',
  padding: '0.75rem 0.5rem 0.25rem',
};

const navStyle = {
  display: 'flex',
  alignItems: 'center',
  padding: '0.5rem 0.875rem',
  gap: '0.625rem',
  borderRadius: '8px',
  color: 'var(--text-primary)',
  transition: 'all 0.2s ease',
  textDecoration: 'none',
  fontSize: '0.9rem',
  flexShrink: 0,
};

export default Sidebar;
