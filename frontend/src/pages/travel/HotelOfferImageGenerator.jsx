import { useMemo, useState } from "react";
import { fetchApi } from "../../utils/api";
import { useNotify } from "../../utils/notify";
import { Hotel, Upload, ChevronLeft, ChevronRight, Download, Plus, Trash2, Sparkles, Eye, X } from "lucide-react";
import { buildReferenceHotelOfferSvg } from "./hotelOfferReferenceSvg";
import { buildHotelOfferPdfBlob, HOTEL_OFFER_PDF_WIDTH, HOTEL_OFFER_PDF_HEIGHT } from "./hotelOfferPdf";

const DEFAULT_CURRENCY = "INR";
const MAX_ROWS = 4;

const shell = {
  padding: 16,
  marginBottom: 16,
};

const headerRow = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: 12,
  flexWrap: "wrap",
};

const titleBlock = {
  display: "grid",
  gap: 6,
};

const title = {
  margin: 0,
  display: "flex",
  alignItems: "center",
  gap: 10,
  fontSize: 20,
  fontWeight: 800,
};

const helper = {
  margin: 0,
  color: "var(--text-secondary)",
  fontSize: 13,
  lineHeight: 1.6,
};

const stepper = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 180px), 1fr))",
  gap: 10,
  marginTop: 14,
};

const stepCard = (active) => ({
  borderRadius: 14,
  border: `1px solid ${active ? "var(--primary-color, var(--accent-color))" : "var(--border-color)"}`,
  background: active ? "linear-gradient(135deg, rgba(76, 88, 225, 0.2), rgba(82, 114, 240, 0.08))" : "var(--surface-color)",
  padding: 14,
  minHeight: 72,
  display: "flex",
  alignItems: "center",
  gap: 12,
  color: "var(--text-primary)",
  boxShadow: active ? "0 0 0 1px rgba(120, 139, 255, 0.12) inset" : "none",
});

const stepBubble = (active) => ({
  width: 30,
  height: 30,
  borderRadius: 999,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  background: active ? "var(--primary-color, var(--accent-color))" : "rgba(255,255,255,0.08)",
  color: active ? "#fff" : "var(--text-secondary)",
  fontWeight: 800,
  flex: "0 0 auto",
});

const sectionTitle = {
  margin: 0,
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontSize: 18,
  fontWeight: 800,
};

const fieldStyle = {
  width: "100%",
  boxSizing: "border-box",
  borderRadius: 12,
  border: "1px solid var(--border-color)",
  background: "var(--surface-color)",
  padding: "10px 12px",
  fontSize: 14,
  color: "var(--text-primary)",
  outline: "none",
};

const primaryBtn = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 8,
  borderRadius: 12,
  border: "none",
  background: "var(--primary-color, var(--accent-color))",
  color: "var(--accent-text, #fff)",
  padding: "10px 16px",
  fontWeight: 800,
  cursor: "pointer",
};

const secondaryBtn = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 8,
  borderRadius: 12,
  border: "1px solid var(--border-color)",
  background: "var(--surface-color)",
  color: "var(--text-primary)",
  padding: "10px 16px",
  fontWeight: 800,
  cursor: "pointer",
};

const summaryCard = {
  border: "1px solid var(--border-color)",
  borderRadius: 14,
  background: "var(--surface-color)",
  padding: 14,
};

const mutedCard = {
  border: "1px dashed var(--border-color)",
  borderRadius: 14,
  background: "var(--subtle-bg)",
  padding: 14,
  color: "var(--text-secondary)",
};

const countPill = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  minWidth: 36,
  padding: "3px 10px",
  borderRadius: 999,
  background: "var(--subtle-bg)",
  border: "1px solid var(--border-color)",
  color: "var(--text-secondary)",
  fontSize: 12,
  fontWeight: 700,
};

const iconDangerBtn = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 32,
  height: 32,
  borderRadius: 8,
  border: "1px solid transparent",
  background: "transparent",
  color: "var(--danger-color, #ef4444)",
  cursor: "pointer",
};

const uploadList = {
  display: "grid",
  gap: 10,
  marginTop: 12,
};

