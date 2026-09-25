import { useEffect, useMemo, useState } from "react";
import { Download, History, Search, UploadCloud } from "lucide-react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import PermissionGate from "../../../components/PermissionGate";
import { fetchApi } from "../../../utils/api";
import { formatMoney } from "../../../utils/money";
import { useNotify } from "../../../utils/notify";
import { getTripLedgerRows, rowMatchesTrip } from "./tallyMath";
import { buildTallyMastersXml, buildTallyXml, buildVoucherRows } from "./tallyExportBuilder";
import { useTravelTallyMaster } from "./useTravelTallyMaster";
import { downloadTallyConnectorPackage, fetchTallyConnectorBinary } from "./tallyConnectorConfig";
import TallySectionNav from "./TallySectionNav";
import tallyIcon from "../../../assets/tally-icon.png";

const field = (value) => value == null || value === "" ? "—" : String(value);
const requestConnectorStatus = (silent = true) =>
  fetchApi("/api/travel/tally/connector/status", { silent });
const SUB_BRAND_OPTIONS = [
  { value: "all", label: "All sub-brands" },
  { value: "tmc", label: "TMC" },
  { value: "rfu", label: "RFU" },
  { value: "travelstall", label: "TravelStall" },
  { value: "visasure", label: "Visa Sure" },
];
const validSubBrand = (value) => SUB_BRAND_OPTIONS.some((option) => option.value === value);
const subBrandLabel = (value) => SUB_BRAND_OPTIONS.find((option) => option.value === value)?.label || value;
const TALLY_PAGE_SIZE_OPTIONS = [10, 20, 50];

