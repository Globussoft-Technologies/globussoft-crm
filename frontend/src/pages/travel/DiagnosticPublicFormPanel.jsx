// Diagnostic Builder — Public Form publishing panel (Travel CRM v3.9.4).
//
// Lets admins style and publish a public, no-auth diagnostic form per sub-brand.
// The published form lives at /diagnostic-form/:tenantSlug/:subBrand and
// submits into the existing TravelDiagnostic + RAG + PDF pipeline.
//
// Brand-kit cascade rules:
//   * When a BrandKit is linked, its values are the base layer.
//   * Form-level fields are explicit overrides; clearing them falls back to
//     the linked kit (or the hard default if no kit is linked).
//   * "Apply brand kit" copies the current kit values into the form fields.
//   * "Reset to brand kit" clears overrides so the live kit values are used.

import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  Copy,
  ExternalLink,
  Globe,
  Save,
  Eye,
  EyeOff,
  RefreshCw,
  RotateCcw,
  Palette,
  Image,
  Type,
  Layout,
  Monitor,
  Info,
  Upload,
  X,
  Plus,
  ArrowUp,
  ArrowDown,
} from "lucide-react";
import { fetchApi, getAuthToken } from "../../utils/api";
import { AuthContext } from "../../App";
import DiagnosticFormRenderer from "../../components/travel/DiagnosticFormRenderer";
import {
  FONT_OPTIONS,
  parseStyling,
  buildTheme,
} from "../../components/travel/diagnosticFormTheme";

const DEFAULT_IDENTITY_FIELDS = [
  { id: "name", label: "Name", type: "text", required: true, enabled: true },
  { id: "email", label: "Email", type: "email", required: true, enabled: true },
  { id: "phone", label: "Phone", type: "tel", required: false, enabled: true },
];