const generatorPreview = {
  minHeight: 340,
  borderRadius: 16,
  border: "1px solid var(--border-color)",
  background: "var(--subtle-bg)",
  padding: 14,
  display: "grid",
  placeItems: "center",
  overflow: "hidden",
};

const previewOverlay = {
  position: "fixed",
  inset: 0,
  zIndex: 80,
  background: "rgba(5, 10, 20, 0.9)",
  backdropFilter: "blur(12px)",
  display: "grid",
  placeItems: "center",
  padding: 24,
};

const previewModal = {
  width: "min(1180px, 100%)",
  maxHeight: "92vh",
  borderRadius: 20,
  border: "1px solid rgba(255,255,255,0.12)",
  background: "rgba(10, 14, 24, 0.96)",
  boxShadow: "0 24px 80px rgba(0,0,0,0.45)",
  padding: 16,
  display: "grid",
  gap: 16,
};

const previewFrame = {
  maxHeight: "calc(92vh - 120px)",
  overflow: "auto",
  borderRadius: 16,
  border: "1px solid rgba(255,255,255,0.12)",
  background: "#0b1220",
  padding: 16,
};

const previewImage = {
  display: "block",
  width: "100%",
  height: "auto",
  borderRadius: 14,
  background: "#fff",
};

function blankHotelRow() {
  return {
    label: "",
    roomType: "",
    nights: "",
    basePrice: "",
    priceBasis: "total",
    adjustmentMode: "markup",
    markupType: "amount",
    markupValue: "",
  };
}

