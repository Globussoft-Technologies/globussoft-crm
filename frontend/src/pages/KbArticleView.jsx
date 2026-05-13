import React, { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { BookOpen, ArrowLeft, Eye, Calendar, FolderTree } from "lucide-react";
import { formatDate } from "../utils/date";

// Lightweight markdown renderer covering the subset we use in KB articles
// (## / ### headers, - lists, **bold**, paragraphs). Avoids pulling in a
// full markdown dep for one page.
function renderInline(text, keyPrefix = "") {
  const parts = String(text).split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={`${keyPrefix}-b-${i}`}>{part.slice(2, -2)}</strong>;
    }
    return <React.Fragment key={`${keyPrefix}-t-${i}`}>{part}</React.Fragment>;
  });
}

function renderMarkdown(content) {
  if (!content) return null;
  const lines = String(content).split(/\r?\n/);
  const blocks = [];
  let listBuffer = [];
  let paraBuffer = [];

  const flushList = () => {
    if (listBuffer.length) {
      blocks.push(
        <ul
          key={`ul-${blocks.length}`}
          style={{
            margin: "0.5rem 0 1.25rem",
            paddingLeft: "1.5rem",
            color: "var(--text-primary)",
            lineHeight: 1.7,
          }}
        >
          {listBuffer.map((item, i) => (
            <li key={i} style={{ marginBottom: "0.35rem" }}>
              {renderInline(item, `li-${blocks.length}-${i}`)}
            </li>
          ))}
        </ul>,
      );
      listBuffer = [];
    }
  };

  const flushPara = () => {
    if (paraBuffer.length) {
      const text = paraBuffer.join(" ");
      blocks.push(
        <p
          key={`p-${blocks.length}`}
          style={{
            margin: "0 0 1rem",
            lineHeight: 1.7,
            color: "var(--text-primary)",
          }}
        >
          {renderInline(text, `p-${blocks.length}`)}
        </p>,
      );
      paraBuffer = [];
    }
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      flushList();
      flushPara();
      continue;
    }
    if (line.startsWith("### ")) {
      flushList();
      flushPara();
      blocks.push(
        <h3
          key={`h3-${blocks.length}`}
          style={{
            fontSize: "1.15rem",
            fontWeight: 600,
            margin: "1.5rem 0 0.6rem",
            color: "var(--text-primary)",
          }}
        >
          {renderInline(line.slice(4), `h3-${blocks.length}`)}
        </h3>,
      );
    } else if (line.startsWith("## ")) {
      flushList();
      flushPara();
      blocks.push(
        <h2
          key={`h2-${blocks.length}`}
          style={{
            fontSize: "1.4rem",
            fontWeight: 700,
            margin: "1.75rem 0 0.75rem",
            color: "var(--text-primary)",
            borderBottom: "1px solid var(--border-color)",
            paddingBottom: "0.4rem",
          }}
        >
          {renderInline(line.slice(3), `h2-${blocks.length}`)}
        </h2>,
      );
    } else if (line.startsWith("# ")) {
      flushList();
      flushPara();
      blocks.push(
        <h1
          key={`h1-${blocks.length}`}
          style={{
            fontSize: "1.7rem",
            fontWeight: 700,
            margin: "1.75rem 0 0.75rem",
          }}
        >
          {renderInline(line.slice(2), `h1-${blocks.length}`)}
        </h1>,
      );
    } else if (line.startsWith("- ") || line.startsWith("* ")) {
      flushPara();
      listBuffer.push(line.slice(2));
    } else {
      flushList();
      paraBuffer.push(line);
    }
  }
  flushList();
  flushPara();
  return blocks;
}

export default function KbArticleView() {
  const { tenantSlug, slug } = useParams();
  const [article, setArticle] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    fetch(
      `/api/knowledge-base/public/${encodeURIComponent(tenantSlug)}/article/${encodeURIComponent(slug)}`,
    )
      .then(async (r) => {
        if (cancelled) return;
        if (r.status === 404) {
          setError("Article not found or unpublished.");
          return;
        }
        if (!r.ok) {
          setError("Could not load this article.");
          return;
        }
        const data = await r.json();
        if (!cancelled) setArticle(data);
      })
      .catch(() => {
        if (!cancelled) setError("Could not load this article.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tenantSlug, slug]);

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "var(--bg-color)",
        color: "var(--text-primary)",
        padding: "2.5rem 1rem",
      }}
    >
      <div style={{ maxWidth: "780px", margin: "0 auto" }}>
        <Link
          to="/portal"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "0.4rem",
            color: "var(--text-secondary)",
            textDecoration: "none",
            fontSize: "0.875rem",
            marginBottom: "1.5rem",
          }}
        >
          <ArrowLeft size={14} /> Back to help center
        </Link>

        {loading && (
          <div
            style={{
              padding: "3rem 1rem",
              textAlign: "center",
              color: "var(--text-secondary)",
            }}
          >
            Loading article…
          </div>
        )}

        {!loading && error && (
          <div
            style={{
              padding: "3rem 1.5rem",
              textAlign: "center",
              background: "var(--subtle-bg-2)",
              border: "1px dashed var(--border-color)",
              borderRadius: "12px",
            }}
          >
            <BookOpen
              size={48}
              style={{
                opacity: 0.25,
                margin: "0 auto 1rem",
                color: "var(--accent-color)",
              }}
            />
            <h2 style={{ marginBottom: "0.4rem" }}>Article unavailable</h2>
            <p style={{ color: "var(--text-secondary)", margin: 0 }}>{error}</p>
          </div>
        )}

        {!loading && !error && article && (
          <article
            className="card"
            style={{
              padding: "2.25rem 2rem",
              borderRadius: "12px",
            }}
          >
            <header style={{ marginBottom: "1.5rem" }}>
              <div
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "0.4rem",
                  padding: "0.25rem 0.7rem",
                  borderRadius: "999px",
                  background: "rgba(16,185,129,0.1)",
                  color: "#10b981",
                  border: "1px solid rgba(16,185,129,0.25)",
                  fontSize: "0.7rem",
                  fontWeight: 600,
                  marginBottom: "1rem",
                }}
              >
                <FolderTree size={12} /> Knowledge Base
              </div>
              <h1
                style={{
                  fontSize: "2rem",
                  fontWeight: 700,
                  lineHeight: 1.25,
                  margin: 0,
                }}
              >
                {article.title}
              </h1>
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: "1rem",
                  marginTop: "0.9rem",
                  color: "var(--text-secondary)",
                  fontSize: "0.8rem",
                }}
              >
                {article.updatedAt && (
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "0.35rem",
                    }}
                  >
                    <Calendar size={13} /> Updated {formatDate(article.updatedAt)}
                  </span>
                )}
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "0.35rem",
                  }}
                >
                  <Eye size={13} /> {(article.views || 0).toLocaleString()} views
                </span>
              </div>
            </header>

            <div style={{ fontSize: "0.95rem" }}>
              {renderMarkdown(article.content)}
              {!String(article.content || "").trim() && (
                <p
                  style={{
                    color: "var(--text-secondary)",
                    fontStyle: "italic",
                  }}
                >
                  This article has no content yet.
                </p>
              )}
            </div>
          </article>
        )}
      </div>
    </div>
  );
}
