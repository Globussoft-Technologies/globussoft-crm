function renderComponent(component, slug) {
  const { type, props = {} } = component;

  switch (type) {
    case "heading": {
      const level = props.level || "h1";
      const align = props.align || "left";
      const color = props.color || "#1a1a1a";
      return `<${level} style="color:${color};text-align:${align};margin:0 0 16px;">${escapeHtml(props.text || "")}</${level}>`;
    }

    case "text": {
      const align = props.align || "left";
      const color = props.color || "#444";
      const fontSize = props.fontSize || "16px";
      return `<p style="color:${color};text-align:${align};font-size:${fontSize};line-height:1.6;margin:0 0 16px;">${escapeHtml(props.text || "")}</p>`;
    }

    case "image": {
      const width = props.width || "100%";
      const maxWidth = props.maxWidth || "100%";
      const alt = escapeHtml(props.alt || "");
      return `<div style="text-align:center;margin:0 0 16px;"><img src="${escapeHtml(props.src || "")}" alt="${alt}" style="width:${width};max-width:${maxWidth};height:auto;border-radius:8px;" /></div>`;
    }

    case "button": {
      const color = props.color || "#ffffff";
      const bgColor = props.bgColor || "#2563eb";
      const align = props.align || "center";
      const size = props.size || "medium";
      const padding = size === "large" ? "16px 40px" : size === "small" ? "8px 20px" : "12px 32px";
      const fontSize = size === "large" ? "18px" : size === "small" ? "13px" : "15px";
      return `<div style="text-align:${align};margin:0 0 16px;"><a href="${escapeHtml(props.url || "#")}" style="display:inline-block;padding:${padding};background:${bgColor};color:${color};text-decoration:none;border-radius:6px;font-size:${fontSize};font-weight:600;cursor:pointer;">${escapeHtml(props.text || "Click")}</a></div>`;
    }

    case "form": {
      const fields = props.fields || [];
      const submitText = escapeHtml(props.submitText || "Submit");
      const thankYouMessage = escapeHtml(props.thankYouMessage || "Thank you for your submission!");
      const formId = "form_" + Math.random().toString(36).substr(2, 8);
      let fieldsHtml = fields
        .map((f) => {
          const req = f.required ? "required" : "";
          const inputType = f.type || "text";
          return `<div style="margin-bottom:12px;">
            <label style="display:block;margin-bottom:4px;font-weight:500;color:#333;font-size:14px;">${escapeHtml(f.label || f.name)}</label>
            <input type="${inputType}" name="${escapeHtml(f.name)}" ${req} style="width:100%;padding:10px 12px;border:1px solid #d1d5db;border-radius:6px;font-size:15px;box-sizing:border-box;" />
          </div>`;
        })
        .join("\n");

      return `<form id="${formId}" style="max-width:480px;margin:0 auto 16px;padding:24px;background:#f9fafb;border-radius:10px;border:1px solid #e5e7eb;" onsubmit="return false;">
        ${fieldsHtml}
        <button type="submit" style="width:100%;padding:12px;background:#2563eb;color:#fff;border:none;border-radius:6px;font-size:15px;font-weight:600;cursor:pointer;">${submitText}</button>
        <div id="${formId}_thanks" style="display:none;text-align:center;padding:16px;color:#16a34a;font-weight:500;">${thankYouMessage}</div>
      </form>
      <script>
      (function(){
        var form = document.getElementById("${formId}");
        form.addEventListener("submit", function(e){
          e.preventDefault();
          var data = {};
          var inputs = form.querySelectorAll("input");
          inputs.forEach(function(inp){ data[inp.name] = inp.value; });
          fetch("/api/pages/${escapeHtml(slug)}/submit", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify(data)
          }).then(function(r){ return r.json(); }).then(function(){
            form.querySelector("button[type=submit]").style.display = "none";
            var fields = form.querySelectorAll("div > label, div > input");
            fields.forEach(function(el){ el.parentElement.style.display = "none"; });
            document.getElementById("${formId}_thanks").style.display = "block";
          }).catch(function(){ alert("Something went wrong. Please try again."); });
        });
      })();
      </script>`;
    }

    case "divider": {
      const color = props.color || "#e5e7eb";
      const margin = props.margin || "24px";
      return `<hr style="border:none;border-top:1px solid ${color};margin:${margin} 0;" />`;
    }

    case "spacer": {
      const height = props.height || "32px";
      return `<div style="height:${height};"></div>`;
    }

    case "video": {
      const width = props.width || "100%";
      return `<div style="text-align:center;margin:0 0 16px;"><iframe src="${escapeHtml(props.url || "")}" style="width:${width};max-width:100%;aspect-ratio:16/9;border:none;border-radius:8px;" allowfullscreen></iframe></div>`;
    }

    case "columns": {
      const columns = props.columns || [];
      const gap = props.gap || "24px";
      const colWidth = columns.length > 0 ? `calc(${100 / columns.length}% - ${gap})` : "100%";
      const colsHtml = columns
        .map((col) => {
          const innerHtml = (col.components || []).map((c) => renderComponent(c, slug)).join("\n");
          return `<div style="flex:1;min-width:250px;">${innerHtml}</div>`;
        })
        .join("\n");
      return `<div style="display:flex;flex-wrap:wrap;gap:${gap};margin:0 0 16px;">${colsHtml}</div>`;
    }

    default:
      return "";
  }
}

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderPage(landingPage) {
  const {
    title = "Landing Page",
    slug = "",
    metaTitle,
    metaDescription,
    content,
    cssOverrides,
  } = landingPage;

  let components = [];
  if (content) {
    try {
      components = typeof content === "string" ? JSON.parse(content) : content;
    } catch (e) {
      components = [];
    }
  }

  const bodyHtml = components.map((c) => renderComponent(c, slug)).join("\n");
  const pageTitle = escapeHtml(metaTitle || title);
  const pageDescription = metaDescription ? `<meta name="description" content="${escapeHtml(metaDescription)}" />` : "";
  const overrides = cssOverrides ? `<style>${cssOverrides}</style>` : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${pageTitle}</title>
  ${pageDescription}
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      color: #1a1a1a;
      background: #ffffff;
      -webkit-font-smoothing: antialiased;
    }
    .lp-container {
      max-width: 960px;
      margin: 0 auto;
      padding: 40px 24px;
    }
    img { max-width: 100%; height: auto; }
    input:focus { outline: 2px solid #2563eb; outline-offset: -1px; }
    a:hover { opacity: 0.9; }
    @media (max-width: 640px) {
      .lp-container { padding: 24px 16px; }
      h1 { font-size: 28px !important; }
      h2 { font-size: 22px !important; }
    }
  </style>
  ${overrides}
</head>
<body>
  <div class="lp-container">
    ${bodyHtml}
  </div>
  <img src="/api/pages/${escapeHtml(slug)}/track?event=VISIT" width="1" height="1" style="position:absolute;opacity:0;" />
</body>
</html>`;
}

module.exports = { renderPage };
