import { useEffect, useMemo, useState } from "react";
import TallySectionNav from "./TallySectionNav";
import { fetchApi } from "../../../utils/api";

const STATUS_COLORS = {
  SYNCED: "#059669",
  FAILED: "#dc2626",
  PENDING: "#d97706",
  CANCELLED: "#64748b",
  LEDGER_CREATED: "#2563eb",
};

const humanize = (value) => String(value || "—")
  .toLowerCase()
  .replaceAll("_", " ")
  .replace(/\b\w/g, (letter) => letter.toUpperCase());

const referenceFor = (row) => row.queue?.reference
  || (row.sourceType === "DIRECT_EXPORT" ? "Direct export" : `#${row.sourceId}`);

const formatPayload = (value, fallback) => {
  if (!value) return fallback;
  const text = String(value).trim();
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch (_) {
    return text.startsWith("<") ? text.replace(/>\s*</g, ">\n<") : text;
  }
};

export default function TallySyncHistoryPage() {
  const [history, setHistory] = useState([]);
  const [selected, setSelected] = useState(null);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [sourceType, setSourceType] = useState("");

  useEffect(() => {
    const load = () => fetchApi("/api/travel/tally/sync-history")
      .then((data) => setHistory(data?.history || []));
    load();
    const timer = setInterval(load, 30000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!selected) return undefined;
    const closeOnEscape = (event) => {
      if (event.key === "Escape") setSelected(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [selected]);

  const filteredHistory = useMemo(() => history.filter((row) => {
    const text = [referenceFor(row), row.queue?.partyName, row.sourceType, row.voucherType, row.status]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return (!search || text.includes(search.toLowerCase()))
      && (!status || row.status === status)
      && (!sourceType || row.sourceType === sourceType);
  }), [history, search, sourceType, status]);

  const statuses = [...new Set(history.map((row) => row.status).filter(Boolean))].sort();
  const sourceTypes = [...new Set(history.map((row) => row.sourceType).filter(Boolean))].sort();

  return <main className="tally-sync-page" style={{ padding: 24, maxWidth: 1280, margin: "0 auto" }}>
    <TallySectionNav />
    <div className="tally-sync-header">
      <div>
        <span className="tally-sync-eyebrow">Finance / Tally</span>
        <h1>Sync History</h1>
        <p>Review Tally exports, responses, failures, and the user who triggered each sync.</p>
      </div>
      <span className="tally-sync-count">{filteredHistory.length} records</span>
    </div>

    <div className="tally-sync-filters">
      <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search reference, party, or status" aria-label="Search sync history" />
      <select value={status} onChange={(event) => setStatus(event.target.value)} aria-label="Filter history status">
        <option value="">All statuses</option>
        {statuses.map((value) => <option key={value} value={value}>{humanize(value)}</option>)}
      </select>
      <select value={sourceType} onChange={(event) => setSourceType(event.target.value)} aria-label="Filter history source">
        <option value="">All sources</option>
        {sourceTypes.map((value) => <option key={value} value={value}>{humanize(value)}</option>)}
      </select>
    </div>

    <section className="tally-sync-card">
      <div className="tally-sync-card-heading">
        <div><h2>Export activity</h2><p>Newest sync attempts appear first.</p></div>
      </div>
      <div className="tally-sync-table-wrap">
        <table className="tally-history-table">
          <thead><tr><th>Date and time</th><th>Reference</th><th>Source</th><th>Voucher</th><th>Tally voucher</th><th>Status</th><th>Details</th></tr></thead>
          <tbody>{filteredHistory.length ? filteredHistory.map((row) => {
            const createdAt = new Date(row.createdAt);
            return <tr key={row.id}>
              <td className="tally-history-date"><strong>{createdAt.toLocaleDateString("en-IN")}</strong><small>{createdAt.toLocaleTimeString("en-IN")}</small></td>
              <td><strong>{referenceFor(row)}</strong>{row.queue?.partyName && <small className="tally-history-secondary">{row.queue.partyName}</small>}</td>
              <td><span className="tally-type-pill">{humanize(row.sourceType)}</span></td>
              <td>{humanize(row.voucherType)}</td>
              <td>{row.tallyVoucherNumber || row.tallyVoucherId || "—"}</td>
              <td><strong className="tally-status-pill" style={{ color: STATUS_COLORS[row.status] || "var(--text-secondary)", borderColor: STATUS_COLORS[row.status] || "var(--border-color)" }}>{humanize(row.status)}</strong></td>
              <td><button className="btn-secondary tally-history-view" type="button" onClick={() => setSelected(row)}>View details</button></td>
            </tr>;
          }) : <tr><td className="tally-sync-empty" colSpan="7">No sync activity matches these filters.</td></tr>}</tbody>
        </table>
      </div>
    </section>

    {selected && <SyncDetailModal row={selected} onClose={() => setSelected(null)} />}
  </main>;
}

function SyncDetailModal({ row, onClose }) {
  const createdAt = new Date(row.createdAt);
  const request = formatPayload(row.requestPayload, "No request payload recorded.");
  const response = formatPayload(row.responsePayload, "No Tally response recorded.");
  const directExport = summarizeDirectExport(row);

  return <div className="tally-history-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="tally-history-modal" role="dialog" aria-modal="true" aria-labelledby="tally-sync-detail-title">
      <div className="tally-history-modal-header">
        <div>
          <span className="tally-sync-eyebrow">Sync record</span>
          <h2 id="tally-sync-detail-title">{referenceFor(row)}</h2>
          <p>{createdAt.toLocaleString("en-IN")}</p>
        </div>
        <button className="btn-secondary" type="button" onClick={onClose} aria-label="Close sync details">Close</button>
      </div>

      <div className="tally-history-summary">
        <Detail label="Status" value={humanize(row.status)} color={STATUS_COLORS[row.status]} />
        <Detail label="Source" value={humanize(row.sourceType)} />
        <Detail label="Voucher type" value={directExport?.voucherTypes || humanize(row.voucherType)} />
        <Detail
          label={directExport ? "Vouchers in batch" : "Tally voucher"}
          value={directExport?.voucherCount
            ? `${directExport.voucherCount} (${directExport.references.join(", ")})`
            : row.tallyVoucherNumber || row.tallyVoucherId || "—"}
        />
        <Detail label={directExport ? "Parties in batch" : "Party"} value={directExport?.parties || row.queue?.partyName || "—"} />
        <Detail
          label={directExport ? "Voucher totals" : "Amount"}
          value={directExport?.amountByType == null
            ? row.queue?.amount == null ? "—" : Number(row.queue.amount).toLocaleString("en-IN", { style: "currency", currency: "INR" })
            : directExport.amountByType}
        />
        <Detail label="Triggered by" value={row.triggeredByUserId ? `User #${row.triggeredByUserId}` : "System"} />
      </div>

      <div className="tally-history-payloads">
        <Payload title="Request sent to Tally" content={request} />
        <Payload title="Response received from Tally" content={response} />
      </div>
    </section>
  </div>;
}

function summarizeDirectExport(row) {
  if (row.sourceType !== "DIRECT_EXPORT" || !row.requestPayload || row.voucherType !== "VOUCHERS") return null;
  try {
    const xml = String(row.requestPayload);
    const vouchers = xml.match(/<VOUCHER\b[^>]*>[\s\S]*?<\/VOUCHER>/gi) || [];
    if (!vouchers.length) return null;

    const typeCounts = new Map();
    const typeAmounts = new Map();
    const references = new Set();
    const parties = new Set();
    vouchers.forEach((voucher) => {
      const type = voucher.match(/\bVCHTYPE="([^"]+)"/i)?.[1] || readXmlValue(voucher, "VOUCHERTYPENAME") || "Voucher";
      typeCounts.set(type, (typeCounts.get(type) || 0) + 1);
      const reference = readXmlValue(voucher, "VOUCHERNUMBER");
      if (reference) references.add(reference);

      const entries = voucher.match(/<(?:ALL)?LEDGERENTRIES\.LIST\b[^>]*>[\s\S]*?<\/(?:ALL)?LEDGERENTRIES\.LIST>/gi) || [];
      const partyEntry = entries.find((entry) => readXmlValue(entry, "ISPARTYLEDGER").toLowerCase() === "yes");
      if (partyEntry) {
        const party = readXmlValue(partyEntry, "LEDGERNAME");
        if (party) parties.add(party);
      }
      const partyAmount = parseTallyAmount(readXmlValue(partyEntry || "", "AMOUNT"));
      const fallbackAmount = entries.reduce((sum, entry) => sum + parseTallyAmount(readXmlValue(entry, "AMOUNT")), 0) / 2;
      const voucherAmount = Math.abs(Number.isFinite(partyAmount) && partyAmount !== 0 ? partyAmount : fallbackAmount);
      typeAmounts.set(type, (typeAmounts.get(type) || 0) + voucherAmount);
    });

    return {
      voucherCount: vouchers.length,
      voucherTypes: [...typeCounts].map(([type, count]) => `${humanize(type)} (${count})`).join(", "),
      references: [...references].slice(0, 3).concat(references.size > 3 ? [`+${references.size - 3} more`] : []),
      parties: parties.size ? `${parties.size} (${[...parties].slice(0, 2).join(", ")}${parties.size > 2 ? ", …" : ""})` : "No party ledger",
      amountByType: [...typeAmounts].map(([type, total]) => `${humanize(type)}: ${total.toLocaleString("en-IN", { style: "currency", currency: "INR" })}`).join(" · "),
    };
  } catch (_) {
    return null;
  }
}

function readXmlValue(xml, tagName) {
  const escapedTag = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const value = String(xml).match(new RegExp(`<${escapedTag}\\b[^>]*>([\\s\\S]*?)</${escapedTag}>`, "i"))?.[1];
  return value ? value.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").trim() : "";
}

function parseTallyAmount(value) {
  const amount = Number(String(value || "").replace(/,/g, "").trim());
  return Number.isFinite(amount) ? Math.abs(amount) : 0;
}

function Detail({ label, value, color }) {
  return <div className="tally-history-detail"><span>{label}</span><strong style={color ? { color } : undefined}>{value}</strong></div>;
}

function Payload({ title, content }) {
  return <section className="tally-history-payload"><h3>{title}</h3><pre>{content}</pre></section>;
}