export default function TallyExportPreviewPage() {
  const { tripId } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const notify = useNotify();
  const { master } = useTravelTallyMaster();
  const requestedSubBrand = searchParams.get("subBrand");
  const [subBrandFilter, setSubBrandFilter] = useState(
    validSubBrand(requestedSubBrand) ? requestedSubBrand : (master.subBrand || "all"),
  );
  const [tallySyncFilter, setTallySyncFilter] = useState("all");
  const [tripSearch, setTripSearch] = useState("");
  const [trip, setTrip] = useState(null);
  const [allTrips, setAllTrips] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [allCustomers, setAllCustomers] = useState([]);
  const [payments, setPayments] = useState([]);
  const [allPayments, setAllPayments] = useState([]);
  const [payables, setPayables] = useState([]);
  const [allPayables, setAllPayables] = useState([]);
  const [costCentreStatuses, setCostCentreStatuses] = useState({});
  const [lastVoucherSyncTimes, setLastVoucherSyncTimes] = useState({});
  const [tripVoucherResults, setTripVoucherResults] = useState({});
  const [loading, setLoading] = useState(true);
  const [tallyPreviewSelection, setTallyPreviewSelection] = useState("voucher:0");
  const [connectorStatus, setConnectorStatus] = useState(null);
  const [generatingCredentials, setGeneratingCredentials] = useState(false);
  const [educationalMode, setEducationalMode] = useState(() => {
    try { return window.localStorage.getItem("travel-tally-educational-mode") === "true"; } catch (_) { return false; }
  });
  const [pushNotice, setPushNotice] = useState(null);
  const [pushing, setPushing] = useState(false);
  useEffect(() => {
    if (validSubBrand(requestedSubBrand)) {
      setSubBrandFilter((current) => current === requestedSubBrand ? current : requestedSubBrand);
    }
  }, [requestedSubBrand]);
  useEffect(() => setTallyPreviewSelection("voucher:0"), [tripId]);

  useEffect(() => {
    let cancelled = false;
    const loadStatus = () => requestConnectorStatus(true)
      .then((status) => { if (!cancelled) setConnectorStatus(status); })
      .catch(() => { if (!cancelled) setConnectorStatus(null); });
    loadStatus();
    const timer = setInterval(loadStatus, 15_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  const refreshConnectorStatus = async () => {
    try {
      setConnectorStatus(await requestConnectorStatus(false));
    } catch (_) {
      setConnectorStatus(null);
    }
  };

  useEffect(() => {
    let cancelled = false;
    const effectiveSubBrand = subBrandFilter;
    const itineraryParams = new URLSearchParams({ fields: "summary", limit: "200" });
    if (effectiveSubBrand !== "all") itineraryParams.set("subBrand", effectiveSubBrand);
    const tripsRequest = effectiveSubBrand === "all" || effectiveSubBrand === "tmc"
      ? fetchApi(`/api/travel/trips?fields=summary&limit=200`).catch(() => ({ trips: [] }))
      : Promise.resolve({ trips: [] });
    Promise.all([
      fetchApi(`/api/travel/itineraries?${itineraryParams}`),
      tripsRequest,
      fetchApi(`/api/travel/tally/ledger?subBrand=${encodeURIComponent(effectiveSubBrand)}`),
      fetchApi("/api/travel/tally/cost-centres").catch(() => ({ costCentres: [] })),
    ]).then(([tripData, tmcTripData, ledgerData, costCentreData]) => {
      if (cancelled) return;
      const nextCostCentreStatuses = {};
      const nextLastVoucherSyncTimes = {};
      (costCentreData?.costCentres || []).forEach((costCentre) => {
        const key = `${costCentre.sourceType}:${costCentre.sourceId}`;
        nextCostCentreStatuses[key] = costCentre.voucherSyncStatus || costCentre.syncStatus || "NOT_CONNECTED";
        if (costCentre.lastVoucherSyncAt) nextLastVoucherSyncTimes[key] = costCentre.lastVoucherSyncAt;
      });
      setCostCentreStatuses(nextCostCentreStatuses);
      setLastVoucherSyncTimes(nextLastVoucherSyncTimes);
      const itineraryTrips = (tripData?.itineraries || []).map((row) => ({ ...row, ledgerType: "itinerary" }));
      const tmcTrips = (tmcTripData?.trips || []).map((row) => ({
        ...row,
        id: `tmc-${row.id}`,
        tmcTripId: row.id,
        ledgerType: "tmc",
        subBrand: row.subBrand || "tmc",
        destination: row.tripCode ? `${row.tripCode} — ${row.destination || ""}`.trim() : row.destination,
      }));
      const combinedTrips = [...itineraryTrips, ...tmcTrips];
      const quoteRows = [...(ledgerData?.customerDetails || []), ...(ledgerData?.payableDetails || [])];
      const quoteTrips = [...new Map(quoteRows
        .filter((row) => row.quoteId != null && !row.itineraryId && !row.tripId)
        .map((row) => [String(row.quoteId), {
          id: `quote-${row.quoteId}`,
          quoteId: Number(row.quoteId),
          destination: row.tripName || `Quote #${row.quoteId}`,
          status: "Quoted",
          ledgerType: "quote",
          subBrand: row.subBrand || effectiveSubBrand,
        }])).values()];
      const allCombinedTrips = [...combinedTrips, ...quoteTrips].filter((row) =>
        effectiveSubBrand === "all" || row.subBrand === effectiveSubBrand,
      );
      const foundTrip = allCombinedTrips.find((row) => String(row.id) === String(tripId));
      setAllTrips(allCombinedTrips);
      setTrip(foundTrip || null);
      const isTmcTrip = String(tripId || "").startsWith("tmc-");
      const isQuoteTrip = String(tripId || "").startsWith("quote-");
      const sourceTripId = isTmcTrip ? String(tripId).replace(/^tmc-/, "") : String(tripId);
      const tripCustomers = (ledgerData?.customerDetails || []).filter((row) =>
        isQuoteTrip ? String(row.quoteId) === String(tripId).replace(/^quote-/, "")
          : isTmcTrip ? String(row.tripId) === sourceTripId : String(row.itineraryId) === sourceTripId,
      );
      setCustomers(tripCustomers);
      const tripInvoiceIds = new Set(tripCustomers.map((row) => Number(row.id)));
      setPayments((ledgerData?.paymentDetails || []).filter((payment) => tripInvoiceIds.has(Number(payment.invoiceId))));
      setAllPayments(ledgerData?.paymentDetails || []);
      setAllCustomers(ledgerData?.customerDetails || []);
      setPayables((ledgerData?.payableDetails || []).filter((row) =>
        isQuoteTrip ? String(row.quoteId) === String(tripId).replace(/^quote-/, "")
          : isTmcTrip ? String(row.tripId) === sourceTripId : String(row.itineraryId) === sourceTripId,
      ));
      setAllPayables(ledgerData?.payableDetails || []);
    }).catch(() => { if (!cancelled) setTrip(null); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [master.subBrand, subBrandFilter, tripId]);

  const summary = useMemo(() => trip ? getTripLedgerRows({ trips: [trip], customers, suppliers: [], payables, tripTaxes: {} })[0] : null, [trip, customers, payables]);
  const allRows = useMemo(() => getTripLedgerRows({ trips: allTrips, customers: allCustomers, suppliers: [], payables: allPayables, tripTaxes: {} }), [allTrips, allCustomers, allPayables]);
  const pendingVoucherCounts = useMemo(() => Object.fromEntries(allRows.map((row) => [row.id, countPendingTripVouchers({
    tripId: row.id,
    customers: allCustomers,
    payments: allPayments,
    payables: allPayables,
    lastSyncedAt: lastVoucherSyncTimes[costCentreKeyForTrip(row.id)],
  })])), [allCustomers, allPayments, allPayables, allRows, lastVoucherSyncTimes]);
  const visibleRows = useMemo(() => {
    const query = tripSearch.trim().toLocaleLowerCase();
    return allRows.filter((row) => {
      const matchesStatus = tallySyncFilter === "all"
        || getTripDisplaySyncStatus(row, costCentreStatuses, pendingVoucherCounts) === tallySyncFilter;
      const tripIdForSearch = String(row.id || "").replace(/^tmc-/, "");
      const matchesSearch = !query || [row.label, row.id, tripIdForSearch]
        .some((value) => String(value || "").toLocaleLowerCase().includes(query));
      return matchesStatus && matchesSearch;
    });
  }, [allRows, costCentreStatuses, pendingVoucherCounts, tallySyncFilter, tripSearch]);
  const currentPage = Math.max(1, Number(searchParams.get("page") || 1));
  const pageSizeParam = Number(searchParams.get("pageSize"));
  const pageSize = TALLY_PAGE_SIZE_OPTIONS.includes(pageSizeParam) ? pageSizeParam : 10;
  const pageCount = Math.max(1, Math.ceil(visibleRows.length / pageSize));
  const safePage = Math.min(currentPage, pageCount);
  const paginatedRows = useMemo(
    () => visibleRows.slice((safePage - 1) * pageSize, safePage * pageSize),
    [pageSize, safePage, visibleRows],
  );
  useEffect(() => {
    if (currentPage === safePage) return;
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set("page", String(safePage));
    setSearchParams(nextParams, { replace: true });
  }, [currentPage, safePage, searchParams, setSearchParams]);
  const buildTripExport = () => {
    if (!summary) return;
    const exportDate = master.to || master.from || trip.startDate || trip.fromDate || trip.createdAt || new Date().toISOString();
    const journalDate = customers.find((row) => row.transactionDate || row.createdAt || row.date)?.transactionDate || customers.find((row) => row.transactionDate || row.createdAt || row.date)?.createdAt || master.from || exportDate;
    const effectiveSubBrand = trip.subBrand || subBrandFilter;
    const exportMaster = { ...master, subBrand: effectiveSubBrand, from: master.from || exportDate, to: journalDate };
    const voucherRows = buildVoucherRows({ accounts: [], commonRows: [], customers, payments, payables, trips: [trip], tripTaxes: {}, master: exportMaster, selectedSubBrandLabel: effectiveSubBrand === "all" ? "Travel" : subBrandLabel(effectiveSubBrand), ledgerRows: [], ledgerMappings: [] });
    return { voucherRows, fileName: summary.label.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "trip" };
  };
  const downloadXmlFile = (fileName, xml) => {
    const url = URL.createObjectURL(new Blob([xml], { type: "application/xml;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    URL.revokeObjectURL(url);
  };
  const pushTripDirectly = async () => {
    const exportData = buildTripExport();
    if (!exportData) return;
    const mastersXml = buildTallyMastersXml({ companyName: master.companyName, voucherRows: exportData.voucherRows });
    const vouchersXml = buildTallyXml({ companyName: master.companyName, voucherRows: exportData.voucherRows, educationalMode });
    const pushToTally = (options = {}) => fetchApi("/api/travel/tally/connector/push", { method: "POST", body: JSON.stringify({ mastersXml, vouchersXml, ...options }), silent: true });
    const downloadFallback = (notice = { title: "Push failed", message: "The push failed, so Masters and Voucher XML files were downloaded automatically." }) => {
      downloadXmlFile(`${exportData.fileName}-masters.xml`, mastersXml);
      downloadXmlFile(`${exportData.fileName}${educationalMode ? "-educational" : ""}-vouchers.xml`, vouchersXml);
      setPushNotice(notice);
    };
    if (!connectorStatus?.online) {
      downloadFallback({
        title: "Connector offline",
        message: "Masters and Voucher XML files were downloaded for manual import into Tally.",
      });
      return;
    }
    const showSuccess = (result) => {
      const tally = result.results?.find((entry) => entry.stage === "vouchers")?.tally;
      if (!tally && result.skippedVouchers > 0) {
        notify.info(`No new vouchers to push. Skipped ${result.skippedVouchers} voucher(s) already sent to Tally.`);
        return;
      }
      const skipped = result.skippedVouchers ? `, skipped ${result.skippedVouchers} already pushed` : "";
      const created = Number(tally?.created || 0);
      const altered = Number(tally?.altered || 0);
      if (trip?.id != null) {
        setTripVoucherResults((current) => ({ ...current, [String(trip.id)]: { created, altered } }));
      }
      const costCentreSynced = result.results?.some((entry) => entry.stage === "masters" && entry.status === "success");
      if (costCentreSynced && trip?.id != null) {
        const rawId = String(trip.id);
        const sourceType = rawId.startsWith("tmc-") ? "TMC_TRIP" : rawId.startsWith("quote-") ? "QUOTE" : "ITINERARY";
        const sourceId = rawId.replace(/^(tmc-|quote-)/, "");
        setCostCentreStatuses((current) => ({ ...current, [`${sourceType}:${sourceId}`]: "SYNCED" }));
        if (result.results?.some((entry) => entry.stage === "vouchers" && entry.status === "success")) {
          setLastVoucherSyncTimes((current) => ({ ...current, [`${sourceType}:${sourceId}`]: new Date().toISOString() }));
        }
      }
      notify.success(`Trip pushed to Tally. ${summary?.label || "Trip"}: ${created} new voucher(s) created, ${altered} updated${skipped}.`);
    };
    setPushing(true);
    try {
      showSuccess(await pushToTally());
    } catch (error) {
      if (error.code === "TALLY_IMPORT_FAILED" && trip?.id != null) {
        setCostCentreStatuses((current) => ({ ...current, [costCentreKeyForTrip(trip.id)]: "FAILED" }));
      }
      if (error.code === "TALLY_EXISTING_VOUCHERS_FOUND") {
        const existingAction = await notify.confirm({
          title: "Existing vouchers found",
          message: `${error.message}\n\nUpdate existing vouchers and recreate any that were deleted from Tally?`,
          confirmText: "Update existing",
          cancelText: "More options",
          confirmValue: "update",
          cancelValue: "more",
          dismissible: true,
        });
        if (existingAction === "update" || existingAction === true) {
          try {
            showSuccess(await pushToTally({ updateExisting: true }));
          } catch (updateError) {
            notify.error(updateError.message || "The Tally update failed.");
          }
          return;
        }
        if (existingAction !== "more") return;
        const repushConfirmed = await notify.confirm({
          title: "Re-upload as new vouchers?",
          message: "This sends every voucher with Create and can produce duplicates for vouchers that still exist in Tally.",
          confirmText: "Re-upload all",
          cancelText: "Cancel",
          destructive: true,
        });
        if (!repushConfirmed) {
          notify.info("Push cancelled. Nothing was sent to Tally.");
          return;
        }
        try {
          showSuccess(await pushToTally({ forceRepush: true }));
        } catch (retryError) {
          notify.error(retryError.message || "The repeated Tally push failed.");
        }
        return;
      }
      if (error.code === "TALLY_NO_NEW_VOUCHERS") {
        const confirmed = await notify.confirm({
          title: "No new vouchers",
          message: `${error.message}\n\nPush all vouchers again?`,
          confirmText: "Push again",
          cancelText: "Cancel",
          destructive: true,
        });
        if (!confirmed) {
          notify.info("Push cancelled. Nothing was sent to Tally.");
          return;
        }
        try {
          showSuccess(await pushToTally({ forceRepush: true }));
        } catch (retryError) {
          notify.error(retryError.message || "The repeated Tally push failed.");
        }
      } else if (error.code === "TALLY_LEGACY_RECEIPT_PARTIAL_MATCH") {
        notify.error(error.message);
      } else {
        downloadFallback();
      }
    } finally {
      setPushing(false);
    }
  };
  const downloadConnector = async () => {
    setGeneratingCredentials(true);
    try {
      const executable = await fetchTallyConnectorBinary();
      const credentials = await fetchApi("/api/travel/tally/connector/credentials", { method: "POST" });
      downloadTallyConnectorPackage(credentials, executable);
      await refreshConnectorStatus();
      notify.success("Tally Connector ZIP downloaded. Extract it and run the executable beside config.json.");
    } catch (error) {
      notify.error(error.message || "Could not download the Tally Connector ZIP.");
    } finally {
      setGeneratingCredentials(false);
    }
  };
  const previewData = buildTripExport();
  const previewRows = previewData?.voucherRows.slice(1) || [];
  const previewOptions = getTallyPreviewOptions(previewRows);
  const selectedPreview = previewOptions.find((option) => option.value === tallyPreviewSelection) || previewOptions[0];
  const updateSubBrandFilter = (value) => {
    setSubBrandFilter(value);
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set("subBrand", value);
    nextParams.set("page", "1");
    setSearchParams(nextParams, { replace: true });
  };
  const updateTallySyncFilter = (value) => {
    setTallySyncFilter(value);
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set("page", "1");
    setSearchParams(nextParams, { replace: true });
  };
  const updateTripSearch = (value) => {
    setTripSearch(value);
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set("page", "1");
    setSearchParams(nextParams, { replace: true });
  };
  const updatePage = (nextPage) => {
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set("page", String(Math.min(pageCount, Math.max(1, nextPage))));
    setSearchParams(nextParams, { replace: true });
  };
  const updatePageSize = (nextPageSize) => {
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set("pageSize", String(nextPageSize));
    nextParams.set("page", "1");
    setSearchParams(nextParams, { replace: true });
  };

  if (loading) return <main style={page}><p>Loading Tally export preview…</p></main>;
  if (!tripId) return <main style={page}>
    <TallySectionNav showBack />
    <section style={card}>
      <div style={header}>
        <div>
          <span style={eyebrow}>Tally Export</span>
          <h1>All Trips</h1>
          <p style={muted}>Paid Sales and Cash Profit use customer payments received. Unpaid invoice value remains outstanding.</p>
        </div>
        <button type="button" onClick={() => navigate("/travel/tally/sync-history")} style={button}><History size={15} /> Sync history</button>
      </div>
      <div style={{ ...connectorPanel, borderColor: connectorStatus?.online ? "#10b981" : undefined }}>
        <div style={connectorHeader}>
          <div>
            <strong>Direct Tally connector</strong>
            <small style={{ display: "block", color: connectorStatus?.online ? "#10b981" : "var(--text-secondary)" }}>
              {connectorStatus?.online ? `Online${connectorStatus.machineId ? ` on ${connectorStatus.machineId}` : ""}` : connectorStatus?.configured ? "Configured, but currently offline" : "Not configured"}
            </small>
          </div>
          <div style={connectorButtons}>
            <button type="button" onClick={refreshConnectorStatus} style={smallButton}>Refresh status</button>
            <PermissionGate module="tally" action="update">
              <button type="button" onClick={downloadConnector} disabled={generatingCredentials} style={{ ...smallButton, background: "#f4512c", borderColor: "#f4512c", color: "#fff" }}><Download size={14} /> {generatingCredentials ? "Preparing ZIP…" : "Download Tally Connector"}</button>
            </PermissionGate>
          </div>
        </div>
        <small style={muted}>Run the connector on the Windows computer where Tally is open on localhost port 9000.</small>
      </div>
      <TallySyncGuidelines />
      <div style={filterBar}>
        <label htmlFor="tally-trip-search" style={searchControl}>
          <Search size={15} aria-hidden="true" />
          <input
            id="tally-trip-search"
            type="search"
            value={tripSearch}
            onChange={(event) => updateTripSearch(event.target.value)}
            placeholder="Search trips by name or ID"
            aria-label="Search trips by name or ID"
            style={tripSearchInput}
          />
        </label>
        <label htmlFor="tally-sub-brand-filter" style={filterLabel}>Sub-brand</label>
        <select id="tally-sub-brand-filter" value={subBrandFilter} onChange={(event) => updateSubBrandFilter(event.target.value)} style={filterSelect}>
          {SUB_BRAND_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <label htmlFor="tally-sync-status-filter" style={filterLabel}>Tally Sync Status</label>
        <select id="tally-sync-status-filter" value={tallySyncFilter} onChange={(event) => updateTallySyncFilter(event.target.value)} style={filterSelect}>
          <option value="all">All statuses</option>
          <option value="SYNCED">Synced</option>
          <option value="NEW_VOUCHERS">New vouchers pending</option>
          <option value="NOT_CONNECTED">Not connected</option>
          <option value="FAILED">Failed</option>
        </select>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={table}>
          <thead><tr>{["Trip", "Status", "Tally Sync Status", "Sales", "Purchase", "GST / TCS", "Cash Profit / Loss", "Actions"].map((label) => <th key={label} style={th}>{label}</th>)}</tr></thead>
          <tbody>{visibleRows.length ? paginatedRows.map((row) => <tr key={row.id}>
            <td style={td}><strong>{row.label}</strong><small style={{ display: "block", color: "var(--text-secondary)" }}>Trip #{row.id}</small></td>
            <td style={td}>{row.status}</td>
            <td style={td}><SyncStatusBadge status={getTripDisplaySyncStatus(row, costCentreStatuses, pendingVoucherCounts)} />{pendingVoucherCounts[row.id] > 0 && <small style={{ display: "block", marginTop: 5, color: "#c2410c" }}>{pendingVoucherCounts[row.id]} new voucher(s) to push</small>}{tripVoucherResults[row.id] && <small style={{ display: "block", marginTop: 5, color: "var(--text-secondary)" }}>Last push: {tripVoucherResults[row.id].created} new, {tripVoucherResults[row.id].altered} updated</small>}</td>
            <td style={td}>{formatMoney(row.sales)}{row.unpaidSales > 0 && <small style={{ display: "block", color: "#f59e0b" }}>Unpaid: {formatMoney(row.unpaidSales)}</small>}</td>
            <td style={td}>{formatMoney(row.purchase)}</td>
            <td style={td}>{formatMoney(row.gst + row.tcs)}</td>
            <td style={td}>{formatMoney(row.profit)}</td>
            <td style={td}><button type="button" aria-label={`Preview ${row.label}`} title={`Preview ${row.label}`} onClick={() => navigate(`/travel/tally/export/${row.id}?subBrand=${encodeURIComponent(subBrandFilter)}`)} style={iconButton}><img src={tallyIcon} alt="" style={tallyIconStyle} /></button></td>
          </tr>) : <tr><td colSpan="8" style={emptyState}>No trips match your search and filters.</td></tr>}</tbody>
        </table>
      </div>
      {visibleRows.length > 0 && (
        <TallyPagination
          page={safePage}
          pageCount={pageCount}
          pageSize={pageSize}
          total={visibleRows.length}
          onPageChange={updatePage}
          onPageSizeChange={updatePageSize}
        />
      )}
    </section>
  </main>;
  if (!trip || !summary) return <main style={page}><TallySectionNav showBack /><section style={card}><h1>Trip not found</h1><p style={muted}>This trip is no longer available for export.</p></section></main>;

  return <main style={page}>
    {pushNotice && <TallyPushNotice notice={pushNotice} onClose={() => setPushNotice(null)} />}
    <TallySectionNav showBack />
    <section style={card}>
      <div style={header}><div><span style={eyebrow}>Tally Export Preview</span><h1 style={{ margin: "5px 0 0" }}>{summary.label}</h1><p style={muted}>Complete trip accounting details prepared for direct Tally push.</p></div></div>
      <div style={detailsGrid}><Detail label="Trip ID" value={`#${trip.id}`} /><Detail label="Status" value={summary.status} /><Detail label="Trip Code" value={trip.tripCode} /><Detail label="Destination" value={trip.destination} /><Detail label="Start Date" value={trip.startDate || trip.fromDate} /><Detail label="End Date" value={trip.endDate || trip.toDate} /><Detail label="Company" value={master.companyName} /><Detail label="Sub-brand" value={subBrandLabel(trip.subBrand || subBrandFilter)} /></div>
      <div style={voucher}><div style={voucherHeader}>Tally voucher summary <span>Globussoft</span></div><div style={summaryGrid}><Metric label="Paid sales" value={summary.sales} /><Metric label="Unpaid sales" value={summary.unpaidSales} /><Metric label="Purchase" value={summary.purchase} /><Metric label="Cash profit / loss" value={summary.profit} positive={summary.profit >= 0} /><Metric label="Accrual profit / loss" value={summary.accrualProfit} positive={summary.accrualProfit >= 0} /></div></div>
      <TallyPreviewSelector options={previewOptions} value={selectedPreview?.value || ""} onChange={setTallyPreviewSelection} />
      {selectedPreview?.kind === "voucher" ? <TallyVoucherPreview row={selectedPreview.row} companyName={master.companyName} /> : selectedPreview ? <TallyLedgerPreview ledger={selectedPreview.ledger} rows={previewRows} /> : <p style={muted}>No voucher or ledger data available for preview.</p>}
    </section>
    <section style={card}><h2 style={sectionTitle}>All trip records</h2><RecordTable title="Customer invoices & receipts" rows={customers} columns={["name", "reference", "invoiceTotal", "amount"]} labels={["Party", "Reference", "Invoice", "Received"]} /><RecordTable title="Expenses" rows={payables} columns={["name", "reference", "amount", "status"]} labels={["Supplier", "Reference", "Amount", "Status"]} /></section>
    <div style={bottomPush}><div style={connectorButtons}><PermissionGate module="tally" action="export"><button type="button" onClick={pushTripDirectly} disabled={pushing} title={connectorStatus?.online ? "Send masters and vouchers directly to local Tally" : "Connector offline: download XML files for manual import into Tally"} style={{ ...downloadButton, background: !pushing ? "#ea580c" : "#64748b", borderColor: !pushing ? "#ea580c" : "#64748b", cursor: !pushing ? "pointer" : "not-allowed" }}><UploadCloud size={16} /> {pushing ? "Pushing…" : "Push directly to Tally"}</button></PermissionGate></div><label style={educationalToggle}><input type="checkbox" checked={educationalMode} onChange={(event) => { const enabled = event.target.checked; setEducationalMode(enabled); try { window.localStorage.setItem("travel-tally-educational-mode", String(enabled)); } catch (_) { /* optional preference */ } }} /> Tally is running in Educational Mode <small>(uses the first day of each month)</small></label></div>
  </main>;
}

function TallyPagination({ page, pageCount, pageSize, total, onPageChange, onPageSizeChange }) {
  const start = (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, total);
  const controlStyle = {
    minHeight: 34,
    padding: "6px 10px",
    border: "1px solid var(--border-color, rgba(148,163,184,.25))",
    borderRadius: 8,
    background: "transparent",
    color: "var(--text-primary)",
    fontWeight: 600,
    cursor: "pointer",
  };
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginTop: 16, color: "var(--text-secondary)", fontSize: 12 }}>
      <span>Showing {start}-{end} of {total}</span>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <label htmlFor="tally-page-size">Per page:</label>
        <select id="tally-page-size" value={pageSize} onChange={(event) => onPageSizeChange(Number(event.target.value))} style={{ ...controlStyle, cursor: "pointer" }}>
          {TALLY_PAGE_SIZE_OPTIONS.map((size) => <option key={size} value={size}>{size}</option>)}
        </select>
        <button type="button" onClick={() => onPageChange(page - 1)} disabled={page <= 1} style={{ ...controlStyle, opacity: page <= 1 ? 0.5 : 1, cursor: page <= 1 ? "not-allowed" : "pointer" }} aria-label="Previous page">Previous</button>
        <span>Page {page} of {pageCount}</span>
        <button type="button" onClick={() => onPageChange(page + 1)} disabled={page >= pageCount} style={{ ...controlStyle, opacity: page >= pageCount ? 0.5 : 1, cursor: page >= pageCount ? "not-allowed" : "pointer" }} aria-label="Next page">Next</button>
      </div>
    </div>
  );
}

function Detail({ label, value }) { return <div style={detail}><span style={muted}>{label}</span><strong>{field(value)}</strong></div>; }
function costCentreKeyForTrip(tripId) {
  const rawId = String(tripId || "");
  const sourceType = rawId.startsWith("tmc-") ? "TMC_TRIP" : rawId.startsWith("quote-") ? "QUOTE" : "ITINERARY";
  const sourceId = rawId.replace(/^(tmc-|quote-)/, "");
  return `${sourceType}:${sourceId}`;
}
function getTripCostCentreSyncStatus(row, statuses) {
  return statuses[costCentreKeyForTrip(row.id)] || "NOT_CONNECTED";
}
function getTripDisplaySyncStatus(row, statuses, pendingVoucherCounts) {
  const status = getTripCostCentreSyncStatus(row, statuses);
  return status === "SYNCED" && Number(pendingVoucherCounts[row.id] || 0) > 0 ? "NEW_VOUCHERS" : status;
}
function countPendingTripVouchers({ tripId, customers, payments, payables, lastSyncedAt }) {
  const lastSync = new Date(lastSyncedAt || "").getTime();
  if (!Number.isFinite(lastSync)) return 0;
  const addedAfterSync = (value) => {
    const timestamp = new Date(value || "").getTime();
    return Number.isFinite(timestamp) && timestamp > lastSync;
  };
  let count = 0;
  customers.filter((row) => rowMatchesTrip(row, tripId)).forEach((row) => {
    const invoiceAdded = addedAfterSync(row.createdAt || row.transactionDate);
    if (invoiceAdded) count += 1;
    const hasPaymentRows = payments.some((payment) => Number(payment.invoiceId) === Number(row.id));
    if (invoiceAdded && !hasPaymentRows && Number(row.amount || 0) > 0) count += 1;
  });
  payments.filter((row) => rowMatchesTrip(row, tripId)).forEach((row) => {
    if (addedAfterSync(row.createdAt || row.paidAt)) count += 1;
  });
  payables.filter((row) => rowMatchesTrip(row, tripId)).forEach((row) => {
    if (addedAfterSync(row.createdAt || row.transactionDate)) count += 1;
    if (Number(row.paidAmount || 0) > 0 && addedAfterSync(row.updatedAt || row.paidAt || row.paidDate)) count += 1;
  });
  return count;
}
function SyncStatusBadge({ status }) {
  const normalized = String(status || "NOT_CONNECTED").toUpperCase();
  const palette = normalized === "SYNCED"
    ? { color: "#047857", background: "#ecfdf5", borderColor: "#a7f3d0", dot: "#10b981" }
    : normalized === "NEW_VOUCHERS"
      ? { color: "#c2410c", background: "#fff7ed", borderColor: "#fdba74", dot: "#f97316" }
    : normalized === "FAILED"
      ? { color: "#b91c1c", background: "#fef2f2", borderColor: "#fecaca", dot: "#ef4444" }
      : { color: "#92400e", background: "#fffbeb", borderColor: "#fde68a", dot: "#f59e0b" };
  const label = normalized === "NOT_CONNECTED" ? "Not connected" : normalized === "NEW_VOUCHERS" ? "New vouchers pending" : normalized.charAt(0) + normalized.slice(1).toLowerCase();
  return <span style={{ ...syncStatusBadge, ...palette }}><span aria-hidden="true" style={{ ...syncStatusDot, background: palette.dot }} />{label}</span>;
}
function TallySyncGuidelines() {
  return <aside style={guidelinesPanel} aria-labelledby="tally-sync-guidelines-title">
    <strong id="tally-sync-guidelines-title" style={{ color: "#f59e0b" }}>Tally Sync Guidelines</strong>
    <ul style={guidelinesList}>
      <li>Push a trip to Tally <strong>only after it is completed</strong>.</li>
      <li>Sales vouchers carry the <strong>full invoice amount</strong>, even when the customer has paid only part or none of it. Recorded payments are exported as separate receipt vouchers.</li>
      <li>Supplier bills are exported at their full amount; recorded supplier payments are exported separately to the selected cash or bank ledger.</li>
      <li>Before exporting vouchers, confirm the trip&apos;s <strong>Cost Centre status is Synced</strong>.</li>
      <li>A normal push skips vouchers already sent. Check <strong>Sync History</strong> after exporting to confirm what was created, updated, or skipped.</li>
      <li>If Tally reports existing vouchers, choose <strong>Update existing</strong> to update matches and recreate vouchers deleted from Tally.</li>
      <li>Use <strong>Re-upload all</strong> only when intended: it sends every voucher as new and may create duplicates for vouchers already in Tally.</li>
    </ul>
  </aside>;
}
function Metric({ label, value, positive }) { return <div style={metric}><span style={muted}>{label}</span><strong style={positive == null ? undefined : { color: positive ? "#059669" : "#dc2626" }}>{formatMoney(value)}</strong></div>; }
function RecordTable({ title, rows, columns, labels }) { return <div style={{ marginTop: 18 }}><h3 style={{ margin: "0 0 8px", fontSize: 14 }}>{title} <span style={count}>{rows.length}</span></h3>{rows.length ? <div style={{ overflowX: "auto" }}><table style={table}><thead><tr>{labels.map((label) => <th key={label} style={th}>{label}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={row.id || index}>{columns.map((column) => <td key={column} style={td}>{column === "amount" || column === "invoiceAmount" || column === "invoiceTotal" ? formatMoney(row[column]) : field(row[column])}</td>)}</tr>)}</tbody></table></div> : <p style={muted}>No records found.</p>}</div>; }

function getTallyPreviewOptions(rows) {
  const options = rows.map((row, index) => ({ value: `voucher:${index}`, kind: "voucher", label: `${row[1]} — ${row[5] || "Unnumbered"}`, row }));
  const ledgers = [...new Set(rows.flatMap((row) => [row[2], row[3]].filter(Boolean)))].sort();
  return [...options, ...ledgers.map((ledger) => ({ value: `ledger:${ledger}`, kind: "ledger", label: `Ledger — ${ledger}`, ledger }))];
}

function TallyPreviewSelector({ options, value, onChange }) {
  const hasOptions = options.length > 0;
  return <div style={previewControls}><div><strong style={{ display: "block", fontSize: 14 }}>Tally preview</strong><span style={muted}>Select a voucher or ledger to see how it will appear in Tally.</span></div><select aria-label="Select voucher or ledger preview" value={value} onChange={(event) => onChange(event.target.value)} disabled={!hasOptions} style={{ ...previewSelect, opacity: hasOptions ? 1 : 0.6, cursor: hasOptions ? "pointer" : "not-allowed" }}>{options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></div>;
}

function TallyVoucherPreview({ row, rows, companyName }) {
  const amount = Number(row[6] || row[7] || 0);
  const isCredit = row[7] !== "" && row[7] != null;
  const entries = isCredit
    ? [{ side: "Dr", ledger: row[3], reference: row[10] || row[5] }, { side: "Cr", ledger: row[2] }]
    : [{ side: "Dr", ledger: row[2] }, { side: "Cr", ledger: row[3], reference: row[10] || row[5] }];
  return <div style={tallyPreview}><div style={tallyPreviewHeader}><strong>Tally Prime</strong><span>{field(companyName)}</span></div><div style={previewCaption}>Accounting Voucher Alteration (Preview)</div><div style={previewMeta}><span style={voucherBadge}>{field(row[1])}</span><span><strong>No.</strong> {field(row[5])}</span><span style={{ marginLeft: "auto" }}><strong>Date:</strong> {field(row[0])}</span></div><div style={particulars}>Particulars <span>Amount</span></div><div style={voucherBody}>{entries.map((entry, index) => <div style={entryRow} key={`${entry.ledger}-${index}`}><div style={entryDetails}><strong>{entry.side}</strong><span>{field(entry.ledger)}</span>{entry.reference && <small>{index === 0 ? "New Ref" : "Against reference"} &nbsp; {field(entry.reference)}</small>}</div><strong>{formatMoney(amount)} {entry.side}</strong></div>)}<div style={previewNarration}>{field(row[8])}</div></div><div style={previewTotals}><span>Total Dr: {formatMoney(amount)}</span><span>Total Cr: {formatMoney(amount)}</span></div><div style={previewStatus}>Sales remains at the full invoice value; cash profit uses paid sales only.</div></div>;
}

function TallyLedgerPreview({ ledger, rows }) {
  const entries = rows.filter((row) => row[2] === ledger || row[3] === ledger);
  return <div style={tallyPreview}><div style={tallyPreviewHeader}><strong>Tally Prime</strong><span>{field(ledger)} Ledger</span></div><div style={previewCaption}>Ledger Preview — {field(ledger)}</div><div style={particulars}><span>Date / Voucher / Particulars</span><span>Amount</span></div>{entries.map((row, index) => { const isPrimary = row[2] === ledger; const amount = Number(row[6] || row[7] || 0); const side = isPrimary ? (row[7] !== "" && row[7] != null ? "Cr" : "Dr") : (row[7] !== "" && row[7] != null ? "Dr" : "Cr"); const other = isPrimary ? row[3] : row[2]; return <div style={entryRow} key={`${row[5]}-${index}`}><div><small>{field(row[0])} · {field(row[1])} · {field(row[5])}</small><span>{field(other)}</span></div><strong>{formatMoney(amount)} {side}</strong></div>; })}{!entries.length && <p style={muted}>No entries found for this ledger.</p>}</div>;
}

function TallyPushNotice({ notice, onClose }) {
  return <div style={noticeOverlay} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div style={noticeModal} role="alertdialog" aria-modal="true" aria-labelledby="tally-push-notice-title">
      <div style={noticeHeader}><h2 id="tally-push-notice-title">{notice.title}</h2><button type="button" onClick={onClose} aria-label="Close notification" style={noticeClose}>×</button></div>
      <p style={noticeMessage}>{notice.message}</p>
      <div style={noticeActions}><button type="button" onClick={onClose} style={noticeOk}>OK</button></div>
    </div>
  </div>;
}

const page = { padding: 24, maxWidth: 1100, margin: "0 auto" };
const card = { marginTop: 16, padding: 20, border: "1px solid var(--border-color, rgba(148,163,184,.2))", borderRadius: 14, background: "var(--card-bg, rgba(255,255,255,.03))" };
const header = { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, flexWrap: "wrap" };
const bottomPush = { display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 8, margin: "18px 0 24px" };
const eyebrow = { color: "#64748b", fontSize: 10, fontWeight: 800, letterSpacing: ".12em", textTransform: "uppercase" };
const muted = { color: "var(--text-secondary)", fontSize: 13 };
const button = { display: "inline-flex", alignItems: "center", gap: 6, minHeight: 38, padding: "8px 12px", border: "1px solid var(--border-color, rgba(148,163,184,.25))", borderRadius: 9, background: "transparent", color: "var(--text-primary)", fontWeight: 700, cursor: "pointer" };
const downloadButton = { ...button, background: "#f97316", borderColor: "#f97316", color: "#fff" };
const connectorPanel = { marginTop: 18, padding: 14, border: "1px solid var(--border-color, rgba(148,163,184,.2))", borderRadius: 10, background: "var(--card-bg, rgba(255,255,255,.04))" };
const connectorHeader = { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" };
const connectorButtons = { display: "flex", gap: 8, flexWrap: "wrap" };
const smallButton = { ...button, minHeight: 34, padding: "6px 10px", fontSize: 12 };
const guidelinesPanel = { margin: "12px 0", padding: 14, border: "1px solid rgba(245,158,11,.45)", borderRadius: 10, background: "rgba(245,158,11,.08)", fontSize: 13 };
const guidelinesList = { margin: "8px 0 0", paddingLeft: 20, color: "var(--text-secondary)", lineHeight: 1.6 };
const filterBar = { display: "flex", alignItems: "center", justifyContent: "flex-end", flexWrap: "wrap", gap: 10, margin: "12px 0" };
const searchControl = { display: "flex", alignItems: "center", gap: 8, flex: "1 1 240px", minWidth: 180, padding: "8px 10px", border: "1px solid var(--border-color, rgba(148,163,184,.25))", borderRadius: 8, color: "var(--text-secondary)", background: "var(--input-bg, #0f172a)" };
const tripSearchInput = { width: "100%", minWidth: 0, border: 0, outline: 0, background: "transparent", color: "var(--text-primary, #f8fafc)", font: "inherit" };
const filterLabel = { color: "var(--text-secondary)", fontSize: 12, fontWeight: 700 };
const filterSelect = { minWidth: 180, padding: "8px 10px", border: "1px solid var(--border-color, rgba(148,163,184,.25))", borderRadius: 8, background: "var(--input-bg, #0f172a)", color: "var(--text-primary, #f8fafc)", colorScheme: "dark light" };
const educationalToggle = { display: "flex", alignItems: "center", gap: 7, marginTop: 16, color: "var(--text-primary)", fontSize: 13 };
const noticeOverlay = { position: "fixed", inset: 0, zIndex: 1000, display: "grid", placeItems: "center", padding: 20, background: "rgba(15, 23, 42, .48)" };
const noticeModal = { width: "min(100%, 520px)", borderRadius: 16, padding: 22, background: "var(--modal-bg, #fff)", color: "var(--text-primary)", boxShadow: "0 22px 60px rgba(15,23,42,.28)" };
const noticeHeader = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 };
const noticeClose = { width: 32, height: 32, border: "1px solid var(--border-color, #d1d5db)", borderRadius: 8, background: "transparent", color: "var(--text-primary)", fontSize: 22, lineHeight: 1, cursor: "pointer" };
const noticeMessage = { margin: "18px 0 24px", color: "var(--text-secondary)", lineHeight: 1.55, fontSize: 14 };
const noticeActions = { display: "flex", justifyContent: "flex-end", gap: 10 };
const noticeOk = { minWidth: 100, border: 0, borderRadius: 9, padding: "11px 20px", background: "#4f46e5", color: "#fff", fontWeight: 700, cursor: "pointer" };
const detailsGrid = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 1, marginTop: 20, border: "1px solid var(--border-color, rgba(148,163,184,.2))", borderRadius: 10, overflow: "hidden" };
const detail = { display: "grid", gap: 5, padding: 13, background: "rgba(148,163,184,.06)" };
const voucher = { marginTop: 18, border: "1px solid #cbd5e1", borderRadius: 10, overflow: "hidden", background: "#fff", color: "#334155" };
const voucherHeader = { padding: "12px 14px", background: "#294b92", color: "#fff", fontWeight: 800, display: "flex", justifyContent: "space-between" };
const summaryGrid = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))" };
const metric = { display: "grid", gap: 6, padding: 14, borderRight: "1px solid #e2e8f0" };
const sectionTitle = { margin: 0, fontSize: 18 };
const count = { padding: "2px 7px", borderRadius: 999, background: "rgba(91,124,250,.12)", color: "#5b7cfa", fontSize: 11 };
const table = { width: "100%", borderCollapse: "collapse", minWidth: 560 };
const th = { padding: "9px 8px", textAlign: "left", color: "var(--text-secondary)", fontSize: 10, textTransform: "uppercase", borderBottom: "1px solid var(--border-color, rgba(148,163,184,.2))" };
const td = { padding: "10px 8px", fontSize: 12, borderBottom: "1px solid var(--border-color, rgba(148,163,184,.12))" };
const syncStatusBadge = { display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 10px", border: "1px solid", borderRadius: 999, fontSize: 11, fontWeight: 700, lineHeight: 1, whiteSpace: "nowrap" };
const syncStatusDot = { width: 6, height: 6, borderRadius: "50%", flex: "0 0 auto" };
const emptyState = { ...td, padding: 24, textAlign: "center", color: "var(--text-secondary)" };
const iconButton = { display: "inline-grid", placeItems: "center", width: 38, height: 38, padding: 7, border: "1px solid var(--border-color, rgba(148,163,184,.25))", borderRadius: 9, background: "transparent", cursor: "pointer" };
const tallyIconStyle = { width: 22, height: 22, objectFit: "contain" };
const previewControls = { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, flexWrap: "wrap", marginTop: 18, padding: 14, border: "1px solid #cbd5e1", borderRadius: 10, background: "#f8fafc" };
const previewSelect = { minWidth: 260, maxWidth: "100%", padding: "9px 10px", border: "1px solid #94a3b8", borderRadius: 7, background: "#fff", color: "#1e293b" };
const tallyPreview = { marginTop: 12, border: "1px solid #cbd5e1", borderRadius: 10, overflow: "hidden", background: "#fff", color: "#1e293b" };
const tallyPreviewHeader = { display: "flex", justifyContent: "space-between", padding: "12px 16px", background: "#294b92", color: "#fff" };
const previewCaption = { padding: "8px 12px", background: "#e0ecfa", fontSize: 12, fontWeight: 700 };
const previewMeta = { display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap", padding: "10px 16px", borderBottom: "1px solid #cbd5e1", fontSize: 13, background: "#fbf1f7" };
const voucherBadge = { padding: "5px 12px", background: "#385bb0", color: "#fff", fontWeight: 800 };
const particulars = { display: "flex", justifyContent: "space-between", padding: "9px 16px", background: "#fbf1f7", fontSize: 12, fontWeight: 800, borderBottom: "1px solid #cbd5e1" };
const voucherBody = { minHeight: 220, background: "#fbf1f7" };
const entryRow = { display: "flex", justifyContent: "space-between", gap: 16, padding: "13px 16px", borderBottom: "1px solid #e2e8f0", fontSize: 13 };
const entryDetails = { display: "grid", gridTemplateColumns: "28px minmax(0, 1fr)", gap: "4px 4px", alignItems: "start" };
const previewNarration = { padding: "14px 16px", color: "#64748b", fontStyle: "italic", fontSize: 12 };
const previewTotals = { display: "flex", justifyContent: "space-between", padding: "12px 16px", borderTop: "1px solid #cbd5e1", background: "#fbf1f7", fontSize: 12, fontWeight: 700 };
const previewStatus = { padding: "9px 16px", color: "#64748b", background: "#fbf1f7", fontSize: 12 };
