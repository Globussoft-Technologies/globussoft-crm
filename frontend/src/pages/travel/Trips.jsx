// Travel CRM — TMC trips list view.
//
// Lands at /travel/trips. Operator-facing list showing destination,
// dates, school, participant count, status. Click → /travel/trips/:id
// for the full operational view (participants, rooming, payment plan,
// instalments, documents, and landing-page registration).
//
// No creation flow here — trips spawn from the linked Deal in the sales
// pipeline (Day 7+ Deal-extension lands later).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import {
  Luggage,
  Filter,
  Plus,
  Users,
  Calendar as CalendarIcon,
  X,
  Trash2,
  Search,
  ChevronDown,
  ChevronUp,
  ChevronRight,
  ArrowUpDown,
  Copy,
  GitBranch,
  Link2,
} from "lucide-react";
import { fetchApi } from "../../utils/api";
import { useNotify } from "../../utils/notify";
import TopScrollSync from "../../components/TopScrollSync";
import CountBadge from "../../components/CountBadge";
import { DashboardBackLink } from "../../components/PageHeader";
import LocationAutocomplete from "../../components/travel/LocationAutocomplete";
import TripPager from "./TripPager";
import SearchHighlight from "../../components/ui/SearchHighlight";

// School is captured as free-text so the operator doesn't have to pre-create
// a Contact row for every new school. The backend POST /api/travel/trips
// accepts `schoolName`, finds-or-creates a tenant Contact (subBrand="tmc")
// with that name, and uses its id as schoolContactId. Existing callers that
// still pass schoolContactId continue to work — both shapes are supported.

const STATUSES = [
  { value: "", label: "All statuses" },
  { value: "confirmed", label: "Confirmed" },
  { value: "in-trip", label: "In trip" },
  { value: "completed", label: "Completed" },
  { value: "cancelled", label: "Cancelled" },
];
const TRIP_TYPES = [
  { value: "international", label: "International" },
  { value: "domestic", label: "Domestic" },
  { value: "day_trip", label: "Day trip" },
];
const EMPTY_TRIP_FILTERS = {
  family: [],
  tripType: [],
  status: [],
  departFrom: "",
  departTo: "",
};
const TRIP_FILTER_KEYS = Object.keys(EMPTY_TRIP_FILTERS);
const TRIP_MULTI_FILTER_KEYS = ["family", "tripType", "status"];
const REMOVED_TRIP_FILTER_KEYS = [
  "tripCode", "destination", "brand", "subBrand", "school", "minParticipants",
  "maxParticipants", "minPerStudent", "maxPerStudent",
];

function readTripFilters(params) {
  return Object.fromEntries(
    TRIP_FILTER_KEYS.map((key) => [
      key,
      TRIP_MULTI_FILTER_KEYS.includes(key)
        ? params.getAll(key)
        : params.get(key) || "",
    ]),
  );
}

function tripFiltersEqual(left, right) {
  return TRIP_FILTER_KEYS.every((key) => {
    if (Array.isArray(left[key]) || Array.isArray(right[key])) {
      return Array.isArray(left[key])
        && Array.isArray(right[key])
        && left[key].length === right[key].length
        && left[key].every((value, index) => value === right[key][index]);
    }
    return left[key] === right[key];
  });
}

function countSelectedTripFilters(filters) {
  return Object.values(filters).reduce(
    (count, value) => count + (Array.isArray(value) ? value.length : (value ? 1 : 0)),
    0,
  );
}

function openNativeDatePicker(event) {
  try {
    event.currentTarget.showPicker?.();
  } catch {
    // The native click remains the fallback where showPicker is unavailable.
  }
}

function handlePickerOnlyDateKeyDown(event) {
  if (event.key === "Tab" || event.key === "Escape") return;
  event.preventDefault();
  if (["Enter", " ", "ArrowDown"].includes(event.key)) openNativeDatePicker(event);
}

function fmt(d) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString();
}

function fmtMoney(amt, currency = "INR") {
  if (amt == null) return "—";
  const n = Number(amt);
  if (!Number.isFinite(n)) return "—";
  if (currency === "INR" && n >= 100000) return `₹${(n / 100000).toFixed(2)}L`;
  return `${currency === "INR" ? "₹" : currency + " "}${n.toLocaleString()}`;
}

function localDateKey(value = new Date()) {
  const d = value instanceof Date ? value : new Date(value);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function dateInputValue(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

const EMPTY_FORM = {
  contactId: "",
  tripCode: "",
  destination: "",
  schoolName: "",
  departDate: "",
  returnDate: "",
  tripType: "international",
  status: "confirmed",
  familyParentId: "",
};

const BRAND_LABEL = "TMC";
const SUB_BRAND_LABEL = "School trips";
const DEFAULT_PAGE_SIZE = 20;
const PAGE_SIZE_OPTIONS = [10, 20, 50];
const MAX_PAGE_SIZE = 200;
const TRIPS_TABLE_COLUMNS = [
  { key: "tripCode", label: "Trip code", defaultWidth: 190, minWidth: 150, maxWidth: 280, maxWidthRatio: 0.5 },
  { key: "family", label: "Trip family", defaultWidth: 210, minWidth: 120 },
  { key: "destination", label: "Destination", defaultWidth: 280, minWidth: 150 },
  { key: "brand", label: "Brand", defaultWidth: 120, minWidth: 90 },
  { key: "subBrand", label: "Sub-brand", defaultWidth: 150, minWidth: 100 },
  { key: "dates", label: "Dates", defaultWidth: 240, minWidth: 180 },
  { key: "school", label: "School", defaultWidth: 250, minWidth: 180 },
  { key: "participants", label: "Participants", defaultWidth: 150, minWidth: 110 },
  { key: "perStudent", label: "Per-student", defaultWidth: 145, minWidth: 105 },
  { key: "tripType", label: "Trip type", defaultWidth: 160, minWidth: 110 },
  { key: "status", label: "Status", defaultWidth: 120, minWidth: 90 },
  { key: "actions", label: "Actions", defaultWidth: 140, minWidth: 110 },
];
const TRIPS_LAST_LIST_URL_KEY = "travel.trips.lastListUrl";
const TRIP_SORT_KEYS = new Set([
  "tripCode", "destination", "dates", "school",
  "participants", "perStudent", "status",
]);

function readPageParam(params) {
  return Math.max(1, parseInt(params.get("page") || "1", 10) || 1);
}

function readPageSizeParam(params) {
  const value = parseInt(params.get("pageSize") || String(DEFAULT_PAGE_SIZE), 10);
  return Math.min(MAX_PAGE_SIZE, Math.max(1, value || DEFAULT_PAGE_SIZE));
}

function getTripTableViewportWidth(element) {
  const table = element?.closest?.("table");
  const viewportWidth = table?.closest?.(".travel-trips-table-viewport")?.clientWidth;
  if (viewportWidth > 0) return viewportWidth;
  return typeof window !== "undefined" ? window.innerWidth : 0;
}

function getTripColumnMaxWidth(column, viewportWidth) {
  if (!column.maxWidthRatio) return column.maxWidth;
  const ratioWidth = Math.floor((viewportWidth || 0) * column.maxWidthRatio);
  return Math.max(column.maxWidth || column.minWidth, ratioWidth);
}

function tripSortValue(trip, key) {
  if (key === "tripCode") return String(trip.tripCode || "").toLowerCase();
  if (key === "destination") return String(trip.destination || "").toLowerCase();
  if (key === "dates") return new Date(trip.departDate || 0).getTime();
  if (key === "school") return String(trip.schoolName || "").toLowerCase();
  if (key === "participants") return Number(trip._count?.participants || 0);
  if (key === "perStudent") return Number(trip.perStudentAmount || 0);
  if (key === "status") return String(trip.status || "").toLowerCase();
  return "";
}

function MultiSelectFilter({ label, options, value, emptyLabel, onChange }) {
  const selectedValues = Array.isArray(value) ? value : [];
  const toggleOption = (optionValue) => {
    onChange(selectedValues.includes(optionValue)
      ? selectedValues.filter((selected) => selected !== optionValue)
      : [...selectedValues, optionValue]);
  };

  return (
    <div style={fieldLabel}>
      <span>{label}</span>
      <details style={{ position: "relative", minWidth: 0 }}>
        <summary
          aria-label={`Filter by ${label.toLowerCase()}`}
          style={{
            ...selectStyle,
            width: "100%",
            minWidth: 0,
            boxSizing: "border-box",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
            cursor: "pointer",
            listStyle: "none",
          }}
        >
          <span>{selectedValues.length ? `${selectedValues.length} selected` : emptyLabel}</span>
          <ChevronDown size={14} aria-hidden />
        </summary>
        <div
          role="group"
          aria-label={`${label} options`}
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            zIndex: 20,
            width: "100%",
            minWidth: 190,
            maxHeight: 220,
            overflowY: "auto",
            padding: 6,
            boxSizing: "border-box",
            border: "1px solid var(--border-color)",
            borderRadius: 8,
            background: "var(--modal-bg, var(--surface-color))",
            boxShadow: "0 8px 20px rgba(15, 23, 42, 0.16)",
          }}
        >
          {options.map((option) => (
            <label
              key={option.value}
              style={{
                display: "flex",
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
                padding: "7px 6px",
                borderRadius: 5,
                color: "var(--text-primary)",
                cursor: "pointer",
                fontSize: 13,
                fontWeight: 400,
              }}
            >
              <input
                type="checkbox"
                checked={selectedValues.includes(option.value)}
                onChange={() => toggleOption(option.value)}
              />
              {option.label}
            </label>
          ))}
        </div>
      </details>
    </div>
  );
}