export default function DiagnosticPublicFormPanel({ subBrand, bankInfo, questionsJson, notify }) {
  const { tenant } = useContext(AuthContext) || {};
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [brandKits, setBrandKits] = useState([]);
  const [selectedKit, setSelectedKit] = useState(null);
  const [form, setForm] = useState(buildDefaultForm());
  const [showPreview, setShowPreview] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [formRes, kitsRes] = await Promise.all([
        fetchApi(`/api/travel/diagnostic-public-forms/${encodeURIComponent(subBrand)}`).catch(() => null),
        fetchApi(`/api/brand-kits?subBrand=${encodeURIComponent(subBrand)}`).catch(() => null),
      ]);

      const kits = Array.isArray(kitsRes?.brandKits) ? kitsRes.brandKits : [];
      const activeKits = kits.filter((k) => k.isActive);
      setBrandKits(activeKits.length ? activeKits : kits);

      if (formRes?.form) {
        const normalized = normalizeForm(formRes.form);
        setForm(normalized);
        if (normalized.brandKitId) {
          const kit = kits.find((k) => k.id === normalized.brandKitId);
          if (kit) setSelectedKit(kit);
        }
      } else {
        const activeKit = activeKits.find((k) => k.subBrand === subBrand);
        if (activeKit) {
          setSelectedKit(activeKit);
          setForm((f) => mergeKitIntoForm(f, activeKit));
        } else {
          setForm(buildDefaultForm());
        }
      }
    } catch (e) {
      notify.error(e?.body?.error || "Failed to load public form settings");
    } finally {
      setLoading(false);
    }
  }, [subBrand, notify]);

  useEffect(() => {
    load();
  }, [load]);

  const styling = useMemo(() => parseStyling(form.stylingConfigJson), [form.stylingConfigJson]);

  const update = (patch) => setForm((f) => ({ ...f, ...patch }));

  const updateStyling = (patch) => {
    setForm((f) => ({
      ...f,
      stylingConfigJson: JSON.stringify({ ...parseStyling(f.stylingConfigJson), ...patch }),
    }));
  };

  const updateIdentityFields = (fields) => {
    setForm((f) => {
      const next = {
        ...f,
        stylingConfigJson: JSON.stringify({
          ...parseStyling(f.stylingConfigJson),
          identityFields: fields,
        }),
      };
      for (const field of fields) {
        if (field.id === "name") {
          next.includeName = field.enabled !== false;
          next.nameRequired = Boolean(field.required);
        }
        if (field.id === "email") {
          next.includeEmail = field.enabled !== false;
          next.emailRequired = Boolean(field.required);
        }
        if (field.id === "phone") {
          next.includePhone = field.enabled !== false;
          next.phoneRequired = Boolean(field.required);
        }
      }
      return next;
    });
  };

  const applyBrandKit = (kit) => {
    if (!kit) return;
    setSelectedKit(kit);
    setForm((f) => mergeKitIntoForm(f, kit));
    notify.success(`Applied brand kit "${kit.subBrand || "tenant-wide"} v${kit.version}".`);
  };

  const resetToBrandKit = () => {
    if (!selectedKit) return;
    setForm((f) => ({
      ...f,
      primaryColor: "",
      bgColor: "",
      textColor: "",
      fontFamily: "",
      logoUrl: "",
      logoPlacement: "top-center",
      stylingConfigJson: "",
    }));
    notify.success("Cleared overrides; form will use the latest brand kit values.");
  };

  const saveFormSettings = async () => {
    const payload = {
      subBrand,
      ...form,
      brandKitId: form.brandKitId || null,
      stylingConfigJson:
        typeof form.stylingConfigJson === "string" && form.stylingConfigJson.trim()
          ? form.stylingConfigJson
          : null,
    };
    const res = await fetchApi("/api/travel/diagnostic-public-forms", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    if (res?.form) setForm(normalizeForm(res.form));
    return res;
  };

  const onSave = async () => {
    setSaving(true);
    try {
      await saveFormSettings();
      notify.success("Public form settings saved.");
    } catch (e) {
      notify.error(e?.body?.error || "Failed to save public form");
    } finally {
      setSaving(false);
    }
  };

  const onTogglePublish = async () => {
    setToggling(true);
    try {
      await saveFormSettings();
      const res = await fetchApi(
        `/api/travel/diagnostic-public-forms/${encodeURIComponent(subBrand)}/toggle`,
        { method: "POST" },
      );
      if (res?.form) setForm(normalizeForm(res.form));
      notify.success(res?.isPublished ? "Public form published." : "Public form unpublished.");
    } catch (e) {
      notify.error(e?.body?.error || "Failed to toggle publish state");
    } finally {
      setToggling(false);
    }
  };

  const publicUrl = buildPublicUrl(subBrand, tenant);
  const copyUrl = async () => {
    try {
      await navigator.clipboard.writeText(publicUrl);
      notify.success("Public URL copied to clipboard.");
    } catch {
      notify.error("Could not copy URL.");
    }
  };

  const brandKitOptions = brandKits.map((k) => ({
    value: k.id,
    label: `${k.subBrand || "tenant-wide"} v${k.version}${k.isActive ? " (active)" : ""}`,
    kit: k,
  }));

  const previewQuestions = useMemo(
    () => parsePreviewQuestions(questionsJson),
    [questionsJson],
  );

  const previewConfig = useMemo(() => ({
    form,
    brandKit: selectedKit,
  }), [form, selectedKit]);

  const handleUpload = async (fieldKey, assetType, file) => {
    if (!file) return;
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("assetType", assetType);
      fd.append("subBrand", subBrand);
      const token = getAuthToken();
      const headers = {};
      if (token) headers.Authorization = `Bearer ${token}`;
      const res = await fetch("/api/brand-kits/upload", {
        method: "POST",
        body: fd,
        headers,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || `Upload failed (${res.status})`);
      }
      const body = await res.json();
      if (fieldKey.startsWith("styling.")) {
        const key = fieldKey.replace("styling.", "");
        updateStyling({ [key]: body.url });
      } else {
        update({ [fieldKey]: body.url });
      }
      notify.success(`${assetType} uploaded`);
    } catch (err) {
      notify.error(err?.message || "Upload failed");
    }
  };

  if (loading) return <p style={{ color: "var(--text-secondary)" }}>Loading…</p>;

  return (
    <>
      <style>{diagnosticSliderCss}</style>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: showPreview
            ? "minmax(0, 0.92fr) minmax(640px, 1.08fr)"
            : "minmax(0, 1fr)",
          gap: 24,
          alignItems: "flex-start",
          width: "100%",
        }}
      >
      <div style={{ minWidth: 0, display: "grid", gap: 16 }}>
        <section style={card}>
          <div style={sectionHeader}>
            <h2 style={cardTitle}>
              <Globe size={18} style={{ verticalAlign: -3, marginRight: 8 }} />
              Public form URL
            </h2>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span
                style={{
                  ...badge,
                  background: form.isPublished
                    ? "rgba(40, 167, 69, 0.15)"
                    : "rgba(108, 117, 125, 0.15)",
                  color: form.isPublished ? "#28a745" : "#6c757d",
                }}
              >
                {form.isPublished ? "Published" : "Draft"}
              </span>
              <button
                type="button"
                onClick={onTogglePublish}
                disabled={toggling || !bankInfo?.existing}
                style={toggling || !bankInfo?.existing ? primaryBtnDisabled : primaryBtn}
              >
                {form.isPublished ? <EyeOff size={14} /> : <Eye size={14} />}
                {form.isPublished ? "Unpublish" : "Publish"}
              </button>
            </div>
          </div>
          {!bankInfo?.existing && (
            <p style={{ color: "var(--danger-color)", fontSize: 13 }}>
              Save a question bank for this sub-brand before publishing the public form.
            </p>
          )}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <code style={urlCode}>{publicUrl}</code>
            <button type="button" onClick={copyUrl} style={secondaryBtn}>
              <Copy size={14} /> Copy URL
            </button>
            <a href={publicUrl} target="_blank" rel="noopener noreferrer" style={secondaryBtn}>
              <ExternalLink size={14} /> Open
            </a>
          </div>
        </section>

        <section style={card}>
          <h2 style={cardTitle}>Form copy</h2>
          <div style={fieldGrid}>
            <Field label="Title" tooltip="Main heading shown at the top of the public form.">
              <input
                type="text"
                value={form.title}
                onChange={(e) => update({ title: e.target.value })}
                style={input}
                placeholder="e.g. Discover your travel readiness"
              />
            </Field>
            <Field label="Subtitle" tooltip="Short line shown directly under the title.">
              <input
                type="text"
                value={form.subtitle}
                onChange={(e) => update({ subtitle: e.target.value })}
                style={input}
                placeholder="Short line below the title"
              />
            </Field>
            <Field label="Title position" tooltip="Horizontal position of the title.">
              <select
                value={styling.titleAlign || "left"}
                onChange={(e) => updateStyling({ titleAlign: e.target.value })}
                style={input}
              >
                <option value="left">Left</option>
                <option value="center">Center</option>
                <option value="right">Right</option>
              </select>
            </Field>
            <Field label="Subtitle position" tooltip="Horizontal position of the subtitle.">
              <select
                value={styling.subtitleAlign || styling.titleAlign || "left"}
                onChange={(e) => updateStyling({ subtitleAlign: e.target.value })}
                style={input}
              >
                <option value="left">Left</option>
                <option value="center">Center</option>
                <option value="right">Right</option>
              </select>
            </Field>
          </div>
          <Field label="Header HTML" tooltip="Optional rich text/HTML shown above the questions.">
            <textarea
              value={form.headerHtml || ""}
              onChange={(e) => update({ headerHtml: e.target.value })}
              style={textarea}
              rows={3}
              placeholder="Optional rich header text / embed / disclaimer"
            />
          </Field>
          <Field label="Footer HTML" tooltip="Optional text/HTML shown below the submit button.">
            <textarea
              value={form.footerHtml || ""}
              onChange={(e) => update({ footerHtml: e.target.value })}
              style={textarea}
              rows={3}
              placeholder="Footer text, links, privacy note"
            />
          </Field>
          <Field label="Submit button label" tooltip="Text on the button that submits the form.">
            <input
              type="text"
              value={form.thankYouMessage}
              onChange={(e) => update({ thankYouMessage: e.target.value })}
              style={input}
              placeholder="e.g. See my diagnostic result"
            />
          </Field>
          <div style={fieldGrid}>
            <Field label="Header position" tooltip="Horizontal position of optional header HTML content.">
              <select
                value={styling.headerAlign || "left"}
                onChange={(e) => updateStyling({ headerAlign: e.target.value })}
                style={input}
              >
                <option value="left">Left</option>
                <option value="center">Center</option>
                <option value="right">Right</option>
              </select>
            </Field>
            <Field label="Footer position" tooltip="Horizontal position of optional footer HTML content.">
              <select
                value={styling.footerAlign || "left"}
                onChange={(e) => updateStyling({ footerAlign: e.target.value })}
                style={input}
              >
                <option value="left">Left</option>
                <option value="center">Center</option>
                <option value="right">Right</option>
              </select>
            </Field>
          </div>
        </section>

        <section style={card}>
          <div style={sectionHeader}>
            <h2 style={cardTitle}>
              <Palette size={18} style={{ verticalAlign: -3, marginRight: 8 }} />
              Branding
            </h2>
            {selectedKit && (
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  type="button"
                  onClick={() => applyBrandKit(selectedKit)}
                  style={{ ...secondaryBtn, fontSize: 12 }}
                  title="Copy current kit values into form fields"
                >
                  <RefreshCw size={13} /> Apply brand kit
                </button>
                <button
                  type="button"
                  onClick={resetToBrandKit}
                  style={{ ...secondaryBtn, fontSize: 12 }}
                  title="Clear overrides and always use the latest kit"
                >
                  <RotateCcw size={13} /> Reset to kit
                </button>
              </div>
            )}
          </div>

          <div style={fieldGrid}>
            <Field label="Brand kit" tooltip="Link an active brand kit. Its colors, logo and font become the base layer.">
              <select
                value={form.brandKitId || ""}
                onChange={(e) => {
                  const id = e.target.value ? parseInt(e.target.value, 10) : null;
                  const kit = brandKits.find((k) => k.id === id) || null;
                  setSelectedKit(kit);
                  update({ brandKitId: id });
                  if (kit) applyBrandKit(kit);
                }}
                style={input}
              >
                <option value="">None / custom</option>
                {brandKitOptions.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              {selectedKit && (
                <p style={{ fontSize: 12, color: "var(--text-secondary)", margin: "6px 0 0" }}>
                  Linked kit values are used unless you override them below.
                </p>
              )}
            </Field>

            <UploadableUrlField
              label="Logo"
              tooltip="Logo shown on the public form. Upload an image or paste a URL."
              value={form.logoUrl || ""}
              onChange={(v) => update({ logoUrl: v })}
              onUpload={(file) => handleUpload("logoUrl", "logo", file)}
              placeholder="https://…/logo.png"
            />

            <Field label="Logo placement" tooltip="Where the logo appears relative to the form title.">
              <select
                value={form.logoPlacement}
                onChange={(e) => update({ logoPlacement: e.target.value })}
                style={input}
              >
                <option value="top-center">Top center</option>
                <option value="top-left">Top left</option>
                <option value="top-right">Top right</option>
                <option value="inline">Inline with title</option>
              </select>
            </Field>

            <ColorField
              label="Primary color"
              tooltip="Buttons, active option borders and emphasis color."
              value={form.primaryColor}
              fallback={buildTheme({ form, brandKit: selectedKit }).primaryColor}
              onChange={(v) => update({ primaryColor: v })}
            />

            <ColorField
              label="Background color"
              tooltip="Page background behind the form card."
              value={form.bgColor}
              fallback={buildTheme({ form, brandKit: selectedKit }).bgColor}
              onChange={(v) => update({ bgColor: v })}
            />

            <ColorField
              label="Text color"
              tooltip="Default color for headings and body text."
              value={form.textColor}
              fallback={buildTheme({ form, brandKit: selectedKit }).textColor}
              onChange={(v) => update({ textColor: v })}
            />

            <Field label="Font family" tooltip="Typeface used for the whole form. Pick a Google Font or system default.">
              <select
                value={form.fontFamily || ""}
                onChange={(e) => update({ fontFamily: e.target.value })}
                style={input}
              >
                {FONT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        </section>

        <section style={card}>
          <h2 style={cardTitle}>
            <Image size={18} style={{ verticalAlign: -3, marginRight: 8 }} />
            Background & layout
          </h2>
          <div style={fieldGrid}>
            <UploadableUrlField
              label="Background image"
              tooltip="Optional full-page background image. If set, it overrides the background color."
              value={styling.bgImageUrl || ""}
              onChange={(v) => updateStyling({ bgImageUrl: v })}
              onUpload={(file) => handleUpload("styling.bgImageUrl", "hero", file)}
              placeholder="https://…/bg.jpg"
            />

            <Field label="Background position" tooltip="Which part of the image stays centered as the screen resizes.">
              <select
                value={styling.bgImagePosition || "center"}
                onChange={(e) => updateStyling({ bgImagePosition: e.target.value })}
                style={input}
              >
                <option value="center">Center</option>
                <option value="top">Top</option>
                <option value="bottom">Bottom</option>
                <option value="left">Left</option>
                <option value="right">Right</option>
              </select>
            </Field>

            <BackgroundSizeField
              value={styling.bgImageSize || "cover"}
              onChange={(v) => updateStyling({ bgImageSize: v })}
            />

            <ColorField
              label="Overlay color"
              tooltip="Tint placed over the background image to improve text readability."
              value={styling.bgOverlayColor || ""}
              fallback="#000000"
              onChange={(v) => updateStyling({ bgOverlayColor: v })}
            />

            <OpacitySlider
              label="Overlay opacity"
              tooltip="How strong the overlay tint is. 0% = no tint, 100% = fully covered."
              value={styling.bgOverlayOpacity ?? 0}
              onChange={(v) => updateStyling({ bgOverlayOpacity: v })}
            />

            <NumberField
              label="Form max width (px)"
              tooltip="Maximum width of the white form card on large screens."
              value={styling.formMaxWidth}
              fallback={760}
              min={320}
              max={1200}
              onChange={(v) => updateStyling({ formMaxWidth: v })}
            />

            <ColorField
              label="Form background color"
              tooltip="Background color of the form card itself."
              value={styling.formBgColor || ""}
              fallback="#ffffff"
              onChange={(v) => updateStyling({ formBgColor: v })}
            />

            <OpacitySlider
              label="Form opacity"
              tooltip="Controls how transparent the form card is over the background image or color."
              value={styling.formBgOpacity ?? 1}
              onChange={(v) => updateStyling({ formBgOpacity: v })}
            />

            <NumberField
              label="Form border radius (px)"
              tooltip="How rounded the form card corners are."
              value={styling.formBorderRadius}
              fallback={16}
              min={0}
              max={60}
              onChange={(v) => updateStyling({ formBorderRadius: v })}
            />

            <NumberField
              label="Form padding (px)"
              tooltip="Space inside the form card border."
              value={styling.formPadding}
              fallback={28}
              min={8}
              max={80}
              onChange={(v) => updateStyling({ formPadding: v })}
            />

            <Field label="Form shadow" tooltip="Depth shadow around the form card.">
              <select
                value={styling.formShadow || "md"}
                onChange={(e) => updateStyling({ formShadow: e.target.value })}
                style={input}
              >
                <option value="none">None</option>
                <option value="sm">Small</option>
                <option value="md">Medium</option>
                <option value="lg">Large</option>
              </select>
            </Field>
          </div>
        </section>

        <section style={card}>
          <h2 style={cardTitle}>
            <Type size={18} style={{ verticalAlign: -3, marginRight: 8 }} />
            Typography & buttons
          </h2>
          <div style={fieldGrid}>
            <NumberField
              label="Title font size (px)"
              tooltip="Size of the main form title."
              value={styling.titleFontSize}
              fallback={24}
              min={16}
              max={64}
              onChange={(v) => updateStyling({ titleFontSize: v })}
            />

            <NumberField
              label="Subtitle font size (px)"
              tooltip="Size of the subtitle text."
              value={styling.subtitleFontSize}
              fallback={15}
              min={12}
              max={32}
              onChange={(v) => updateStyling({ subtitleFontSize: v })}
            />

            <Field label="Button shape" tooltip="Quick preset for the submit button corners.">
              <select
                value={styling.buttonShape || "rounded"}
                onChange={(e) => updateStyling({ buttonShape: e.target.value })}
                style={input}
              >
                <option value="rounded">Rounded</option>
                <option value="pill">Pill</option>
                <option value="square">Square</option>
              </select>
            </Field>

            <NumberField
              label="Button border radius (px)"
              tooltip="Fine control of button corner rounding. Ignored when shape is Pill."
              value={styling.buttonBorderRadius}
              fallback={8}
              min={0}
              max={60}
              onChange={(v) => updateStyling({ buttonBorderRadius: v })}
            />

            <SizeSlider
              label="Logo size (px)"
              tooltip="Controls how large the logo appears in the public form and preview."
              value={styling.logoSize ?? styling.logoMaxHeight}
              fallback={64}
              min={24}
              max={240}
              step={1}
              suffix="px"
              onChange={(v) => updateStyling({ logoSize: v, logoMaxHeight: v })}
            />
          </div>
        </section>

        <section style={card}>
          <h2 style={cardTitle}>
            <Layout size={18} style={{ verticalAlign: -3, marginRight: 8 }} />
            Question cards
          </h2>
          <div style={fieldGrid}>
            <Field label="Card style" tooltip="Visual treatment of each question block.">
              <select
                value={styling.questionCardStyle || "bordered"}
                onChange={(e) => updateStyling({ questionCardStyle: e.target.value })}
                style={input}
              >
                <option value="bordered">Bordered</option>
                <option value="filled">Filled</option>
                <option value="plain">Plain</option>
              </select>
            </Field>

            <ColorField
              label="Card border color"
              tooltip="Border color for bordered question cards."
              value={styling.questionBorderColor || ""}
              fallback={buildTheme({ form, brandKit: selectedKit }).primaryColor}
              onChange={(v) => updateStyling({ questionBorderColor: v })}
            />

            <OpacitySlider
              label="Card border opacity"
              tooltip="Controls how visible the question card border is."
              value={styling.questionBorderOpacity ?? 0.2}
              onChange={(v) => updateStyling({ questionBorderOpacity: v })}
            />

            <ColorField
              label="Card fill color"
              tooltip="Fill color used when card style is Filled."
              value={styling.questionFillColor || ""}
              fallback={buildTheme({ form, brandKit: selectedKit }).primaryColor}
              onChange={(v) => updateStyling({ questionFillColor: v })}
            />

            <OpacitySlider
              label="Card fill opacity"
              tooltip="Controls how strong the filled question-card background is."
              value={styling.questionFillOpacity ?? 0.06}
              onChange={(v) => updateStyling({ questionFillOpacity: v })}
            />

            <NumberField
              label="Card border radius (px)"
              tooltip="How rounded each question card is."
              value={styling.questionBorderRadius}
              fallback={12}
              min={0}
              max={40}
              onChange={(v) => updateStyling({ questionBorderRadius: v })}
            />
          </div>
        </section>

        <IdentityFieldsEditor
          styling={styling}
          form={form}
          onChange={updateIdentityFields}
        />

        <section style={card}>
          <Field
            label="Advanced styling JSON"
            tooltip="Raw JSON config that stores every visual setting above. You can paste a custom theme here or copy this value to replicate the form styling elsewhere. Invalid JSON is ignored."
          >
            <textarea
              value={form.stylingConfigJson || ""}
              onChange={(e) => update({ stylingConfigJson: e.target.value })}
              style={textarea}
              rows={4}
              placeholder='{"formMaxWidth": 800, "buttonShape": "pill"}'
            />
          </Field>
        </section>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, position: "sticky", bottom: 16 }}>
          <button
            type="button"
            onClick={() => setShowPreview((s) => !s)}
            style={secondaryBtn}
          >
            <Monitor size={16} /> {showPreview ? "Hide preview" : "Show preview"}
          </button>
          <button type="button" onClick={onSave} disabled={saving} style={saving ? primaryBtnDisabled : primaryBtn}>
            <Save size={16} /> {saving ? "Saving…" : "Save settings"}
          </button>
        </div>
      </div>

      {showPreview && (
        <aside
          style={{
            ...card,
            width: "100%",
            minWidth: 0,
            padding: 14,
            height: "calc(100vh - 120px)",
            maxHeight: "calc(100vh - 120px)",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          }}
        >
          <div style={sectionHeader}>
            <h2 style={cardTitle}>
              <Eye size={18} style={{ verticalAlign: -3, marginRight: 8 }} />
              Live preview
            </h2>
          </div>
          <div
            style={{
              flex: 1,
              overflow: "auto",
              borderRadius: 10,
              padding: 16,
              background: "var(--bg-color, rgba(255,255,255,0.02))",
              display: "flex",
              justifyContent: "center",
              alignItems: "flex-start",
            }}
          >
            <div
              style={{
                width: "min(100%, 820px)",
                minWidth: 0,
                maxWidth: "100%",
                boxSizing: "border-box",
                overflow: "visible",
              }}
            >
              <DiagnosticFormRenderer
                config={previewConfig}
                questions={previewQuestions}
                submitLabel={form.thankYouMessage || "See my diagnostic result"}
                mode="preview"
                preview
              />
            </div>
          </div>
        </aside>
      )}
      </div>
    </>
  );
}

