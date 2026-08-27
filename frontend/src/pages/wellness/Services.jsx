import { useEffect, useState, useContext } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Sparkles,
  Plus,
  Package,
  Layers,
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
import usePackageCheckout from './services/usePackageCheckout';
import RequestSessionModal from './services/RequestSessionModal';
import SessionRequestsPanel from './services/SessionRequestsPanel';
import ServiceDetailModal from './services/ServiceDetailModal';
import TreatmentDetailModal from './services/TreatmentDetailModal';

const sectionHeading = {
  fontSize: '0.95rem',
  fontWeight: 600,
  color: 'var(--text-primary)',
  marginBottom: '0.75rem',
};

export default function Services() {
  const notify = useNotify();
  // Backend gates POST/PUT/DELETE on adminOrPerm('services', 'write').
  // One flag for everything since this route doesn't split write/update/delete.
  const { hasPermission, isReady: permsReady, userType } = usePermissions();
  const { user, tenant } = useContext(AuthContext) || {};
  const canManageServices = permsReady && hasPermission('services', 'write');
  // USER / CUSTOMER get a customer-facing catalog: Active Packages
  // (per-patient clinical data) is hidden. Admin / Manager are untouched.
  // A real customer is stamped `userType: 'CUSTOMER'` — the same test
  // GET /api/wellness/packages uses to decide what it hands back. Reading
  // `role === 'USER'` as "customer" swept in every doctor, nurse, telecaller
  // and receptionist, because staff are role USER / userType STAFF: they were
  // shown the customer catalog, complete with a Buy button.
  const isCustomer = userType === 'CUSTOMER' || user?.role === 'CUSTOMER';
  const [searchParams] = useSearchParams();
  // The saved-bundles tab was folded away and treatment plans took its name,
  // so a bookmark still pointing at ?tab=activepackages lands on the renamed
  // tab instead of rendering nothing.
  const requestedTab = searchParams.get('tab') || 'catalog';
  const initialTab = requestedTab === 'activepackages' ? 'activetreatments' : requestedTab;
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
  // Customer checkout. A purchase becomes a treatment plan on the patient's
  // record, so the list is reloaded to reflect anything that changed.
  const { buy, buyingId } = usePackageCheckout({
    onPurchased: () => loadPackages({ quiet: true }),
    clinicName: tenant?.name || 'Wellness',
  });
  // Which owned package the customer is asking for a session from.
  const [sessionRequestPkg, setSessionRequestPkg] = useState(null);
  // Practitioners the clinic can hand a requested session to.
  const [doctors, setDoctors] = useState([]);

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

  const loadTreatments = ({ quiet = false } = {}) => {
    // Same rule as loadPackages: pausing or cancelling a patient's package
    // should replace the card in place, not blank the whole list first.
    if (!quiet) setTreatmentsLoading(true);
    fetchApi('/api/wellness/activetreatment').then(res => setTreatments(res.data || [])).catch(() => setTreatments([])).finally(() => setTreatmentsLoading(false));
  };

  useEffect(() => {
    load();
    loadCategories();
  }, []);
  // Customers only ever see published packages; the backend enforces that
  // too, so a crafted request cannot pull drafts.
  const loadPackages = ({ quiet = false } = {}) => {
    // A refresh that follows a publish / retire / edit keeps the cards on
    // screen: `quiet` skips the loading flag, so the list is replaced in place
    // when the new data lands. Swapping the whole grid for "Loading packages…"
    // on every toggle is what made publishing feel like a page reload.
    if (!quiet) setPackagesLoading(true);
    fetchApi('/api/wellness/packages')
      .then((res) => setPackages(Array.isArray(res?.packages) ? res.packages : []))
      .catch(() => setPackages([]))
      .finally(() => setPackagesLoading(false));
  };

  useEffect(() => {
    if (isCustomer || tab !== 'activetreatments') return undefined;
    let cancelled = false;
    fetchApi('/api/staff', { silent: true })
      .then((res) => {
        if (cancelled) return;
        const all = Array.isArray(res) ? res : [];
        setDoctors(all.filter((u) => u.wellnessRole === 'doctor' || u.primaryRole?.key === 'DOCTOR'));
      })
      .catch(() => setDoctors([]));
    return () => { cancelled = true; };
  }, [tab, isCustomer]);

  useEffect(() => {
    if (tab === 'activetreatments') {
      loadTreatments();
      // Bundles saved on the Packages tab surface here too, so staff have
      // somewhere to publish or retire what they just built.
      if (!isCustomer) loadPackages();
    }
    // Loaded for anyone who sees the list rather than the builder: customers,
    // and staff without services.write.
    if (tab === 'packages' && (isCustomer || !canManageServices)) {
      loadPackages();
    }
  }, [tab, isCustomer, canManageServices]);
  // A customer deep-linking to an internal tab has it hidden — fall back
  // to the catalog so they never see a blank page. `packages` is NOT in this
  // list any more: customers now get a read-only Packages tab of their own.
  useEffect(() => {
    if (isCustomer && tab === 'activetreatments') {
      setTab('catalog');
    }
  }, [isCustomer, tab]);

  // A bundle built on the Packages tab is a catalog offering; a treatment
  // plan is one a patient has bought and is working through. Both are
  // "packages" to this clinic, so they share a tab — but only when there is a
  // bundle to show, otherwise the extra headings are noise.
  const hasBundles = !isCustomer && packages.length > 0;

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
        {/* "Active Packages" is what this clinic calls a plan a patient has
            bought and is working through — the tab is backed by TreatmentPlan
            rows, which are per-patient clinical data, so it stays hidden for
            USER/CUSTOMER. The internal tab key is still `activetreatments`;
            only the label changed. */}
        {!isCustomer && (
          <TabBtn active={tab === 'activetreatments'} onClick={() => setTab('activetreatments')} icon={Layers} label="Active Packages" />
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

      {/* Three audiences, not two. A patient buys; someone who can manage the
          catalog builds; everyone else on staff — a doctor, say — may look at
          what the clinic sells without being offered a purchase they should
          not be making from a staff account. */}
      {tab === 'packages' && (
        isCustomer ? (
          <ActivePackagesTab
            packages={packages}
            loading={packagesLoading}
            readOnly
            onBuy={buy}
            buyingId={buyingId}
            onRequestSession={setSessionRequestPkg}
          />
        ) : canManageServices ? (
          <PackageBuilder services={services} onSaved={() => loadPackages()} />
        ) : (
          <ActivePackagesTab packages={packages} loading={packagesLoading} readOnly />
        )
      )}

      {tab === 'activetreatments' && !isCustomer && (
        <>
          {/* Answering these is time-sensitive — a patient is waiting on a
              reply — so the queue sits above the catalog admin below it. */}
          <SessionRequestsPanel
            doctors={doctors}
            onHandled={() => { loadTreatments({ quiet: true }); loadPackages({ quiet: true }); }}
          />
          {hasBundles && (
            <section style={{ marginBottom: '1.75rem' }}>
              <h2 style={sectionHeading}>Packages you offer</h2>
              <ActivePackagesTab
                packages={packages}
                loading={packagesLoading}
                onChanged={() => loadPackages({ quiet: true })}
                readOnly={!canManageServices}
              />
            </section>
          )}
          {hasBundles && <h2 style={sectionHeading}>Patient packages in progress</h2>}
          <ActiveTreatmentsTab
            treatments={treatments}
            loading={treatmentsLoading}
            onChanged={() => loadTreatments({ quiet: true })}
            onSelectTreatment={setSelectedTreatment}
          />
        </>
      )}

      {selectedTreatment && (
        <TreatmentDetailModal
          treatment={selectedTreatment}
          onClose={() => setSelectedTreatment(null)}
          onChanged={() => { loadTreatments({ quiet: true }); setSelectedTreatment(null); }}
        />
      )}

      {sessionRequestPkg && (
        <RequestSessionModal
          pkg={sessionRequestPkg}
          onClose={() => setSessionRequestPkg(null)}
          onRequested={loadPackages}
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
