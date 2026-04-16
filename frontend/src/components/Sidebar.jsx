import { NavLink } from 'react-router-dom';
import { Users, LayoutDashboard, Briefcase, Settings, LifeBuoy, Send, Inbox as InboxIcon, BarChart3, Code, FileDigit, Blocks, Database, Network, Target, CheckSquare, UserPlus, Building2, Receipt, Ticket, UsersRound, FileText, FileSpreadsheet, FolderKanban, DollarSign, Trophy, ShoppingBag, Radio, PanelTop, Calendar, Shield, ScrollText, GitBranch, TrendingUp, BookOpen, PenTool, ClipboardList, MessageSquare, Eye, BadgePercent, Bot, FileSignature, Award, CreditCard } from 'lucide-react';

const Sidebar = () => {
  return (
    <aside className="glass" style={{ width: '250px', height: '100vh', padding: '1rem 1.25rem', display: 'flex', flexDirection: 'column', borderRadius: '0', borderLeft: 'none', borderTop: 'none', borderBottom: 'none' }}>
      <div style={{ marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.75rem', flexShrink: 0 }}>
        <div style={{ width: '32px', height: '32px', backgroundColor: 'var(--accent-color)', borderRadius: '8px', boxShadow: '0 0 15px var(--accent-glow)' }}></div>
        <h1 style={{ fontSize: '1.25rem', fontWeight: 'bold', fontFamily: 'var(--font-family)' }}>Globussoft</h1>
      </div>

      <nav style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', flex: 1, overflowY: 'auto', minHeight: 0 }}>
        <NavLink to="/dashboard" end className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} style={navStyle}>
          <LayoutDashboard size={20} /> Dashboard
        </NavLink>
        <NavLink to="/inbox" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} style={navStyle}>
          <InboxIcon size={20} /> Inbox
        </NavLink>
        <NavLink to="/contacts" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} style={navStyle}>
          <Users size={20} /> Contacts
        </NavLink>
        <NavLink to="/pipeline" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} style={navStyle}>
          <Briefcase size={20} /> Pipeline
        </NavLink>
        <NavLink to="/pipelines" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} style={navStyle}>
          <GitBranch size={20} /> Pipelines
        </NavLink>
        <NavLink to="/forecasting" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} style={navStyle}>
          <TrendingUp size={20} /> Forecasting
        </NavLink>
        <NavLink to="/quotas" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} style={navStyle}>
          <Award size={20} /> Quotas
        </NavLink>
        <NavLink to="/win-loss" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} style={navStyle}>
          <BadgePercent size={20} /> Win/Loss
        </NavLink>
        <NavLink to="/deal-insights" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} style={navStyle}>
          <Eye size={20} /> Deal Insights
        </NavLink>
        <NavLink to="/cpq" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} style={navStyle}>
          <FileDigit size={20} /> CPQ
        </NavLink>
        <NavLink to="/marketing" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} style={navStyle}>
          <Send size={20} /> Marketing
        </NavLink>
        <NavLink to="/sequences" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} style={navStyle}>
          <Network size={20} /> Sequences
        </NavLink>
        <NavLink to="/reports" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} style={navStyle}>
          <BarChart3 size={20} /> Reports
        </NavLink>
        <NavLink to="/agent-reports" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} style={navStyle}>
          <Trophy size={20} /> Agent Reports
        </NavLink>
        <NavLink to="/dashboards" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} style={navStyle}>
          <LayoutDashboard size={20} /> Dashboards
        </NavLink>
        <NavLink to="/custom-reports" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} style={navStyle}>
          <BarChart3 size={20} /> Custom Reports
        </NavLink>
        <NavLink to="/booking-pages" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} style={navStyle}>
          <Calendar size={20} /> Booking Pages
        </NavLink>
        <NavLink to="/signatures" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} style={navStyle}>
          <FileSignature size={20} /> E-Signatures
        </NavLink>
        <NavLink to="/document-templates" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} style={navStyle}>
          <FileText size={20} /> Doc Templates
        </NavLink>
        <NavLink to="/ab-tests" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} style={navStyle}>
          <PenTool size={20} /> A/B Tests
        </NavLink>
        <NavLink to="/web-visitors" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} style={navStyle}>
          <Eye size={20} /> Web Visitors
        </NavLink>
        <NavLink to="/chatbots" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} style={navStyle}>
          <Bot size={20} /> Chatbots
        </NavLink>
        <NavLink to="/knowledge-base" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} style={navStyle}>
          <BookOpen size={20} /> Knowledge Base
        </NavLink>
        <NavLink to="/surveys" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} style={navStyle}>
          <ClipboardList size={20} /> Surveys (NPS/CSAT)
        </NavLink>
        <NavLink to="/payments" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} style={navStyle}>
          <CreditCard size={20} /> Payments
        </NavLink>
        <NavLink to="/approvals" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} style={navStyle}>
          <CheckSquare size={20} /> Approvals
        </NavLink>
        <NavLink to="/territories" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} style={navStyle}>
          <Network size={20} /> Territories
        </NavLink>
        <NavLink to="/lead-routing" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} style={navStyle}>
          <Send size={20} /> Lead Routing
        </NavLink>
        <NavLink to="/sla" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} style={navStyle}>
          <Target size={20} /> SLA Policies
        </NavLink>
        <NavLink to="/tasks" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} style={navStyle}>
          <CheckSquare size={20} /> Task Queue
        </NavLink>
        <NavLink to="/lead-scoring" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} style={navStyle}>
          <Target size={20} /> Lead Scoring
        </NavLink>
        <NavLink to="/leads" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} style={navStyle}>
          <UserPlus size={20} /> Leads
        </NavLink>
        <NavLink to="/marketplace-leads" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} style={navStyle}>
          <ShoppingBag size={20} /> Marketplace Leads
        </NavLink>
        <NavLink to="/channels" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} style={navStyle}>
          <Radio size={20} /> Channels
        </NavLink>
        <NavLink to="/clients" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} style={navStyle}>
          <Building2 size={20} /> Clients
        </NavLink>
        <NavLink to="/invoices" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} style={navStyle}>
          <Receipt size={20} /> Invoices
        </NavLink>
        <NavLink to="/estimates" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} style={navStyle}>
          <FileSpreadsheet size={20} /> Estimates
        </NavLink>
        <NavLink to="/expenses" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} style={navStyle}>
          <DollarSign size={20} /> Expenses
        </NavLink>
        <NavLink to="/contracts" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} style={navStyle}>
          <FileText size={20} /> Contracts
        </NavLink>
        <NavLink to="/projects" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} style={navStyle}>
          <FolderKanban size={20} /> Projects
        </NavLink>
        <NavLink to="/tickets" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} style={navStyle}>
          <Ticket size={20} /> Tickets
        </NavLink>
        <NavLink to="/support" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} style={navStyle}>
          <LifeBuoy size={20} /> Support
        </NavLink>
        <NavLink to="/objects" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} style={navStyle}>
          <Database size={20} /> App Builder
        </NavLink>
        <NavLink to="/landing-pages" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} style={navStyle}>
          <PanelTop size={20} /> Landing Pages
        </NavLink>
        <NavLink to="/calendar-sync" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} style={navStyle}>
          <Calendar size={20} /> Calendar
        </NavLink>
        <div style={{ paddingTop: '0.75rem', marginTop: '0.5rem', borderTop: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
          <NavLink to="/staff" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} style={navStyle}>
            <UsersRound size={20} /> Staff
          </NavLink>
          <NavLink to="/audit-log" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} style={navStyle}>
            <ScrollText size={20} /> Audit Log
          </NavLink>
          <NavLink to="/privacy" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} style={navStyle}>
            <Shield size={20} /> Privacy
          </NavLink>
          <NavLink to="/developer" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} style={navStyle}>
            <Code size={20} /> Developers
          </NavLink>
          <NavLink to="/settings" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} style={navStyle}>
            <Settings size={20} /> Settings
          </NavLink>
        </div>
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
