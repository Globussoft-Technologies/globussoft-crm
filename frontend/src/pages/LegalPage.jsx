import { useEffect, useState } from "react";

const API_MAP = {
  "terms-and-conditions": "/api/legal/terms-and-conditions",
  "privacy-policy": "/api/legal/privacy-policy",
  "deleted-account-policy": "/api/legal/deleted-account-policy",
};

const TITLES = {
  "terms-and-conditions": "Terms and Conditions",
  "privacy-policy": "Privacy Policy",
  "deleted-account-policy": "Account & Data Deletion Policy",
};

export default function LegalPage({ page }) {
  const [content, setContent] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const url = API_MAP[page];
    if (!url) {
      setLoading(false);
      setError("Page not found");
      return;
    }
    fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error("Failed to load");
        return r.json();
      })
      .then((data) => setContent(data))
      .catch(() => setError("Failed to load document. Please try again later."))
      .finally(() => setLoading(false));
  }, [page]);

  if (loading) {
    return (
      <div style={{ maxWidth: 800, margin: "0 auto", padding: "48px 24px", color: "var(--text-secondary)" }}>
        Loading…
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ maxWidth: 800, margin: "0 auto", padding: "48px 24px" }}>
        <div style={{ background: "var(--danger-color)", color: "white", padding: "0.75rem", borderRadius: 8, fontSize: "0.875rem" }}>
          {error}
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        maxWidth: 800,
        margin: "0 auto",
        padding: "48px 24px 80px",
        lineHeight: 1.7,
        color: "var(--text-primary)",
      }}
    >
      <h1 style={{ fontSize: "2rem", fontWeight: 800, margin: "0 0 8px", letterSpacing: "-0.02em", lineHeight: 1.2 }}>
        {content?.title || TITLES[page]}
      </h1>
      <div
        className="legal-content"
        dangerouslySetInnerHTML={{ __html: content?.html || "" }}
        style={{
          marginTop: 32,
        }}
      />
      <style>{`
        .legal-content h2 { font-size: 1.35rem; font-weight: 700; margin: 40px 0 12px; padding-bottom: 8px; border-bottom: 1px solid var(--border-color); }
        .legal-content h3 { font-size: 1.1rem; font-weight: 600; margin: 28px 0 8px; }
        .legal-content h4 { font-size: 1rem; font-weight: 600; margin: 20px 0 6px; }
        .legal-content p { margin: 0 0 16px; color: var(--text-secondary); }
        .legal-content a { color: var(--accent-color); text-decoration: none; }
        .legal-content a:hover { text-decoration: underline; }
        .legal-content ul, .legal-content ol { margin: 0 0 16px; padding-left: 24px; }
        .legal-content li { margin-bottom: 8px; }
        .legal-content blockquote { margin: 0 0 16px; padding: 12px 16px; border-left: 4px solid var(--accent-color); background: rgba(255,255,255,0.03); border-radius: 0 8px 8px 0; }
        .legal-content blockquote p { margin: 0; color: var(--text-primary); }
        .legal-content code { font-family: 'SF Mono', Monaco, monospace; font-size: 0.85em; background: rgba(255,255,255,0.06); padding: 2px 6px; border-radius: 4px; color: var(--accent-color); }
        .legal-content pre { background: rgba(255,255,255,0.06); padding: 16px; border-radius: 8px; overflow-x: auto; font-size: 0.85rem; line-height: 1.5; border: 1px solid var(--border-color); margin: 0 0 16px; }
        .legal-content pre code { background: transparent; padding: 0; color: var(--text-primary); }
        .legal-content table { width: 100%; border-collapse: collapse; margin: 0 0 16px; font-size: 0.9rem; }
        .legal-content th, .legal-content td { padding: 10px 12px; border: 1px solid var(--border-color); text-align: left; }
        .legal-content th { background: rgba(255,255,255,0.03); font-weight: 600; }
        .legal-content tr:nth-child(even) { background: rgba(255,255,255,0.02); }
        .legal-content hr { border: none; border-top: 1px solid var(--border-color); margin: 32px 0; }
      `}</style>
    </div>
  );
}