function Tooltip({ children }) {
  const [show, setShow] = useState(false);
  return (
    <span
      style={{ position: "relative", display: "inline-flex", marginLeft: 6 }}
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
      onClick={() => setShow((s) => !s)}
    >
      <Info size={14} style={{ color: "var(--text-secondary)", cursor: "help", verticalAlign: -2 }} />
      {show && (
        <span
          style={{
            position: "absolute",
            bottom: "100%",
            left: "50%",
            transform: "translateX(-50%)",
            width: 240,
            padding: 8,
            background: "var(--surface-color)",
            border: "1px solid var(--border-color)",
            borderRadius: 6,
            fontSize: 12,
            fontWeight: 400,
            color: "var(--text-secondary)",
            boxShadow: "0 4px 16px rgba(0,0,0,0.12)",
            zIndex: 10,
            marginBottom: 6,
          }}
        >
          {children}
        </span>
      )}
    </span>
  );
}

function Field({ label, tooltip, children }) {
  return (
    <label style={fieldLabel}>
      <span style={{ fontSize: 13, fontWeight: 600, marginBottom: 6, display: "flex", alignItems: "center" }}>
        {label}
        {tooltip && <Tooltip>{tooltip}</Tooltip>}
      </span>
      {children}
    </label>
  );
}

