import { NavLink } from 'react-router-dom';
import { Users, LayoutDashboard, Briefcase, Settings, LifeBuoy, Send, Inbox as InboxIcon, BarChart3, Code, FileDigit, Blocks, Database, Network, Target, CheckSquare, UserPlus, Building2, Receipt, Ticket, UsersRound, FileText, FileSpreadsheet, FolderKanban, DollarSign } from 'lucide-react';

const Sidebar = () => {
  return (
    <aside className="glass" style={{ width: '250px', height: '100vh', padding: '1.5rem', display: 'flex', flexDirection: 'column', borderRadius: '0', borderLeft: 'none', borderTop: 'none', borderBottom: 'none' }}>
      <div style={{ marginBottom: '2rem', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
        <div style={{ width: '32px', height: '32px', backgroundColor: 'var(--accent-color)', borderRadius: '8px', boxShadow: '0 0 15px var(--accent-glow)' }}></div>
        <h1 style={{ fontSize: '1.25rem', fontWeight: 'bold', fontFamily: 'var(--font-family)' }}>Globussoft</h1>
      </div>

      <nav style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', flex: 1 }}>
        <NavLink to="/" end className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} style={navStyle}>
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
        <NavLink to="/tasks" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} style={navStyle}>
          <CheckSquare size={20} /> Task Queue
        </NavLink>
        <NavLink to="/lead-scoring" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} style={navStyle}>
          <Target size={20} /> Lead Scoring
        </NavLink>
        <NavLink to="/leads" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} style={navStyle}>
          <UserPlus size={20} /> Leads
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
        <div style={{ marginTop: 'auto', paddingTop: '1rem', borderTop: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          <NavLink to="/staff" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} style={navStyle}>
            <UsersRound size={20} /> Staff
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
  padding: '0.75rem 1rem',
  gap: '0.75rem',
  borderRadius: '8px',
  color: 'var(--text-primary)',
  transition: 'all 0.2s ease',
  textDecoration: 'none'
};

export default Sidebar;
