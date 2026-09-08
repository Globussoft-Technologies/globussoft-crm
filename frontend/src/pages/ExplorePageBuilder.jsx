import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, Eye, GripVertical, Save, Upload } from "lucide-react";
import { fetchApi, getAuthToken } from "../utils/api";
import "./ExplorePageBuilder.css";

const defaultConfig = {
  brandName: "The Modern School",
  heroEyebrow: "EXPLORE. DREAM. DISCOVER.",
  heroTitle: "Journeys that",
  heroAccent: "inspire growth.",
  heroDescription: "Discover transformative travel experiences, take the diagnostic, and browse curated catalogues crafted for schools and explorers.",
  cataloguesEyebrow: "TRAVEL INSPIRATION",
  cataloguesTitle: "Explore our TMC catalogues",
  cataloguesDescription: "Select the journeys you would like to discuss with our travel team.",
  journeysEyebrow: "PUBLISHED TRIPS",
  journeysTitle: "Explore current journeys",
  heroImage: "",
  navigation: ["Explore", "Current Journeys", "Catalogues"],
  sections: ["hero", "catalogues", "journeys"],
  palette: { background: "#f7f9fc", accent: "#6d4aff", text: "#0f172a", muted: "#64748b", panel: "#ffffff", border: "#dbe3f0", button: "#6d4aff", buttonText: "#ffffff" },
};

const paletteFields = [
  ["accent", "Accent color", "Links, highlights, and primary actions"],
  ["text", "Heading color", "Main headings and card titles"],
  ["muted", "Supporting text", "Descriptions and secondary labels"],
  ["background", "Page background", "Main Explore page background"],
  ["panel", "Card background", "Cards, panels, and input surfaces"],
  ["border", "Border color", "Card, input, and divider borders"],
  ["button", "Button color", "Primary actions and PDF buttons"],
  ["buttonText", "Button text", "Text shown inside colored buttons"],
];
const basePalette = { background: "#f7f9fc", accent: "#6d4aff", text: "#0f172a", muted: "#64748b", panel: "#ffffff", border: "#dbe3f0", button: "#6d4aff", buttonText: "#ffffff" };

function mergeConfig(content) {
  return { ...defaultConfig, ...(content?.exploreConfig || {}), palette: { ...defaultConfig.palette, ...(content?.exploreConfig?.palette || {}) } };
}