function NumberField({ label, tooltip, value, fallback, min, max, onChange }) {
  const [raw, setRaw] = useState(value == null || value === "" ? "" : String(value));
  useEffect(() => {
    setRaw(value == null || value === "" ? "" : String(value));
  }, [value]);

  return (
    <Field label={label} tooltip={tooltip}>
      <input
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        value={raw}
        onChange={(e) => {
          const v = e.target.value.replace(/\D/g, "");
          setRaw(v);
          const n = v === "" ? null : parseInt(v, 10);
          if (n === null) {
            onChange(null);
          } else if (n >= min && n <= max) {
            onChange(n);
          }
        }}
        onBlur={() => setRaw(value == null || value === "" ? "" : String(value))}
        placeholder={fallback == null ? "" : String(fallback)}
        style={input}
      />
    </Field>
  );
}

function ColorField({ label, value, fallback, onChange, tooltip }) {
  const display = value || fallback;
  const swatchValue = isHex(display) ? display : isHex(fallback) ? fallback : "#000000";
  return (
    <Field label={label} tooltip={tooltip}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: value ? "36px minmax(0, 1fr) auto" : "36px minmax(0, 1fr)",
          gap: 8,
          alignItems: "center",
          minWidth: 0,
        }}
      >
        <input
          type="color"
          value={swatchValue}
          onChange={(e) => onChange(e.target.value)}
          style={{
            width: 36,
            height: 32,
            minWidth: 36,
            padding: 2,
            borderRadius: 6,
            border: "1px solid var(--border-color)",
            background: "var(--surface-color)",
            cursor: "pointer",
          }}
        />
        <input
          type="text"
          value={value || ""}
          onChange={(e) => onChange(e.target.value)}
          style={{ ...input, minWidth: 0, width: "100%" }}
          placeholder={fallback}
        />
        {value && (
          <button
            type="button"
            onClick={() => onChange("")}
            style={{
              ...secondaryBtn,
              fontSize: 11,
              padding: "4px 8px",
              whiteSpace: "nowrap",
            }}
            title="Clear override and use brand kit / default"
          >
            Reset
          </button>
        )}
      </div>
    </Field>
  );
}

