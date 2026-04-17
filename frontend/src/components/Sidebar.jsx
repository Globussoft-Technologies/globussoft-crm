import { useContext } from 'react';
import { NavLink } from 'react-router-dom';
import { Users, LayoutDashboard, Briefcase, Settings, LifeBuoy, Send, Inbox as InboxIcon, BarChart3, Code, FileDigit, Blocks, Database, Network, Target, CheckSquare, UserPlus, Building2, Receipt, Ticket, UsersRound, FileText, FileSpreadsheet, FolderKanban, DollarSign, Trophy, ShoppingBag, Radio, PanelTop, Calendar, Shield, ScrollText, GitBranch, TrendingUp, BookOpen, PenTool, ClipboardList, MessageSquare, Eye, BadgePercent, Bot, FileSignature, Award, CreditCard } from 'lucide-react';
import { AuthContext } from '../App';

const Sidebar = () => {
  const { user } = useContext(AuthContext);
  const role = user?.role || 'USER';
  const isAdmin = role === 'ADMIN';
  const isManager = role === 'ADMIN' || role === 'MANAGER';

  const Link = ({ to, icon: Icon, label, adminOnly, managerOnly }) => {
    if (adminOnly && !isAdmin) return null;
    if (managerOnly && !isManager) return null;
    return (
      <NavLink to={to} className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} style={navStyle}>
        <Icon size={20} /> {label}
      </NavLink>
    );
  };

  return (
    <aside className="glass" style={{ width: '250px', height: '100vh', padding: '1rem 1.25rem', display: 'flex', flexDirection: 'column', borderRadius: '0', borderLeft: 'none', borderTop: 'none', borderBottom: 'none' }}>
      <div style={{ marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.75rem', flexShrink: 0 }}>
        <div style={{ width: '32px', height: '32px', backgroundColor: 'var(--accent-color)', borderRadius: '8px', boxShadow: '0 0 15px var(--accent-glow)' }}></div>
        <h1 style={{ fontSize: '1.25rem', fontWeight: 'bold', fontFamily: 'var(--font-family)' }}>Globussoft</h1>
      </div>

      <nav style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', flex: 1, overflowY: 'auto', minHeight: 0 }}>
        {/* Core — visible to ALL roles */}
        <Link to="/dashboard" icon={LayoutDashboard} label="Dashboard" />
        <Link to="/inbox" icon={InboxIcon} label="Inbox" />
        <Link to="/contacts" icon={Users} label="Contacts" />
        <Link to="/pipeline" icon={Briefcase} label="Pipeline" />
        <Link to="/leads" icon={UserPlus} label="Leads" />
        <Link to="/clients" icon={Building2} label="Clients" />
        <Link to="/tasks" icon={CheckSquare} label="Task Queue" />
        <Link to="/tickets" icon={Ticket} label="Tickets" />
        <Link to="/calendar-sync" icon={Calendar} label="Calendar" />
        <Link to="/live-chat" icon={MessageSquare} label="Live Chat" />

        {/* Sales — visible to ALL (reps need these) */}
        <Link to="/deal-insights" icon={Eye} label="Deal Insights" />
        <Link to="/playbooks" icon={FileText} label="Playbooks" />
        <Link to="/booking-pages" icon={Calendar} label="Booking Pages" />
        <Link to="/signatures" icon={FileSignature} label="E-Signatures" />
        <Link to="/document-templates" icon={FileText} label="Doc Templates" />
        <Link to="/document-tracking" icon={Eye} label="Doc Tracking" />

        {/* Financial — visible to ALL */}
        <Link to="/invoices" icon={Receipt} label="Invoices" />
        <Link to="/estimates" icon={FileSpreadsheet} label="Estimates" />
        <Link to="/expenses" icon={DollarSign} label="Expenses" />
        <Link to="/contracts" icon={FileText} label="Contracts" />
        <Link to="/projects" icon={FolderKanban} label="Projects" />

        {/* Manager+ features */}
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

        {/* Marketing — Manager+ */}
        <Link to="/marketing" icon={Send} label="Marketing" managerOnly />
        <Link to="/sequences" icon={Network} label="Sequences" managerOnly />
        <Link to="/ab-tests" icon={PenTool} label="A/B Tests" managerOnly />
        <Link to="/web-visitors" icon={Eye} label="Web Visitors" managerOnly />
        <Link to="/chatbots" icon={Bot} label="Chatbots" managerOnly />
        <Link to="/social" icon={Send} label="Social Media" managerOnly />
        <Link to="/landing-pages" icon={PanelTop} label="Landing Pages" managerOnly />
        <Link to="/marketplace-leads" icon={ShoppingBag} label="Marketplace Leads" managerOnly />

        {/* Service — Manager+ */}
        <Link to="/support" icon={LifeBuoy} label="Support" managerOnly />
        <Link to="/knowledge-base" icon={BookOpen} label="Knowledge Base" managerOnly />
        <Link to="/surveys" icon={ClipboardList} label="Surveys" managerOnly />
        <Link to="/sla" icon={Target} label="SLA Policies" managerOnly />
        <Link to="/payments" icon={CreditCard} label="Payments" managerOnly />
        <Link to="/lead-scoring" icon={Target} label="Lead Scoring" managerOnly />
        <Link to="/cpq" icon={FileDigit} label="CPQ" managerOnly />

        {/* Admin-only section */}
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

        {/* Settings — visible to Manager too (but not regular USER) */}
        {!isAdmin && isManager && (
          <div style={{ paddingTop: '0.75rem', marginTop: '0.5rem', borderTop: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
            <Link to="/settings" icon={Settings} label="Settings" />
          </div>
        )}
      </nav>
    </aside>
  );
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