function formatCurrency(value, currency = DEFAULT_CURRENCY) {
  const num = Number(value);
  if (!Number.isFinite(num)) return currency;
  return `${currency} ${num.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function normalizeAdjustmentMode(value) {
  const text = String(value == null ? "" : value).trim().toLowerCase();
  return text === "discount" ? "discount" : "markup";
}

function normalizeAdjustmentType(value) {
  const text = String(value == null ? "" : value).trim().toLowerCase();
  return text === "percentage" ? "percentage" : "amount";
}

function calculateHotelRowPricing(row, quoteCity = "") {
  const basePrice = Number(row.basePrice);
  if (!Number.isFinite(basePrice)) return null;
  const adjustmentValue = Number(row.markupValue);
  if (!Number.isFinite(adjustmentValue)) return null;
  const nightsValue = Number(row.nights);
  const nights = Number.isFinite(nightsValue) && nightsValue > 0 ? nightsValue : 1;
  const baseAmount = row.priceBasis === "per_night"
    ? Math.round(basePrice * nights * 100) / 100
    : Math.round(basePrice * 100) / 100;
  const adjustmentMode = normalizeAdjustmentMode(row.adjustmentMode);
  const adjustmentType = normalizeAdjustmentType(row.markupType);
  const adjustmentAmount = adjustmentType === "percentage"
    ? Math.round((baseAmount * adjustmentValue / 100) * 100) / 100
    : Math.round(adjustmentValue * 100) / 100;
  const signedAdjustment = adjustmentMode === "discount" ? -adjustmentAmount : adjustmentAmount;
  const total = Math.max(0, Math.round((baseAmount + signedAdjustment) * 100) / 100);
  return {
    basePrice,
    baseAmount,
    adjustmentMode,
    adjustmentType,
    adjustmentAmount,
    signedAdjustment,
    total,
    nights,
    city: quoteCity || "",
  };
}

function buildHotelOfferSvg({ hotelLabel, pricedRows, totalAmount, quoteMeta = {} }) {
  return buildReferenceHotelOfferSvg({ hotelLabel, pricedRows, totalAmount, quoteMeta });
}

function buildSvgDataUrl(svg) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export default function HotelOfferImageGenerator() {
  const notify = useNotify();
  const [activeStep, setActiveStep] = useState(1);
  const [uploadedScreenshots, setUploadedScreenshots] = useState([]);
  const [hotelRows, setHotelRows] = useState([blankHotelRow()]);
  const [generatedImageUrl, setGeneratedImageUrl] = useState("");
  const [generatedSvgMarkup, setGeneratedSvgMarkup] = useState("");
  const [quoteMeta, setQuoteMeta] = useState({});
  const [previewOpen, setPreviewOpen] = useState(false);
  const [generatingImage, setGeneratingImage] = useState(false);
  const [downloadingPdf, setDownloadingPdf] = useState(false);
  const [extractingPrices, setExtractingPrices] = useState(false);
  const [generatorError, setGeneratorError] = useState("");

  const pricedRows = useMemo(() => hotelRows.map((row, index) => {
    const pricing = calculateHotelRowPricing(row, quoteMeta.city);
    if (!pricing) return null;
    return {
      index: index + 1,
      label: row.label || null,
      roomType: row.roomType || "",
      city: quoteMeta.city || "",
      nights: pricing.nights,
      priceBasis: row.priceBasis || "total",
      basePrice: pricing.basePrice,
      baseAmount: pricing.baseAmount,
      adjustmentMode: pricing.adjustmentMode,
      adjustmentType: pricing.adjustmentType,
      adjustmentAmount: pricing.adjustmentAmount,
      signedAdjustment: pricing.signedAdjustment,
      total: pricing.total,
      priceNote: row.priceNote || "",
    };
  }).filter(Boolean), [hotelRows, quoteMeta.city]);

  const totalAmount = pricedRows.reduce((sum, row) => sum + (Number(row.total) || 0), 0);
  const hotelLabel = quoteMeta.hotelLabel || "Hotel quotation";
  const hotelCountLabel = pricedRows.length === 1 ? "1 priced hotel" : `${pricedRows.length} priced hotels`;
  const downloadFileName = `hotel-offer-${Date.now()}.pdf`;

  const updateRow = (index, patch) => {
    setHotelRows((prev) => prev.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)));
  };

  const addRow = () => {
    setHotelRows((prev) => (prev.length >= MAX_ROWS ? prev : [...prev, blankHotelRow()]));
  };

  const removeRow = (index) => {
    setHotelRows((prev) => (prev.length <= 1 ? prev : prev.filter((_, rowIndex) => rowIndex !== index)));
  };

  const continueFromUpload = async () => {
    if (uploadedScreenshots.length === 0) {
      setGeneratorError("Upload at least one screenshot before continuing.");
      notify.error("Upload at least one screenshot before continuing.");
      return;
    }
    setGeneratorError("");
    setExtractingPrices(true);
    try {
      const form = new FormData();
      uploadedScreenshots.forEach((file) => form.append("images", file));
      const result = await fetchApi("/api/v1/flight-plugin/extract-hotel-prices", { method: "POST", body: form });
      const rows = Array.isArray(result?.rows) ? result.rows : [];
      if (rows.length > 0) {
        setHotelRows(rows.map((row) => ({
          label: row.label || "",
          roomType: row.roomType || "",
          nights: row.nights == null ? "" : String(row.nights),
          basePrice: row.basePrice == null ? "" : String(row.basePrice),
          priceBasis: row.priceBasis === "per_night" ? "per_night" : "total",
          adjustmentMode: "markup",
          markupType: "amount",
          markupValue: "",
        })));
      } else {
        setHotelRows([blankHotelRow()]);
      }
      setQuoteMeta({
        hotelLabel: result?.hotelLabel || result?.summary?.hotelLabel || "",
        city: result?.city || result?.summary?.city || "",
        stayLabel: result?.stayLabel || result?.summary?.stayLabel || "",
        checkIn: result?.checkIn || result?.summary?.checkIn || "",
        checkOut: result?.checkOut || result?.summary?.checkOut || "",
        basisLabel: result?.summary?.basisLabel || result?.basisLabel || "",
        sourceLabel: result?.summary?.sourceLabel || result?.sourceLabel || "",
        notes: result?.notes || {},
      });
      if (result?.provider || result?.model) {
        notify.success(`Extracted hotel prices using ${result.provider}${result.model ? ` (${result.model})` : ""}.`);
      }
    } catch (error) {
      setHotelRows([blankHotelRow()]);
      setQuoteMeta({});
      const message = error?.data?.error || error?.message || "Failed to extract prices from the uploaded screenshots.";
      setGeneratorError(message);
      notify.error(message);
    } finally {
      setExtractingPrices(false);
      setActiveStep(2);
    }
  };

  const generateImage = () => {
    setGeneratingImage(true);
    setGeneratorError("");
    try {
      const svg = buildHotelOfferSvg({
        hotelLabel,
        pricedRows,
        totalAmount,
        quoteMeta,
      });
      setGeneratedSvgMarkup(svg);
      setGeneratedImageUrl(buildSvgDataUrl(svg));
      setActiveStep(3);
    } catch (error) {
      setGeneratorError(error?.message || "Failed to generate the hotel offer image.");
    } finally {
      setGeneratingImage(false);
    }
  };

  const downloadImage = async () => {
    if (!generatedSvgMarkup) {
      setGeneratorError("Generate the image before downloading it.");
      return;
    }
    setDownloadingPdf(true);
    setGeneratorError("");
    try {
      const pdfBlob = await buildHotelOfferPdfBlob(generatedSvgMarkup, {
        pageWidth: HOTEL_OFFER_PDF_WIDTH,
        pageHeight: HOTEL_OFFER_PDF_HEIGHT,
      });
      const objectUrl = URL.createObjectURL(pdfBlob);
      try {
        const link = document.createElement("a");
        link.href = objectUrl;
        link.download = downloadFileName;
        link.click();
      } finally {
        window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      }
    } catch (error) {
      const message = error?.message || "Failed to download the hotel offer PDF.";
      setGeneratorError(message);
      notify.error(message);
    } finally {
      setDownloadingPdf(false);
    }
  };

  return (
    <section className="glass" style={shell}>
      <div style={headerRow}>
        <div style={titleBlock}>
          <h2 style={title}><Hotel size={18} aria-hidden /> Hotel offer image generator</h2>
          <p style={helper}>Upload an offline hotel price screenshot, then edit prices and choose markup or discount before generating a customer-ready quotation image.</p>
        </div>
        <span style={countPill}>Step {activeStep} of 3</span>
      </div>

      <div style={stepper} aria-label="Hotel offer image generator steps">
        {["Upload", "Price + adjustment", "Generate"].map((label, index) => {
          const stepIndex = index + 1;
          const active = activeStep === stepIndex;
          return (
            <div key={label} style={stepCard(active)}>
              <span style={stepBubble(active)}>{stepIndex}</span>
              <strong>{label}</strong>
            </div>
          );
        })}
      </div>

      {activeStep === 1 ? (
        <div style={{ ...summaryCard, marginTop: 16 }}>
          <div style={headerRow}>
            <div style={titleBlock}>
              <h3 style={sectionTitle}><Upload size={18} aria-hidden /> Upload hotel screenshots</h3>
              <p style={helper}>Add one or more hotel price screenshots, then continue to the pricing step.</p>
            </div>
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <span style={countPill}>{uploadedScreenshots.length} files</span>
              <button type="button" onClick={continueFromUpload} disabled={extractingPrices} style={{ ...secondaryBtn, opacity: extractingPrices ? 0.7 : 1 }}>
                {extractingPrices ? "Extracting..." : <>Continue <ChevronRight size={14} aria-hidden /></>}
              </button>
            </div>
          </div>

          <div style={{ marginTop: 14 }}>
            <input
              type="file"
              multiple
              accept="image/png,image/jpeg,image/webp,image/gif"
              aria-label="Upload hotel screenshots"
              onChange={(event) => setUploadedScreenshots(Array.from(event.target.files || []))}
              style={fieldStyle}
            />
            <div style={{ marginTop: 8, ...helper }}>
              Supported formats: JPG, PNG, WebP or GIF. Each file can be up to 5 MB.
            </div>
            {uploadedScreenshots.length > 0 ? (
              <div style={uploadList}>
                {uploadedScreenshots.map((file) => (
                  <div key={`${file.name}-${file.size}`} style={summaryCard}>
                    <strong>{file.name}</strong>
                    <div style={{ marginTop: 6, ...helper }}>{Math.round(file.size / 1024)} KB</div>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
          {generatorError ? <div style={{ ...mutedCard, marginTop: 12, borderColor: "rgba(239,68,68,0.45)", color: "#fecaca" }}>{generatorError}</div> : null}
        </div>
      ) : null}

      {activeStep === 2 ? (
        <div style={{ ...summaryCard, marginTop: 16 }}>
          <div style={headerRow}>
            <div style={titleBlock}>
              <h3 style={sectionTitle}><Sparkles size={18} aria-hidden /> Price + adjustment</h3>
              <p style={helper}>Adjust the extracted hotel rows, edit the fetched prices if seasonal rates changed, choose markup or discount, and keep the pricing decision internal.</p>
            </div>
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <button type="button" onClick={() => setActiveStep(1)} style={secondaryBtn}><ChevronLeft size={14} aria-hidden /> Back</button>
              <button type="button" onClick={() => setActiveStep(3)} style={primaryBtn}>Next <ChevronRight size={14} aria-hidden /></button>
            </div>
          </div>

          <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 240px), 1fr))", marginTop: 14 }}>
            <div style={summaryCard}>
              <strong>Hotel title</strong>
              <div style={{ marginTop: 6, ...helper }}>{hotelLabel}</div>
            </div>
            <div style={summaryCard}>
              <strong>Priced rows</strong>
              <div style={{ marginTop: 6, ...helper }}>{hotelCountLabel}</div>
            </div>
            <div style={summaryCard}>
              <strong>Net total</strong>
              <div style={{ marginTop: 6, ...helper }}>{formatCurrency(totalAmount)}</div>
            </div>
          </div>

          <div style={{ display: "grid", gap: 14, marginTop: 14 }}>
            {hotelRows.map((row, index) => {
              const pricing = calculateHotelRowPricing(row, quoteMeta.city);
              const finalPrice = pricing ? pricing.total : null;
              return (
                <div key={`hotel-row-${index}`} style={summaryCard}>
                  <div style={headerRow}>
                    <strong>{row.label || `Hotel ${index + 1}`}</strong>
                    <button type="button" aria-label={`Remove hotel ${index + 1}`} onClick={() => removeRow(index)} disabled={hotelRows.length <= 1} style={{ ...iconDangerBtn, opacity: hotelRows.length <= 1 ? 0.45 : 1 }}>
                      <Trash2 size={14} aria-hidden />
                    </button>
                  </div>
                  <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 160px), 1fr))", marginTop: 12 }}>
                    <input aria-label={`Hotel name ${index + 1}`} placeholder="Hotel / property name" value={row.label} onChange={(e) => updateRow(index, { label: e.target.value })} style={fieldStyle} />
                    <input aria-label={`Room type ${index + 1}`} placeholder="Room type" value={row.roomType} onChange={(e) => updateRow(index, { roomType: e.target.value })} style={fieldStyle} />
                    <input aria-label={`Nights ${index + 1}`} placeholder="Nights" value={row.nights} onChange={(e) => updateRow(index, { nights: e.target.value.replace(/[^0-9.]/g, "") })} style={fieldStyle} />
                    <select aria-label={`Pricing basis ${index + 1}`} value={row.priceBasis} onChange={(e) => updateRow(index, { priceBasis: e.target.value })} style={fieldStyle}>
                      <option value="total">Total</option>
                      <option value="per_night">Per night</option>
                    </select>
                    <input aria-label={`Base price ${index + 1}`} placeholder="Fetched price" value={row.basePrice} onChange={(e) => updateRow(index, { basePrice: e.target.value.replace(/[^0-9.]/g, "") })} style={fieldStyle} />
                    <select aria-label={`Adjustment mode ${index + 1}`} value={row.adjustmentMode || "markup"} onChange={(e) => updateRow(index, { adjustmentMode: e.target.value })} style={fieldStyle}>
                      <option value="markup">Markup</option>
                      <option value="discount">Discount</option>
                    </select>
                    <select aria-label={`Adjustment type ${index + 1}`} value={row.markupType} onChange={(e) => updateRow(index, { markupType: e.target.value })} style={fieldStyle}>
                      <option value="amount">Amount</option>
                      <option value="percentage">Percentage</option>
                    </select>
                    <input aria-label={`Adjustment value ${index + 1}`} placeholder="Adjustment Value" value={row.markupValue} onChange={(e) => updateRow(index, { markupValue: e.target.value.replace(/[^0-9.]/g, "") })} style={fieldStyle} />
                    <input aria-label={`Final price ${index + 1}`} value={finalPrice == null ? "" : formatCurrency(finalPrice)} readOnly style={{ ...fieldStyle, fontWeight: 800 }} />
                  </div>
                </div>
              );
            })}
          </div>

          <div style={{ marginTop: 14, display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
            <button type="button" onClick={addRow} disabled={hotelRows.length >= MAX_ROWS} style={{ ...secondaryBtn, opacity: hotelRows.length >= MAX_ROWS ? 0.5 : 1 }}>
              <Plus size={14} aria-hidden /> Add another hotel
            </button>
            <span style={countPill}>{pricedRows.length} priced rows</span>
          </div>
        </div>
      ) : null}

      {activeStep === 3 ? (
        <div style={{ ...summaryCard, marginTop: 16 }}>
          <div style={headerRow}>
            <div style={titleBlock}>
              <h3 style={sectionTitle}><Download size={18} aria-hidden /> Generate image</h3>
              <p style={helper}>Build the final image and download it directly. No adjustment breakdown is shown to the customer.</p>
            </div>
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <button type="button" onClick={() => setActiveStep(2)} style={secondaryBtn}><ChevronLeft size={14} aria-hidden /> Back</button>
              <button type="button" onClick={generateImage} disabled={generatingImage} style={{ ...primaryBtn, opacity: generatingImage ? 0.7 : 1 }}>
                {generatingImage ? "Generating..." : "Generate image"}
              </button>
              <button type="button" onClick={() => setPreviewOpen(true)} disabled={!generatedImageUrl} style={{ ...secondaryBtn, opacity: generatedImageUrl ? 1 : 0.5 }}>
                <Eye size={14} aria-hidden /> Preview image
              </button>
              <button type="button" onClick={downloadImage} disabled={!generatedSvgMarkup || downloadingPdf} style={{ ...secondaryBtn, opacity: generatedSvgMarkup && !downloadingPdf ? 1 : 0.5 }}>
                <Download size={14} aria-hidden /> {downloadingPdf ? "Preparing PDF..." : "Download PDF"}
              </button>
            </div>
          </div>

          <div style={{ display: "grid", gap: 12, gridTemplateColumns: "minmax(0, 1.4fr) minmax(280px, 0.8fr)", marginTop: 16 }}>
            <div style={generatorPreview}>
              {generatedImageUrl ? (
                <img src={generatedImageUrl} alt="Generated hotel offer preview" style={{ width: "100%", maxWidth: 500, borderRadius: 16, boxShadow: "0 16px 40px rgba(0,0,0,0.22)" }} />
              ) : (
                <div style={{ ...mutedCard, width: "100%", maxWidth: 520, textAlign: "left" }}>
                  <strong>Preview will appear here after generation.</strong>
                  <div style={{ marginTop: 8, ...helper }}>The card uses the current hotel rows and adjustment to build a share-ready quotation image.</div>
                </div>
              )}
            </div>
            <div style={summaryCard}>
              <h4 style={{ margin: 0, fontSize: 16 }}>Included in the image</h4>
              <div style={{ marginTop: 12, ...helper }}>Hotel title: <strong>{hotelLabel}</strong></div>
              <div style={{ marginTop: 8, ...helper }}>Uploaded screenshots: <strong>{uploadedScreenshots.length}</strong></div>
              <div style={{ marginTop: 8, ...helper }}>Priced rows: <strong>{pricedRows.length}</strong></div>
              <div style={{ marginTop: 8, ...helper }}>Net total: <strong>{formatCurrency(totalAmount)}</strong></div>
              {generatorError ? <div style={{ marginTop: 12, color: "#fecaca" }}>{generatorError}</div> : null}
            </div>
          </div>
        </div>
      ) : null}

      {previewOpen && generatedImageUrl ? (
        <div role="dialog" aria-modal="true" aria-label="Hotel offer preview" style={previewOverlay} onClick={() => setPreviewOpen(false)}>
          <div style={previewModal} onClick={(event) => event.stopPropagation()}>
            <div style={headerRow}>
              <div style={titleBlock}>
                <h3 style={sectionTitle}>Full-size preview</h3>
                <p style={helper}>Inspect the complete quotation image before sharing it.</p>
              </div>
              <button type="button" onClick={() => setPreviewOpen(false)} style={secondaryBtn}>
                <X size={14} aria-hidden /> Close
              </button>
            </div>
            <div style={previewFrame}>
              <img src={generatedImageUrl} alt="Full-size hotel offer preview" style={previewImage} />
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}