function OpacitySlider({ label, tooltip, value, onChange }) {
  const pct = Math.round((value || 0) * 100);
  return (
    <Field label={label} tooltip={tooltip}>
      <div style={sliderShell}>
        <input
          className="diagnostic-opacity-slider"
          type="range"
          min={0}
          max={100}
          value={pct}
          onChange={(e) => onChange(parseInt(e.target.value, 10) / 100)}
          style={{
            "--slider-fill": "var(--primary-color, var(--accent-color, #5b6cff))",
            background: `linear-gradient(90deg, var(--slider-fill) 0%, var(--slider-fill) ${pct}%, var(--slider-track) ${pct}%, var(--slider-track) 100%)`,
          }}
          aria-label={label}
        />
        <span style={sliderValue}>
          {pct}%
        </span>
      </div>
    </Field>
  );
}

function SizeSlider({
  label,
  tooltip,
  value,
  fallback,
  min,
  max,
  step = 1,
  suffix = "",
  onChange,
}) {
  const safeValue = Number.isFinite(Number(value)) ? Number(value) : fallback;
  const pct = Math.round(((safeValue - min) / (max - min)) * 100);
  return (
    <Field label={label} tooltip={tooltip}>
      <div style={sliderShell}>
        <input
          className="diagnostic-opacity-slider"
          type="range"
          min={min}
          max={max}
          step={step}
          value={safeValue}
          onChange={(e) => onChange(parseInt(e.target.value, 10))}
          style={{
            "--slider-fill": "var(--primary-color, var(--accent-color, #5b6cff))",
            background: `linear-gradient(90deg, var(--slider-fill) 0%, var(--slider-fill) ${pct}%, var(--slider-track) ${pct}%, var(--slider-track) 100%)`,
          }}
          aria-label={label}
        />
        <span style={sliderValue}>
          {safeValue}{suffix}
        </span>
      </div>
    </Field>
  );
}

