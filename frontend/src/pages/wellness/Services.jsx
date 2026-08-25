import { useEffect, useState, useContext } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Sparkles,
  Plus,
  Package,
  Layers,
  Activity,
} from 'lucide-react';
import { fetchApi } from '../../utils/api';
import { useNotify } from '../../utils/notify';
import { usePermissions } from '../../hooks/usePermissions';
import { AuthContext } from '../../App';
// Issue #816: Reusable CSV import/export toolbar for the Catalog + Packages tabs.
import CsvImportExportToolbar from '../../components/wellness/CsvImportExportToolbar';
import PageHeader from '../../components/PageHeader';
import TabBtn from './services/TabBtn';
import CatalogTab from './services/CatalogTab';
import PackageBuilder from './services/PackageBuilder';
import ActiveTreatmentsTab from './services/ActiveTreatmentsTab';
import ActivePackagesTab from './services/ActivePackagesTab';
import ServiceDetailModal from './services/ServiceDetailModal';
import TreatmentDetailModal from './services/TreatmentDetailModal';

export default function Services() {
  const notify = useNotify();
  // Backend gates POST/PUT/DELETE on adminOrPerm('services', 'write').
  // One flag for everything since this route doesn't split write/update/delete.
  const { hasPermission, isReady: permsReady, userType } = usePermissions();
  const { user } = useContext(AuthContext) || {};
  const canManageServices = permsReady && hasPermission('services', 'write');
  // USER / CUSTOMER get a customer-facing catalog: Packages + Active Treatments
  // (internal/clinical surfaces) are hidden. Admin / Manager are untouched.
  const isUserOrCustomer = userType === 'CUSTOMER' || user?.role === 'USER';
  const [searchParams] = useSearchParams();
  const initialTab = searchParams.get('tab') || 'catalog';
  const [tab, setTab] = useState(initialTab); // catalog | packages | activetreatments
  const [services, setServices] = useState([]);
  const [categories, setCategories] = useState([]);
  const [treatments, setTreatments] = useState([]);
  const [packages, setPackages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [categoriesLoading, setCategoriesLoading] = useState(true);
  const [treatmentsLoading, setTreatmentsLoading] = useState(false);
  const [packagesLoading, setPackagesLoading] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [selectedTreatment, setSelectedTreatment] = useState(null);
  const [selectedService, setSelectedService] = useState(null);
  // When the modal's "Edit" button fires, we close the modal AND tell the
  // matching ServiceCard to flip into edit mode. The card watches this id
  // via a useEffect + clears it on consumption, so the next modal-edit
  // click works repeatedly.
  const [editRequestId, setEditRequestId] = useState(null);
  // #115: basePrice starts blank (not 0) so the placeholder shows and the
  // validity gate rejects submit until the user enters ≥ ₹1.
  const [form, setForm] = useState({ name: '', categoryIds: [], ticketTier: 'medium', basePrice: '', durationMin: 60, targetRadiusKm: 30, description: '', imageUrl: '' });

  const load = () => {
    setLoading(true);
    fetchApi('/api/wellness/services').then(setServices).catch(() => setServices([])).finally(() => setLoading(false));
  };

  const loadCategories = () => {
    setCategoriesLoading(true);
    fetchApi('/api/wellness/service-categories?limit=1000')
      .then(res => setCategories(res.sort((a, b) => a.name.localeCompare(b.name))))
      .catch(() => setCategories([]))
      .finally(() => setCategoriesLoading(false));
  };

  const loadTreatments = () => {
    setTreatmentsLoading(true);
    fetchApi('/api/wellness/activetreatment').then(res => setTreatments(res.data || [])).catch(() => setTreatments([])).finally(() => setTreatmentsLoading(false));
  };

  useEffect(() => {
    load();
    loadCategories();
  }, []);
  // Customers only ever see published packages; the backend enforces that
  // too, so a crafted request cannot pull drafts.
  const loadPackages = () => {
    setPackagesLoading(true);
    fetchApi('/api/wellness/packages')
      .then((res) => setPackages(Array.isArray(res?.packages) ? res.packages : []))
      .catch(() => setPackages([]))
      .finally(() => setPackagesLoading(false));
  };

  useEffect(() => {
    if (tab === 'activetreatments') {
      loadTreatments();
    }
    if (tab === 'activepackages' || (isUserOrCustomer && tab === 'packages')) {
      loadPackages();
    }
  }, [tab, isUserOrCustomer]);
  // A USER/CUSTOMER deep-linking to an internal tab has it hidden — fall back
  // to the catalog so they never see a blank page. `packages` is NOT in this
  // list any more: customers now get a read-only Packages tab of their own.
  useEffect(() => {
    if (isUserOrCustomer && (tab === 'activetreatments' || tab === 'activepackages')) {
      setTab('catalog');
    }
  }, [isUserOrCustomer, tab]);

  const submit = async (e) => {
    e.preventDefault();
    try {
      // Use first category as primary categoryId for backend compatibility.
      // imageUrls is a JSON array column — backend stringifies for us when
      // we pass an array.
      const submitData = {
        ...form,
        categoryId: form.categoryIds?.[0] || null,
        imageUrls: form.imageUrl ? [form.imageUrl] : null,
      };
      delete submitData.imageUrl;
      await fetchApi('/api/wellness/services', { method: 'POST', body: JSON.stringify(submitData) });
      notify.success(`Service "${form.name}" created`);
      setShowAdd(false);
      setForm({ name: '', categoryIds: [], ticketTier: 'medium', basePrice: '', durationMin: 60, targetRadiusKm: 30, description: '', imageUrl: '' });
      load();
    } catch (_err) { /* fetchApi already toasted */ }
  };

  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.5s ease-out' }}>
      <PageHeader
        icon={Sparkles}
        title="Service catalog"
        description="Each service has a price, duration, and target marketing radius."
        inlineBadge={permsReady && !canManageServices ? (
          <span
            title="You can view services but can't make changes."
            style={{ fontSize: '0.7rem', padding: '0.2rem 0.55rem', borderRadius: 999, background: 'var(--subtle-bg)', color: 'var(--text-secondary)', border: '1px solid var(--border-color)', fontWeight: 500 }}
          >
            View only
          </span>
        ) : null}
      >
        {tab === 'catalog' && canManageServices && (
          <>
            {/* Issue #816: services CSV. No active filter, so we pass an empty
                filters object — the export reflects the same all-active view
                as the catalog tab. CsvImportExportToolbar wraps Import POST
                and the destructive backend hits services.write too, so it is
                gated alongside New service. */}
            <CsvImportExportToolbar entity="services" label="Services" formats={['csv', 'xlsx']} onImported={load} />
            <button onClick={() => setShowAdd(!showAdd)} style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', padding: '0.5rem 1rem', background: 'var(--primary-color, var(--accent-color))', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' }}>
              <Plus size={16} /> {showAdd ? 'Cancel' : 'New service'}
            </button>
          </>
        )}
        {tab === 'packages' && canManageServices && (
          /* Issue #816: packages CSV. */
          <CsvImportExportToolbar entity="packages" label="Packages" formats={['csv', 'xlsx']} />
        )}
      </PageHeader>

      {/* Tabs */}
      <div
        style={{
          display: 'flex',
          gap: '0.5rem',
          marginBottom: '1.5rem',
          borderBottom: '1px solid rgba(255,255,255,0.06)',
        }}
      >
        <TabBtn active={tab === 'catalog'} onClick={() => setTab('catalog')} icon={Sparkles} label="Catalog" />
        {/* Packages is now BOTH surfaces: the builder for staff, and a
            read-only list of published packages for customers. */}
        <TabBtn active={tab === 'packages'} onClick={() => setTab('packages')} icon={Package} label="Packages" />
        {/* Active Packages (saved bundles) + Active Treatments (clinical PHI)
            are internal surfaces — hidden for USER/CUSTOMER. They are
            deliberately separate tabs: one is catalog config, the other is
            per-patient clinical data. */}
        {!isUserOrCustomer && (
          <TabBtn active={tab === 'activepackages'} onClick={() => setTab('activepackages')} icon={Layers} label="Active Packages" />
        )}
        {!isUserOrCustomer && (
          <TabBtn active={tab === 'activetreatments'} onClick={() => setTab('activetreatments')} icon={Activity} label="Active Treatments" />
        )}
      </div>

      {tab === 'catalog' && (
        <CatalogTab
          services={services}
          loading={loading}
          categories={categories}
          categoriesLoading={categoriesLoading}
          showAdd={showAdd}
          form={form}
          setForm={setForm}
          submit={submit}
          onChanged={load}
          onOpenService={setSelectedService}
          editRequestId={editRequestId}
          clearEditRequest={() => setEditRequestId(null)}
        />
      )}

      {tab === 'packages' &&
        (isUserOrCustomer ? (
          <ActivePackagesTab packages={packages} loading={packagesLoading} readOnly />
        ) : (
          <PackageBuilder services={services} onSaved={loadPackages} />
        ))}

      {tab === 'activepackages' && !isUserOrCustomer && (
        <ActivePackagesTab
          packages={packages}
          loading={packagesLoading}
          onChanged={loadPackages}
        />
      )}

      {tab === 'activetreatments' && !isUserOrCustomer && (
        <ActiveTreatmentsTab
          treatments={treatments}
          loading={treatmentsLoading}
          onChanged={loadTreatments}
          onSelectTreatment={setSelectedTreatment}
        />
      )}

      {selectedTreatment && (
        <TreatmentDetailModal
          treatment={selectedTreatment}
          onClose={() => setSelectedTreatment(null)}
          onChanged={() => { loadTreatments(); setSelectedTreatment(null); }}
        />
      )}

      {selectedService && (
        <ServiceDetailModal
          service={selectedService}
          categories={categories}
          onClose={() => setSelectedService(null)}
          onEdit={(svc) => {
            setSelectedService(null);
            setEditRequestId(svc.id);
          }}
          onChanged={load}
        />
      )}
    </div>
  );
}