export default function Trips() {
  const notify = useNotify();
  const location = useLocation();
  const [trips, setTrips] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchParams, setSearchParams] = useSearchParams();
  const page = readPageParam(searchParams);
  const [search, setSearch] = useState(searchParams.get("search") || "");
  const [filters, setFilters] = useState(() => readTripFilters(searchParams));
  const [draftFilters, setDraftFilters] = useState(() => readTripFilters(searchParams));
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [total, setTotal] = useState(0);
  const [pageSize, setPageSize] = useState(() => readPageSizeParam(searchParams));
  const [isCustomPageSize, setIsCustomPageSize] = useState(false);
  const [customPageSize, setCustomPageSize] = useState("");
  const [reloadTick, setReloadTick] = useState(0);
  const [sortKey, setSortKey] = useState(() => {
    const value = searchParams.get("sortKey");
    return TRIP_SORT_KEYS.has(value) ? value : null;
  });
  const [sortDirection, setSortDirection] = useState(() => {
    const value = searchParams.get("sortDirection");
    return value === "asc" || value === "desc" ? value : null;
  });
  const [creating, setCreating] = useState(() => location.state?.createTrip === true);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [variantSource, setVariantSource] = useState(null);
  const [expandedFamilyIds, setExpandedFamilyIds] = useState(() => new Set());
  const [familyChildrenByParent, setFamilyChildrenByParent] = useState({});
  const [columnWidths, setColumnWidths] = useState(() => Object.fromEntries(
    TRIPS_TABLE_COLUMNS.map(({ key, defaultWidth }) => [key, defaultWidth]),
  ));
  const reqIdRef = useRef(0);
  const columnResizeRef = useRef(null);
  const tripsTableRef = useRef(null);
  const filtersPanelRef = useRef(null);
  const filtersButtonRef = useRef(null);
  const fromReports = searchParams.get("from") === "reports";
  const tripsListPath = `${location.pathname}${location.search}`;
  const today = localDateKey();
  const tripsTableWidth = useMemo(
    () => TRIPS_TABLE_COLUMNS.reduce((width, column) => width + columnWidths[column.key], 0),
    [columnWidths],
  );

  useEffect(() => {
    const handlePointerMove = (event) => {
      const resize = columnResizeRef.current;
      if (!resize) return;
      const column = TRIPS_TABLE_COLUMNS.find(({ key }) => key === resize.key);
      if (!column) return;
      const maxWidth = resize.maxWidth;
      const requestedWidth = resize.startWidth + event.clientX - resize.startX;
      const nextWidth = Math.round(Math.max(
        column.minWidth,
        maxWidth ? Math.min(requestedWidth, maxWidth) : requestedWidth,
      ));
      setColumnWidths((current) => current[resize.key] === nextWidth
        ? current
        : { ...current, [resize.key]: nextWidth });
    };
    const stopColumnResize = () => {
      if (!columnResizeRef.current) return;
      columnResizeRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopColumnResize);
    window.addEventListener("pointercancel", stopColumnResize);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopColumnResize);
      window.removeEventListener("pointercancel", stopColumnResize);
      stopColumnResize();
    };
  }, []);

  const startColumnResize = (event, key) => {
    if (event.button > 0) return;
    event.preventDefault();
    event.stopPropagation();
    const column = TRIPS_TABLE_COLUMNS.find((item) => item.key === key);
    columnResizeRef.current = {
      key,
      startX: event.clientX,
      startWidth: columnWidths[key],
      maxWidth: getTripColumnMaxWidth(column, getTripTableViewportWidth(event.currentTarget)),
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  const handleColumnResizeKeyDown = (event, key) => {
    const column = TRIPS_TABLE_COLUMNS.find((item) => item.key === key);
    if (!column) return;
    const maxWidth = getTripColumnMaxWidth(column, getTripTableViewportWidth(event.currentTarget));
    let nextWidth;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      nextWidth = columnWidths[key] + (event.key === "ArrowRight" ? 12 : -12);
    } else if (event.key === "Home") {
      nextWidth = column.defaultWidth;
    } else if (event.key === "End" && maxWidth) {
      nextWidth = maxWidth;
    } else {
      return;
    }
    event.preventDefault();
    setColumnWidths((current) => ({
      ...current,
      [key]: Math.round(Math.max(
        column.minWidth,
        maxWidth ? Math.min(nextWidth, maxWidth) : nextWidth,
      )),
    }));
  };

  const renderColumnResizeHandle = (key) => {
    const column = TRIPS_TABLE_COLUMNS.find((item) => item.key === key);
    const maxWidth = getTripColumnMaxWidth(column, getTripTableViewportWidth(tripsTableRef.current));
    return (
      <div
        className="travel-trips-table__resize-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label={`Resize ${column.label} column`}
        aria-valuemin={column.minWidth}
        aria-valuemax={maxWidth}
        aria-valuenow={columnWidths[key]}
        aria-valuetext={`${columnWidths[key]} pixels`}
        title="Drag to resize; use arrow keys to adjust"
        tabIndex={0}
        onPointerDown={(event) => startColumnResize(event, key)}
        onKeyDown={(event) => handleColumnResizeKeyDown(event, key)}
      />
    );
  };

  useEffect(() => {
    if (location.state?.contactId != null) {
      setForm((current) => ({ ...current, contactId: String(location.state.contactId), schoolName: location.state.contactName || "" }));
      setCreating(true);
      window.history.replaceState({}, document.title, window.location.href);
    }
  }, [location.state]);

  const updateParams = useCallback(
    (patch, options = {}) => {
      const next = new URLSearchParams(searchParams);
      for (const [key, value] of Object.entries(patch)) {
        next.delete(key);
        if (
          value === null ||
          value === undefined ||
          value === "" ||
          (Array.isArray(value) && !value.length)
        ) {
          continue;
        } else if (Array.isArray(value)) {
          value.forEach((item) => {
            if (item !== null && item !== undefined && item !== "") {
              next.append(key, String(item));
            }
          });
        } else {
          next.set(key, String(value));
        }
      }
      setSearchParams(next, options);
    },
    [searchParams, setSearchParams],
  );

  useEffect(() => {
    const nextSearch = searchParams.get("search") || "";
    const nextPageSize = readPageSizeParam(searchParams);
    const nextSortKey = searchParams.get("sortKey");
    const nextSortDirection = searchParams.get("sortDirection");
    setSearch((current) => (current === nextSearch ? current : nextSearch));
    const nextFilters = readTripFilters(searchParams);
    setFilters((current) => (tripFiltersEqual(current, nextFilters) ? current : nextFilters));
    setPageSize((current) => (current === nextPageSize ? current : nextPageSize));
    setSortKey((current) => (
      current === (TRIP_SORT_KEYS.has(nextSortKey) ? nextSortKey : null)
        ? current
        : (TRIP_SORT_KEYS.has(nextSortKey) ? nextSortKey : null)
    ));
    setSortDirection((current) => {
      const next = nextSortDirection === "asc" || nextSortDirection === "desc"
        ? nextSortDirection
        : null;
      return current === next ? current : next;
    });
  }, [searchParams]);

  useEffect(() => {
    setDraftFilters(filters);
  }, [filters]);

  useEffect(() => {
    if (!filtersOpen) return undefined;
    const closeWhenOutside = (event) => {
      if (filtersPanelRef.current?.contains(event.target)) return;
      if (filtersButtonRef.current?.contains(event.target)) return;
      setFiltersOpen(false);
    };
    const closeOnEscape = (event) => {
      if (event.key === "Escape") {
        setFiltersOpen(false);
        filtersButtonRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", closeWhenOutside);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeWhenOutside);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [filtersOpen]);

  const pageCount = Math.max(1, Math.ceil((total || 0) / pageSize));
  const safePage = Math.min(page, pageCount);
  const activeFilterCount = countSelectedTripFilters(filters);
  const isDepartDateRangeInvalid = Boolean(
    draftFilters.departFrom
      && draftFilters.departTo
      && draftFilters.departFrom > draftFilters.departTo,
  );
  const hasActiveFilters = Boolean(activeFilterCount || search.trim());
  const sortedTrips = useMemo(() => {
    if (!sortKey || !sortDirection) return trips;
    const direction = sortDirection === "asc" ? 1 : -1;
    return [...trips].sort((left, right) => {
      const a = tripSortValue(left, sortKey);
      const b = tripSortValue(right, sortKey);
      if (a < b) return -1 * direction;
      if (a > b) return 1 * direction;
      return 0;
    });
  }, [sortDirection, sortKey, trips]);

  const visibleTripRows = useMemo(() => {
    const loadedParentIds = new Set(sortedTrips.map((trip) => Number(trip.id)));
    const childrenByParent = new Map();
    const addChild = (child) => {
      const parentId = Number(child.familyParent?.id);
      if (!Number.isInteger(parentId)) return;
      const children = childrenByParent.get(parentId) || new Map();
      children.set(Number(child.id), child);
      childrenByParent.set(parentId, children);
    };

    trips.forEach(addChild);
    Object.values(familyChildrenByParent).flat().forEach(addChild);

    const rows = [];
    sortedTrips.forEach((trip) => {
      const parentId = Number(trip.familyParent?.id);
      if (Number.isInteger(parentId) && loadedParentIds.has(parentId)) return;
      rows.push({ trip, isFamilyChild: false });
      if (!expandedFamilyIds.has(Number(trip.id))) return;
      const children = [...(childrenByParent.get(Number(trip.id))?.values() || [])]
        .sort((left, right) => Number(left.id) - Number(right.id));
      children.forEach((child) => rows.push({ trip: child, isFamilyChild: true }));
    });
    return rows;
  }, [expandedFamilyIds, familyChildrenByParent, sortedTrips, trips]);

  const openCreate = () => {
    setForm(EMPTY_FORM);
    setVariantSource(null);
    setCreating(true);
  };

  const openVariantCreate = (trip) => {
    setVariantSource(trip);
    setForm({
      ...EMPTY_FORM,
      destination: trip.destination || "",
      departDate: dateInputValue(trip.departDate),
      returnDate: dateInputValue(trip.returnDate),
      tripType: trip.tripType || "international",
      status: trip.status || "confirmed",
      familyParentId: String(trip.familyParent?.id || trip.id),
    });
    setCreating(true);
  };

  const toggleFamily = async (trip) => {
    const tripId = Number(trip.id);
    const isExpanded = expandedFamilyIds.has(tripId);
    setExpandedFamilyIds((current) => {
      const next = new Set(current);
      if (isExpanded) next.delete(tripId);
      else next.add(tripId);
      return next;
    });
    if (isExpanded || familyChildrenByParent[tripId]) return;

    try {
      const result = await fetchApi("/api/travel/trips?limit=200", { silent: true });
      const rows = Array.isArray(result?.trips) ? result.trips : [];
      setFamilyChildrenByParent((current) => ({
        ...current,
        [tripId]: rows.filter((candidate) => Number(candidate.familyParent?.id) === tripId),
      }));
    } catch {
      setFamilyChildrenByParent((current) => ({ ...current, [tripId]: [] }));
      notify.error("Could not load the trips in this group");
    }
  };

  const submitCreate = async (e) => {
    e.preventDefault();
    if (
      !form.tripCode.trim() ||
      !form.destination.trim() ||
      !form.schoolName.trim() ||
      !form.departDate ||
      !form.returnDate
    ) {
      notify.error(
        "Trip code, destination, school, depart + return dates required",
      );
      return;
    }
    if (form.departDate < today || form.returnDate < today) {
      notify.error("Depart and return dates must be today or later.");
      return;
    }
    if (form.returnDate < form.departDate) {
      notify.error("Return date must be on or after depart date.");
      return;
    }
    setSaving(true);
    try {
      const body = {
        tripCode: form.tripCode.trim(),
        destination: form.destination.trim(),
        schoolName: form.schoolName.trim(),
        departDate: form.departDate,
        returnDate: form.returnDate,
        status: form.status,
        tripType: form.tripType,
        ...(form.familyParentId ? { familyParentId: Number(form.familyParentId) } : {}),
        ...(form.contactId ? { schoolContactId: Number(form.contactId) } : {}),
      };
      await fetchApi("/api/travel/trips", {
        method: "POST",
        body: JSON.stringify(body),
      });
      notify.success(variantSource ? "School trip variant created" : "Trip created");
      setCreating(false);
      setVariantSource(null);
      setReloadTick((t) => t + 1);
    } catch (err) {
      notify.error(err?.body?.error || err?.message || "Failed to create trip");
    } finally {
      setSaving(false);
    }
  };

  const load = useCallback(
    async ({ reset = false } = {}) => {
      const myReqId = ++reqIdRef.current;
      if (reset) {
        setLoading(true);
        setTrips([]);
        setExpandedFamilyIds(new Set());
        setFamilyChildrenByParent({});
      } else {
        setLoading(true);
      }
      const qs = new URLSearchParams();
      if (search.trim()) qs.set("search", search.trim());
      TRIP_FILTER_KEYS.forEach((key) => {
        if (Array.isArray(filters[key])) {
          filters[key].forEach((value) => qs.append(key, value));
        } else if (filters[key]) {
          qs.set(key, filters[key]);
        }
      });
      qs.set("limit", String(pageSize));
      qs.set("offset", String(Math.max(0, (page - 1) * pageSize)));

      try {
        const res = await fetchApi(`/api/travel/trips?${qs.toString()}`);
        if (myReqId !== reqIdRef.current) return;
        const rows = Array.isArray(res?.trips) ? res.trips : [];
        setTrips(rows);
        setTotal(Number(res?.total) || 0);
      } catch (e) {
        if (myReqId !== reqIdRef.current) return;
        notify.error(e?.body?.error || "Failed to load trips");
        setTrips([]);
        setTotal(0);
      } finally {
        if (myReqId === reqIdRef.current) {
          setLoading(false);
        }
      }
    },
    [filters, page, pageSize, search, notify],
  );

  useEffect(() => {
    load({ reset: true });
  }, [load, reloadTick]);

  useEffect(() => {
    if (total > 0 && page > pageCount) {
      updateParams({ page: pageCount }, { replace: true });
    }
  }, [page, pageCount, total, updateParams]);

  const handleSearchChange = (value) => {
    setSearch(value);
    updateParams({ search: value, page: 1 }, { replace: true });
  };

  const updateDraftFilter = (key, value) => {
    setDraftFilters((current) => ({ ...current, [key]: value }));
  };

  const applyFilters = () => {
    if (isDepartDateRangeInvalid) return;
    const nextFilters = Object.fromEntries(
      TRIP_FILTER_KEYS.map((key) => [
        key,
        Array.isArray(draftFilters[key])
          ? draftFilters[key].map((value) => value.trim()).filter(Boolean)
          : draftFilters[key].trim(),
      ]),
    );
    setFilters(nextFilters);
    setDraftFilters(nextFilters);
    updateParams({
      ...Object.fromEntries(REMOVED_TRIP_FILTER_KEYS.map((key) => [key, null])),
      ...nextFilters,
      page: 1,
    }, { replace: true });
    setFiltersOpen(false);
  };

  const clearAllFilters = () => {
    setFilters(EMPTY_TRIP_FILTERS);
    setDraftFilters(EMPTY_TRIP_FILTERS);
    setSearch("");
    updateParams({
      ...Object.fromEntries(TRIP_FILTER_KEYS.map((key) => [key, null])),
      ...Object.fromEntries(REMOVED_TRIP_FILTER_KEYS.map((key) => [key, null])),
      search: null,
      page: 1,
    }, { replace: true });
  };

  const setPage = useCallback(
    (nextPage) => {
      updateParams({ page: nextPage });
    },
    [updateParams],
  );

  const setPageSizeAndReset = useCallback(
    (nextPageSize) => {
      setPageSize(nextPageSize);
      updateParams({ page: 1, pageSize: nextPageSize });
    },
    [updateParams],
  );

  useEffect(() => {
    if (location.pathname !== "/travel/trips") return;
    try {
      window.sessionStorage.setItem(
        TRIPS_LAST_LIST_URL_KEY,
        `${location.pathname}${location.search}`,
      );
    } catch {
      // The URL still preserves the active list state if storage is unavailable.
    }
  }, [location.pathname, location.search]);

  const toggleSort = useCallback((key) => {
    if (sortKey !== key) {
      setSortKey(key);
      setSortDirection("asc");
      updateParams({ sortKey: key, sortDirection: "asc", page: 1 });
    } else if (sortDirection === "asc") {
      setSortDirection("desc");
      updateParams({ sortKey: key, sortDirection: "desc", page: 1 });
    } else {
      setSortKey(null);
      setSortDirection(null);
      updateParams({ sortKey: null, sortDirection: null, page: 1 });
    }
  }, [sortDirection, sortKey, updateParams]);

  const sortButton = (key, label) => {
    const active = sortKey === key;
    const Icon = active && sortDirection === "asc"
      ? ChevronUp
      : active && sortDirection === "desc"
        ? ChevronDown
        : ArrowUpDown;
    return (
      <button
        type="button"
        className="travel-trips-table__sort-button"
        onClick={() => toggleSort(key)}
        aria-label={`Sort ${label} ${active ? sortDirection : "default"}`}
        style={{
          ...sortButtonStyle,
          background: active ? "var(--subtle-bg-3, var(--subtle-bg))" : "transparent",
          borderRadius: 6,
          padding: "4px 0",
        }}
      >
        <span>{label}</span><Icon size={14} aria-hidden />
      </button>
    );
  };

  // Track which trip is currently being deleted so we can disable its
  // row's trash button (prevents double-click race) without disabling
  // siblings.
  const [deletingId, setDeletingId] = useState(null);

  // DELETE /api/travel/trips/:id is ADMIN-only on the server
  // (requirePermission("trips","delete")). The route cascades through
  // participants, rooming, payment plan, document
  // requirements, AND PendingTripRegistration drafts via the schema's
  // onDelete:Cascade — so the confirmation copy MUST flag that. A
  // wrongly-deleted trip cannot be recovered without restoring the
  // mysqldump backup.
  const remove = async (t) => {
    const ok = await notify.confirm({
      title: "Delete trip",
      message:
        `Permanently delete "${t.tripCode}" — ${t.destination}?\n\n` +
        "This will also delete every participant, room assignment, payment-plan row, " +
        "instalment payment, document requirement, landing page, and " +
        "pending registration linked to this trip.\n\n" +
        "This cannot be undone.",
      confirmText: "Delete trip",
      destructive: true,
    });
    if (!ok) return;
    setDeletingId(t.id);
    // Toast before the network call fires so the operator sees
    // immediate feedback that the action is in progress — useful
    // because the cascade can take a moment on trips with many
    // participants.
    notify.info(`Deleting trip ${t.tripCode}…`);
    try {
      await fetchApi(`/api/travel/trips/${t.id}`, { method: "DELETE" });
      notify.success(`Trip ${t.tripCode} deleted`);
      load({ reset: true });
    } catch (e) {
      // The route returns 403 RBAC_DENIED for non-ADMIN callers; surface
      // the server-side message so the operator knows it's a perms issue
      // rather than a network problem.
      notify.error(e?.body?.error || "Failed to delete trip");
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div
      className="travel-trips-page"
      style={{
        padding: 24,
        maxWidth: 1480,
        margin: "0 auto",
        height: "100%",
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <DashboardBackLink />
      <div
        className="travel-trips-page__header"
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div>
          {fromReports && (
            <Link
              to="/travel/reports"
              style={{ ...backLink, marginBottom: 10 }}
            >
              Back to reports
            </Link>
          )}
          <h1
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              margin: 0,
              marginBottom: 4,
            }}
          >
            <Luggage size={28} aria-hidden /> TMC Trips
            <CountBadge count={total} title={`${total.toLocaleString()} trips`} />
          </h1>
          <p style={{ color: "var(--text-secondary)", marginTop: 0 }}>
            School educational trips. Operational view per trip — participants,
            rooming, payment plan, documents, and landing page — lives on the detail page.
          </p>
        </div>
        <button
          type="button"
          onClick={openCreate}
          style={primaryBtn}
          aria-label="Create a new trip"
        >
          <Plus size={14} /> New Trip
        </button>
      </div>

      <div
        className="travel-trips-page__filters"
        style={{
          display: "flex",
          gap: 12,
          flexWrap: "wrap",
          alignItems: "center",
          background: "var(--surface-color)",
          padding: 12,
          borderRadius: 8,
          border: "1px solid var(--border-color)",
          marginBottom: 16,
          position: "relative",
        }}
      >
        <div
          className="travel-trips-page__search"
          style={{
            width: "min(360px, 100%)",
            minWidth: "min(240px, 100%)",
            maxWidth: 360,
            flex: "1 1 300px",
            display: "flex",
            alignItems: "center",
            gap: 6,
            paddingLeft: 10,
            paddingRight: 8,
            border: "1px solid var(--border-color)",
            borderRadius: 8,
            background: "var(--surface-color)",
            boxSizing: "border-box",
          }}
        >
          <Search
            size={14}
            aria-hidden
            style={{
              color: "var(--text-secondary)",
              pointerEvents: "none",
              flex: "0 0 auto",
            }}
          />
          <input
            type="search"
            className="travel-trips-search-input"
            value={search}
            onChange={(e) => handleSearchChange(e.target.value)}
            placeholder="Search trip code or destination…"
            aria-label="Search trips"
            style={{ ...selectStyle, padding: "6px 0", minWidth: 0, width: "100%", flex: "1 1 auto", border: 0, outline: 0, background: "transparent", boxShadow: "none" }}
          />
        </div>
        <button
          ref={filtersButtonRef}
          type="button"
          onClick={() => {
            if (!filtersOpen) setDraftFilters(filters);
            setFiltersOpen((current) => !current);
          }}
          style={{ ...refreshBtn, display: "inline-flex", alignItems: "center", gap: 7 }}
          aria-label="Filter trips"
          aria-expanded={filtersOpen}
          aria-controls="trip-filters-panel"
        >
          <Filter size={15} aria-hidden /> Filter
          {activeFilterCount > 0 && (
            <span style={{
              minWidth: 18,
              height: 18,
              padding: "0 5px",
              borderRadius: 999,
              background: "var(--primary-color, var(--accent-color))",
              color: "var(--accent-text, #fff)",
              fontSize: 11,
              fontWeight: 700,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
            }}>
              {activeFilterCount}
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={() => load({ reset: true })}
          style={refreshBtn}
          aria-label="Reload list"
        >
          Refresh
        </button>
      </div>

      {filtersOpen && (
        <section
          ref={filtersPanelRef}
          id="trip-filters-panel"
          className="travel-trips-page__filter-panel"
          role="region"
          aria-label="Trip filters"
          style={{
            position: "relative",
            zIndex: 30,
            width: "100%",
            flex: "0 0 auto",
            boxSizing: "border-box",
            marginTop: -4,
            marginBottom: 16,
            padding: "16px 20px 14px",
            border: "1px solid var(--border-color)",
            borderRadius: 12,
            background: "var(--surface-color)",
            color: "var(--text-primary)",
            boxShadow: "0 5px 18px rgba(15, 23, 42, 0.07)",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 14, paddingBottom: 12, borderBottom: "1px solid var(--border-color)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
              <span style={{ width: 34, height: 34, borderRadius: 9, display: "inline-flex", alignItems: "center", justifyContent: "center", flex: "0 0 auto", color: "var(--primary-color, #4f46e5)", background: "rgba(79,70,229,0.1)" }}>
                <Filter size={17} aria-hidden />
              </span>
              <div>
                <h2 style={{ margin: 0, fontSize: 16, lineHeight: 1.25 }}>Filters</h2>
                <p style={{ margin: "3px 0 0", color: "var(--text-secondary)", fontSize: 12 }}>
                  Choose multiple values in a filter; different filters work together.
                </p>
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 12, flex: "0 0 auto" }}>
              <button
                type="button"
                onClick={() => setDraftFilters(EMPTY_TRIP_FILTERS)}
                style={{ background: "transparent", border: 0, padding: "6px 4px", color: "var(--primary-color, #4f46e5)", fontSize: 13, fontWeight: 600, cursor: "pointer" }}
              >
                Clear all
              </button>
              <button type="button" onClick={() => setFiltersOpen(false)} style={iconBtn} aria-label="Collapse filters">
                <ChevronUp size={18} aria-hidden />
              </button>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 190px), 1fr))", gap: 16, padding: "16px 0" }}>
            <MultiSelectFilter
              label="Trip family"
              emptyLabel="All trip families"
              options={[
                { value: "primary", label: "Primary" },
                { value: "variant", label: "Variant" },
                { value: "standalone", label: "Standalone" },
              ]}
              value={draftFilters.family}
              onChange={(value) => updateDraftFilter("family", value)}
            />
            <MultiSelectFilter
              label="Trip type"
              emptyLabel="All trip types"
              options={TRIP_TYPES}
              value={draftFilters.tripType}
              onChange={(value) => updateDraftFilter("tripType", value)}
            />
            <MultiSelectFilter
              label="Status"
              emptyLabel="All statuses"
              options={STATUSES.filter((item) => item.value)}
              value={draftFilters.status}
              onChange={(value) => updateDraftFilter("status", value)}
            />
            <label style={fieldLabel}>
              Depart from
              <input
                type="date"
                value={draftFilters.departFrom}
                max={draftFilters.departTo || undefined}
                aria-invalid={isDepartDateRangeInvalid}
                onChange={(event) => updateDraftFilter("departFrom", event.target.value)}
                style={{ ...inputStyle, width: "100%", minWidth: 0, boxSizing: "border-box", borderColor: isDepartDateRangeInvalid ? "#dc2626" : undefined }}
              />
            </label>
            <label style={fieldLabel}>
              Depart to
              <input
                type="date"
                value={draftFilters.departTo}
                min={draftFilters.departFrom || undefined}
                aria-invalid={isDepartDateRangeInvalid}
                onChange={(event) => updateDraftFilter("departTo", event.target.value)}
                style={{ ...inputStyle, width: "100%", minWidth: 0, boxSizing: "border-box", borderColor: isDepartDateRangeInvalid ? "#dc2626" : undefined }}
              />
            </label>
          </div>
          {isDepartDateRangeInvalid && (
            <p role="alert" style={{ margin: "-6px 0 12px", color: "#dc2626", fontSize: 12 }}>
              Depart from must be on or before Depart to.
            </p>
          )}

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap", paddingTop: 12, borderTop: "1px solid var(--border-color)" }}>
            <span style={{ color: "var(--text-secondary)", fontSize: 13 }}>
              {activeFilterCount} active filter{activeFilterCount === 1 ? "" : "s"}
            </span>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
              <button type="button" onClick={clearAllFilters} style={refreshBtn}>Reset</button>
              <button
                type="button"
                onClick={applyFilters}
                disabled={isDepartDateRangeInvalid}
                style={{ ...primaryBtn, opacity: isDepartDateRangeInvalid ? 0.55 : 1, cursor: isDepartDateRangeInvalid ? "not-allowed" : "pointer" }}
              >
                Apply filters
              </button>
            </div>
          </div>
        </section>
      )}

      <div
        className="travel-trips-page__table-card"
        style={{
          background: "var(--surface-color)",
          borderRadius: 8,
          border: "1px solid var(--border-color)",
          flex: "1 1 auto",
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {loading ? (
          <div style={empty}>Loading&hellip;</div>
        ) : trips.length === 0 ? (
          <div style={empty}>
            {hasActiveFilters
              ? "No trips match the current filters."
              : "No trips yet. New trips spawn from the linked Deal in the sales pipeline."}
          </div>
        ) : (
          <>
            <TopScrollSync
              forceScrollbar
              hideTopBar
              hideBottomHorizontalScrollbar
              bottomBarLeadingWidth={columnWidths.tripCode}
              scrollWidth={tripsTableWidth - columnWidths.tripCode}
              verticalOverflow="auto"
              contentClassName="travel-trips-table-viewport"
            >
              <table
                ref={tripsTableRef}
                className="travel-trips-table"
                style={{
                  width: `${tripsTableWidth}px`,
                  minWidth: `${tripsTableWidth}px`,
                  borderCollapse: "separate",
                  borderSpacing: 0,
                  tableLayout: "fixed",
                }}
              >
                <colgroup>
                  {TRIPS_TABLE_COLUMNS.map(({ key }) => (
                    <col key={key} style={{ width: `${columnWidths[key]}px` }} />
                  ))}
                </colgroup>
                <thead>
                  <tr>
                    <th className="travel-trips-table__trip-code-header" style={th}>
                      {sortButton("tripCode", "Trip code")}
                      {renderColumnResizeHandle("tripCode")}
                    </th>
                    <th style={th}>Trip family{renderColumnResizeHandle("family")}</th>
                    <th style={th}>{sortButton("destination", "Destination")}{renderColumnResizeHandle("destination")}</th>
                    <th style={th}>Brand{renderColumnResizeHandle("brand")}</th>
                    <th style={th}>Sub-brand{renderColumnResizeHandle("subBrand")}</th>
                    <th style={th}>{sortButton("dates", "Dates")}{renderColumnResizeHandle("dates")}</th>
                    <th style={th}>{sortButton("school", "School")}{renderColumnResizeHandle("school")}</th>
                    <th style={th}>{sortButton("participants", "Participants")}{renderColumnResizeHandle("participants")}</th>
                    <th style={th}>{sortButton("perStudent", "Per-student")}{renderColumnResizeHandle("perStudent")}</th>
                    <th style={th}>Trip type{renderColumnResizeHandle("tripType")}</th>
                    <th style={th}>{sortButton("status", "Status")}{renderColumnResizeHandle("status")}</th>
                    <th
                      style={{ ...th, width: columnWidths.actions, textAlign: "left" }}
                      aria-label="Actions"
                    >
                      Actions
                      {renderColumnResizeHandle("actions")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {visibleTripRows.map(({ trip: t, isFamilyChild }) => {
                    const tripType = t.tripType || "international";
                    const familyVariantCount = Number(t._count?.familyVariants || 0)
                      || familyChildrenByParent[t.id]?.length
                      || 0;
                    const canExpandFamily = !t.familyParent && familyVariantCount > 0;
                    const familyIsExpanded = expandedFamilyIds.has(Number(t.id));
                    return (
                      <tr
                        className={isFamilyChild
                          ? "travel-trips-row travel-trips-row--family-child"
                          : canExpandFamily
                            ? "travel-trips-row travel-trips-row--family-parent"
                            : "travel-trips-row"}
                        key={`${isFamilyChild ? "family-child" : "trip"}-${t.id}`}
                        style={{
                          background: isFamilyChild
                            ? "rgba(79,70,229,0.045)"
                            : canExpandFamily
                              ? "rgba(79,70,229,0.025)"
                              : "transparent",
                          boxShadow: isFamilyChild
                            ? "inset 3px 0 0 rgba(79,70,229,0.32)"
                            : canExpandFamily
                              ? "inset 3px 0 0 rgba(47,122,77,0.72)"
                              : "none",
                        }}
                      >
                        <td className="travel-trips-table__trip-code-cell" style={{ ...td, whiteSpace: "nowrap", paddingLeft: isFamilyChild ? 28 : 12 }}>
                          <div style={familyCodeCell}>
                            {canExpandFamily && (
                              <button
                                type="button"
                                aria-label={`${familyIsExpanded ? "Collapse" : "Expand"} variants for ${t.tripCode}`}
                                aria-expanded={familyIsExpanded}
                                title={familyIsExpanded ? "Hide school variants" : "Show school variants"}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  toggleFamily(t);
                                }}
                                style={{
                                  ...familyExpandButton,
                                  ...(familyIsExpanded ? familyExpandButtonActive : {}),
                                }}
                              >
                                {familyIsExpanded
                                  ? <ChevronDown size={13} aria-hidden />
                                  : <ChevronRight size={13} aria-hidden />}
                              </button>
                            )}
                            <Link
                              to={`/travel/trips/${t.id}`}
                              title={t.tripCode}
                              state={{
                                backTo: tripsListPath,
                                backLabel: fromReports
                                  ? "Back to reports results"
                                  : "Back to trips",
                              }}
                              style={{
                                color: "var(--primary-color)",
                                textDecoration: "none",
                                fontWeight: 600,
                                display: "inline-flex",
                                alignItems: "center",
                                gap: 5,
                                minWidth: 0,
                                overflow: "hidden",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {isFamilyChild && (
                                <GitBranch size={14} aria-hidden style={{ color: "var(--text-secondary)", flexShrink: 0 }} />
                              )}
                              <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
                                <SearchHighlight text={t.tripCode} query={search} />
                              </span>
                            </Link>
                          </div>
                        </td>
                        <td style={{ ...td, minWidth: 0 }}>
                          {t.familyParent ? (
                            <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
                              <span style={{ ...familyBadge, background: "rgba(79,70,229,0.12)", color: "var(--primary-color, #4f46e5)" }}>
                                <Link2 size={12} aria-hidden /> Variant
                              </span>
                              <Link
                                to={`/travel/trips/${t.familyParent.id}`}
                                title={`Primary trip ${t.familyParent.tripCode}`}
                                style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-secondary)", textDecoration: "none", fontSize: 12 }}
                              >
                                {t.familyParent.tripCode}
                              </Link>
                            </div>
                          ) : Number(t._count?.familyVariants || 0) > 0 ? (
                            <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
                              <span style={{ ...familyBadge, background: "rgba(47,122,77,0.14)", color: "#2F7A4D" }}>
                                <Link2 size={12} aria-hidden /> Primary
                              </span>
                              <span style={{ color: "var(--text-secondary)", fontSize: 12 }}>
                                {t._count.familyVariants} school variant{t._count.familyVariants === 1 ? "" : "s"}
                              </span>
                            </div>
                          ) : (
                            <span style={{ ...familyBadge, background: "var(--subtle-bg)", color: "var(--text-secondary)" }}>
                              Standalone
                            </span>
                          )}
                        </td>
                        <td style={{ ...td, minWidth: 0 }}>
                          <SearchHighlight text={t.destination} query={search} />
                        </td>
                        <td style={{ ...td, whiteSpace: "nowrap" }}>
                          <span style={brandBadge}>{BRAND_LABEL}</span>
                        </td>
                        <td style={{ ...td, whiteSpace: "nowrap" }}>
                          <SearchHighlight text={SUB_BRAND_LABEL} query={search} />
                        </td>
                        <td style={{ ...td, whiteSpace: "nowrap" }}>
                          <span
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: 4,
                            }}
                          >
                            <CalendarIcon size={12} aria-hidden />
                            {fmt(t.departDate)} – {fmt(t.returnDate)}
                          </span>
                        </td>
                        <td style={{ ...td, whiteSpace: "nowrap" }}>
                          <SearchHighlight
                            text={
                              t.schoolName ||
                              (t.schoolContactId
                                ? `School #${t.schoolContactId}`
                                : "?")
                            }
                            query={search}
                          />
                        </td>
                        <td style={{ ...td, whiteSpace: "nowrap" }}>
                          <span
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: 4,
                            }}
                          >
                            <Users size={12} aria-hidden />
                            {t._count?.participants ?? 0}
                          </span>
                        </td>
                        <td style={{ ...td, whiteSpace: "nowrap" }}>
                          {fmtMoney(t.perStudentAmount)}
                        </td>
                        <td style={{ ...td, whiteSpace: "nowrap" }}>
                          <span className="tmc-trip-badge" data-type={tripType}>
                            {String(tripType).replaceAll("_", " ")}
                          </span>
                        </td>
                        <td style={{ ...td, whiteSpace: "nowrap" }}>
                          <span className="tmc-trip-badge" data-status={t.status}>
                            {t.status || "Unknown"}
                          </span>
                        </td>
                        <td
                          style={{
                            ...td,
                            textAlign: "left",
                            whiteSpace: "nowrap",
                            overflow: "visible",
                          }}
                        >
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                            <button
                              type="button"
                              onClick={() => openVariantCreate(t)}
                              aria-label={`Create school variant for ${t.tripCode}`}
                              title="Create school variant"
                              style={{
                                background: "transparent",
                                border: "1px solid var(--border-color)",
                                borderRadius: 6,
                                padding: "4px 6px",
                                color: "var(--primary-color, var(--accent-color))",
                                cursor: "pointer",
                                display: "inline-flex",
                                alignItems: "center",
                              }}
                            >
                              <Copy size={14} aria-hidden />
                            </button>
                            <button
                              type="button"
                              onClick={() => remove(t)}
                              disabled={deletingId === t.id}
                              aria-label={`Delete trip ${t.tripCode}`}
                              title="Delete trip"
                              style={{
                                background: "transparent",
                                border: "1px solid var(--border-color)",
                                borderRadius: 6,
                                padding: "4px 6px",
                                color: "#A8323F",
                                cursor: deletingId === t.id ? "wait" : "pointer",
                                opacity: deletingId === t.id ? 0.5 : 1,
                                display: "inline-flex",
                                alignItems: "center",
                              }}
                            >
                              <Trash2 size={14} aria-hidden />
                            </button>
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TopScrollSync>
            <div className="travel-trips-page__pager">
              <TripPager
                total={total}
                page={safePage}
                pageSize={pageSize}
                onPageChange={setPage}
                onPageSizeChange={setPageSizeAndReset}
                isCustomPageSize={isCustomPageSize}
                setIsCustomPageSize={setIsCustomPageSize}
                customPageSize={customPageSize}
                setCustomPageSize={setCustomPageSize}
                pageSizeOptions={PAGE_SIZE_OPTIONS}
                maxPageSize={MAX_PAGE_SIZE}
                entityLabel="trips"
              />
            </div>
          </>
        )}
      </div>
      {creating && (
        <div
          // Dismiss only when the pointer press starts on the backdrop. If a
          // user drags to select text and releases outside the dialog, the
          // browser may dispatch the final click on this backdrop; closing
          // from click would discard the form unexpectedly.
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) {
              setCreating(false);
              setVariantSource(null);
            }
          }}
          style={{
            position: "fixed",
            inset: 0,
            background: "var(--catalogue-modal-backdrop)",
            backdropFilter: "blur(4px)",
            WebkitBackdropFilter: "blur(4px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
            padding: "1rem",
          }}
        >
          <form
            onSubmit={submitCreate}
            // Keep page-level travel shortcuts from treating clipboard and
            // other editing keystrokes as actions on the list behind the
            // modal. The modal owns all keyboard interaction while open.
            onKeyDown={(event) => event.stopPropagation()}
            onCopy={(event) => event.stopPropagation()}
            onPaste={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
            className="card travel-trip-create-modal"
            role="dialog"
            aria-modal="true"
            style={drawerStyle}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 16,
              }}
            >
              <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>
                {variantSource ? "Create school variant" : "New Trip"}
              </h2>
              <button
                type="button"
                onClick={() => {
                  setCreating(false);
                  setVariantSource(null);
                }}
                aria-label="Close"
                style={iconBtn}
              >
                <X size={16} />
              </button>
            </div>
            {variantSource && (
              <div
                style={{
                  marginBottom: 14,
                  padding: "10px 12px",
                  borderRadius: 8,
                  background: "var(--subtle-bg)",
                  color: "var(--text-secondary)",
                  fontSize: 12,
                  lineHeight: 1.45,
                }}
              >
                Itinerary copied from <strong>{variantSource.tripCode}</strong>.
                This creates a separate school trip, so its school, teacher,
                landing page, parent link, participants, and payments stay independent.
              </div>
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <label style={fieldLabel}>
                Trip code
                <input
                  required
                  type="text"
                  value={form.tripCode}
                  onChange={(e) =>
                    setForm({ ...form, tripCode: e.target.value })
                  }
                  style={inputStyle}
                  placeholder='e.g. "TMC-AND-2026-MUMBAI-G7"'
                />
              </label>
              <div style={{ ...fieldLabel, width: "100%" }}>
                <label htmlFor="new-trip-destination">Destination</label>
                <LocationAutocomplete
                  value={form.destination}
                  onChange={(destination) =>
                    setForm((current) => ({ ...current, destination }))
                  }
                  nameOnly
                  limit={10}
                  style={{ ...inputStyle, width: "100%", minWidth: 0, boxSizing: "border-box" }}
                  inputProps={{ id: "new-trip-destination", required: true, placeholder: "Andaman" }}
                />
              </div>
              <label style={fieldLabel}>
                School
                <input
                  required
                  type="text"
                  value={form.schoolName}
                  onChange={(e) =>
                    setForm({ ...form, schoolName: e.target.value })
                  }
                  style={inputStyle}
                  placeholder='e.g. "DPS North" or "Bharat Public School"'
                  maxLength={200}
                />
              </label>
              <div className="travel-trip-date-row" style={{ display: "flex", gap: 8 }}>
                <label style={{ ...fieldLabel, flex: 1 }}>
                  Depart date
                  <input
                    required
                    type="date"
                    value={form.departDate}
                    onChange={(e) =>
                      setForm({ ...form, departDate: e.target.value })
                    }
                    style={inputStyle}
                    min={today}
                    onClick={openNativeDatePicker}
                    onKeyDown={handlePickerOnlyDateKeyDown}
                    onPaste={(event) => event.preventDefault()}
                    onDrop={(event) => event.preventDefault()}
                  />
                </label>
                <label style={{ ...fieldLabel, flex: 1 }}>
                  Return date
                  <input
                    required
                    type="date"
                    value={form.returnDate}
                    onChange={(e) =>
                      setForm({ ...form, returnDate: e.target.value })
                    }
                    style={inputStyle}
                    min={form.departDate || today}
                    onClick={openNativeDatePicker}
                    onKeyDown={handlePickerOnlyDateKeyDown}
                    onPaste={(event) => event.preventDefault()}
                    onDrop={(event) => event.preventDefault()}
                  />
                </label>
              </div>
              <label style={fieldLabel}>
                Trip type
                <select value={form.tripType} onChange={(e) => setForm({ ...form, tripType: e.target.value })} style={inputStyle}>
                  <option value="international">International</option>
                  <option value="domestic">Domestic</option>
                  <option value="day_trip">Day trip</option>
                </select>
              </label>
              <label style={fieldLabel}>
                Status
                <select
                  value={form.status}
                  onChange={(e) => setForm({ ...form, status: e.target.value })}
                  style={inputStyle}
                >
                  {STATUSES.filter((s) => s.value).map((s) => (
                    <option key={s.value} value={s.value}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                gap: 8,
                marginTop: 20,
              }}
            >
              <button
                type="button"
                onClick={() => {
                  setCreating(false);
                  setVariantSource(null);
                }}
                style={refreshBtn}
              >
                Cancel
              </button>
              <button type="submit" disabled={saving} style={primaryBtn}>
                {saving ? "Creating…" : variantSource ? "Create variant" : "Create Trip"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

const selectStyle = {
  padding: "6px 10px",
  borderRadius: 6,
  border: "1px solid var(--border-color)",
  background: "var(--surface-color)",
  color: "var(--text-primary)",
  minWidth: 160,
  fontSize: 13,
};
const backLink = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  fontSize: 13,
  color: "var(--text-secondary)",
  textDecoration: "none",
  padding: "6px 12px",
  borderRadius: 6,
  border: "1px solid var(--border-color)",
};
const refreshBtn = {
  padding: "6px 12px",
  borderRadius: 6,
  border: "1px solid var(--border-color)",
  background: "var(--surface-color)",
  color: "var(--text-primary)",
  fontSize: 13,
  cursor: "pointer",
};
const sortButtonStyle = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 6,
  width: "calc(100% - 10px)",
  padding: 0,
  border: "none",
  background: "transparent",
  color: "inherit",
  font: "inherit",
  textTransform: "inherit",
  letterSpacing: "inherit",
  cursor: "pointer",
  textAlign: "left",
};
const primaryBtn = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "6px 12px",
  borderRadius: 6,
  fontWeight: 600,
  fontSize: 13,
  background: "var(--primary-color, var(--accent-color))",
  color: "var(--accent-text, #fff)",
  border: "1px solid var(--primary-color, var(--accent-color))",
  cursor: "pointer",
};
// Centred modal — mirrors the Itineraries + Staff add-staff-member pattern.
// `.card` (set on the form element) supplies border-radius, border, blur
// and lifted shadow; we force opaque `--bg-color` here so the panel
// doesn't read as glassmorphic over the page content behind it.
const drawerStyle = {
  background: "var(--bg-color)",
  color: "var(--text-primary)",
  width: "100%",
  maxWidth: 480,
  maxHeight: "90vh",
  overflowY: "auto",
  padding: "1.5rem",
};
const iconBtn = {
  background: "transparent",
  border: "none",
  color: "var(--text-secondary)",
  cursor: "pointer",
  padding: 4,
};
const fieldLabel = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  fontSize: 12,
  color: "var(--text-secondary)",
  fontWeight: 500,
};
const inputStyle = {
  padding: "8px 10px",
  borderRadius: 6,
  border: "1px solid var(--border-color)",
  background: "var(--input-bg, var(--surface-color))",
  color: "var(--text-primary)",
  fontSize: 14,
};
const empty = {
  padding: 32,
  textAlign: "center",
  color: "var(--text-secondary)",
  fontSize: 14,
};
const brandBadge = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "2px 8px",
  borderRadius: 999,
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: 0.5,
  textTransform: "uppercase",
  background: "rgba(91,110,225,0.14)",
  color: "var(--primary-color)",
};
const familyBadge = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  flexShrink: 0,
  padding: "3px 7px",
  borderRadius: 999,
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: 0.2,
  whiteSpace: "nowrap",
};
const familyExpandButton = {
  appearance: "none",
  border: "1px solid rgba(79,70,229,0.24)",
  background: "rgba(79,70,229,0.07)",
  color: "var(--primary-color, #4f46e5)",
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 20,
  height: 20,
  borderRadius: 6,
  flexShrink: 0,
};
const familyExpandButtonActive = {
  borderColor: "var(--primary-color, #4f46e5)",
  background: "var(--primary-color, #4f46e5)",
  color: "var(--accent-text, #fff)",
};
const familyCodeCell = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  minWidth: 0,
  width: "100%",
};
const th = {
  textAlign: "left",
  padding: "10px 12px",
  fontSize: 12,
  textTransform: "uppercase",
  letterSpacing: 0.5,
  color: "var(--text-secondary)",
  borderBottom: "1px solid var(--border-color)",
  position: "sticky",
  top: 0,
  zIndex: 3,
  background: "var(--modal-bg, var(--bg-color))",
  backgroundColor: "var(--modal-bg, var(--bg-color))",
  backgroundClip: "padding-box",
  boxShadow: "inset 0 -1px 0 var(--border-color)",
  opacity: 1,
  backgroundImage: "none",
  isolation: "isolate",
  backdropFilter: "none",
  whiteSpace: "nowrap",
};
const td = {
  minWidth: 0,
  padding: "10px 12px",
  fontSize: 14,
  color: "var(--text-primary)",
  verticalAlign: "middle",
  overflow: "hidden",
  textOverflow: "ellipsis",
};