function UploadableUrlField({ label, tooltip, value, onChange, onUpload, placeholder }) {
  const fileInputRef = useRef(null);
  return (
    <Field label={label} tooltip={tooltip}>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={(e) => {
            const normalized = normalizePastedImageUrl(e.target.value);
            if (normalized !== e.target.value) onChange(normalized);
          }}
          placeholder={placeholder}
          style={{ ...input, flex: 1 }}
        />
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          style={{ display: "none" }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onUpload(file);
            if (fileInputRef.current) fileInputRef.current.value = "";
          }}
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          style={{ ...secondaryBtn, padding: "8px 10px" }}
          title="Upload image"
        >
          <Upload size={14} />
        </button>
      </div>
      {value && (
        <img
          src={normalizePastedImageUrl(value)}
          alt=""
          style={{
            marginTop: 8,
            maxHeight: 60,
            maxWidth: "100%",
            objectFit: "contain",
            borderRadius: 6,
            border: "1px solid var(--border-color)",
          }}
          onError={(e) => { e.currentTarget.style.display = "none"; }}
        />
      )}
      {isLikelyImagePageUrl(value) && (
        <p style={{ margin: "6px 0 0", color: "var(--warning-color, #c98400)", fontSize: 12 }}>
          This looks like an image page, not a direct image URL. Open the image and copy its image address, or upload the image here.
        </p>
      )}
    </Field>
  );
}

function normalizePastedImageUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (url.hostname === "unsplash.com" && url.pathname.startsWith("/photos/")) {
      const photoId = url.pathname.split("/").filter(Boolean).pop();
      if (photoId) return `https://source.unsplash.com/${photoId}/1800x1200`;
    }
  } catch {
    return raw;
  }
  return raw;
}

function isLikelyImagePageUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return false;
  try {
    const url = new URL(raw);
    return url.hostname === "unsplash.com" && !url.pathname.startsWith("/photos/");
  } catch {
    return false;
  }
}

const BG_SIZE_PRESETS = ["cover", "contain", "auto"];

function BackgroundSizeField({ value, onChange }) {
  const size = parseBackgroundSizePercent(value);

  return (
    <Field
      label="Background zoom"
      tooltip="Adjusts image zoom while keeping the page height covered. Use Cover for the safest no-empty-background fit."
    >
      <div style={sliderShell}>
        <input
          className="diagnostic-opacity-slider"
          type="range"
          min={25}
          max={250}
          step={5}
          value={size}
          onChange={(e) => {
            const next = parseInt(e.target.value, 10);
            onChange(`auto ${next}%`);
          }}
          style={{
            "--slider-fill": "var(--primary-color, var(--accent-color, #5b6cff))",
            background: `linear-gradient(90deg, var(--slider-fill) 0%, var(--slider-fill) ${Math.round(((size - 25) / 225) * 100)}%, var(--slider-track) ${Math.round(((size - 25) / 225) * 100)}%, var(--slider-track) 100%)`,
          }}
          aria-label="Background zoom"
        />
        <span style={sliderValue}>{size}%</span>
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
        <button type="button" onClick={() => onChange("cover")} style={miniBtn}>
          Cover
        </button>
        <button type="button" onClick={() => onChange("contain")} style={miniBtn}>
          Contain
        </button>
        <button type="button" onClick={() => onChange("auto 100%")} style={miniBtn}>
          100%
        </button>
      </div>
    </Field>
  );
}

function parseBackgroundSizePercent(value) {
  if (typeof value !== "string" || BG_SIZE_PRESETS.includes(value)) return 100;
  const match = value.trim().match(/(?:^|\s)(\d+(?:\.\d+)?)%/);
  if (!match) return 100;
  const n = parseInt(match[1], 10);
  if (!Number.isFinite(n)) return 100;
  return Math.min(250, Math.max(25, n));
}

