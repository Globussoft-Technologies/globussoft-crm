import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Search, X, Loader2, FileText, LayoutDashboard } from 'lucide-react';
import * as icons from '../icons';
import { IconThemeContext } from '../icons/IconThemeContext';
import { CrmDocTemplates, CrmContracts } from '../icons/crmIcons';
import { CrmTaskQueue, CrmApprovals } from '../icons/crmIcons';
import { CrmWhatsApp, CrmLiveChat } from '../icons/crmIcons';
import { CrmPlotInventory, CrmPickupInventory, CrmCustomerWorkflows, CrmSalesExecutives, CrmSiteVisits } from '../icons/crmIcons';
import { CrmDeals, CrmSupport, CrmContacts, CrmInvoice, CrmConvertedLead, CrmSandbox, CrmAppBuilder, CrmZapier, CrmCommissionProfiles, CrmCommissionData } from '../icons/crmIcons';

describe('Generic Ant Design icon family', () => {
  it('distinguishes Doc Templates from Contracts only in Generic', () => {
    const items = <><CrmDocTemplates /><CrmContracts /></>;
    const { container, rerender } = render(<IconThemeContext.Provider value>{items}</IconThemeContext.Provider>);
    expect([...container.querySelectorAll('svg')].map(icon => icon.dataset.iconName)).toEqual(['snippets', 'file-protect']);
    rerender(<IconThemeContext.Provider value={false}>{items}</IconThemeContext.Provider>);
    expect(container.querySelector('[data-icon-library="ant-design"]')).toBeNull();
    expect(container.querySelectorAll('.lucide-file-text')).toHaveLength(2);
  });

  it('distinguishes Task Queue from Approvals only in Generic', () => {
    const items = <><CrmTaskQueue /><CrmApprovals /></>;
    const { container, rerender } = render(<IconThemeContext.Provider value>{items}</IconThemeContext.Provider>);
    expect([...container.querySelectorAll('svg')].map(icon => icon.dataset.iconName)).toEqual(['ordered-list', 'safety-certificate']);
    rerender(<IconThemeContext.Provider value={false}>{items}</IconThemeContext.Provider>);
    expect(container.querySelector('[data-icon-library="ant-design"]')).toBeNull();
    expect(container.querySelectorAll('svg')).toHaveLength(2);
    for (const icon of container.querySelectorAll('svg')) expect(icon).toHaveAttribute('viewBox', '0 0 24 24');
  });

  it('distinguishes WhatsApp from Live Chat only in Generic', () => {
    const items = <><CrmWhatsApp /><CrmLiveChat /></>;
    const { container, rerender } = render(<IconThemeContext.Provider value>{items}</IconThemeContext.Provider>);
    expect([...container.querySelectorAll('svg')].map(icon => icon.dataset.iconName)).toEqual(['whats-app', 'comment']);
    rerender(<IconThemeContext.Provider value={false}>{items}</IconThemeContext.Provider>);
    expect(container.querySelector('[data-icon-library="ant-design"]')).toBeNull();
    expect(container.querySelectorAll('.lucide-message-square')).toHaveLength(2);
  });

  it('uses five distinct Pickup & Plot glyphs while preserving other themes', () => {
    const items = <><CrmPlotInventory /><CrmPickupInventory /><CrmCustomerWorkflows /><CrmSalesExecutives /><CrmSiteVisits /></>;
    const { container, rerender } = render(<IconThemeContext.Provider value>{items}</IconThemeContext.Provider>);
    expect([...container.querySelectorAll('svg')].map(icon => icon.dataset.iconName)).toEqual([
      'border-outer', 'car', 'partition', 'solution', 'environment',
    ]);
    rerender(<IconThemeContext.Provider value={false}>{items}</IconThemeContext.Provider>);
    expect(container.querySelector('[data-icon-library="ant-design"]')).toBeNull();
    expect(container.querySelectorAll('.lucide-map')).toHaveLength(1);
    expect(container.querySelectorAll('.lucide-map-pin')).toHaveLength(2);
    expect(container.querySelectorAll('.lucide-handshake')).toHaveLength(2);
  });

  it('distinguishes commission profiles from data only in Generic', () => {
    const items = <><CrmCommissionProfiles /><CrmCommissionData /></>;
    const { container, rerender } = render(<IconThemeContext.Provider value>{items}</IconThemeContext.Provider>);
    expect([...container.querySelectorAll('svg')].map(icon => icon.dataset.iconName)).toEqual(['idcard', 'fund']);
    rerender(<IconThemeContext.Provider value={false}>{items}</IconThemeContext.Provider>);
    expect(container.querySelector('[data-icon-library="ant-design"]')).toBeNull();
    expect(container.querySelectorAll('.lucide-award')).toHaveLength(2);
  });

  it('uses distinct platform icons and preserves non-Generic originals', () => {
    const items = <><CrmSandbox /><CrmAppBuilder /><CrmZapier /><icons.Code /></>;
    const { container, rerender } = render(<IconThemeContext.Provider value>{items}</IconThemeContext.Provider>);
    expect([...container.querySelectorAll('svg')].map(icon => icon.dataset.iconName)).toEqual([
      'experiment', 'build', 'thunderbolt', 'code',
    ]);
    rerender(<IconThemeContext.Provider value={false}>{items}</IconThemeContext.Provider>);
    expect(container.querySelector('[data-icon-library="ant-design"]')).toBeNull();
    expect(container.querySelectorAll('.lucide-database')).toHaveLength(2);
    expect(container.querySelectorAll('.lucide-code')).toHaveLength(2);
  });

  it('uses the overview grid for Generic Dashboard and preserves the original for other themes', () => {
    const { container, rerender } = render(<IconThemeContext.Provider value><LayoutDashboard /></IconThemeContext.Provider>);
    expect(container.querySelector('svg')).toHaveAttribute('data-icon-name', 'appstore');
    rerender(<IconThemeContext.Provider value={false}><LayoutDashboard /></IconThemeContext.Provider>);
    expect(container.querySelector('svg')).not.toHaveAttribute('data-icon-library');
    expect(container.querySelector('svg')).toHaveAttribute('viewBox', '0 0 24 24');
  });
  it('uses CRM-specific meanings rather than shop, tag, or calendar substitutes', () => {
    const { container } = render(<IconThemeContext.Provider value><CrmDeals /><CrmSupport /><CrmContacts /><CrmInvoice /><CrmConvertedLead /></IconThemeContext.Provider>);
    expect([...container.querySelectorAll('svg')].map(icon => icon.dataset.iconName)).toEqual([
      'project', 'customer-service', 'contacts', 'reconciliation', 'check-circle',
    ]);
  });
  it('uses Ant Design glyphs for Generic while preserving size, color, ref and events', () => {
    const ref = createRef();
    const onClick = vi.fn();
    render(<IconThemeContext.Provider value><Search size={18} color="#234567" ref={ref}
      role="img" aria-label="Search records" className="custom-icon" onClick={onClick} /></IconThemeContext.Provider>);
    const icon = screen.getByRole('img', { name: 'Search records' });
    expect(icon.tagName.toLowerCase()).toBe('svg');
    expect(icon).toHaveAttribute('data-icon-library', 'ant-design');
    expect(icon).toHaveAttribute('data-icon-name', 'search');
    expect(icon).toHaveAttribute('width', '18');
    expect(icon).toHaveAttribute('height', '18');
    expect(icon).toHaveAttribute('fill', '#234567');
    expect(icon).toHaveAttribute('viewBox', '64 64 896 896');
    expect(icon).toHaveClass('custom-icon');
    expect(ref.current).toBe(icon);
    fireEvent.click(icon);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it.each([false, undefined])('preserves the original icons outside Generic (%s)', (value) => {
    const { container } = render(<IconThemeContext.Provider value={value}><Search size={20} /></IconThemeContext.Provider>);
    expect(container.querySelector('svg')).toHaveAttribute('viewBox', '0 0 24 24');
    expect(container.querySelector('svg')).not.toHaveAttribute('data-icon-library');
  });

  it('switches families when the tenant context changes', () => {
    const { container, rerender } = render(<IconThemeContext.Provider value><Search /></IconThemeContext.Provider>);
    expect(container.querySelector('[data-icon-library="ant-design"]')).not.toBeNull();
    rerender(<IconThemeContext.Provider value={false}><Search /></IconThemeContext.Provider>);
    expect(container.querySelector('[data-icon-library="ant-design"]')).toBeNull();
  });

  it('maps close, document and loading symbols to their respective glyphs', () => {
    const { container } = render(<IconThemeContext.Provider value><X /><FileText /><Loader2 className="spin" /></IconThemeContext.Provider>);
    expect(container.querySelector('[data-icon-name="close"]')).not.toBeNull();
    expect(container.querySelector('[data-icon-name="file-text"]')).not.toBeNull();
    expect(container.querySelector('[data-icon-name="loading"]')).toHaveClass('spin');
  });

  it('renders every mapped app icon using an Ant Design SVG without extra wrappers', () => {
    const { container } = render(<IconThemeContext.Provider value>{Object.entries(icons).map(([name, Icon]) => <Icon key={name} />)}</IconThemeContext.Provider>);
    expect(Object.keys(icons).length).toBeGreaterThan(300);
    expect(container.children).toHaveLength(Object.keys(icons).length);
    expect(container.querySelectorAll('svg[data-icon-library="ant-design"]')).toHaveLength(Object.keys(icons).length);
    expect(container.querySelectorAll('svg[aria-hidden="true"]')).toHaveLength(Object.keys(icons).length);
  });
});