export default function ExplorePageBuilder() {
  const { id } = useParams();
  const [page, setPage] = useState(null);
  const [config, setConfig] = useState(defaultConfig);
  const [saved, setSaved] = useState(false);
  const [preview, setPreview] = useState(false);
  const [dragged, setDragged] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [paletteReset, setPaletteReset] = useState(false);

  useEffect(() => {
    fetchApi(`/api/landing-pages/${id}`).then((data) => {
      setPage(data);
      const content = typeof data.content === "string" ? JSON.parse(data.content) : data.content;
      setConfig(mergeConfig(content));
    });
  }, [id]);

  const update = (key, value) => setConfig((current) => ({ ...current, [key]: value }));
  const updatePalette = (key, value) => setConfig((current) => ({ ...current, palette: { ...current.palette, [key]: value } }));
  const resetPalette = (checked) => {
    setPaletteReset(checked);
    if (checked) setConfig((current) => ({ ...current, palette: { ...basePalette } }));
  };
  const uploadHeroImage = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setUploadError("");
    try {
      const formData = new FormData();
      formData.append("image", file);
      const response = await fetch("/api/landing-pages/upload", {
        method: "POST",
        headers: getAuthToken() ? { Authorization: `Bearer ${getAuthToken()}` } : {},
        body: formData,
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.url) throw new Error(body.error || "Image upload failed.");
      update("heroImage", body.url);
    } catch (error) {
      setUploadError(error.message || "Image upload failed.");
    } finally {
      setUploading(false);
      event.target.value = "";
    }
  };
  const reorder = (target) => {
    if (dragged == null || dragged === target) return;
    const next = [...config.sections];
    const [item] = next.splice(dragged, 1);
    next.splice(target, 0, item);
    update("sections", next);
    setDragged(null);
  };
  const save = async () => {
    const content = typeof page.content === "string" ? JSON.parse(page.content) : (page.content || {});
    await fetchApi(`/api/landing-pages/${id}`, { method: "PUT", body: JSON.stringify({ content: { ...content, exploreConfig: config } }) });
    setSaved(true);
    setTimeout(() => setSaved(false), 2200);
  };

  if (!page) return <div className="explore-builder-loading">Loading Explore editor...</div>;
  if (preview) return <div className="explore-builder-preview"><button type="button" onClick={() => setPreview(false)}>Back to editor</button><iframe title="Explore preview" src={`/explore?preview=${encodeURIComponent(JSON.stringify(config))}`} /></div>;

  return (
    <div className="explore-builder" style={{ "--builder-accent": config.palette.accent }}>
      <header className="explore-builder-header">
        <Link to="/landing-pages"><ArrowLeft size={17} /> Landing pages</Link>
        <div><strong>Explore page editor</strong><span>Dedicated editor for The Modern School discovery page</span></div>
        <div className="explore-builder-actions"><button type="button" onClick={() => setPreview(true)}><Eye size={15} /> Preview</button><button type="button" className="primary" onClick={save}><Save size={15} /> {saved ? "Saved" : "Save"}</button></div>
      </header>
      <main className="explore-builder-main">
        <section className="explore-editor-card"><h2>Brand and hero</h2><div className="explore-editor-grid">
          <label>Brand name<input value={config.brandName} onChange={(e) => update("brandName", e.target.value)} /></label>
          <label>Hero eyebrow<input value={config.heroEyebrow} onChange={(e) => update("heroEyebrow", e.target.value)} /></label>
          <label>Hero title<input value={config.heroTitle} onChange={(e) => update("heroTitle", e.target.value)} /></label>
          <label>Hero accent<input value={config.heroAccent} onChange={(e) => update("heroAccent", e.target.value)} /></label>
          <label className="wide">Hero description<textarea value={config.heroDescription} onChange={(e) => update("heroDescription", e.target.value)} /></label>
          <label className="wide">Hero image URL<input value={config.heroImage} onChange={(e) => update("heroImage", e.target.value)} placeholder="Paste an image URL" /><span className="editor-help"><Upload size={13} /> <input type="file" accept="image/*" onChange={uploadHeroImage} disabled={uploading} /> {uploading ? "Uploading..." : uploadError || "Upload a replacement hero image"}</span></label>
        </div></section>
        <section className="explore-editor-card"><h2>Section content</h2><div className="explore-editor-grid">
          <label>Catalogues eyebrow<input value={config.cataloguesEyebrow} onChange={(e) => update("cataloguesEyebrow", e.target.value)} /></label>
          <label>Catalogues heading<input value={config.cataloguesTitle} onChange={(e) => update("cataloguesTitle", e.target.value)} /></label>
          <label className="wide">Catalogues description<textarea value={config.cataloguesDescription} onChange={(e) => update("cataloguesDescription", e.target.value)} /></label>
          <label>Journeys eyebrow<input value={config.journeysEyebrow} onChange={(e) => update("journeysEyebrow", e.target.value)} /></label>
          <label>Journeys heading<input value={config.journeysTitle} onChange={(e) => update("journeysTitle", e.target.value)} /></label>
        </div></section>
        <section className="explore-editor-card"><h2>Theme colors</h2><p>Choose colors by role. These changes apply to the public Explore page after you save.</p><div className="explore-editor-grid palette-grid">
          {paletteFields.map(([key, label, description]) => <label key={key}><span>{label}<small>{description}</small></span><div className="palette-control"><input aria-label={`${label} picker`} type="color" value={config.palette[key]} onChange={(e) => updatePalette(key, e.target.value)} /><input aria-label={`${label} hex value`} value={config.palette[key]} onChange={(e) => updatePalette(key, e.target.value)} /></div></label>)}
        </div><label className="palette-reset"><input type="checkbox" checked={paletteReset} onChange={(e) => resetPalette(e.target.checked)} /> Reset to the base Explore palette <small>Restores the original colors in this editor. Click Save to apply the reset to /explore.</small></label></section>
        <section className="explore-editor-card"><h2>Section order</h2><p>Drag sections into the order they should appear on Explore. Save to publish this order to <code>/explore</code>.</p><div className="explore-section-order">
          {config.sections.map((section, index) => <div key={section} draggable onDragStart={() => setDragged(index)} onDragOver={(e) => e.preventDefault()} onDrop={() => reorder(index)}><GripVertical size={16} /> {section === "hero" ? "Hero" : section === "catalogues" ? "Catalogues" : "Current Journeys"}</div>)}
        </div></section>
      </main>
    </div>
  );
}