function IdentityFieldsEditor({ styling, form, onChange }) {
  const fields = normalizeIdentityEditorFields(
    Array.isArray(styling.identityFields) && styling.identityFields.length > 0
      ? styling.identityFields
      : DEFAULT_IDENTITY_FIELDS,
    form,
  );

  const updateFields = (next) => onChange(next);

  const addField = () => {
    updateFields([
      ...fields,
      { id: `field_${Date.now()}`, label: "New field", type: "text", required: false, enabled: true },
    ]);
  };

  const removeField = (id) => updateFields(fields.filter((f) => f.id !== id));

  const editField = (id, patch) => {
    updateFields(fields.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  };

  const moveField = (id, dir) => {
    const idx = fields.findIndex((f) => f.id === id);
    if (idx < 0) return;
    const nextIdx = idx + dir;
    if (nextIdx < 0 || nextIdx >= fields.length) return;
    const next = [...fields];
    [next[idx], next[nextIdx]] = [next[nextIdx], next[idx]];
    updateFields(next);
  };

  return (
    <section style={card}>
      <div style={{ ...sectionHeader, marginBottom: 12 }}>
        <h2 style={cardTitle}>Identity fields</h2>
        <button type="button" onClick={addField} style={{ ...secondaryBtn, fontSize: 12 }}>
          <Plus size={13} /> Add field
        </button>
      </div>
      <p style={{ color: "var(--text-secondary)", fontSize: 13, marginTop: -8, marginBottom: 14 }}>
        Public submitters leave contact details so the submission becomes a lead. Use the arrows to reorder fields.
      </p>
      <div style={{ display: "grid", gap: 10 }}>
        {fields.map((f, idx) => (
          <div
            key={f.id}
            style={{
              display: "grid",
              gridTemplateColumns: "64px 1fr 120px 80px 80px 36px",
              gap: 8,
              alignItems: "center",
              padding: 10,
              border: "1px solid var(--border-color)",
              borderRadius: 8,
              background: "rgba(255,255,255,0.03)",
            }}
          >
            <div style={{ display: "flex", gap: 4 }}>
              <button
                type="button"
                onClick={() => moveField(f.id, -1)}
                disabled={idx === 0}
                style={{
                  ...secondaryBtn,
                  padding: "4px 6px",
                  opacity: idx === 0 ? 0.4 : 1,
                  cursor: idx === 0 ? "not-allowed" : "pointer",
                }}
                title="Move up"
              >
                <ArrowUp size={14} />
              </button>
              <button
                type="button"
                onClick={() => moveField(f.id, 1)}
                disabled={idx === fields.length - 1}
                style={{
                  ...secondaryBtn,
                  padding: "4px 6px",
                  opacity: idx === fields.length - 1 ? 0.4 : 1,
                  cursor: idx === fields.length - 1 ? "not-allowed" : "pointer",
                }}
                title="Move down"
              >
                <ArrowDown size={14} />
              </button>
            </div>
            <input
              type="text"
              value={f.label}
              onChange={(e) => editField(f.id, { label: e.target.value })}
              style={input}
              placeholder="Field label"
            />
            <select
              value={f.type || "text"}
              onChange={(e) => editField(f.id, { type: e.target.value })}
              style={input}
            >
              <option value="text">Text</option>
              <option value="email">Email</option>
              <option value="tel">Phone</option>
            </select>
            <label style={{ ...inlineLabel, fontSize: 12 }}>
              <input
                type="checkbox"
                checked={f.required}
                onChange={(e) => editField(f.id, { required: e.target.checked })}
              />
              Required
            </label>
            <label style={{ ...inlineLabel, fontSize: 12 }}>
              <input
                type="checkbox"
                checked={f.enabled !== false}
                onChange={(e) => editField(f.id, { enabled: e.target.checked })}
              />
              Show
            </label>
            <button
              type="button"
              onClick={() => removeField(f.id)}
              style={{ ...secondaryBtn, padding: "6px 8px", color: "var(--danger-color)" }}
              title="Remove field"
            >
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

function normalizeIdentityEditorFields(fields, form) {
  return fields.map((field) => {
    if (field.id === "name") {
      return {
        ...field,
        enabled: form.includeName !== false,
        required: form.nameRequired !== false,
      };
    }
    if (field.id === "email") {
      return {
        ...field,
        enabled: form.includeEmail !== false,
        required: form.emailRequired !== false,
      };
    }
    if (field.id === "phone") {
      return {
        ...field,
        enabled: form.includePhone !== false,
        required: form.phoneRequired === true,
      };
    }
    return field;
  });
}

function buildDefaultForm() {
  return {
    title: "",
    subtitle: "",
    headerHtml: "",
    footerHtml: "",
    thankYouMessage: "See my diagnostic result",
    brandKitId: null,
    logoUrl: "",
    logoPlacement: "top-center",
    primaryColor: "",
    bgColor: "",
    textColor: "",
    fontFamily: "",
    stylingConfigJson: "",
    includeName: true,
    includeEmail: true,
    includePhone: true,
    nameRequired: true,
    emailRequired: true,
    phoneRequired: false,
    isPublished: false,
  };
}

function normalizeForm(raw) {
  const d = buildDefaultForm();
  const styling = parseStyling(raw.stylingConfigJson);
  return {
    ...d,
    ...raw,
    stylingConfigJson: JSON.stringify(styling),
    brandKitId: raw.brandKitId || null,
    logoPlacement: raw.logoPlacement || "top-center",
    includeName: raw.includeName !== false,
    includeEmail: raw.includeEmail !== false,
    includePhone: raw.includePhone !== false,
    nameRequired: raw.nameRequired !== false,
    emailRequired: raw.emailRequired !== false,
    phoneRequired: raw.phoneRequired === true,
    thankYouMessage: raw.thankYouMessage || d.thankYouMessage,
  };
}

function mergeKitIntoForm(form, kit) {
  if (!kit) return form;
  const styling = parseStyling(form.stylingConfigJson);
  return {
    ...form,
    brandKitId: kit.id,
    logoUrl: kit.logoUrl || kit.logoDarkUrl || kit.wordmarkUrl || "",
    primaryColor: kit.primaryColor || kit.accentColor || "",
    bgColor: kit.bgColor || "",
    textColor: kit.textColor || "",
    fontFamily: kit.fontFamily || kit.bodyFontFamily || kit.headingFontFamily || "",
    stylingConfigJson: JSON.stringify({
      ...styling,
      bgImageUrl: kit.heroUrl || kit.headerImageUrl || "",
    }),
  };
}

function isHex(v) {
  return typeof v === "string" && /^#([0-9A-Fa-f]{3}){1,2}$/.test(v);
}

function buildPublicUrl(subBrand, tenant) {
  const host = window.location.origin;
  let tenantSlug = tenant?.slug || "";
  try {
    const storedTenant = JSON.parse(localStorage.getItem("tenant") || "null");
    if (!tenantSlug && storedTenant?.slug) tenantSlug = storedTenant.slug;
  } catch {
    /* ignore */
  }
  if (!tenantSlug) tenantSlug = "travelstall";
  return `${host}/diagnostic-form/${encodeURIComponent(tenantSlug)}/${encodeURIComponent(subBrand)}`;
}

const SAMPLE_QUESTIONS = [
  {
    id: "q1",
    text: "What type of trip are you planning?",
    type: "single-choice",
    options: [
      { value: "educational", label: "Educational / heritage tour" },
      { value: "adventure", label: "Adventure / outdoor camp" },
      { value: "international", label: "International exposure trip" },
    ],
  },
  {
    id: "q2",
    text: "Approximate group size (students)?",
    type: "single-choice",
    options: [
      { value: "under20", label: "Under 20" },
      { value: "20-50", label: "20-50" },
      { value: "50+", label: "50+" },
    ],
  },
];

// ─── Styles ─────────────────────────────────────────────────────────────────
function parsePreviewQuestions(raw) {
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    const questions = Array.isArray(parsed?.questions) ? parsed.questions : [];
    if (questions.length === 0) return SAMPLE_QUESTIONS;
    return questions.map((q) => ({
      id: q.id,
      text: q.text,
      type: q.type,
      options: Array.isArray(q.options)
        ? q.options.map((o) => ({ value: o.value, label: o.label }))
        : [],
      max: q.max,
    }));
  } catch {
    return SAMPLE_QUESTIONS;
  }
}

const card = {
  background: "var(--surface-color)",
  border: "1px solid var(--border-color)",
  borderRadius: 10,
  padding: "18px 20px",
};

const cardTitle = {
  fontSize: 16,
  fontWeight: 600,
  margin: "0 0 14px",
  color: "var(--text-primary)",
};

const sectionHeader = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  flexWrap: "wrap",
  gap: 10,
};

const fieldGrid = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 240px), 1fr))",
  gap: 14,
};

const fieldLabel = {
  display: "flex",
  flexDirection: "column",
};

const input = {
  padding: "8px 10px",
  borderRadius: 6,
  border: "1px solid var(--border-color)",
  background: "var(--surface-color)",
  color: "var(--text-primary)",
  fontSize: 14,
  fontFamily: "inherit",
};

const textarea = {
  ...input,
  minHeight: 60,
  resize: "vertical",
};

const primaryBtn = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "8px 14px",
  borderRadius: 8,
  border: "none",
  background: "var(--primary-color, var(--accent-color))",
  color: "#fff",
  fontWeight: 600,
  fontSize: 14,
  cursor: "pointer",
};

const primaryBtnDisabled = {
  ...primaryBtn,
  opacity: 0.55,
  cursor: "not-allowed",
};

const secondaryBtn = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "8px 12px",
  borderRadius: 8,
  border: "1px solid var(--border-color)",
  background: "var(--surface-color)",
  color: "var(--primary-color, var(--accent-color))",
  fontWeight: 600,
  fontSize: 13,
  textDecoration: "none",
  cursor: "pointer",
};

const miniBtn = {
  ...secondaryBtn,
  padding: "5px 8px",
  borderRadius: 6,
  fontSize: 12,
};

const urlCode = {
  flex: 1,
  minWidth: 240,
  padding: "8px 10px",
  borderRadius: 6,
  background: "var(--bg-color, rgba(255,255,255,0.04))",
  border: "1px solid var(--border-color)",
  fontSize: 13,
  wordBreak: "break-all",
};

const sliderShell = {
  display: "grid",
  gridTemplateColumns: "minmax(150px, 1fr) 56px",
  gap: 12,
  alignItems: "center",
  minHeight: 40,
  padding: "6px 8px 6px 10px",
  borderRadius: 8,
  background: "color-mix(in srgb, var(--surface-color) 92%, var(--text-primary) 8%)",
  border: "1px solid var(--border-color)",
};

const sliderValue = {
  minWidth: 52,
  textAlign: "center",
  fontSize: 13,
  fontWeight: 700,
  lineHeight: "24px",
  padding: "3px 8px",
  borderRadius: 7,
  background: "color-mix(in srgb, var(--surface-color) 82%, var(--primary-color, var(--accent-color)) 18%)",
  border: "1px solid var(--border-color)",
  color: "var(--text-primary)",
  fontVariantNumeric: "tabular-nums",
};

const diagnosticSliderCss = `
  .diagnostic-opacity-slider {
    --slider-track: color-mix(in srgb, var(--border-color) 72%, transparent);
    width: 100%;
    height: 12px;
    min-width: 0;
    appearance: none;
    -webkit-appearance: none;
    border-radius: 999px;
    border: 1px solid var(--border-color);
    cursor: pointer;
    outline: none;
    transition: box-shadow 0.15s ease, filter 0.15s ease;
  }

  .diagnostic-opacity-slider:hover {
    filter: brightness(1.03);
  }

  .diagnostic-opacity-slider:focus-visible {
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--primary-color, var(--accent-color)) 28%, transparent);
  }

  .diagnostic-opacity-slider::-webkit-slider-thumb {
    appearance: none;
    -webkit-appearance: none;
    width: 24px;
    height: 24px;
    border-radius: 999px;
    background: var(--surface-color);
    border: 3px solid var(--primary-color, var(--accent-color));
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.22), 0 0 0 1px var(--border-color);
  }

  .diagnostic-opacity-slider::-moz-range-thumb {
    width: 20px;
    height: 20px;
    border-radius: 999px;
    background: var(--surface-color);
    border: 3px solid var(--primary-color, var(--accent-color));
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.22), 0 0 0 1px var(--border-color);
  }

  .diagnostic-opacity-slider::-moz-range-track {
    height: 12px;
    border-radius: 999px;
    background: transparent;
  }
`;

const badge = {
  padding: "4px 10px",
  borderRadius: 999,
  fontSize: 12,
  fontWeight: 700,
  textTransform: "uppercase",
};

const inlineLabel = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  fontSize: 13,
  cursor: "pointer",
};
