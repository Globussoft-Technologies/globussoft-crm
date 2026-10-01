import { useCallback, useContext, useEffect, useRef, useState } from "react";
import WebFormLeadsModal from "../components/WebFormLeadsModal";
import { createPortal } from "react-dom";
















import { DndContext, PointerSensor, KeyboardSensor, closestCenter, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ArrowDown, ArrowUp, ChevronDown, Code2, Copy, Eye, GripVertical, Hash,
  Link2, ListChecks, Paperclip, Plus, Save, Search, Trash2, Type,
  Upload, Info, Monitor, Smartphone, Tablet, X, CheckCircle2,
} from "lucide-react";
import { AuthContext } from "../App";
import { fetchApi } from "../utils/api";
import { useNotify } from "../utils/notify";
import { buildPublicUrl, buildWebFormEmbedCode, buildWebFormPreviewUrl, textOrBlank } from "../utils/webForms";
const CONTACT_FIELD_OPTIONS = [
  { value: "name", label: "Name", fieldType: "text", placeholder: "Enter name" },
  { value: "email", label: "Email", fieldType: "email", placeholder: "Enter email" },
  { value: "phone", label: "Phone", fieldType: "number", placeholder: "Enter phone" },

  { value: "company", label: "Company", fieldType: "text", placeholder: "Enter company" },

  { value: "title", label: "Job title", fieldType: "text", placeholder: "Enter job title" },

  {
    value: "source",
    label: "Source",
    fieldType: "dropdown",
    placeholder: "Enter source",
    options: ["Organic", "Referral", "LinkedIn", "Cold Call", "Website", "Event", "Other"],
  },
  {
    value: "status",
  label: "Lifecycle stage",
 fieldType: "dropdown",
  placeholder: "Enter lifecycle stage",
 options: ["Lead", "Prospect", "Customer", "Churned", "Junk"],
  },
 { value: "aiScore", label: "Lead score", fieldType: "number", placeholder: "Enter lead score" },
  { value: "assignedToId", label: "Sales owner", fieldType: "text", placeholder: "Enter sales owner" },
 { value: "industry", label: "Industry", fieldType: "text", placeholder: "Enter industry" },

 { value: "companySize", label: "Company size", fieldType: "text", placeholder: "Enter company size" },
 { value: "website", label: "Website URL", fieldType: "url", placeholder: "Enter website URL" },
 { value: "linkedin", label: "LinkedIn", fieldType: "url", placeholder: "Enter LinkedIn" },
 { value: "firstTouchSource", label: "First touch source", fieldType: "text", placeholder: "Enter first touch source" },
  { value: "lastTouchSource", label: "Last touch source", fieldType: "text", placeholder: "Enter last touch source" },

 { value: "subBrand", label: "Sub-brand", fieldType: "text", placeholder: "Enter sub-brand" },

 { value: "treatmentOfInterest", label: "Treatment of interest", fieldType: "text", placeholder: "Enter treatment of interest" },
 { value: "stateCode", label: "State code", fieldType: "text", placeholder: "Enter state code" },

 { value: "billingStateCode", label: "Billing state code", fieldType: "text", placeholder: "Enter billing state code" },
 { value: "gst", label: "GSTIN", fieldType: "text", placeholder: "Enter GSTIN" },
  { value: "birthDate", label: "Birth date", fieldType: "date", placeholder: "" },
  { value: "anniversary", label: "Anniversary", fieldType: "date", placeholder: "" },
];

// These are the additional Contact-backed columns exposed by the generic
// Leads Customize table. They are form fields (unlike tracking, Created, and
// Last Updated, which are captured by the system and must not become inputs).
const GENERIC_TABLE_CONTACT_FIELD_OPTIONS = [
  { value: "firstName", label: "First Name", fieldType: "text", placeholder: "Enter first name" },
  { value: "lastName", label: "Last Name", fieldType: "text", placeholder: "Enter last name" },
  { value: "medium", label: "Medium", fieldType: "text", placeholder: "Enter medium" },
  { value: "tags", label: "Tags", fieldType: "text", placeholder: "Enter tags" },
  { value: "description", label: "Note", fieldType: "textarea", placeholder: "Enter note" },
];

const ALL_CONTACT_FIELD_OPTIONS = [...CONTACT_FIELD_OPTIONS, ...GENERIC_TABLE_CONTACT_FIELD_OPTIONS];
const GENERIC_TABLE_FIELD_LABELS = {
  title: "Job Title",
  status: "Status",
  assignedToId: "Assigned To",
  industry: "Service Type",
  companySize: "No Of Employee",
  stateCode: "State",
  treatmentOfInterest: "Treatment Of Interest",
  birthDate: "Birth Date",
  billingStateCode: "Billing State Code",
  firstTouchSource: "First Touch Source",
  lastTouchSource: "Last Touch Source",
};
const GENERIC_CONTACT_FIELD_OPTIONS = [
  ...CONTACT_FIELD_OPTIONS.slice(0, 4),
  ...GENERIC_TABLE_CONTACT_FIELD_OPTIONS,
  ...CONTACT_FIELD_OPTIONS.slice(4),
].map((item) => ({
  ...item,
  label: GENERIC_TABLE_FIELD_LABELS[item.value] || item.label,
}));
const GENERIC_AUTOMATIC_TABLE_FIELDS = [
  ["pageUrl", "Page URL"],
  ["pageTitle", "Page Title"],
  ["pageSource", "Page Source"],
  ["referrerUrl", "Referrer URL"],
  ["landingPageUrl", "Landing Page URL"],
  ["currentDomain", "Current Domain"],
  ["formName", "Form Name / ID"],
  ["utm_source", "UTM Source"],
  ["utm_medium", "UTM Medium"],
  ["utm_campaign", "UTM Campaign"],
  ["utm_term", "UTM Term"],
  ["utm_content", "UTM Content"],
  ["gclid", "Google Click ID"],
  ["fbclid", "Meta Click ID"],
  ["fbc", "Meta Click Cookie"],
  ["fbp", "Meta Browser ID"],
  ["submittedAt", "Submission Timestamp"],
  ["browser", "Browser"],
  ["operatingSystem", "Operating System"],
  ["deviceType", "Device Type"],
].map(([value, label]) => ({ value, label }));

const CONTACT_FIELD_LABELS = Object.fromEntries(ALL_CONTACT_FIELD_OPTIONS.map((item) => [item.value, item.label]));

const CONTACT_FIELD_DEFAULTS = Object.fromEntries(ALL_CONTACT_FIELD_OPTIONS.map((item) => [item.value, item]));

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function restrictToVerticalAxis({ transform }) {
  return { ...transform, x: 0 };
}

function restrictToWebFormsFieldList({ transform, activeNodeRect, containerNodeRect }) {
  if (!activeNodeRect || !containerNodeRect) return transform;

  const minX = containerNodeRect.left - activeNodeRect.left;
  const maxX = containerNodeRect.right - activeNodeRect.right;
  const minY = containerNodeRect.top - activeNodeRect.top;
  const maxY = containerNodeRect.bottom - activeNodeRect.bottom;

  return {
    ...transform,
    x: clamp(transform.x, minX, maxX),
    y: clamp(transform.y, minY, maxY),
  };
}

const FIELD_TYPE_OPTIONS = [
  { value: "text", label: "Text" },
  { value: "email", label: "Email" },
 { value: "textarea", label: "Textarea" },


  { value: "number", label: "Number" },

  { value: "dropdown", label: "Dropdown" },

  { value: "radio", label: "Radio" },
{ value: "date", label: "Date" },
  { value: "url", label: "URL" },

 { value: "checkbox", label: "Checkbox" },
{ value: "multiselect", label: "Multiselect" },

 { value: "file", label: "File upload" },
];
const CHOICE_FIELD_TYPES = new Set(["dropdown", "radio", "multiselect"]);
const FILE_FORMAT_OPTIONS = [
 { value: "CSV", accept: ".csv,text/csv" },
 { value: "XLSX", accept: ".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
 { value: "JPG", accept: ".jpg,image/jpeg" },
  { value: "JPEG", accept: ".jpeg,image/jpeg" },
 { value: "PDF", accept: ".pdf,application/pdf" },
 { value: "DOCX", accept: ".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
 { value: "PPTX", accept: ".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation" },
{ value: "TXT", accept: ".txt,text/plain" },
{ value: "WEBP", accept: ".webp,image/webp" },

];
const DEFAULT_FILE_FORMATS = ["CSV", "XLSX", "JPG", "JPEG", "PNG", "PDF", "DOCX", "PPTX"];

function resolveConditionalParent(field, fields) {
  const condition = field?.showWhen;
  if (!condition) return null;

  return fields.find((candidate) => (
    (condition.fieldId && String(candidate.id) === String(condition.fieldId)) ||
    (!condition.fieldId && condition.fieldKey && String(candidate.sourceKey) === String(condition.fieldKey))
  )) || null;
}

function createsConditionalCycle(candidate, child, fields) {
  const childId = String(child?.id || "");
  const visited = new Set();
  let current = candidate;

  while (current) {
    const currentId = String(current.id || "");
    if (!currentId) return false;
    if (currentId === childId || visited.has(currentId)) return true;
    visited.add(currentId);
    current = resolveConditionalParent(current, fields);
  }

  return false;
}

function getConditionalDepth(field, fields) {
  let depth = 1;
  const visited = new Set();
  let parent = resolveConditionalParent(field, fields);

  while (parent && !visited.has(String(parent.id))) {
    visited.add(String(parent.id));
    depth += 1;
    parent = resolveConditionalParent(parent, fields);
  }

  return depth;
}

function getConditionalPath(field, fields) {
  const path = [];
  const visited = new Set();
  let current = field;

  while (current && !visited.has(String(current.id))) {
    visited.add(String(current.id));
    path.unshift(current.label || "Untitled field");
    current = resolveConditionalParent(current, fields);
  }

  return path;
}

function getConditionalRoot(field, fields) {
  const visited = new Set();
  let current = field;

  while (current && !visited.has(String(current.id))) {
    visited.add(String(current.id));
    const parent = resolveConditionalParent(current, fields);
    if (!parent) return current;
    current = parent;
  }

  return current || field;
}

function buildConditionalFieldGroups(fields, preserveFieldOrder = false) {
  const groups = new Map();

  fields.forEach((field, index) => {
    const root = getConditionalRoot(field, fields);
    const rootId = String(root?.id || field.id);
    if (!groups.has(rootId)) {
      groups.set(rootId, { root, firstIndex: index, fields: [] });
    }
    groups.get(rootId).fields.push({ field, index });
  });

  const groupedFields = Array.from(groups.values())
    .map((group) => ({
      ...group,
      fields: [...group.fields].sort((a, b) => {
        const aIsRoot = String(a.field.id) === String(group.root?.id);
        const bIsRoot = String(b.field.id) === String(group.root?.id);
        if (aIsRoot !== bIsRoot) return aIsRoot ? -1 : 1;
        return a.index - b.index;
      }),
    }));

  if (preserveFieldOrder) {
    return groupedFields.sort((a, b) => a.firstIndex - b.firstIndex);
  }

  return groupedFields.sort((a, b) => {
      const isConditionalRoot = (group) => (
        group.root?.conditionalFlow === true ||
        String(group.root?.sourceKey || "").startsWith("conditional-root_") ||
        (group.root?.sourceKind === "custom" && group.root?.fieldType === "dropdown" && !group.root?.showWhen)
      );
      const aIsConditionalRoot = isConditionalRoot(a);
      const bIsConditionalRoot = isConditionalRoot(b);

      // Keep the newest conditional flow above older flows, even when an
      // existing saved form has the older order in its fields array.
      if (aIsConditionalRoot && bIsConditionalRoot) {
        const aCreatedAt = Number(a.root.conditionalCreatedAt || 0);
        const bCreatedAt = Number(b.root.conditionalCreatedAt || 0);
        if (aCreatedAt !== bCreatedAt) return bCreatedAt - aCreatedAt;
        if (!aCreatedAt && !bCreatedAt) return b.firstIndex - a.firstIndex;
        return String(b.root.sourceKey).localeCompare(String(a.root.sourceKey));
      }
      if (aIsConditionalRoot !== bIsConditionalRoot) return aIsConditionalRoot ? -1 : 1;
      return a.firstIndex - b.firstIndex;
    });
}

const FALLBACK_LEAD_CUSTOM_FIELDS = [
  { fieldKey: "industry", label: "Industry", fieldType: "text", options: [], placeholder: "" },
  { fieldKey: "jobRoles", label: "Job Roles", fieldType: "text", options: [], placeholder: "" },
  { fieldKey: "organization", label: "Organization", fieldType: "text", options: [], placeholder: "" },
  { fieldKey: "numberOfEmployees", label: "No Of Employee", fieldType: "text", options: [], placeholder: "" },
  { fieldKey: "medium", label: "Medium", fieldType: "text", options: [], placeholder: "" },
];
const CUSTOM_FIELD_TEMPLATES = [
{ fieldType: "text", label: "Text field", helper: "Plain text input" },
 { fieldType: "email", label: "Email field", helper: "Email address input" },
 { fieldType: "textarea", label: "Textarea", helper: "Long-form text" },
{ fieldType: "number", label: "Number field", helper: "Numeric input" },
 { fieldType: "dropdown", label: "Dropdown field", helper: "Choose one option" },
 { fieldType: "radio", label: "Radio buttons", helper: "Single choice buttons" },
 { fieldType: "date", label: "Date field", helper: "Date picker" },
  { fieldType: "url", label: "URL field", helper: "Web address" },

  { fieldType: "checkbox", label: "Checkbox", helper: "Yes / no toggle" },
 { fieldType: "multiselect", label: "Multi-select", helper: "Choose many options" },
];

function uid(prefix = "field") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

}

function slugify(text) {
  return String(text || "web-form")
  .trim()
  .toLowerCase()
   .replace(/[^a-z0-9]+/g, "-")
  .replace(/(^-|-$)/g, "")
    .slice(0, 60) || "web-form";

}

function defaultStyle() {
  return {
    fontFamily: "Inter, system-ui, sans-serif",
  backgroundColor: "#EBEFF3",
   formColor: "#FFFFFF",
   titleColor: "#000000",
    textColor: "#111827",
   fieldLabelColor: "#666666",
 buttonColor: "#12344D",
 accentColor: "#12344D",
    logoUrl: "",
    logoSize: 48,
    logoPosition: "left",
    fontSize: 16,
    fontWeight: 400,
    labelFontSize: 13,
    placeholderFontSize: 14,
    errorFontSize: 13,
    successFontSize: 16,
    fieldWidth: 100,
    fieldHeight: 44,
    fieldBorderWidth: 1,
    fieldBorderRadius: 12,
    fieldBorderColor: "#D8DDEC",
    fieldFocusBorderColor: "#6366F1",
    fieldBackgroundColor: "#FFFFFF",
    placeholderColor: "#6B7280",
    fieldTextColor: "#111827",
    layoutColumns: "one",
    customColumnWidth: 50,
    rowGap: 9,
    columnGap: 9,
    mobileColumns: "one",
    tabletColumns: "one",
    containerBackgroundMode: "solid",
    gradientStart: "#FFFFFF",
    gradientEnd: "#EEF1FF",
    gradientAngle: 145,
    containerBorderColor: "#D8DDEC",
    containerBorderWidth: 1,
    containerBorderRadius: 24,
    containerShadow: "0 24px 70px rgba(30,41,96,.14)",
    containerShadowColor: "#1E2960",
    containerShadowOpacity: 14,
    containerPadding: 30,
    containerMargin: 0,
    buttonHoverColor: "#0D2639",
    buttonTextColor: "#FFFFFF",
    buttonFontSize: 16,
    buttonBorderColor: "transparent",
    buttonBorderWidth: 0,
    buttonBorderRadius: 12,
    buttonWidth: "auto",
    buttonHeight: 46,
    buttonAlignment: "left",
    buttonLoadingColor: "#12344D",
    buttonLoadingText: "Submitting...",
    successMessageColor: "#065F46",
    errorMessageColor: "#B91C1C",
  };
}

function defaultSettings() {
  return {
  formTitle: "",
  submitButtonLabel: "Submit",
  showPoweredBy: true,
  successMessage: "Thank you! Your information has been received. We will be in touch with you shortly to assist with your account.",
    afterSubmitAction: "message",
 redirectUrl: "",
  notificationEnabled: false,
   notificationEmail: "",
  // Keep the existing generic-form WhatsApp acknowledgement enabled for
  // previously-created forms; email and SMS are opt-in per submitted lead.
  contactNotificationChannels: ["whatsapp"],
  contactNotificationMessage: "Thank you for contacting us through {{form}}. Our team will be in touch shortly.",
  optInEnabled: false,
   optInText: "I agree to receive communication on newsletters, promotional content, offers and events.",
  optInLinkText: "",
  optInLinkUrl: "",
  createAccount: false,
  createDeal: false,
  phoneAllowAllCountries: true,
    phoneAllowedCountries: [],
    multiStepEnabled: false,
    steps: [],
  };
}
const PHONE_COUNTRY_OPTIONS = [
  ["+1", "United States / Canada"], ["+7", "Russia / Kazakhstan"], ["+20", "Egypt"], ["+27", "South Africa"], ["+30", "Greece"], ["+31", "Netherlands"], ["+32", "Belgium"], ["+33", "France"], ["+34", "Spain"], ["+39", "Italy"], ["+40", "Romania"], ["+41", "Switzerland"], ["+43", "Austria"], ["+44", "United Kingdom"], ["+45", "Denmark"], ["+46", "Sweden"], ["+47", "Norway"], ["+48", "Poland"], ["+49", "Germany"], ["+51", "Peru"], ["+52", "Mexico"], ["+53", "Cuba"], ["+54", "Argentina"], ["+55", "Brazil"], ["+56", "Chile"], ["+57", "Colombia"], ["+58", "Venezuela"], ["+60", "Malaysia"], ["+61", "Australia"], ["+62", "Indonesia"], ["+63", "Philippines"], ["+64", "New Zealand"], ["+65", "Singapore"], ["+66", "Thailand"], ["+81", "Japan"], ["+82", "South Korea"], ["+84", "Vietnam"], ["+86", "China"], ["+90", "Türkiye"], ["+91", "India"], ["+92", "Pakistan"], ["+93", "Afghanistan"], ["+94", "Sri Lanka"], ["+95", "Myanmar"], ["+98", "Iran"], ["+211", "South Sudan"], ["+212", "Morocco"], ["+213", "Algeria"], ["+216", "Tunisia"], ["+218", "Libya"], ["+220", "Gambia"], ["+221", "Senegal"], ["+222", "Mauritania"], ["+223", "Mali"], ["+224", "Guinea"], ["+225", "Ivory Coast"], ["+226", "Burkina Faso"], ["+227", "Niger"], ["+228", "Togo"], ["+229", "Benin"], ["+230", "Mauritius"], ["+231", "Liberia"], ["+232", "Sierra Leone"], ["+233", "Ghana"], ["+234", "Nigeria"], ["+235", "Chad"], ["+236", "Central African Republic"], ["+237", "Cameroon"], ["+238", "Cape Verde"], ["+239", "Sao Tome and Principe"], ["+240", "Equatorial Guinea"], ["+241", "Gabon"], ["+242", "Republic of the Congo"], ["+243", "DR Congo"], ["+244", "Angola"], ["+245", "Guinea-Bissau"], ["+246", "British Indian Ocean Territory"], ["+248", "Seychelles"], ["+249", "Sudan"], ["+250", "Rwanda"], ["+251", "Ethiopia"], ["+252", "Somalia"], ["+253", "Djibouti"], ["+254", "Kenya"], ["+255", "Tanzania"], ["+256", "Uganda"], ["+257", "Burundi"], ["+258", "Mozambique"], ["+260", "Zambia"], ["+261", "Madagascar"], ["+262", "Reunion"], ["+263", "Zimbabwe"], ["+264", "Namibia"], ["+265", "Malawi"], ["+266", "Lesotho"], ["+267", "Botswana"], ["+268", "Eswatini"], ["+269", "Comoros"], ["+290", "Saint Helena"], ["+291", "Eritrea"], ["+297", "Aruba"], ["+298", "Faroe Islands"], ["+299", "Greenland"], ["+350", "Gibraltar"], ["+351", "Portugal"], ["+352", "Luxembourg"], ["+353", "Ireland"], ["+354", "Iceland"], ["+355", "Albania"], ["+356", "Malta"], ["+357", "Cyprus"], ["+358", "Finland"], ["+359", "Bulgaria"], ["+370", "Lithuania"], ["+371", "Latvia"], ["+372", "Estonia"], ["+373", "Moldova"], ["+374", "Armenia"], ["+375", "Belarus"], ["+376", "Andorra"], ["+377", "Monaco"], ["+378", "San Marino"], ["+380", "Ukraine"], ["+381", "Serbia"], ["+382", "Montenegro"], ["+383", "Kosovo"], ["+385", "Croatia"], ["+386", "Slovenia"], ["+387", "Bosnia and Herzegovina"], ["+389", "North Macedonia"], ["+420", "Czechia"], ["+421", "Slovakia"], ["+971", "United Arab Emirates"], ["+974", "Qatar"], ["+975", "Bhutan"], ["+976", "Mongolia"], ["+977", "Nepal"], ["+992", "Tajikistan"], ["+993", "Turkmenistan"], ["+994", "Azerbaijan"], ["+995", "Georgia"], ["+996", "Kyrgyzstan"], ["+998", "Uzbekistan"],
];

function fieldPlaceholderHint(field) {
  const label = String(field?.label || "value").trim().toLowerCase();
  return `Enter ${label || "value"}`;
}

function defaultField(sourceKind = "contact", sourceKey = "name", label = "Name", fieldType = "text") {

  const contactDefaults = CONTACT_FIELD_DEFAULTS[sourceKey] || {};

  const resolvedFieldType = FIELD_TYPE_OPTIONS.some((item) => item.value === fieldType) ? fieldType : (contactDefaults.fieldType || "text");
 return {
    id: uid("field"),
  sourceKind,
    sourceKey,
fieldType: resolvedFieldType,
 label,
   placeholder: contactDefaults.placeholder || fieldPlaceholderHint({ label }),
defaultValue: "",
  helpText: "",
  required: false,
   hidden: false,
  showWhen: null,
width: "full",
    optionsText: Array.isArray(contactDefaults.options) ? contactDefaults.options.join(", ") : "",
   fileFormats: resolvedFieldType === "file" ? DEFAULT_FILE_FORMATS : [],
   allowMultipleFiles: false,
   fileTagsText: "",















  };















}































function contactLabelFor(key) {















  return CONTACT_FIELD_LABELS[key] || String(key || "field").replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());















}































function normalizeField(field, index, leadFields = []) {















  const sourceKind = field?.sourceKind === "lead_custom" || field?.sourceKind === "custom" ? field.sourceKind : "contact";















  const sourceKey = String(field?.sourceKey || "").trim() || (sourceKind === "contact" ? CONTACT_FIELD_OPTIONS[index % CONTACT_FIELD_OPTIONS.length]?.value || "name" : `custom_${index + 1}`);















  const leadLabel = leadFields.find((item) => item.fieldKey === sourceKey)?.label || sourceKey.replace(/_/g, " ");















  const label = field?.label == null ? (sourceKind === "contact" ? contactLabelFor(sourceKey) : sourceKind === "lead_custom" ? leadLabel : `Field ${index + 1}`) : textOrBlank(field.label);















  const fieldType = sourceKind === "contact" && sourceKey === "email"
    ? "email"
    : FIELD_TYPE_OPTIONS.some((item) => item.value === field?.fieldType)
      ? field.fieldType
      : (CONTACT_FIELD_DEFAULTS[sourceKey]?.fieldType || "text");















  return {















    id: String(field?.id || uid("field")),















    sourceKind,















    sourceKey,















    fieldType,















    label,















    placeholder: field?.placeholder == null ? String(CONTACT_FIELD_DEFAULTS[sourceKey]?.placeholder || fieldPlaceholderHint({ label })) : textOrBlank(field.placeholder),















    defaultValue: field?.defaultValue == null ? "" : textOrBlank(field.defaultValue),















    helpText: field?.helpText == null ? "" : textOrBlank(field.helpText),















    required: Boolean(field?.required),















    hidden: Boolean(field?.hidden),















    width: field?.width === "half" ? "half" : "full",















    optionsText: Array.isArray(field?.options) ? field.options.join(", ") : String(field?.optionsText || CONTACT_FIELD_DEFAULTS[sourceKey]?.options?.join(", ") || ""),















    fileFormats: Array.isArray(field?.fileFormats) && field.fileFormats.length ? field.fileFormats.map((item) => String(item).toUpperCase()).filter((item) => FILE_FORMAT_OPTIONS.some((format) => format.value === item)) : (fieldType === "file" ? DEFAULT_FILE_FORMATS : []),















    allowMultipleFiles: Boolean(field?.allowMultipleFiles),

    showWhen: field?.showWhen && (field.showWhen.fieldId || field.showWhen.fieldKey)
      ? {
        fieldId: textOrBlank(field.showWhen.fieldId),
        fieldKey: textOrBlank(field.showWhen.fieldKey),
        parentQuestion: textOrBlank(field.showWhen.parentQuestion),
        value: textOrBlank(field.showWhen.value),
      }
      : null,















    fileTagsText: Array.isArray(field?.fileTags) ? field.fileTags.join(", ") : String(field?.fileTagsText || ""),

    stepId: textOrBlank(field?.stepId),















  };















}































function normalizeForm(raw, leadFields = []) {















  const base = raw || {};















  return {















    ...base,















    name: String(base.name ?? "Untitled form"),















    slug: String(base.slug || slugify(base.name || "web-form")),















    description: String(base.description || ""),















    isActive: base.isActive !== false,















    fields: Array.isArray(base.fields) && base.fields.length ? base.fields.map((field, index) => normalizeField(field, index, leadFields)) : [defaultField()],















    style: { ...defaultStyle(), ...(base.style || {}) },















    settings: (() => {
      const merged = { ...defaultSettings(), ...(base.settings || {}) };
      const steps = Array.isArray(merged.steps)
        ? merged.steps.map((step, index) => ({
          id: String(step?.id || `step-${index + 1}`),
          title: String(step?.title || `Step ${index + 1}`),
          description: String(step?.description || ""),
        }))
        : [];
      if ((base.settings || {}).formTitle == null && base.name) merged.formTitle = String(base.name);
      const userSteps = steps.length === 1 && steps[0].id === "step-1" && steps[0].title === "Step 1" && !steps[0].description ? [] : steps;
      return { ...merged, steps: userSteps };
    })(),















    submissionCount: Number(base.submissionCount || 0),















  };















}































function splitOptions(text) {















  return String(text || "").split(/[,\n]/).map((item) => item.trim()).filter(Boolean).slice(0, 50);















}















function emptyFieldFor(kind, leadFields, sourceKey = "", fieldType = "text", label = "") {















  if (kind === "contact") {















    const key = sourceKey || CONTACT_FIELD_OPTIONS[0]?.value || "name";















    const def = CONTACT_FIELD_DEFAULTS[key] || CONTACT_FIELD_OPTIONS[0] || {};















    return defaultField("contact", key, def.label || contactLabelFor(key), def.fieldType || "text");















  }















  if (kind === "lead_custom") {















    const firstLead = leadFields.find((item) => item.fieldKey === sourceKey) || FALLBACK_LEAD_CUSTOM_FIELDS.find((item) => item.fieldKey === sourceKey) || leadFields[0];















    return defaultField("lead_custom", firstLead?.fieldKey || sourceKey || "lead_custom_field", label || firstLead?.label || "Lead field", fieldType || firstLead?.fieldType || "text");















  }















  if (kind === "file") {















    return { ...defaultField("custom", `file_${Date.now().toString(36)}`, "File attachment", "file"), label: "Upload your file" };















  }















  const resolvedType = FIELD_TYPE_OPTIONS.some((item) => item.value === fieldType) ? fieldType : "text";















  const _labelMap = {















    textarea: "Textarea field",















    number: "Number field",















    dropdown: "Dropdown field",















    radio: "Radio buttons",















    date: "Date field",















    url: "URL field",















    checkbox: "Checkbox",















    multiselect: "Multi-select field",















  };















  // Custom questions start blank so the form owner can enter every value manually.
  return defaultField("custom", `custom_${Date.now().toString(36)}`, label, resolvedType);















}































function Section({ id, step, title, subtitle, children }) {















  return (















    <section id={id} className="card" style={{ position: "relative", zIndex: id === "wf-fields" ? 20 : 1, overflow: "visible", padding: 20, background: "var(--surface-color)", border: "1px solid var(--border-color)", borderRadius: 14, color: "var(--text-primary)", boxShadow: "var(--wf-shadow)", scrollMarginTop: id === "wf-style" ? 16 : undefined }}>















      <div style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 16 }}>















        <div style={{ width: 22, height: 22, borderRadius: 999, display: "grid", placeItems: "center", background: "var(--wf-step-bg)", color: "var(--wf-step-text)", fontWeight: 700, flexShrink: 0, fontSize: 13 }}>{step}</div>















        <div>















          <h3 style={{ margin: 0, fontSize: "1.05rem", color: "var(--text-primary)" }}>{title}</h3>















          {subtitle ? <p style={{ margin: "0.35rem 0 0", color: "var(--text-secondary)", fontSize: "0.88rem" }}>{subtitle}</p> : null}















        </div>















      </div>















      {children}















    </section>















  );















}































function normalizeHexColor(value, fallback = "#FFFFFF") {















  const text = String(value || "").trim();















  if (/^#[0-9a-fA-F]{6}$/.test(text)) return text.toUpperCase();















  if (/^[0-9a-fA-F]{6}$/.test(text)) return `#${text.toUpperCase()}`;















  return fallback;















}































function labelLengthStyle(label) {
  const labelLength = String(label || "").length;
  const widthInCh = Math.max(11, Math.ceil(labelLength * 0.72 + 4));
  return {
    "--wf-label-length": String(labelLength),
    "--wf-control-width": `${widthInCh}ch`,
  };
}

function optionLengthStyle(options) {
  const longestOption = (options || []).reduce((longest, option) => Math.max(longest, String(option || "").length), 0);
  const widthInCh = Math.max(14, Math.ceil(longestOption * 0.9 + 6));
  return {
    "--wf-option-length": String(longestOption),
    "--wf-option-width": `${widthInCh}ch`,
    width: `${widthInCh}ch`,
    minWidth: `${widthInCh}ch`,
  };
}

function ColorField({ label, value, onChange, fallback }) {















  const safeValue = normalizeHexColor(value, fallback);















  return (















    <label className="wf-color-field" style={labelLengthStyle(label)}>















      <span style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>{label}</span>















      <div className="wf-color-control">















        <input className="input-field wf-color-text" value={value} onChange={(e) => onChange(e.target.value)} />















        <input type="color" className="wf-color-native" value={safeValue} onChange={(e) => onChange(e.target.value.toUpperCase())} aria-label={label} />















      </div>















    </label>















  );















}

function StyleNumberField({ label, value, min, max, step = 1, onChange }) {
  return (
    <label style={{ display: "grid", gap: 6, minWidth: 0, ...labelLengthStyle(label) }}>
      <span style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>{label}</span>
      <input className="input-field" type="number" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}















function modalShellStyle() {















  return {















    position: "fixed",















    inset: 0,















    background: "rgba(3, 6, 16, 0.72)",















    zIndex: 60,















    display: "grid",















    placeItems: "center",















    padding: 20,















  };















}































function modalCardStyle(width = 960) {















  return {















    width: "min(100%, " + width + "px)",















    maxHeight: "90vh",















    overflow: "auto",















    background: "var(--surface-1, #13161b)",















    border: "1px solid var(--border-color, rgba(255,255,255,0.08))",















    borderRadius: 18,















    boxShadow: "0 24px 80px rgba(0,0,0,0.36)",















  };















}































function fieldKindLabel(field) {















  if (field.sourceKind === "contact") return "Contact field";















  if (field.sourceKind === "lead_custom") return "Lead custom field";















  return "Custom field";















}































function fieldTypeIcon(fieldType) {















  if (fieldType === "dropdown" || fieldType === "radio" || fieldType === "multiselect") return <ListChecks size={16} />;















  if (fieldType === "number") return <Hash size={16} />;















  if (fieldType === "date") return <span style={{ fontSize: 13, fontWeight: 700 }}>31</span>;















  if (fieldType === "file") return <Paperclip size={16} />;















  if (fieldType === "checkbox") return <span style={{ fontSize: 12, fontWeight: 700, lineHeight: 1 }}>CB</span>;















  return <Type size={16} />;















}































function fieldControlValue(field) {















  if (!field.hidden) return null;















  if (CHOICE_FIELD_TYPES.has(field.fieldType)) return String(field.defaultValue || "");















  if (field.fieldType === "checkbox") return field.defaultValue === true || field.defaultValue === "true" || field.defaultValue === "1" ? "true" : "false";















  return String(field.defaultValue || "");















}































function fileFormatSummary(formats) {















  const selected = Array.isArray(formats) && formats.length ? formats : DEFAULT_FILE_FORMATS;















  if (selected.length <= 5) return selected.join(", ");















  return `${selected.slice(0, 5).join(", ")} and ${selected.length - 5} more`;















}































function toggleFormat(formats, value) {















  const selected = new Set(Array.isArray(formats) ? formats : DEFAULT_FILE_FORMATS);















  if (selected.has(value)) selected.delete(value);















  else selected.add(value);















  return FILE_FORMAT_OPTIONS.map((item) => item.value).filter((item) => selected.has(item));















}































function supportsAdvancedWebFormFeatures(scope) {
  return scope === "generic" || scope === "travel";
}

const GENERIC_ELEMENT_TEXT_DEFAULTS = {
  form: { fontFamily: "Inter, system-ui, sans-serif", fontSize: 16, fontWeight: 400, fontStyle: "normal", textDecoration: "none", textAlign: "left" },
  title: { fontFamily: "Inter, system-ui, sans-serif", fontSize: 20, fontWeight: 700, fontStyle: "normal", textDecoration: "none", textAlign: "left" },
  label: { fontFamily: "Inter, system-ui, sans-serif", fontSize: 13, fontWeight: 600, fontStyle: "normal", textDecoration: "none", textAlign: "left" },
  placeholder: { fontFamily: "Inter, system-ui, sans-serif", fontSize: 14, fontWeight: 400, fontStyle: "normal", textDecoration: "none", textAlign: "left" },
  input: { fontFamily: "Inter, system-ui, sans-serif", fontSize: 16, fontWeight: 400, fontStyle: "normal", textDecoration: "none", textAlign: "left" },
  button: { fontFamily: "Inter, system-ui, sans-serif", fontSize: 16, fontWeight: 700, fontStyle: "normal", textDecoration: "none", textAlign: "left" },
  error: { fontFamily: "Inter, system-ui, sans-serif", fontSize: 13, fontWeight: 400, fontStyle: "normal", textDecoration: "none", textAlign: "left" },
  success: { fontFamily: "Inter, system-ui, sans-serif", fontSize: 16, fontWeight: 700, fontStyle: "normal", textDecoration: "none", textAlign: "center" },
};

function GenericElementTextControls({ element, value, onChange }) {
  const update = (changes) => onChange({ ...value, ...changes });
  return (
    <div className="wf-generic-element-text-controls">
      <label><span>Font</span><select value={value.fontFamily} onChange={(e) => update({ fontFamily: e.target.value })}><option value="Inter, system-ui, sans-serif">Inter / system UI</option><option value="Arial, sans-serif">Arial</option><option value="Georgia, serif">Georgia</option><option value="Tahoma, sans-serif">Tahoma</option><option value="Verdana, sans-serif">Verdana</option></select></label>
      <label><span>Size</span><input type="number" min={9} max={40} value={value.fontSize} onChange={(e) => update({ fontSize: Number(e.target.value) })} /></label>
      <div className="wf-generic-text-toggle-group" aria-label={`${element} text formatting`}>
        <button type="button" className={value.fontWeight >= 700 ? "is-active" : ""} onClick={() => update({ fontWeight: value.fontWeight >= 700 ? 400 : 700 })} aria-label="Toggle bold"><strong>B</strong></button>
        <button type="button" className={value.fontStyle === "italic" ? "is-active" : ""} onClick={() => update({ fontStyle: value.fontStyle === "italic" ? "normal" : "italic" })} aria-label="Toggle italic"><em>I</em></button>
        <button type="button" className={value.textDecoration === "underline" ? "is-active" : ""} onClick={() => update({ textDecoration: value.textDecoration === "underline" ? "none" : "underline" })} aria-label="Toggle underline"><u>U</u></button>
      </div>
      <label><span>Align</span><select value={value.textAlign} onChange={(e) => update({ textAlign: e.target.value })}><option value="left">Left</option><option value="center">Center</option><option value="right">Right</option><option value="justify">Justify</option></select></label>
    </div>
  );
}

function GenericFormStyleControls({ group, form, style, updateStyle, applyDraft, logoUploadRef, uploadingLogo, onLogoUpload, previewDevice, setPreviewDevice, hidePreviewDevice = false }) {
  const field = (label, value, onChange, min, max) => <StyleNumberField label={label} value={value} min={min} max={max} onChange={onChange} />;
  if (group === "front") return <>
    <div className="wf-logo-upload">
      <div className="wf-logo-upload-label">Add a logo to your form</div>
      <input ref={logoUploadRef} type="file" accept="image/*" style={{ display: "none" }} onChange={onLogoUpload} />
      <button type="button" className="btn-secondary" disabled={uploadingLogo} onClick={() => logoUploadRef.current?.click()}>{uploadingLogo ? "Uploading..." : "Upload"}</button>
      {style.logoUrl ? <button type="button" className="btn-secondary" onClick={() => updateStyle({ logoUrl: "" })}>Remove</button> : null}
    </div>
    {style.logoUrl ? <div className="wf-logo-preview"><img src={style.logoUrl} alt="Form logo preview" /><span>Logo uploaded</span></div> : null}
    <label style={{ display: "grid", gap: 6 }}><span>Title of the form</span><input className="input-field" value={form.settings.formTitle} onChange={(e) => applyDraft({ settings: { ...form.settings, formTitle: e.target.value } })} /></label>
    <label style={{ display: "grid", gap: 6 }}><span>Description</span><input className="input-field" value={form.description || ""} onChange={(e) => applyDraft({ description: e.target.value })} /></label>
    <label style={{ display: "grid", gap: 6 }}><span>Submit button label</span><input className="input-field" value={form.settings.submitButtonLabel} onChange={(e) => applyDraft({ settings: { ...form.settings, submitButtonLabel: e.target.value } })} /></label>
    <StyleNumberField label="Logo size (px)" value={style.logoSize} min={20} max={200} onChange={(value) => updateStyle({ logoSize: value })} />
    <label style={{ display: "grid", gap: 6 }}><span>Logo position</span><select className="input-field" value={style.logoPosition} onChange={(e) => updateStyle({ logoPosition: e.target.value })}><option value="left">Left</option><option value="center">Center</option><option value="right">Right</option></select></label>
  </>;
  if (group === "form") return <>
    <ColorField label="Background color" value={style.backgroundColor} onChange={(value) => updateStyle({ backgroundColor: value })} fallback="#EBEFF3" />
    <ColorField label="Form color" value={style.formColor} onChange={(value) => updateStyle({ formColor: value })} fallback="#FFFFFF" />
  </>;
  if (group === "layout") return <>
    {!hidePreviewDevice ? <div style={{ display: "grid", gap: 6 }}><span>Preview device</span><div style={{ display: "flex", gap: 8 }} aria-label="Preview device"><button type="button" className="btn-secondary" style={previewDevice === "desktop" ? { borderColor: "var(--accent-color)", background: "var(--accent-color)", color: "#fff" } : undefined} onClick={() => setPreviewDevice("desktop")} aria-label="Desktop preview" title="Desktop preview"><Monitor size={18} /></button><button type="button" className="btn-secondary" style={previewDevice === "tablet" ? { borderColor: "var(--accent-color)", background: "var(--accent-color)", color: "#fff" } : undefined} onClick={() => setPreviewDevice("tablet")} aria-label="Tablet preview" title="Tablet preview"><Tablet size={18} /></button><button type="button" className="btn-secondary" style={previewDevice === "mobile" ? { borderColor: "var(--accent-color)", background: "var(--accent-color)", color: "#fff" } : undefined} onClick={() => setPreviewDevice("mobile")} aria-label="Mobile preview" title="Mobile preview"><Smartphone size={18} /></button></div></div> : null}
    <label style={{ display: "grid", gap: 6 }}><span>Desktop columns</span><select className="input-field" value={style.layoutColumns} onChange={(e) => updateStyle({ layoutColumns: e.target.value })}><option value="one">One column</option><option value="two">Two columns</option></select></label>
    {field("Custom column width (%)", style.customColumnWidth, (value) => updateStyle({ customColumnWidth: value }), 25, 75)}
    {field("Row gap (px)", style.rowGap, (value) => updateStyle({ rowGap: value }), 0, 64)}
    {field("Column gap (px)", style.columnGap, (value) => updateStyle({ columnGap: value }), 0, 64)}
    <label style={{ display: "grid", gap: 6 }}><span>Tablet layout</span><select className="input-field" value={style.tabletColumns} onChange={(e) => updateStyle({ tabletColumns: e.target.value })}><option value="one">One column</option><option value="two">Two columns</option></select></label>
    <label style={{ display: "grid", gap: 6 }}><span>Mobile layout</span><select className="input-field" value={style.mobileColumns} onChange={(e) => updateStyle({ mobileColumns: e.target.value })}><option value="one">One column</option><option value="two">Two columns</option></select></label>
  </>;
  if (group === "container") return <>
    <label style={{ display: "grid", gap: 6 }}><span>Container background</span><select className="input-field" value={style.containerBackgroundMode} onChange={(e) => updateStyle({ containerBackgroundMode: e.target.value })}><option value="solid">Solid background</option><option value="gradient">Gradient background</option></select></label>
    {style.containerBackgroundMode === "gradient" ? <><ColorField label="Gradient start" value={style.gradientStart} onChange={(value) => updateStyle({ gradientStart: value })} fallback="#FFFFFF" /><ColorField label="Gradient end" value={style.gradientEnd} onChange={(value) => updateStyle({ gradientEnd: value })} fallback="#EEF1FF" /><StyleNumberField label="Gradient angle (degrees)" value={style.gradientAngle} min={0} max={360} onChange={(value) => updateStyle({ gradientAngle: value })} /></> : null}
    <ColorField label="Container border" value={style.containerBorderColor} onChange={(value) => updateStyle({ containerBorderColor: value })} fallback="#D8DDEC" />
    {field("Container border width (px)", style.containerBorderWidth, (value) => updateStyle({ containerBorderWidth: value }), 0, 8)}
    {field("Container radius (px)", style.containerBorderRadius, (value) => updateStyle({ containerBorderRadius: value }), 0, 48)}
    {field("Container padding (px)", style.containerPadding, (value) => updateStyle({ containerPadding: value }), 0, 80)}
    {field("Container margin (px)", style.containerMargin, (value) => updateStyle({ containerMargin: value }), 0, 80)}
    <label style={{ display: "grid", gap: 6 }}><span>Shadow</span><select className="input-field" value={style.containerShadow} onChange={(e) => updateStyle({ containerShadow: e.target.value })}><option value="none">None</option><option value="0 24px 70px rgba(30,41,96,.14)">Soft</option><option value="0 8px 24px rgba(15,23,42,.18)">Compact</option></select></label>
    <ColorField label="Shadow color" value={style.containerShadowColor} onChange={(value) => updateStyle({ containerShadowColor: value })} fallback="#1E2960" />
    {field("Shadow opacity (%)", style.containerShadowOpacity, (value) => updateStyle({ containerShadowOpacity: value }), 0, 100)}
  </>;
  if (group === "title") return <ColorField label="Title color" value={style.titleColor} onChange={(value) => updateStyle({ titleColor: value })} fallback="#000000" />;
  if (group === "label") return <><ColorField label="Field label color" value={style.fieldLabelColor} onChange={(value) => updateStyle({ fieldLabelColor: value })} fallback="#666666" />{field("Label size (px)", style.labelFontSize, (value) => updateStyle({ labelFontSize: value }), 9, 24)}</>;
  if (group === "placeholder") return <><ColorField label="Placeholder color" value={style.placeholderColor} onChange={(value) => updateStyle({ placeholderColor: value })} fallback="#6B7280" />{field("Placeholder size (px)", style.placeholderFontSize, (value) => updateStyle({ placeholderFontSize: value }), 9, 24)}</>;
  if (group === "input") return <>{field("Field width (%)", style.fieldWidth, (value) => updateStyle({ fieldWidth: value }), 50, 100)}{field("Field height (px)", style.fieldHeight, (value) => updateStyle({ fieldHeight: value }), 10, 96)}{field("Border width (px)", style.fieldBorderWidth, (value) => updateStyle({ fieldBorderWidth: value }), 0, 8)}{field("Border radius (px)", style.fieldBorderRadius, (value) => updateStyle({ fieldBorderRadius: value }), 0, 40)}<ColorField label="Border color" value={style.fieldBorderColor} onChange={(value) => updateStyle({ fieldBorderColor: value })} fallback="#D8DDEC" /><ColorField label="Focus border color" value={style.fieldFocusBorderColor} onChange={(value) => updateStyle({ fieldFocusBorderColor: value })} fallback="#6366F1" /><ColorField label="Field background" value={style.fieldBackgroundColor} onChange={(value) => updateStyle({ fieldBackgroundColor: value })} fallback="#FFFFFF" /><ColorField label="Text color" value={style.fieldTextColor} onChange={(value) => updateStyle({ fieldTextColor: value })} fallback="#111827" /></>;
  if (group === "error") return <ColorField label="Error message color" value={style.errorMessageColor} onChange={(value) => updateStyle({ errorMessageColor: value })} fallback="#B91C1C" />;
  if (group === "success") return <ColorField label="Success message color" value={style.successMessageColor} onChange={(value) => updateStyle({ successMessageColor: value })} fallback="#065F46" />;
  return null;
}

function _TravelCustomizationEditor({ form, selection, onSelectionChange, applyDraft, logoUploadRef, uploadingLogo, onLogoUpload }) {
  const style = form.style;
  const elementTextStyles = { ...GENERIC_ELEMENT_TEXT_DEFAULTS, ...(style.elementTextStyles || {}) };
  const updateStyle = (changes) => applyDraft({ style: { ...style, ...changes } });
  const updateSelectedTextStyle = (value) => updateStyle({ elementTextStyles: { ...elementTextStyles, [selection]: value } });
  const selectedTextStyle = elementTextStyles[selection] || elementTextStyles.form;

  return (
    <div className="wf-travel-customization">
      <div className="wf-generic-live-inspector-title">Customize selected element</div>
      <div className="wf-generic-live-elements">
        {[["form", "Form"], ["title", "Title"], ["label", "Label"], ["placeholder", "Placeholder"], ["input", "Input box"], ["button", "Submit button"], ["error", "Error message"], ["success", "Success message"], ["layout", "Layout"], ["container", "Form container"]].map(([value, label]) => (
          <button key={value} type="button" className={selection === value ? "is-selected" : ""} onClick={() => onSelectionChange(value)}>{label}</button>
        ))}
      </div>
      {["title", "label", "placeholder", "input", "button", "error", "success"].includes(selection) ? <GenericElementTextControls element={selection} value={selectedTextStyle} onChange={updateSelectedTextStyle} /> : null}
      <div className="wf-generic-live-context-options">
        {selection === "form" ? <>
          <GenericFormStyleControls group="front" form={form} style={style} updateStyle={updateStyle} applyDraft={applyDraft} logoUploadRef={logoUploadRef} uploadingLogo={uploadingLogo} onLogoUpload={onLogoUpload} />
          <GenericFormStyleControls group="form" form={form} style={style} updateStyle={updateStyle} applyDraft={applyDraft} logoUploadRef={logoUploadRef} uploadingLogo={uploadingLogo} onLogoUpload={onLogoUpload} />
        </> : null}
        {selection === "layout" ? <GenericFormStyleControls group="layout" form={form} style={style} updateStyle={updateStyle} applyDraft={applyDraft} logoUploadRef={logoUploadRef} uploadingLogo={uploadingLogo} onLogoUpload={onLogoUpload} hidePreviewDevice /> : null}
        {selection === "container" ? <GenericFormStyleControls group="container" form={form} style={style} updateStyle={updateStyle} applyDraft={applyDraft} logoUploadRef={logoUploadRef} uploadingLogo={uploadingLogo} onLogoUpload={onLogoUpload} /> : null}
        {selection === "title" ? <GenericFormStyleControls group="title" form={form} style={style} updateStyle={updateStyle} applyDraft={applyDraft} logoUploadRef={logoUploadRef} uploadingLogo={uploadingLogo} onLogoUpload={onLogoUpload} /> : null}
        {selection === "label" ? <GenericFormStyleControls group="label" form={form} style={style} updateStyle={updateStyle} applyDraft={applyDraft} logoUploadRef={logoUploadRef} uploadingLogo={uploadingLogo} onLogoUpload={onLogoUpload} /> : null}
        {selection === "placeholder" ? <GenericFormStyleControls group="placeholder" form={form} style={style} updateStyle={updateStyle} applyDraft={applyDraft} logoUploadRef={logoUploadRef} uploadingLogo={uploadingLogo} onLogoUpload={onLogoUpload} /> : null}
        {selection === "input" ? <GenericFormStyleControls group="input" form={form} style={style} updateStyle={updateStyle} applyDraft={applyDraft} logoUploadRef={logoUploadRef} uploadingLogo={uploadingLogo} onLogoUpload={onLogoUpload} /> : null}
        {selection === "button" ? <>
          <ColorField label="Submit button color" value={style.buttonColor} onChange={(value) => updateStyle({ buttonColor: value })} fallback="#12344D" />
          <ColorField label="Hover color" value={style.buttonHoverColor} onChange={(value) => updateStyle({ buttonHoverColor: value })} fallback="#0D2639" />
          <ColorField label="Button text color" value={style.buttonTextColor} onChange={(value) => updateStyle({ buttonTextColor: value })} fallback="#FFFFFF" />
          <label style={{ display: "grid", gap: 6 }}><span>Button position</span><select className="input-field" value={style.buttonAlignment} onChange={(e) => updateStyle({ buttonAlignment: e.target.value })}><option value="left">Left</option><option value="center">Center</option><option value="right">Right</option><option value="full">Full width</option></select></label>
          <StyleNumberField label="Button height (px)" value={style.buttonHeight} min={30} max={96} onChange={(value) => updateStyle({ buttonHeight: value })} />
          <StyleNumberField label="Button radius (px)" value={style.buttonBorderRadius} min={0} max={40} onChange={(value) => updateStyle({ buttonBorderRadius: value })} />
          <ColorField label="Button border" value={style.buttonBorderColor} onChange={(value) => updateStyle({ buttonBorderColor: value })} fallback="#12344D" />
          <StyleNumberField label="Button border width (px)" value={style.buttonBorderWidth} min={0} max={8} onChange={(value) => updateStyle({ buttonBorderWidth: value })} />
          <label style={{ display: "grid", gap: 6 }}><span>Width</span><select className="input-field" value={style.buttonWidth} onChange={(e) => updateStyle({ buttonWidth: e.target.value })}><option value="auto">Auto</option><option value="full">Full width</option></select></label>
          <ColorField label="Loading color" value={style.buttonLoadingColor} onChange={(value) => updateStyle({ buttonLoadingColor: value })} fallback="#12344D" />
          <label style={{ display: "grid", gap: 6 }}><span>Loading text</span><input className="input-field" value={style.buttonLoadingText} onChange={(e) => updateStyle({ buttonLoadingText: e.target.value })} /></label>
        </> : null}
        {selection === "error" ? <GenericFormStyleControls group="error" form={form} style={style} updateStyle={updateStyle} applyDraft={applyDraft} logoUploadRef={logoUploadRef} uploadingLogo={uploadingLogo} onLogoUpload={onLogoUpload} /> : null}
        {selection === "success" ? <GenericFormStyleControls group="success" form={form} style={style} updateStyle={updateStyle} applyDraft={applyDraft} logoUploadRef={logoUploadRef} uploadingLogo={uploadingLogo} onLogoUpload={onLogoUpload} /> : null}
      </div>
    </div>
  );
}

function GenericLiveCustomizationEditor({ form, fields, selection, onSelectionChange, applyDraft, logoUploadRef, uploadingLogo, onLogoUpload }) {
  const style = form.style;
  const livePreviewFrameRef = useRef(null);
  const [previewDevice, setPreviewDevice] = useState("desktop");
  const livePreviewSrcRef = useRef(buildWebFormPreviewUrl(form, typeof window !== "undefined" ? window.location.origin : "", { previewDevice }));
  const livePreviewSrc = livePreviewSrcRef.current;
  const formTitle = form.settings?.formTitle ?? form.formTitle ?? form.name ?? "";
  const [previewValues, setPreviewValues] = useState({});

  useEffect(() => {
    const handlePreviewMessage = (event) => {
      const frame = livePreviewFrameRef.current;
      if (
        !frame ||
        event.source !== frame.contentWindow ||
        !event.data ||
        event.data.source !== "gbs-web-form" ||
        event.data.type !== "size"
      ) return;
      const height = Number(event.data.height);
      if (!Number.isFinite(height) || height <= 0) return;
      frame.style.height = `${Math.ceil(height)}px`;
      frame.style.minHeight = "0px";
    };
    window.addEventListener("message", handlePreviewMessage);
    return () => window.removeEventListener("message", handlePreviewMessage);
  }, []);

  useEffect(() => {
    const frame = livePreviewFrameRef.current;
    if (!frame) return undefined;
    const sendPreviewUpdate = () => {
      frame.contentWindow?.postMessage({ source: "gbs-web-form-host", type: "preview-update", form, previewDevice }, "*");
    };
    frame.addEventListener("load", sendPreviewUpdate);
    sendPreviewUpdate();
    return () => frame.removeEventListener("load", sendPreviewUpdate);
  }, [form, previewDevice]);
  const fieldOptions = fields.filter((field) => field.fieldType !== "file");
  const previewOptionsFor = (field) => Array.isArray(field.options) && field.options.length ? field.options : splitOptions(field.optionsText);
  const previewValueFor = (field) => previewValues[String(field.id)] ?? "";
  const isPreviewFieldVisible = (field) => {
    if (!field.showWhen) return true;
    const parent = resolveConditionalParent(field, fieldOptions);
    return Boolean(parent) && String(previewValueFor(parent)) === String(field.showWhen.value ?? "");
  };
  const elementTextStyles = { ...GENERIC_ELEMENT_TEXT_DEFAULTS, ...(style.elementTextStyles || {}) };
  const updatePreviewValue = (field, value) => setPreviewValues((current) => ({ ...current, [String(field.id)]: value }));
  const updateStyle = (changes) => {
    const legacyTextFields = { fontFamily: "form", fontSize: "form", fontWeight: "form", labelFontSize: "label", placeholderFontSize: "placeholder", buttonFontSize: "button", errorFontSize: "error", successFontSize: "success" };
    const nextElementTextStyles = { ...elementTextStyles };
    Object.entries(legacyTextFields).forEach(([styleKey, elementKey]) => {
      if (Object.prototype.hasOwnProperty.call(changes, styleKey)) {
        nextElementTextStyles[elementKey] = { ...nextElementTextStyles[elementKey], ...(styleKey === "fontFamily" ? { fontFamily: changes[styleKey] } : styleKey === "fontWeight" ? { fontWeight: changes[styleKey] } : { fontSize: changes[styleKey] }) };
      }
    });
    const hasTextStyleChange = Object.keys(legacyTextFields).some((key) => Object.prototype.hasOwnProperty.call(changes, key));
    applyDraft({ style: { ...style, ...changes, ...(hasTextStyleChange ? { elementTextStyles: nextElementTextStyles } : {}) } });
  };
  const selectedTextStyle = elementTextStyles[selection] || elementTextStyles.form;
  const titleTextStyle = elementTextStyles.title;
  const labelTextStyle = elementTextStyles.label;
  const placeholderTextStyle = elementTextStyles.placeholder;
  const inputTextStyle = elementTextStyles.input;
  const buttonTextStyle = elementTextStyles.button;
  const updateSelectedTextStyle = (nextValue) => updateStyle({ elementTextStyles: { ...elementTextStyles, [selection]: nextValue } });
  const isLabelSelection = selection === "label";
  const isPlaceholderSelection = selection === "placeholder";
  const isInputSelection = selection === "input";

  return (
    <div className="wf-generic-live-editor">
      <div className="wf-generic-live-layout">
        <div className="wf-generic-live-preview-wrap" style={{ background: style.backgroundColor }}>
          <div className="wf-generic-live-preview-label">Preview</div>
          <div className="wf-generic-live-preview">
            <iframe ref={livePreviewFrameRef} title="Web form live preview" src={livePreviewSrc} style={{ width: "100%", height: "620px", minHeight: 0, border: 0, display: "block", background: "transparent" }} />
          </div>
          <div hidden>
            {style.logoUrl ? <img src={style.logoUrl} alt="Form logo" className="wf-generic-live-logo" onClick={(event) => { event.stopPropagation(); onSelectionChange("form"); }} /> : null}
            <h3 style={{ margin: "0 0 6px", color: style.titleColor, fontFamily: titleTextStyle.fontFamily, fontSize: `${titleTextStyle.fontSize}px`, fontWeight: titleTextStyle.fontWeight, fontStyle: titleTextStyle.fontStyle, textDecoration: titleTextStyle.textDecoration, textAlign: titleTextStyle.textAlign }} onClick={(event) => { event.stopPropagation(); onSelectionChange("title"); }}>{formTitle}</h3>
            {form.description ? <p style={{ margin: "0 0 16px", color: style.fieldLabelColor }}>{form.description}</p> : null}
            <div className="wf-generic-live-fields" style={{ width: `${Math.min(Math.max(Number(style.fieldWidth) || 100, 50), 100)}%` }}>
              {fieldOptions.filter(isPreviewFieldVisible).map((field) => (
                <div role="button" tabIndex={0} key={field.id} className={`wf-generic-live-field${isInputSelection ? " is-selected" : ""}`} onClick={(event) => { event.stopPropagation(); onSelectionChange("input"); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); onSelectionChange("input"); } }}>
                  <span className={isLabelSelection ? "is-selected" : ""} style={{ fontFamily: labelTextStyle.fontFamily, fontSize: `${labelTextStyle.fontSize}px`, fontWeight: labelTextStyle.fontWeight, fontStyle: labelTextStyle.fontStyle, textDecoration: labelTextStyle.textDecoration, textAlign: labelTextStyle.textAlign }} onClick={(event) => { event.stopPropagation(); onSelectionChange("label"); }}>{field.label}</span>
                  <div className="wf-generic-live-field-control">
                    {field.fieldType === "textarea" ? <textarea value={previewValueFor(field)} onChange={(event) => updatePreviewValue(field, event.target.value)} placeholder={field.placeholder || ""} style={{ fontFamily: inputTextStyle.fontFamily, fontSize: `${inputTextStyle.fontSize}px`, fontWeight: inputTextStyle.fontWeight, fontStyle: inputTextStyle.fontStyle, textDecoration: inputTextStyle.textDecoration, textAlign: inputTextStyle.textAlign, "--wf-live-placeholder-font": placeholderTextStyle.fontFamily, "--wf-live-placeholder-size": `${placeholderTextStyle.fontSize}px`, "--wf-live-placeholder-weight": placeholderTextStyle.fontWeight, "--wf-live-placeholder-style": placeholderTextStyle.fontStyle, "--wf-live-placeholder-decoration": placeholderTextStyle.textDecoration, "--wf-live-placeholder-align": placeholderTextStyle.textAlign, "--wf-live-placeholder-color": style.placeholderColor }} onClick={(event) => { event.stopPropagation(); onSelectionChange("placeholder"); }} /> : field.fieldType === "dropdown" || field.fieldType === "radio" || field.fieldType === "multiselect" ? <select value={previewValueFor(field)} onChange={(event) => updatePreviewValue(field, event.target.value)} style={{ fontFamily: inputTextStyle.fontFamily, fontSize: `${inputTextStyle.fontSize}px`, fontWeight: inputTextStyle.fontWeight, fontStyle: inputTextStyle.fontStyle, textDecoration: inputTextStyle.textDecoration, textAlign: inputTextStyle.textAlign }} onClick={(event) => { event.stopPropagation(); onSelectionChange("input"); }}><option value="">{field.placeholder || "Select an option"}</option>{previewOptionsFor(field).map((option) => <option key={option} value={option}>{option}</option>)}</select> : <input value={previewValueFor(field)} onChange={(event) => updatePreviewValue(field, event.target.value)} type={field.fieldType === "email" ? "email" : field.fieldType === "number" ? "number" : field.fieldType === "url" ? "url" : field.fieldType === "date" ? "date" : "text"} placeholder={field.placeholder || ""} style={{ fontFamily: inputTextStyle.fontFamily, fontSize: `${inputTextStyle.fontSize}px`, fontWeight: inputTextStyle.fontWeight, fontStyle: inputTextStyle.fontStyle, textDecoration: inputTextStyle.textDecoration, textAlign: inputTextStyle.textAlign, "--wf-live-placeholder-font": placeholderTextStyle.fontFamily, "--wf-live-placeholder-size": `${placeholderTextStyle.fontSize}px`, "--wf-live-placeholder-weight": placeholderTextStyle.fontWeight, "--wf-live-placeholder-style": placeholderTextStyle.fontStyle, "--wf-live-placeholder-decoration": placeholderTextStyle.textDecoration, "--wf-live-placeholder-align": placeholderTextStyle.textAlign, "--wf-live-placeholder-color": style.placeholderColor }} onClick={(event) => { event.stopPropagation(); onSelectionChange("placeholder"); }} />}
                  </div>
                </div>
              ))}
            </div>
            <button type="button" className={`wf-generic-live-submit${selection === "button" ? " is-selected" : ""}`} onClick={(event) => { event.stopPropagation(); onSelectionChange("button"); }} style={{ background: style.buttonColor, color: style.buttonTextColor, fontFamily: buttonTextStyle.fontFamily, fontSize: `${buttonTextStyle.fontSize}px`, fontWeight: buttonTextStyle.fontWeight, fontStyle: buttonTextStyle.fontStyle, textDecoration: buttonTextStyle.textDecoration, textAlign: buttonTextStyle.textAlign, height: `${style.buttonHeight}px`, borderRadius: `${style.buttonBorderRadius}px`, border: `${style.buttonBorderWidth}px solid ${style.buttonBorderColor}`, width: style.buttonWidth === "full" || style.buttonAlignment === "full" ? "100%" : "auto", display: "block", marginLeft: style.buttonAlignment === "center" ? "auto" : undefined, marginRight: style.buttonAlignment === "center" ? "auto" : undefined, float: style.buttonAlignment === "right" ? "right" : "none" }}>{form.settings.submitButtonLabel}</button>
           </div>
           </div>
         <div className="wf-generic-live-inspector">
          <div className="wf-generic-live-inspector-title">Customize selected element</div>
          <div className="wf-generic-live-elements">
            <button type="button" className={selection === "form" ? "is-selected" : ""} onClick={() => onSelectionChange("form")}>Form</button>
            <button type="button" className={selection === "title" ? "is-selected" : ""} onClick={() => onSelectionChange("title")}>Title</button>
            <button type="button" className={isLabelSelection ? "is-selected" : ""} onClick={() => onSelectionChange("label")}>Label</button>
            <button type="button" className={isPlaceholderSelection ? "is-selected" : ""} onClick={() => onSelectionChange("placeholder")}>Placeholder</button>
            <button type="button" className={isInputSelection ? "is-selected" : ""} onClick={() => onSelectionChange("input")}>Input box</button>
            <button type="button" className={selection === "button" ? "is-selected" : ""} onClick={() => onSelectionChange("button")}>Submit button</button>
            <button type="button" className={selection === "error" ? "is-selected" : ""} onClick={() => onSelectionChange("error")}>Error message</button>
            <button type="button" className={selection === "success" ? "is-selected" : ""} onClick={() => onSelectionChange("success")}>Success message</button>
            <button type="button" className={selection === "layout" ? "is-selected" : ""} onClick={() => onSelectionChange("layout")}>Layout</button>
            <button type="button" className={selection === "container" ? "is-selected" : ""} onClick={() => onSelectionChange("container")}>Form container</button>
          </div>
          {["title", "label", "placeholder", "input", "button", "error", "success"].includes(selection) ? <GenericElementTextControls element={selection} value={selectedTextStyle} onChange={updateSelectedTextStyle} /> : null}
          <div className="wf-generic-live-context-options">
            {selection === "form" ? <>
              <GenericFormStyleControls group="front" form={form} style={style} updateStyle={updateStyle} applyDraft={applyDraft} logoUploadRef={logoUploadRef} uploadingLogo={uploadingLogo} onLogoUpload={onLogoUpload} />
              <GenericFormStyleControls group="form" form={form} style={style} updateStyle={updateStyle} applyDraft={applyDraft} logoUploadRef={logoUploadRef} uploadingLogo={uploadingLogo} onLogoUpload={onLogoUpload} />
            </> : null}
            {selection === "layout" ? <GenericFormStyleControls group="layout" form={form} style={style} updateStyle={updateStyle} applyDraft={applyDraft} logoUploadRef={logoUploadRef} uploadingLogo={uploadingLogo} onLogoUpload={onLogoUpload} previewDevice={previewDevice} setPreviewDevice={setPreviewDevice} /> : null}
            {selection === "container" ? <GenericFormStyleControls group="container" form={form} style={style} updateStyle={updateStyle} applyDraft={applyDraft} logoUploadRef={logoUploadRef} uploadingLogo={uploadingLogo} onLogoUpload={onLogoUpload} /> : null}
            {selection === "title" ? <GenericFormStyleControls group="title" form={form} style={style} updateStyle={updateStyle} applyDraft={applyDraft} logoUploadRef={logoUploadRef} uploadingLogo={uploadingLogo} onLogoUpload={onLogoUpload} /> : null}
            {isLabelSelection ? <GenericFormStyleControls group="label" form={form} style={style} updateStyle={updateStyle} applyDraft={applyDraft} logoUploadRef={logoUploadRef} uploadingLogo={uploadingLogo} onLogoUpload={onLogoUpload} /> : null}
            {isPlaceholderSelection ? <>
              <GenericFormStyleControls group="placeholder" form={form} style={style} updateStyle={updateStyle} applyDraft={applyDraft} logoUploadRef={logoUploadRef} uploadingLogo={uploadingLogo} onLogoUpload={onLogoUpload} />
            </> : null}
            {isInputSelection ? <GenericFormStyleControls group="input" form={form} style={style} updateStyle={updateStyle} applyDraft={applyDraft} logoUploadRef={logoUploadRef} uploadingLogo={uploadingLogo} onLogoUpload={onLogoUpload} /> : null}
            {selection === "button" ? <>
              <ColorField label="Submit button color" value={style.buttonColor} onChange={(value) => updateStyle({ buttonColor: value })} fallback="#12344D" />
              <ColorField label="Hover color" value={style.buttonHoverColor} onChange={(value) => updateStyle({ buttonHoverColor: value })} fallback="#0D2639" />
              <ColorField label="Button text color" value={style.buttonTextColor} onChange={(value) => updateStyle({ buttonTextColor: value })} fallback="#FFFFFF" />
              <label style={{ display: "grid", gap: 6 }}><span style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>Button position</span><select className="input-field" value={style.buttonAlignment} onChange={(e) => updateStyle({ buttonAlignment: e.target.value })}><option value="left">Left</option><option value="center">Center</option><option value="right">Right</option><option value="full">Full width</option></select></label>
              <StyleNumberField label="Button height (px)" value={style.buttonHeight} min={30} max={96} onChange={(value) => updateStyle({ buttonHeight: value })} />
              <StyleNumberField label="Button radius (px)" value={style.buttonBorderRadius} min={0} max={40} onChange={(value) => updateStyle({ buttonBorderRadius: value })} />
              <ColorField label="Button border" value={style.buttonBorderColor} onChange={(value) => updateStyle({ buttonBorderColor: value })} fallback="#12344D" />
              <StyleNumberField label="Button border width (px)" value={style.buttonBorderWidth} min={0} max={8} onChange={(value) => updateStyle({ buttonBorderWidth: value })} />
              <label style={{ display: "grid", gap: 6 }}><span>Width</span><select className="input-field" value={style.buttonWidth} onChange={(e) => updateStyle({ buttonWidth: e.target.value })}><option value="auto">Auto</option><option value="full">Full width</option></select></label>
              <ColorField label="Loading color" value={style.buttonLoadingColor} onChange={(value) => updateStyle({ buttonLoadingColor: value })} fallback="#12344D" />
              <label style={{ display: "grid", gap: 6 }}><span>Loading text</span><input className="input-field" value={style.buttonLoadingText} onChange={(e) => updateStyle({ buttonLoadingText: e.target.value })} /></label>
            </> : null}
            {selection === "error" ? <GenericFormStyleControls group="error" form={form} style={style} updateStyle={updateStyle} applyDraft={applyDraft} logoUploadRef={logoUploadRef} uploadingLogo={uploadingLogo} onLogoUpload={onLogoUpload} /> : null}
            {selection === "success" ? <GenericFormStyleControls group="success" form={form} style={style} updateStyle={updateStyle} applyDraft={applyDraft} logoUploadRef={logoUploadRef} uploadingLogo={uploadingLogo} onLogoUpload={onLogoUpload} /> : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function FieldCard({ field, index, allFields, conditionalFlowFields = [], leadFields, scope, onChange, onMove, onRemove, phoneSettings, onPhoneSettingsChange, onAddConditionalChild, steps = [], multiStepEnabled = false, formScope = scope || "generic", formSettings, onFormSettingsChange }) {















  const supportsAdvancedFeatures = supportsAdvancedWebFormFeatures(scope);
  const isConditional = supportsAdvancedFeatures && Boolean(field.showWhen && (field.showWhen.fieldId || field.showWhen.fieldKey));
  const isChoice = CHOICE_FIELD_TYPES.has(field.fieldType);
  const [countryPickerOpen, setCountryPickerOpen] = useState(false);
  const [countrySearch, setCountrySearch] = useState("");
  const [countryPickerOrder, setCountryPickerOrder] = useState(PHONE_COUNTRY_OPTIONS);
  const countryPickerRef = useRef(null);

  const toggleCountryPicker = () => {
    if (countryPickerOpen) {
      setCountryPickerOpen(false);
      return;
    }

    const selectedCountries = new Set(phoneSettings?.phoneAllowAllCountries === false ? (phoneSettings.phoneAllowedCountries || []) : []);
    setCountryPickerOrder([...PHONE_COUNTRY_OPTIONS].sort(([codeA], [codeB]) => Number(selectedCountries.has(codeB)) - Number(selectedCountries.has(codeA))));
    setCountrySearch("");
    setCountryPickerOpen(true);
  };

  useEffect(() => {
    if (!countryPickerOpen) return undefined;

    const handleOutsideCountryPickerClick = (event) => {
      if (!countryPickerRef.current?.contains(event.target)) {
        setCountryPickerOpen(false);
      }
    };

    document.addEventListener("pointerdown", handleOutsideCountryPickerClick);
    return () => document.removeEventListener("pointerdown", handleOutsideCountryPickerClick);
  }, [countryPickerOpen]);

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: String(field.id) });

  const fieldCardStyle = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.92 : 1,
    boxShadow: isDragging ? "0 12px 24px rgba(0, 0, 0, 0.12)" : undefined,
  };
















  const editableFieldTypes = FIELD_TYPE_OPTIONS.filter((item) => item.value !== "file");

  const optionList = field.sourceKind === "lead_custom"















    ? leadFields.find((item) => item.fieldKey === field.sourceKey)?.options || []















    : field.sourceKind === "custom"

      ? splitOptions(field.optionsText)

      : CONTACT_FIELD_DEFAULTS[field.sourceKey]?.options || [];

  const getConditionalOptions = (candidate) => {
    if (!candidate) return [];
    if (candidate.fieldType === "checkbox") return ["true"];
    if (candidate.sourceKind === "lead_custom") {
      const leadOptions = leadFields.find((item) => item.fieldKey === candidate.sourceKey)?.options || [];
      return leadOptions.length ? leadOptions : splitOptions(candidate.optionsText);
    }
    if (candidate.sourceKind === "custom") return splitOptions(candidate.optionsText);
    if (CHOICE_FIELD_TYPES.has(candidate.fieldType)) {
      const configuredOptions = splitOptions(candidate.optionsText);
      return configuredOptions.length ? configuredOptions : CONTACT_FIELD_DEFAULTS[candidate.sourceKey]?.options || [];
    }
    return [];
  };
  const conditionalParentFields = supportsAdvancedFeatures
    ? (conditionalFlowFields.length ? conditionalFlowFields : allFields).filter((candidate) => (
      String(candidate.id) !== String(field.id) &&
      !candidate.hidden &&
      candidate.fieldType !== "file" &&
      getConditionalOptions(candidate).length > 0 &&
      !createsConditionalCycle(candidate, field, allFields)
    ))
    : [];
  const selectedConditionalField = resolveConditionalParent(field, conditionalParentFields) || null;
  const conditionalOptions = getConditionalOptions(selectedConditionalField);
  const branchOptions = supportsAdvancedFeatures ? getConditionalOptions(field) : [];
  const conditionalDepth = isConditional ? getConditionalDepth(field, allFields) : 0;
  const conditionalPath = isConditional ? getConditionalPath(field, allFields) : [];
  const fieldTypeOptions = editableFieldTypes;















  const controlValue = fieldControlValue(field);















  const [formatPickerOpen, setFormatPickerOpen] = useState(false);
  const [domainDraft, setDomainDraft] = useState({ blockedEmailDomains: "", allowedEmailDomains: "" });

  useEffect(() => {
    const closeDomainPickers = (event) => {
      document.querySelectorAll("details[data-email-domain-picker][open]").forEach((picker) => {
        if (!picker.contains(event.target)) picker.removeAttribute("open");
      });
    };
    document.addEventListener("click", closeDomainPickers);
    return () => document.removeEventListener("click", closeDomainPickers);
  }, []);

  const updateDomainList = (key, domain, checked) => {
    if (!formSettings || !onFormSettingsChange) return;
    const current = Array.isArray(formSettings[key]) ? formSettings[key] : [];
    const disabledKey = key === "blockedEmailDomains" ? "disabledBlockedEmailDomains" : "disabledAllowedEmailDomains";
    const disabled = Array.isArray(formSettings[disabledKey]) ? formSettings[disabledKey] : [];
    const nextDisabled = checked ? disabled.filter((item) => item !== domain) : [...new Set([...disabled, domain])];
    onFormSettingsChange({ ...formSettings, [key]: [...new Set([...current, domain])], [disabledKey]: nextDisabled });
  };

  const addDomain = (key) => {
    const domain = String(domainDraft[key] || "").trim().toLowerCase().replace(/^@+/, "").replace(/\.+$/, "");
    if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(domain)) return;
    const current = Array.isArray(formSettings?.[key]) ? formSettings[key] : [];
    if (!current.includes(domain)) onFormSettingsChange({ ...formSettings, [key]: [...current, domain] });
    setDomainDraft((value) => ({ ...value, [key]: "" }));
  };















  const selectedFormats = Array.isArray(field.fileFormats) && field.fileFormats.length ? field.fileFormats : DEFAULT_FILE_FORMATS;































  if (field.fieldType === "file") {















    return (















      <div ref={setNodeRef} className="wf-field-card wf-file-card" style={fieldCardStyle}>















        <div className="wf-file-top-row">















          <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>















            <button type="button" aria-label={"Drag " + (field.label || "field") + " to reorder"} title="Drag to reorder" {...attributes} {...listeners} onClick={(e) => e.stopPropagation()} style={{ background: "none", border: "none", padding: 0, color: "var(--text-secondary)", flexShrink: 0, cursor: "grab", touchAction: "none", display: "inline-flex", alignItems: "center", justifyContent: "center" }}><GripVertical size={18} style={{ color: "var(--text-secondary)", flexShrink: 0 }} /></button>















            <div className="wf-file-icon"><Paperclip size={18} /></div>















            <strong style={{ color: "var(--text-primary)", whiteSpace: "nowrap" }}>File attachment</strong>















          </div>















          <label className="wf-file-label">















            <span>Enter a label for file upload</span>















            <input className="input-field" value={field.label} onChange={(e) => onChange(index, { label: e.target.value })} placeholder="Upload your file" />















          </label>















          <label style={{ display: "inline-flex", alignItems: "center", gap: 8, color: "var(--text-primary)", whiteSpace: "nowrap" }}>















            <input type="checkbox" checked={field.required} onChange={(e) => onChange(index, { required: e.target.checked })} />















            Required















          </label>















          <button type="button" className="btn-secondary" onClick={() => onRemove(index)} title="Delete field" style={{ padding: "0.55rem 0.65rem", justifySelf: "end" }}>















            <Trash2 size={15} />















          </button>















        </div>































        <div className="wf-file-options">















          <div className="wf-file-format-wrap">















            <div style={{ fontWeight: 700, color: "var(--text-primary)", marginBottom: 6 }}>File formats allowed</div>















            <button type="button" className="wf-file-format-trigger" onClick={() => setFormatPickerOpen((open) => !open)}>















              {fileFormatSummary(selectedFormats)} <ChevronDown size={14} />















            </button>















            {formatPickerOpen ? (















              <div className="wf-file-format-menu">















                <input className="input-field" placeholder="Search" readOnly />















                <div style={{ display: "flex", gap: 8, margin: "10px 0", fontSize: 13 }}>















                  <button type="button" className="wf-link-button" onClick={() => onChange(index, { fileFormats: FILE_FORMAT_OPTIONS.map((item) => item.value) })}>Select all</button>















                  <span style={{ color: "var(--text-secondary)" }}>-</span>















                  <button type="button" className="wf-link-button" onClick={() => onChange(index, { fileFormats: [] })}>Clear</button>















                </div>















                <div className="wf-file-format-list">















                  {FILE_FORMAT_OPTIONS.map((item) => (















                    <label key={item.value} className="wf-file-format-option">















                      <input type="checkbox" checked={selectedFormats.includes(item.value)} onChange={() => onChange(index, { fileFormats: toggleFormat(selectedFormats, item.value) })} />















                      {item.value}















                    </label>















                  ))}















                </div>















                <div className="wf-file-format-footer">















                  <button type="button" className="btn-secondary" onClick={() => setFormatPickerOpen(false)}>Cancel</button>















                  <button type="button" className="btn-primary" onClick={() => setFormatPickerOpen(false)}>Apply</button>















                </div>















              </div>















            ) : null}















          </div>































          <div>















            <div style={{ fontWeight: 700, color: "var(--text-primary)", marginBottom: 8 }}>Allow upload of multiple files?</div>















            <div style={{ display: "flex", gap: 16, color: "var(--text-primary)" }}>















              <label style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>















                <input type="radio" name={`multi-${field.id}`} checked={Boolean(field.allowMultipleFiles)} onChange={() => onChange(index, { allowMultipleFiles: true })} />















                Yes















              </label>















              <label style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>















                <input type="radio" name={`multi-${field.id}`} checked={!field.allowMultipleFiles} onChange={() => onChange(index, { allowMultipleFiles: false })} />















                No















              </label>















            </div>















          </div>































          <label className="wf-file-tags">















            <span>Add tags to uploaded files</span>















            <input className="input-field" value={field.fileTagsText || ""} onChange={(e) => onChange(index, { fileTagsText: e.target.value })} placeholder="Click to add" />















          </label>















        </div>















      </div>















    );















  }































  return (















    <div ref={setNodeRef} className="wf-field-card" style={{ ...fieldCardStyle, overflow: supportsAdvancedWebFormFeatures(formScope) && field.sourceKind === "contact" && field.sourceKey === "email" ? "visible" : undefined }}>















      <div className="wf-field-grid">















        <div style={{ display: "flex", gap: 10, alignItems: "center", minWidth: 0 }}>















          <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "center", color: "var(--text-secondary)", flexShrink: 0 }}>















            <button type="button" className="btn-secondary" onClick={() => onMove(index, -1)} disabled={index === 0} title="Move up" style={{ padding: "0.3rem 0.4rem", minWidth: 32 }}>















              <ArrowUp size={13} />















            </button>















            <button type="button" aria-label={"Drag " + (field.label || "field") + " to reorder"} title="Drag to reorder" {...attributes} {...listeners} onClick={(e) => e.stopPropagation()} style={{ background: "none", border: "none", padding: 0, color: "var(--text-secondary)", cursor: "grab", touchAction: "none", display: "inline-flex", alignItems: "center", justifyContent: "center" }}><GripVertical size={18} /></button>















            <button type="button" className="btn-secondary" onClick={() => onMove(index, 1)} title="Move down" style={{ padding: "0.3rem 0.4rem", minWidth: 32 }}>















              <ArrowDown size={13} />















            </button>















          </div>















          <div style={{ minWidth: 0 }}>















            <div style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "0.16rem 0.45rem", borderRadius: 6, background: "var(--wf-badge-bg)", border: "1px solid var(--wf-badge-border)", color: "var(--wf-badge-text)", fontSize: 12, lineHeight: 1.2, marginBottom: 8 }}>















              {fieldTypeIcon(field.fieldType)}















              <span>{fieldKindLabel(field)}</span>















            </div>















            <div style={{ fontWeight: 700, color: "var(--text-primary)", lineHeight: 1.3, wordBreak: "break-word" }}>{field.label || `Field ${index + 1}`}</div>















          </div>















        </div>































        <div data-testid="wf-field-editor-grid" className={`wf-field-editor-grid${supportsAdvancedWebFormFeatures(formScope) ? " wf-generic-field-editor-grid" : ""}`} style={{ display: "grid", gridTemplateColumns: field.hidden ? "minmax(220px, 1fr) minmax(220px, max-content)" : "minmax(220px, 1fr) minmax(180px, 0.8fr) minmax(260px, max-content)", gap: 10, minWidth: 0, alignItems: "start" }}>















          <label className="wf-generic-field-label" style={{ display: "grid", gap: 6, minWidth: 0 }}>















            <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)" }}>Field label in form</span>















            <input className="input-field" value={field.label} onChange={(e) => onChange(index, { label: e.target.value })} placeholder="Field label" />















          </label>















          {multiStepEnabled && steps.length > 0 ? (
            <label className="wf-generic-field-step" style={{ display: "grid", gap: 6, minWidth: 0 }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)" }}>Form step</span>
              <select className="input-field" value={field.stepId || steps[0].id} onChange={(e) => onChange(index, { stepId: e.target.value })}>
                {steps.map((step, stepIndex) => <option key={step.id} value={step.id}>{step.title || `Step ${stepIndex + 1}`}</option>)}
              </select>
            </label>
          ) : null}

          {field.hidden ? (

            <label className="wf-generic-field-default" style={{ display: "grid", gap: 6, minWidth: 0 }}>

              <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)" }}>Select a default value for this hidden field</span>

              {isChoice ? (

                <select className="input-field" value={controlValue} onChange={(e) => onChange(index, { defaultValue: e.target.value })}>

                  <option value="">Click to select</option>

                  {optionList.map((opt) => <option key={opt} value={opt}>{opt}</option>)}

                </select>

              ) : field.fieldType === "checkbox" ? (

                <select className="input-field" value={controlValue} onChange={(e) => onChange(index, { defaultValue: e.target.value })}>

                  <option value="false">False</option>

                  <option value="true">True</option>

                </select>

              ) : field.fieldType === "date" ? (

                <input className="input-field" type="date" value={controlValue} onChange={(e) => onChange(index, { defaultValue: e.target.value })} />

              ) : field.fieldType === "number" ? (

                <input className="input-field" type="number" value={controlValue} onChange={(e) => onChange(index, { defaultValue: e.target.value })} placeholder="Default value" />

              ) : field.fieldType === "url" ? (

                <input className="input-field" type="url" value={controlValue} onChange={(e) => onChange(index, { defaultValue: e.target.value })} placeholder="Default value" />

              ) : field.fieldType === "email" ? (

                <input className="input-field" type="email" value={controlValue} onChange={(e) => onChange(index, { defaultValue: e.target.value })} placeholder="Default value" />

              ) : (

                <input className="input-field" value={controlValue} onChange={(e) => onChange(index, { defaultValue: e.target.value })} placeholder="Default value" />

              )}

            </label>

          ) : (

            <div className="wf-generic-field-controls" style={{ display: "grid", gridTemplateColumns: "minmax(160px, 0.8fr) minmax(200px, 1fr)", gap: 10, minWidth: 0, alignItems: "start" }}>

              <label className="wf-generic-field-type" style={{ display: "grid", gap: 6, minWidth: 0 }}>

                <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)" }}>Field type</span>

                <select
                  className="input-field"
                  value={field.fieldType}
                  onChange={(e) => {
                    const nextType = e.target.value;
                    onChange(index, {
                      fieldType: nextType,
                      showWhen: field.showWhen || null,
                      optionsText: CHOICE_FIELD_TYPES.has(nextType) ? field.optionsText || "" : "",
                    });
                  }}
                >
                  {fieldTypeOptions.map((item) => (
                    <option key={item.value} value={item.value} disabled={item.disabled}>
                      {item.label}
                    </option>
                  ))}
                </select>

              </label>

              {isChoice ? (

                <label className="wf-generic-field-secondary" style={{ display: "grid", gap: 6, minWidth: 0 }}>

                  <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)" }}>Options</span>

                  <textarea className="input-field wf-generic-options-input" rows={2} value={field.optionsText || ""} onChange={(e) => onChange(index, { optionsText: e.target.value })} placeholder="Type one option per line (or use commas)" />

                </label>

              ) : (

                <label className="wf-generic-field-secondary" style={{ display: "grid", gap: 6, minWidth: 0 }}>

                  <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)" }}>Placeholder</span>

                  <input className="input-field" value={field.placeholder} onChange={(e) => onChange(index, { placeholder: e.target.value })} placeholder={fieldPlaceholderHint(field)} />

                </label>

              )}

            </div>

          )}
















          <div className="wf-field-editor-actions" style={{ display: "flex", alignItems: "center", gap: 10, justifyContent: "flex-end", flexWrap: phoneSettings || (field.sourceKind === "contact" && field.sourceKey === "email" && supportsAdvancedFeatures) ? "wrap" : "nowrap", flexDirection: "row", minWidth: 0, width: phoneSettings || (field.sourceKind === "contact" && field.sourceKey === "email" && supportsAdvancedFeatures) ? "100%" : "max-content", gridColumn: phoneSettings || (field.sourceKind === "contact" && field.sourceKey === "email" && supportsAdvancedFeatures) ? "1 / -1" : "auto", justifySelf: "end", alignSelf: "start" }}>















            <label style={{ display: "inline-flex", alignItems: "center", gap: 8, color: "var(--text-secondary)", fontSize: 14, whiteSpace: "nowrap", lineHeight: 1.35 }}>















              <input type="checkbox" checked={field.required} onChange={(e) => onChange(index, { required: e.target.checked })} />















              Required















            </label>















            <label style={{ display: "inline-flex", alignItems: "center", gap: 8, color: "var(--text-secondary)", fontSize: 14, whiteSpace: "nowrap", lineHeight: 1.35 }}>















              <input type="checkbox" checked={field.hidden} onChange={(e) => onChange(index, { hidden: e.target.checked })} />















              Hidden in form














            </label>

            {field.sourceKey === "phone" && phoneSettings ? (
              <div className="wf-phone-country-controls" style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "var(--text-primary)", fontSize: 13, whiteSpace: "nowrap", paddingTop: 2 }}>
                <span style={{ fontWeight: 700 }}>Countries:</span>
                  <div ref={countryPickerRef} className="wf-country-picker">
                    <button type="button" className="wf-country-picker-trigger" onClick={toggleCountryPicker} aria-expanded={countryPickerOpen}>
                      <span>{phoneSettings.phoneAllowAllCountries !== false ? "All" : `${(phoneSettings.phoneAllowedCountries || []).length} selected`}</span>
                      <ChevronDown size={13} />
                    </button>
                    {countryPickerOpen ? (
                      <div className="wf-country-picker-panel">
                        <input className="wf-country-picker-search" value={countrySearch} onChange={(e) => setCountrySearch(e.target.value)} placeholder="Search countries" aria-label="Search countries" />
                        <div className="wf-country-picker-actions">
                          <button type="button" className="wf-country-picker-clear" onClick={() => onPhoneSettingsChange({ ...phoneSettings, phoneAllowAllCountries: true, phoneAllowedCountries: [] })}>Select all</button>
                          <button type="button" className="wf-country-picker-clear" onClick={() => onPhoneSettingsChange({ ...phoneSettings, phoneAllowAllCountries: false, phoneAllowedCountries: [] })}>Clear all</button>
                        </div>
                        <div className="wf-country-picker-options">
                          {countryPickerOrder.filter(([code, name]) => `${code} ${name}`.toLowerCase().includes(countrySearch.trim().toLowerCase())).map(([code, name]) => {
                            const selected = phoneSettings.phoneAllowAllCountries === false && (phoneSettings.phoneAllowedCountries || []).includes(code);
                            return <label key={code} className="wf-country-picker-option"><input type="checkbox" checked={phoneSettings.phoneAllowAllCountries !== false || selected} onChange={() => { const nextAllowedCountries = selected ? (phoneSettings.phoneAllowedCountries || []).filter((item) => item !== code) : [...(phoneSettings.phoneAllowedCountries || []), code]; onPhoneSettingsChange({ ...phoneSettings, phoneAllowAllCountries: nextAllowedCountries.length === 0, phoneAllowedCountries: nextAllowedCountries }); }} /><span>{code} - {name}</span></label>;
                          })}
                          {!countryPickerOrder.some(([code, name]) => `${code} ${name}`.toLowerCase().includes(countrySearch.trim().toLowerCase())) ? <div className="wf-country-picker-empty">No countries found</div> : null}
                        </div>
                      </div>
                    ) : null}
                  </div>
              </div>
            ) : null}















            {supportsAdvancedFeatures && field.sourceKind === "contact" && field.sourceKey === "email" && formSettings && onFormSettingsChange ? (
                <div className="wf-email-validation-controls" style={{ display: "inline-flex", alignItems: "center", justifyContent: "flex-end", gap: 8, flexWrap: "wrap", flexBasis: "100%", order: 2, color: "var(--text-primary)", fontSize: 13, whiteSpace: "nowrap" }}>
                <label style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><span className="wf-email-validation-label">Email validation</span>
                  <select className="input-field" style={{ width: 150, padding: "0.35rem 0.45rem" }} value={formSettings.emailValidationType || "all"} onChange={(e) => onFormSettingsChange({ ...formSettings, emailValidationType: e.target.value })}>
                    <option value="all">Allow all email addresses</option><option value="company">Company email only</option>
                  </select>
                </label>
                {formSettings.emailValidationType === "company" ? ["blockedEmailDomains", "allowedEmailDomains"].map((key) => {
                  const label = key === "blockedEmailDomains" ? "Blocked" : "Allowed";
                  const domains = Array.isArray(formSettings[key]) ? formSettings[key] : [];
                  const disabledKey = key === "blockedEmailDomains" ? "disabledBlockedEmailDomains" : "disabledAllowedEmailDomains";
                  const disabled = Array.isArray(formSettings[disabledKey]) ? formSettings[disabledKey] : [];
                  return <details key={key} data-email-domain-picker="true" style={{ position: "relative" }}><summary style={{ cursor: "pointer" }}>{label} ({domains.filter((domain) => !disabled.includes(domain)).length})</summary><div className="wf-email-domain-popover" style={{ position: "absolute", right: 0, top: "100%", zIndex: 1000, minWidth: 230, maxHeight: 230, overflowY: "auto", marginTop: 6, padding: 10, border: "1px solid var(--border-color)", borderRadius: 8, background: "var(--wf-popover-bg, #fff)", boxShadow: "0 8px 20px rgba(0,0,0,.14)", opacity: 1 }}><div style={{ display: "grid", gap: 6 }}>{domains.map((domain) => <label key={domain} style={{ display: "flex", alignItems: "center", gap: 6 }}><input type="checkbox" checked={!disabled.includes(domain)} onChange={(e) => updateDomainList(key, domain, e.target.checked)} />{domain}</label>)}</div><div style={{ position: "sticky", bottom: 0, display: "flex", gap: 5, marginTop: 8, paddingTop: 8, background: "var(--wf-popover-bg, #fff)" }}><input className="input-field" style={{ minWidth: 0, padding: "0.35rem" }} value={domainDraft[key]} onChange={(e) => setDomainDraft((value) => ({ ...value, [key]: e.target.value }))} placeholder="customdomain.com" /><button type="button" className="btn-secondary" onClick={() => addDomain(key)}>Add</button></div></div></details>;
                }) : null}
                <label style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><input type="checkbox" checked={Boolean(formSettings.emailMxValidation)} onChange={(e) => onFormSettingsChange({ ...formSettings, emailMxValidation: e.target.checked })} />Valid MX</label>
              </div>
            ) : null}

            <button type="button" className="btn-secondary" onClick={() => onRemove(index)} title="Delete field" style={{ padding: "0.55rem 0.65rem", color: "var(--text-secondary)", borderColor: "var(--border-color)", background: "var(--surface-hover)" }}>















              <Trash2 size={15} />















            </button>















          </div>
        </div>































        {supportsAdvancedFeatures && isConditional ? (

          <div className="wf-conditional-config" style={{ gridColumn: "1 / -1", marginTop: 14, paddingTop: 14, borderTop: "1px solid var(--wf-border)", display: "grid", gridTemplateColumns: "minmax(220px, 1fr) minmax(180px, 0.8fr)", gap: 10 }}>

            <div style={{ gridColumn: "1 / -1", fontSize: 12, color: "var(--text-secondary)", fontWeight: 600 }}>
              Conditional level {conditionalDepth}{conditionalPath.length > 1 ? ` · ${conditionalPath.join(" → ")}` : ""}
            </div>

            <label className="wf-conditional-parent-select" style={{ display: "grid", gap: 6, minWidth: 0 }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)" }}>Parent question</span>
              <select
                className="input-field"
                value={field.showWhen?.fieldId || ""}
                onChange={(e) => {
                   const parent = conditionalParentFields.find((candidate) => String(candidate.id) === e.target.value);
                  const options = getConditionalOptions(parent);
                  onChange(index, { showWhen: parent ? { fieldId: parent.id, fieldKey: parent.sourceKey, parentQuestion: parent.label, value: options[0] || "" } : null });
                }}
              >
                <option value="">Select the root question</option>
                 {conditionalParentFields.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.label}</option>)}
              </select>
            </label>

            {selectedConditionalField ? (
              <label className="wf-conditional-answer-select" style={{ display: "grid", gap: 6, minWidth: 0 }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)" }}>Child answer</span>
                {conditionalOptions.length > 0 ? (
                  <select
                    className="input-field"
                    value={field.showWhen?.value || ""}
                    onChange={(e) => onChange(index, { showWhen: { ...field.showWhen, value: e.target.value } })}
                  >
                    {conditionalOptions.map((option) => <option key={option} value={option}>{option}</option>)}
                  </select>
                ) : (
                  <input
                    className="input-field"
                    value={field.showWhen?.value || ""}
                    onChange={(e) => onChange(index, { showWhen: { ...field.showWhen, value: e.target.value } })}
                    placeholder="Enter the value that should show this field"
                  />
                )}
              </label>
            ) : null}

          </div>

        ) : null}

        {supportsAdvancedFeatures && branchOptions.length > 0 && onAddConditionalChild ? (
          <div style={{ gridColumn: "1 / -1", marginTop: 14, paddingTop: 14, borderTop: "1px dashed var(--wf-border)", display: "grid", gap: 8 }}>
            <div style={{ fontSize: 12, color: "var(--text-secondary)", fontWeight: 700 }}>
              Add a child question for an answer
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {branchOptions.map((option) => (
                <button
                  key={option}
                  type="button"
                  className="btn-secondary"
                  onClick={() => onAddConditionalChild(field.id, option)}
                  style={{ fontSize: 12, padding: "0.45rem 0.65rem" }}
                >
                  + {option}
                </button>
              ))}
            </div>
          </div>
        ) : null}
































        {field.fieldType === "file" ? <div style={{ marginTop: 12, fontSize: 12, color: "var(--text-secondary)" }}>File uploads are stored as contact attachments on submit.</div> : null}















      </div>
    </div>















  );















}































function FieldPicker({ open, anchorRef, leadFields, existingFields = [], scope = "generic", onPick, onClose }) {















  const [search, setSearch] = useState("");

  const existingFieldKeys = new Set((existingFields || []).map((field) => `${field.sourceKind || "custom"}:${String(field.sourceKey || "")}`));















  const panelRef = useRef(null);































  useEffect(() => {















    if (!open) {















      setSearch("");















      return undefined;















    }















    const handleOutside = (event) => {















      const insideAnchor = anchorRef.current && anchorRef.current.contains(event.target);















      const insidePanel = panelRef.current && panelRef.current.contains(event.target);















      if (!insideAnchor && !insidePanel) onClose();















    };















    const handleKey = (event) => {















      if (event.key === "Escape") onClose();















    };















    document.addEventListener("mousedown", handleOutside);















    document.addEventListener("keydown", handleKey);















    return () => {















      document.removeEventListener("mousedown", handleOutside);















      document.removeEventListener("keydown", handleKey);















    };















  }, [anchorRef, onClose, open]);































  const query = search.trim().toLowerCase();















  const matches = (label, value = "") => !query || `${label} ${value}`.toLowerCase().includes(query);















  const contactFieldOptions = scope === "generic" ? GENERIC_CONTACT_FIELD_OPTIONS : CONTACT_FIELD_OPTIONS;
  const contactItems = contactFieldOptions.filter((item) => matches(item.label, item.value) && !existingFieldKeys.has(`contact:${item.value}`));
  const automaticItems = scope === "generic" ? GENERIC_AUTOMATIC_TABLE_FIELDS.filter((item) => matches(item.label, item.value)) : [];















  const leadItems = (() => {
    const seen = new Set((leadFields || []).map((item) => item.fieldKey));
    const effective = [...(leadFields || []), ...FALLBACK_LEAD_CUSTOM_FIELDS.filter((item) => !seen.has(item.fieldKey))];
    return effective.filter((item) => matches(item.label, item.fieldKey) && !existingFieldKeys.has(`lead_custom:${item.fieldKey}`));
  })();















  // Temporarily HIDDEN (NOT deleted): set to `true` to re-enable the
  // "Custom inputs" picker section below. Already-added custom fields in
  // existing forms keep rendering — this only hides the picker entries.
  const SHOW_CUSTOM_INPUTS = false;
  const customItems = SHOW_CUSTOM_INPUTS
    ? CUSTOM_FIELD_TEMPLATES.filter((item) => matches(item.label, item.helper))
    : [];































  if (!open) return null;































  return (















    <div ref={panelRef} className="wf-field-picker">















      <div className="wf-field-picker-search">















        <Search size={14} />















        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Type to search" className="input-field" autoFocus />















      </div>















      <div className="wf-field-picker-list">















        <div className="wf-field-picker-heading">CONTACT FIELDS</div>















        {contactItems.length || leadItems.length || automaticItems.length ? (















          <>















            {contactItems.map((item) => (















              <button key={item.value} type="button" className="wf-field-picker-item" onClick={() => onPick({ kind: "contact", sourceKey: item.value, label: item.label, fieldType: item.fieldType, placeholder: item.placeholder || "", options: item.options || [] })}>















                <span>{item.label}</span>















                <small>{item.value}</small>















              </button>















            ))}















            {leadItems.map((item) => (















              <button key={item.fieldKey} type="button" className="wf-field-picker-item" onClick={() => onPick({ kind: "lead_custom", sourceKey: item.fieldKey, label: item.label, fieldType: item.fieldType, options: item.options || [], placeholder: item.placeholder || "" })}>















                <span>{item.label}</span>















                <small>custom</small>















              </button>















            ))}















          </>















        ) : <div className="wf-field-picker-empty">No matching fields.</div>}

        {automaticItems.length > 0 ? (
          <>
            <div className="wf-field-picker-heading">AUTOMATICALLY CAPTURED</div>
            {automaticItems.map((item) => (
              <div key={item.value} className="wf-field-picker-item" style={{ opacity: 0.62, cursor: "default" }} title="Captured automatically when the form is submitted">
                <span>{item.label}</span>
                <small>automatic</small>
              </div>
            ))}
          </>
        ) : null}































        {customItems.length > 0 && (<div className="wf-field-picker-heading">Custom inputs</div>)}















        {customItems.map((item) => (















          <button key={item.fieldType} type="button" className="wf-field-picker-item" onClick={() => onPick({ kind: "custom", fieldType: item.fieldType, label: item.label })}>















            <span>{item.label}</span>















            <small>{item.helper}</small>















          </button>















        ))}















      </div>















    </div>















  );















}















export default function WebForms({ scope = "generic" }) {
  if (scope !== "travel" && scope !== "generic") return null;
  return <WebFormsContent scope={scope} />;
}

function WebFormsContent({ scope = "generic" }) {
  const auth = useContext(AuthContext);
  const [leadsForm, setLeadsForm] = useState(null);
  const canViewFormLeads = scope === "generic" && (auth?.tenant?.vertical || auth?.user?.vertical || "generic") === "generic";













































  const formScope = scope === "travel" ? "travel" : "generic";
  const scopeQuery = formScope === "generic" ? "" : `?scope=${encodeURIComponent(formScope)}`;
  const isGenericScope = formScope === "generic";















  const notify = useNotify();
  const notifyRef = useRef(notify);
  useEffect(() => {
    notifyRef.current = notify;
  }, [notify]);















  const origin = typeof window !== "undefined" ? window.location.origin : "https://crm.globusdemos.com";















  const [forms, setForms] = useState([]);















  const [leadFields, setLeadFields] = useState([]);















  const [loading, setLoading] = useState(true);















  const [selectedForm, setSelectedForm] = useState(null);
  const [activeBuilderStepId, setActiveBuilderStepId] = useState("step-1");
  const [pageDialog, setPageDialog] = useState(null);
  const [genericStyleSelection, setGenericStyleSelection] = useState("form");

  const [builderOpen, setBuilderOpen] = useState(false);















  const [dirty, setDirty] = useState(false);















  const [saving, setSaving] = useState(false);
  const [uploadingLogo, setUploadingLogo] = useState(false);















  const [search, setSearch] = useState("");















  const [showEmbed, setShowEmbed] = useState(false);

  // Landing-page hero form (generic scope only): which form the public
  // marketing page embeds + whether this user may change it (server-side
  // LANDING_FORM_ADMIN_EMAILS allowlist — the per-card control below only
  // renders for allowlisted logins).
  const [landingFormId, setLandingFormId] = useState(null);
  const [canManageLandingForm, setCanManageLandingForm] = useState(false);
  const [settingLandingFormId, setSettingLandingFormId] = useState(null);















  const [showPreview, setShowPreview] = useState(false);
  const previewFrameRef = useRef(null);

  useEffect(() => {
    if (!showPreview) return undefined;
    const handlePreviewMessage = (event) => {
      const frame = previewFrameRef.current;
      if (
        !frame ||
        event.source !== frame.contentWindow ||
        !event.data ||
        event.data.source !== "gbs-web-form" ||
        event.data.type !== "size"
      ) return;
      const height = Number(event.data.height);
      if (!Number.isFinite(height) || height <= 0) return;
      frame.style.height = `${Math.ceil(height)}px`;
      frame.style.minHeight = "0px";
    };
    window.addEventListener("message", handlePreviewMessage);
    return () => window.removeEventListener("message", handlePreviewMessage);
  }, [showPreview]);















  const [showOptInLinkEditor, setShowOptInLinkEditor] = useState(false);















  const [optInLinkDraft, setOptInLinkDraft] = useState({ text: "", url: "" });
  const [optInLinkPosition, setOptInLinkPosition] = useState({ top: 0, left: 0, width: 340 });















  const [fieldPickerOpen, setFieldPickerOpen] = useState(false);















  const fieldPickerButtonRef = useRef(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
















  const logoUploadRef = useRef(null);







  const optInLinkButtonRef = useRef(null);































  const refreshLeadFields = useCallback(async () => {

    if (formScope !== "generic") {
      setLeadFields([]);
      return;
    }

    try {

      const data = await fetchApi("/api/lead-custom-fields");

      setLeadFields(Array.isArray(data) ? data : []);

    } catch {

      setLeadFields([]);

    }

  }, [formScope]);



  const loadData = useCallback(async () => {















    setLoading(true);















    try {















      const [formData, leadData] = await Promise.all([















        fetchApi(`/api/forms${scopeQuery}`),















        formScope === "generic" ? fetchApi("/api/lead-custom-fields").catch(() => []) : Promise.resolve([]),















      ]);















      const leadList = Array.isArray(leadData) ? leadData : [];















      setLeadFields(leadList);















      const normalizedForms = Array.isArray(formData) ? formData.map((form) => normalizeForm(form, leadList)) : [];















      setForms(normalizedForms);















      setSelectedForm((current) => {















        if (current) {















          const replacement = normalizedForms.find((form) => String(form.id) === String(current.id));















          return replacement ? normalizeForm(replacement, leadList) : normalizedForms[0] || null;















        }















        return normalizedForms[0] || null;















      });















    } catch (err) {















      notifyRef.current.error(err?.message || "Failed to load forms");















    } finally {















      setLoading(false);















    }















  }, [formScope, scopeQuery]);































  useEffect(() => {

    loadData();

  }, [loadData]);

  // Landing-page hero form state (generic scope only): current selection is
  // public (plain fetch — no auth needed), management access is resolved per
  // caller via the authed /access endpoint.
  useEffect(() => {
    if (formScope !== "generic") {
      setLandingFormId(null);
      setCanManageLandingForm(false);
      return;
    }
    let cancelled = false;
    fetchApi("/api/landing-form-config/access", { silent: true })
      .then((data) => {
        if (!cancelled) setCanManageLandingForm(Boolean(data && data.canManage));
      })
      .catch(() => {
        if (!cancelled) setCanManageLandingForm(false);
      });
    fetchApi("/api/landing-form-config/mine", { silent: true })
      .then((data) => {
        if (cancelled) return;
        const id = Number.parseInt(data && data.webFormId, 10);
        setLandingFormId(Number.isInteger(id) && id > 0 ? id : null);
      })
      .catch(() => {
        if (!cancelled) setLandingFormId(null);
      });
    return () => {
      cancelled = true;
    };
  }, [formScope]);

  const setAsLandingForm = useCallback(async (form) => {
    const id = Number(form && form.id);
    if (!Number.isInteger(id) || id <= 0) return;
    setSettingLandingFormId(id);
    try {
      const updated = await fetchApi("/api/landing-form-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ webFormId: id }),
      });
      const nextId = Number.parseInt(updated && updated.webFormId, 10);
      if (Number.isInteger(nextId) && nextId > 0) setLandingFormId(nextId);
      notify.success(`"${form.name}" now shows on the landing page for everyone`);
    } catch (err) {
      notify.error(err?.body?.error || err?.message || "Failed to set the landing-page form");
    } finally {
      setSettingLandingFormId(null);
    }
  }, [notify]);































  useEffect(() => {















    if (!selectedForm && forms.length) {















      setSelectedForm(forms[0]);















      setDirty(false);















    }















  }, [forms, selectedForm]);















  useEffect(() => {















    if (!fieldPickerOpen) return undefined;















    const timer = window.setInterval(refreshLeadFields, 5000);















    return () => window.clearInterval(timer);















  }, [fieldPickerOpen, refreshLeadFields]);






























































  const applyDraft = (updater) => {















    setSelectedForm((current) => {















      const base = current || normalizeForm({}, leadFields);

      const draft =
        typeof updater === "function" ? updater(base) : updater;

      const next = draft ? { ...base, ...draft } : draft;

      // Slug is frozen after creation so renames never break shared public URLs.
      // (Public links now prefer the stable numeric id — see utils/webForms.)















      return next ? normalizeForm(next, leadFields) : next;















    });















    setDirty(true);















  };































  const handleLogoUpload = async (event) => {















    const file = event?.target?.files?.[0];















    if (!file) return;

    if (formScope === "travel") {
      setUploadingLogo(true);
      try {
        const body = new FormData();
        body.append("image", file);
        const uploaded = await fetchApi("/api/forms/logo-upload?scope=travel", {
          method: "POST",
          body,
        });
        applyDraft({ style: { ...selectedForm.style, logoUrl: uploaded.url } });
        notifyRef.current.success(uploaded.storage === "ocs" ? "Logo uploaded to OCS." : "Logo uploaded.");
      } catch (error) {
        notifyRef.current.error(error?.data?.error || error?.message || "Failed to upload form logo.");
      } finally {
        setUploadingLogo(false);
        if (event.target) event.target.value = "";
      }
      return;
    }

    if (formScope === "generic") {
      setUploadingLogo(true);
      try {
        const body = new FormData();
        body.append("image", file);
        const uploaded = await fetchApi("/api/forms/generic-logo-upload?scope=generic", {
          method: "POST",
          body,
        });
        applyDraft({ style: { ...selectedForm.style, logoUrl: uploaded.url } });
        notifyRef.current.success(uploaded.storage === "ocs" ? "Logo uploaded to OCS." : "Logo uploaded.");
      } catch (error) {
        notifyRef.current.error(error?.data?.error || error?.message || "Failed to upload form logo.");
      } finally {
        setUploadingLogo(false);
        if (event.target) event.target.value = "";
      }
      return;
    }















    const reader = new FileReader();















    reader.onload = () => {















      applyDraft({ style: { ...selectedForm.style, logoUrl: String(reader.result || "") } });















    };















    reader.readAsDataURL(file);















    event.target.value = "";















  };































  const positionOptInLinkEditor = () => {
    const rect = optInLinkButtonRef.current?.getBoundingClientRect();

    if (!rect || typeof window === "undefined") return;

    const margin = 16;
    const gap = 10;
    const popoverWidth = Math.min(340, Math.max(260, window.innerWidth - margin * 2));
    const estimatedHeight = 286;
    const belowTop = rect.bottom + gap;
    const aboveTop = rect.top - estimatedHeight - gap;
    const top = belowTop + estimatedHeight <= window.innerHeight - margin
      ? belowTop
      : Math.max(margin, aboveTop);
    const left = Math.min(
      Math.max(margin, rect.right - popoverWidth),
      window.innerWidth - popoverWidth - margin,
    );

    setOptInLinkPosition({
      top: Math.round(top),
      left: Math.round(left),
      width: Math.round(popoverWidth),
    });
  };

  const openOptInLinkEditor = () => {
    const fallbackText = "privacy policy";
    positionOptInLinkEditor();
    setOptInLinkDraft({
      text: selectedForm?.settings?.optInLinkText || fallbackText,
      url: selectedForm?.settings?.optInLinkUrl || "",
    });
    setShowOptInLinkEditor(true);
  };

  const saveOptInLink = () => {
    const linkText = optInLinkDraft.text.trim() || optInLinkDraft.url.trim();
    const linkUrl = optInLinkDraft.url.trim();
    const currentText = String(selectedForm.settings.optInText || defaultSettings().optInText)
      .replace(/\s*\[[^\]]+\]\([^)]+\)\s*$/g, "")
      .trim();
    const linkToken = linkText && linkUrl ? ` [${linkText}](${linkUrl})` : "";
    applyDraft({
      settings: {
        ...selectedForm.settings,
        optInEnabled: true,
        optInText: `${currentText}${linkToken}`.trim(),
        optInLinkText: linkText,
        optInLinkUrl: linkUrl,
      },
    });
    setShowOptInLinkEditor(false);
  };

  const clearOptInLink = () => {
    const cleanedText = String(selectedForm.settings.optInText || defaultSettings().optInText)
      .replace(/\s*\[[^\]]+\]\([^)]+\)\s*$/g, "")
      .trim();
    applyDraft({
      settings: {
        ...selectedForm.settings,
        optInText: cleanedText,
        optInLinkText: "",
        optInLinkUrl: "",
      },
    });
    setOptInLinkDraft({ text: "", url: "" });
    setShowOptInLinkEditor(false);
  };

  const updateField = (index, patch) => {















    applyDraft((current) => {















      const fields = [...(current?.fields || [])];















      fields[index] = { ...(fields[index] || {}), ...patch };

      if (supportsAdvancedWebFormFeatures(current?.scope) && Object.prototype.hasOwnProperty.call(patch, "stepId")) {
        const changedField = fields[index];
        const isConditionalRoot = !changedField.showWhen && (
          changedField?.conditionalFlow === true ||
          String(changedField?.sourceKey || "").startsWith("conditional-root_")
        );
        if (isConditionalRoot) {
          const descendantIds = new Set([String(changedField.id)]);
          let foundDescendant = true;
          while (foundDescendant) {
            foundDescendant = false;
            fields.forEach((field) => {
              const condition = field?.showWhen;
              const parentMatches = condition && (
                (condition.fieldId && descendantIds.has(String(condition.fieldId))) ||
                (condition.fieldKey && fields.some((candidate) => descendantIds.has(String(candidate.id)) && String(candidate.sourceKey) === String(condition.fieldKey)))
              );
              if (parentMatches && !descendantIds.has(String(field.id))) {
                descendantIds.add(String(field.id));
                foundDescendant = true;
              }
            });
          }
          fields.forEach((field) => {
            if (descendantIds.has(String(field.id))) field.stepId = patch.stepId;
          });
        }
      }















      if (patch.sourceKind === "contact" && patch.sourceKey && patch.label == null) {















        fields[index].label = contactLabelFor(patch.sourceKey);















      }















      if (patch.sourceKind === "lead_custom" && patch.sourceKey && patch.label == null) {















        fields[index].label = leadFields.find((item) => item.fieldKey === patch.sourceKey)?.label || fields[index].label;















      }















      return { ...(current || {}), fields };















    });















  };































  const moveField = (index, delta) => {















    applyDraft((current) => {















      const fields = [...(current?.fields || [])];















      if (supportsAdvancedWebFormFeatures(current?.scope)) {
        const groups = buildConditionalFieldGroups(fields, true);
        const selectedGroup = groups.find((group) =>
          group.fields.some(({ field }) => String(field.id) === String(fields[index]?.id))
        );
        const isConditionalGroup = selectedGroup && (
          selectedGroup.fields.length > 1 ||
          selectedGroup.root?.conditionalFlow === true ||
          String(selectedGroup.root?.sourceKey || "").startsWith("conditional-root_") ||
          selectedGroup.fields.some(({ field }) => Boolean(field.showWhen))
        );

        if (isConditionalGroup) {
          const blockIndex = groups.findIndex((group) => group === selectedGroup);
          const nextBlockIndex = blockIndex + delta;
          if (nextBlockIndex < 0 || nextBlockIndex >= groups.length) return current;

          const blocks = groups.map((group) => [...group.fields]
            .sort((a, b) => a.index - b.index)
            .map(({ field }) => field));
          const [block] = blocks.splice(blockIndex, 1);
          blocks.splice(nextBlockIndex, 0, block);
          return { ...(current || {}), fields: blocks.flat() };
        }
      }

      const nextIndex = index + delta;















      if (nextIndex < 0 || nextIndex >= fields.length) return current;















      const [item] = fields.splice(index, 1);















      fields.splice(nextIndex, 0, item);















      return { ...(current || {}), fields };















    });















  };































  const fieldExists = (kind, sourceKey = "") => (selectedForm?.fields || []).some((field) => field.sourceKind === kind && String(field.sourceKey || "") === String(sourceKey || ""));

  const addField = (kind, sourceKey = "", fieldType = "text", label = "") => {

    if ((kind === "contact" || kind === "lead_custom") && fieldExists(kind, sourceKey)) {
      notifyRef.current?.error?.("That field is already added.");
      return;
    }

    applyDraft((current) => {
      const field = emptyFieldFor(kind, leadFields, sourceKey, fieldType, label);
      if (current?.settings?.multiStepEnabled && activeBuilderStepId) field.stepId = activeBuilderStepId;
      return { ...(current || {}), fields: [...(current?.fields || []), field] };
    });

  };

  const addConditionalFlow = () => {
    if (!supportsAdvancedWebFormFeatures(selectedForm?.scope)) return;

    const root = {
      ...emptyFieldFor("custom", leadFields, "", "dropdown", ""),
      sourceKey: uid("conditional-root"),
      conditionalFlow: true,
      conditionalCreatedAt: Date.now(),
      stepId: selectedForm?.settings?.multiStepEnabled ? activeBuilderStepId : "",
      label: "",
      fieldType: "dropdown",
      optionsText: "",
      showWhen: null,
    };

    applyDraft((current) => ({
      ...(current || {}),
      fields: [root, ...(current?.fields || [])],
    }));
  };

  const addFormStep = () => {
    setPageDialog({ title: "", description: "" });
  };

  const createFormStep = () => {
    if (!pageDialog) return;
    const steps = selectedForm?.settings?.steps || [];
    const nextSteps = [...steps, { id: uid("step"), title: String(pageDialog.title || "").trim() || `Step ${steps.length + 1}`, description: String(pageDialog.description || "").trim() }];
    setActiveBuilderStepId(nextSteps[nextSteps.length - 1].id);
    applyDraft((current) => ({ ...(current || {}), settings: { ...(current?.settings || {}), multiStepEnabled: true, steps: nextSteps } }));
    setPageDialog(null);
  };

  const toggleFieldPicker = async () => {

    const willOpen = !fieldPickerOpen;

    setFieldPickerOpen(willOpen);

    if (willOpen) await refreshLeadFields();

  };

  const handlePickField = (item) => {

    if ((item.kind === "contact" || item.kind === "lead_custom") && fieldExists(item.kind, item.sourceKey || "")) {
      notifyRef.current?.error?.("That field is already added.");
      return;
    }

    addField(item.kind, item.sourceKey || "", item.fieldType || "text", item.label || "");

    setFieldPickerOpen(false);

  };

  const addConditionalChild = (parentFieldId, answer) => {
    if (!supportsAdvancedWebFormFeatures(selectedForm?.scope)) return;

    const parent = (selectedForm.fields || []).find((field) => String(field.id) === String(parentFieldId));
    if (!parent) return;

    const alreadyAdded = (selectedForm.fields || []).some((field) => (
      field.showWhen &&
      String(field.showWhen.fieldId || "") === String(parent.id) &&
      String(field.showWhen.value || "") === String(answer)
    ));
    if (alreadyAdded) {
      notifyRef.current?.error?.(`A child question already exists for ${answer}.`);
      return;
    }

    const child = {
      ...emptyFieldFor("custom", leadFields, "", "text", ""),
      sourceKey: uid("conditional"),
      label: "",
      showWhen: {
        fieldId: parent.id,
        fieldKey: parent.sourceKey,
        value: String(answer),
      },
    };

    applyDraft((current) => ({
      ...(current || {}),
      fields: [...(current?.fields || []), { ...child, stepId: current?.settings?.multiStepEnabled ? (parent.stepId || activeBuilderStepId) : "" }],
    }));
  };

  const handleDragEnd = ({ active, over }) => {

    if (!over || active.id === over.id) return;

    const currentFields = selectedForm?.fields || [];

    const oldIndex = currentFields.findIndex((field) => String(field.id) === String(active.id));

    const newIndex = currentFields.findIndex((field) => String(field.id) === String(over.id));

    if (oldIndex < 0 || newIndex < 0) return;

    applyDraft((current) => {

      const nextFields = arrayMove([...(current?.fields || [])], oldIndex, newIndex);

      return { ...(current || {}), fields: nextFields };

    });

  };

  const removeField = async (index) => {















    const ok = await notify.confirm({ title: "Delete field?", message: "This field will be removed from the form builder.", confirmText: "Delete", destructive: true });















    if (!ok) return;















    applyDraft((current) => {
      const removed = current?.fields?.[index];
      const allFields = current?.fields || [];
      const fieldsToRemove = new Set(removed ? [String(removed.id)] : []);
      const sourceKeysToRemove = new Set(removed?.sourceKey ? [String(removed.sourceKey)] : []);

      // Remove the complete descendant tree, including grandchildren whose
      // parent is itself being removed.
      let changed = true;
      while (changed) {
        changed = false;
        allFields.forEach((field) => {
          const condition = field.showWhen;
          const pointsToRemoved = condition && (
            (condition.fieldId && fieldsToRemove.has(String(condition.fieldId))) ||
            (condition.fieldKey && sourceKeysToRemove.has(String(condition.fieldKey)))
          );
          if (pointsToRemoved && !fieldsToRemove.has(String(field.id))) {
            fieldsToRemove.add(String(field.id));
            if (field.sourceKey) sourceKeysToRemove.add(String(field.sourceKey));
            changed = true;
          }
        });
      }

      const fields = allFields.filter((field) => !fieldsToRemove.has(String(field.id)));
      return { ...(current || {}), fields };
    });















  };































  const selectForm = async (form) => {















    if (dirty) {















      const ok = await notify.confirm({ title: "Discard changes?", message: "You have unsaved changes on the current form.", confirmText: "Discard", destructive: true });















      if (!ok) return;















    }















    setSelectedForm(normalizeForm(form, leadFields));















    setBuilderOpen(true);



    setDirty(false);















  };































  const showFormsLibrary = async () => {

    if (dirty) {

      const ok = await notify.confirm({ title: "Discard changes?", message: "You have unsaved changes on the current form.", confirmText: "Discard", destructive: true });

      if (!ok) return;

    }

    setBuilderOpen(false);

    setDirty(false);

  };














  const createForm = async () => {















    const now = new Date();















    const date = now.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });















    const time = now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });















    const name = `Untitled form - ${date}, ${time}`;















    try {















      const created = await fetchApi(`/api/forms${scopeQuery}`, {















        method: "POST",















        body: JSON.stringify({ name, description: "", scope: formScope }),















      });















      const normalized = normalizeForm(created, leadFields);















      setForms((current) => [normalized, ...current.filter((item) => String(item.id) !== String(normalized.id))]);















      setSelectedForm(normalized);















      setBuilderOpen(true);



      setDirty(false);















      notify.success("Form created");















    } catch (err) {















      notify.error(err?.message || "Failed to create form");















    }















  };































  const saveForm = async () => {















    if (!selectedForm?.id) return;















    setSaving(true);















    try {















      const updated = await fetchApi(`/api/forms/${selectedForm.id}${scopeQuery}`, {















        method: "PUT",















        body: JSON.stringify({















          name: selectedForm.name,















          slug: selectedForm.slug,















          description: selectedForm.description,















          isActive: selectedForm.isActive,















          fields: (selectedForm.fields || []).map((field) => ({















            ...field,















            options: CHOICE_FIELD_TYPES.has(field.fieldType) ? splitOptions(field.optionsText) : [],















            fileTags: field.fieldType === "file" ? splitOptions(field.fileTagsText) : [],















          })),















          style: selectedForm.style,















          settings: selectedForm.settings,















        }),















      });















      const normalized = normalizeForm(updated, leadFields);















      setSelectedForm(normalized);















      setForms((current) => current.map((item) => (String(item.id) === String(normalized.id) ? normalized : item)));















      setDirty(false);















      notify.success("Form saved");















    } catch (err) {















      notify.error(err?.message || "Failed to save form");















    } finally {















      setSaving(false);















    }















  };































  const deleteForm = async (targetForm = selectedForm) => {

    if (!targetForm?.id) return;

    const ok = await notify.confirm({ title: "Delete form?", message: `Delete "${targetForm.name}"? This cannot be undone.`, confirmText: "Delete", destructive: true });

    if (!ok) return;

    try {

      await fetchApi(`/api/forms/${targetForm.id}${scopeQuery}`, { method: "DELETE" });

      setForms((current) => current.filter((item) => String(item.id) !== String(targetForm.id)));

      if (String(selectedForm?.id) === String(targetForm.id)) {

        setSelectedForm(null);

        setBuilderOpen(false);

        setDirty(false);

      }

      notify.success("Form deleted");

    } catch (err) {

      notify.error(err?.message || "Failed to delete form");

    }

  };































  const copyText = async (text, label) => {















    try {















      await navigator.clipboard.writeText(text);















      notify.success(`${label} copied`);















    } catch {















      notify.error("Clipboard unavailable");















    }















  };































  const filteredForms = forms.filter((form) => `${form.name} ${form.slug} ${form.description}`.toLowerCase().includes(search.trim().toLowerCase()));















  const publicUrl = selectedForm ? buildPublicUrl(selectedForm, origin) : "";















  const embedCode = selectedForm ? buildWebFormEmbedCode(selectedForm, origin) : "";















  const previewSrc = selectedForm ? buildWebFormPreviewUrl(selectedForm, origin) : "";

  const builderFields = selectedForm?.fields || [];
  const builderFieldGroups = supportsAdvancedWebFormFeatures(selectedForm?.scope)
    ? buildConditionalFieldGroups(builderFields, true)
    : builderFields.map((field, index) => ({ root: field, firstIndex: index, fields: [{ field, index }] }));

  useEffect(() => {
    if (selectedForm?.scope !== "generic") return;
    if (["form", "title", "label", "placeholder", "input", "button", "error", "success", "layout", "container"].includes(genericStyleSelection)) return;
    if (!["form", "title", "label", "placeholder", "input", "button", "error", "success", "layout", "container"].includes(genericStyleSelection)) {
      setGenericStyleSelection("form");
    }
  }, [selectedForm?.scope, builderFields, genericStyleSelection]);































  return (















    <div className={`${scope === "generic" ? "web-form-builder web-form-builder-generic" : "web-form-builder"}${scope === "travel" ? " web-form-builder-travel" : ""}`} style={{ padding: "1.5rem", display: "grid", gap: 16, alignContent: "start", color: "var(--text-primary)", animation: "fadeIn 0.2s ease" }}>















      <style>{`















        .web-form-builder {















          --wf-page-bg: transparent;















          --wf-panel: var(--surface-color);















          --wf-panel-solid: color-mix(in srgb, var(--surface-color) 88%, transparent);















          --wf-soft: var(--surface-hover);















          --wf-border: var(--border-color);















          --wf-text: var(--text-primary);















          --wf-muted: var(--text-secondary);















          --wf-label: var(--text-primary);















          --wf-step-bg: var(--accent-color);















          --wf-step-text: #ffffff;















          --wf-badge-bg: color-mix(in srgb, var(--accent-color) 14%, transparent);















          --wf-badge-border: color-mix(in srgb, var(--accent-color) 42%, var(--border-color));















          --wf-badge-text: var(--accent-color);















          --wf-shadow: 0 10px 28px rgba(0, 0, 0, 0.16);















          --wf-field-shadow: 0 6px 18px rgba(0, 0, 0, 0.10);

        }

        .web-form-builder-generic {
          --wf-popover-bg: #ffffff;
        }

        html[data-theme="dark"] .web-form-builder-generic,
        [data-theme="dark"] .web-form-builder-generic {
          --wf-popover-bg: #1a1d24;
        }

        .web-form-builder-travel .wf-travel-customization {
          display: grid;
          gap: 12px;
          max-width: 100%;
          padding: 12px;
          border: 1px solid var(--border-color);
          border-radius: 10px;
          background: var(--surface-hover);
        }

        .wf-travel-customization .wf-generic-live-inspector-title {
          color: var(--text-primary);
          font-weight: 700;
        }

        .wf-travel-customization .wf-generic-live-elements {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
          max-height: 150px;
          overflow: auto;
        }

        .wf-travel-customization .wf-generic-live-elements button {
          max-width: 100%;
          padding: 6px 8px;
          overflow: hidden;
          border: 1px solid var(--border-color);
          border-radius: 7px;
          background: var(--surface-color);
          color: var(--text-secondary);
          text-overflow: ellipsis;
          white-space: nowrap;
          cursor: pointer;
        }

        .wf-travel-customization .wf-generic-live-elements button.is-selected {
          border-color: var(--accent-color, #6366f1);
          color: var(--text-primary);
          box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent-color, #6366f1) 20%, transparent);
        }

        .wf-travel-customization .wf-generic-live-context-options {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
          gap: 10px;
          align-items: start;
        }

        .wf-travel-customization .wf-generic-live-context-options > label > span,
        .wf-travel-customization .wf-generic-live-context-options .wf-logo-upload-label {
          font-size: 0.8rem;
          line-height: 1.2;
        }

        .wf-travel-customization .wf-generic-element-text-controls {
          display: flex;
          align-items: end;
          flex-wrap: wrap;
          gap: 8px;
          padding: 8px;
          border: 1px solid var(--border-color);
          border-radius: 8px;
          background: var(--surface-color);
        }

        .wf-travel-customization .wf-generic-element-text-controls > label {
          display: grid;
          gap: 4px;
          min-width: 84px;
          color: var(--text-secondary);
          font-size: 0.76rem;
        }

        .wf-travel-customization .wf-generic-text-toggle-group {
          display: flex;
          gap: 5px;
          align-items: center;
        }

        .wf-travel-customization .wf-generic-text-toggle-group button {
          min-width: 32px;
          padding: 6px 8px;
          border: 1px solid var(--border-color);
          border-radius: 7px;
          background: var(--surface-color);
          color: var(--text-secondary);
          cursor: pointer;
        }

        .wf-travel-customization .wf-generic-text-toggle-group button.is-active {
          border-color: var(--accent-color, #6366f1);
          color: var(--text-primary);
          box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent-color, #6366f1) 20%, transparent);
        }

        .web-form-builder-generic .wf-generic-live-editor {
          display: grid;
          gap: 16px;
          margin-bottom: 22px;
          padding: 16px;
          border: 1px solid var(--border-color);
          border-radius: 14px;
          background: var(--surface-color);
        }

        .web-form-builder-generic .wf-generic-live-toolbar {
          display: flex;
          align-items: end;
          flex-wrap: wrap;
          gap: 12px;
          padding-bottom: 14px;
          border-bottom: 1px solid var(--border-color);
        }

        .web-form-builder-generic .wf-generic-live-toolbar-title,
        .web-form-builder-generic .wf-generic-live-inspector-title {
          color: var(--text-primary);
          font-weight: 700;
        }

        .web-form-builder-generic .wf-generic-live-toolbar-title {
          margin-right: auto;
          font-size: 1rem;
        }

        .web-form-builder-generic .wf-generic-live-toolbar-control {
          display: grid;
          gap: 5px;
          min-width: 120px;
        }

        .web-form-builder-generic .wf-generic-live-toolbar-control span,
        .web-form-builder-generic .wf-generic-live-preview-label {
          color: var(--text-secondary);
          font-size: 0.76rem;
        }

        .web-form-builder-generic .wf-generic-live-toolbar-control select {
          min-height: 36px;
          padding: 0 9px;
          border: 1px solid var(--border-color);
          border-radius: 8px;
          background: var(--surface-color);
          color: var(--text-primary);
        }

        .web-form-builder-generic .wf-generic-live-layout {
          display: grid;
          grid-template-columns: minmax(0, 1.35fr) minmax(240px, 0.65fr);
          gap: 16px;
          align-items: start;
        }

        .web-form-builder-generic .wf-generic-live-preview-wrap,
        .web-form-builder-generic .wf-generic-live-inspector {
          min-width: 0;
        }

        .web-form-builder-generic .wf-generic-live-preview-wrap {
          padding: 10px;
          border-radius: 10px;
        }

        .web-form-builder-generic .wf-generic-live-preview-label {
          margin-bottom: 7px;
          font-weight: 700;
        }

        .web-form-builder-generic .wf-generic-live-preview {
          min-height: 300px;
          overflow: hidden;
        }

        .web-form-builder-generic .wf-generic-live-logo {
          display: block;
          max-width: 150px;
          max-height: 46px;
          margin-bottom: 12px;
          object-fit: contain;
        }

        .web-form-builder-generic .wf-generic-live-fields {
          display: grid;
          gap: 10px;
          margin: 16px 0;
        }

        .web-form-builder-generic .wf-generic-live-field {
          display: grid;
          gap: 6px;
          width: 100%;
          padding: 0;
          border: 0;
          background: transparent;
          color: inherit;
          text-align: left;
          cursor: pointer;
        }

        .web-form-builder-generic .wf-generic-live-field > span {
          color: var(--wf-live-label-color, currentColor);
          font-size: var(--wf-live-label-size, 0.8rem);
          font-weight: 600;
        }

        .web-form-builder-generic .wf-generic-live-field-control input,
        .web-form-builder-generic .wf-generic-live-field-control select,
        .web-form-builder-generic .wf-generic-live-field-control textarea {
          width: 100%;
          min-height: var(--wf-live-field-height, 40px);
          box-sizing: border-box;
          padding: 8px 10px;
          border: 1px solid var(--wf-live-border-color, var(--border-color));
          border-radius: 8px;
          background: var(--wf-live-field-bg, var(--surface-color));
          color: inherit;
          font: inherit;
        }

        .web-form-builder-generic .wf-generic-live-field-control input::placeholder,
        .web-form-builder-generic .wf-generic-live-field-control textarea::placeholder {
          font-family: var(--wf-live-placeholder-font, inherit);
          font-size: var(--wf-live-placeholder-size, inherit);
          font-weight: var(--wf-live-placeholder-weight, inherit);
          font-style: var(--wf-live-placeholder-style, normal);
          text-decoration: var(--wf-live-placeholder-decoration, none);
          text-align: var(--wf-live-placeholder-align, left);
          color: var(--wf-live-placeholder-color, currentColor);
          opacity: 1;
        }

        .web-form-builder-generic .wf-generic-live-field-control textarea {
          min-height: 70px;
          resize: vertical;
        }

        .web-form-builder-generic .wf-generic-live-field.is-selected .wf-generic-live-field-control input,
        .web-form-builder-generic .wf-generic-live-field.is-selected .wf-generic-live-field-control select,
        .web-form-builder-generic .wf-generic-live-field.is-selected .wf-generic-live-field-control textarea,
        .web-form-builder-generic .wf-generic-live-submit.is-selected {
          outline: 2px solid var(--accent-color, #6366f1);
          outline-offset: 2px;
        }

        .web-form-builder-generic .wf-generic-live-message {
          margin-top: 10px;
          padding: 8px 10px;
          border-radius: 6px;
          cursor: pointer;
        }

        .web-form-builder-generic .wf-generic-live-error {
          background: color-mix(in srgb, #b91c1c 8%, transparent);
        }

        .web-form-builder-generic .wf-generic-live-success {
          background: color-mix(in srgb, #065f46 8%, transparent);
        }

        .web-form-builder-generic .wf-generic-live-message.is-selected {
          outline: 2px solid var(--accent-color, #6366f1);
          outline-offset: 2px;
        }

        .web-form-builder-generic .wf-generic-live-field > span.is-selected {
          outline: 2px solid var(--accent-color, #6366f1);
          outline-offset: 2px;
          border-radius: 3px;
        }

        .web-form-builder-generic .wf-generic-live-submit {
          min-width: 120px;
          padding: 0 16px;
          cursor: pointer;
        }

        .web-form-builder-generic .wf-generic-live-inspector {
          display: grid;
          gap: 12px;
          padding: 12px;
          border: 1px solid var(--border-color);
          border-radius: 10px;
          background: var(--surface-hover);
        }

        .web-form-builder-generic .wf-generic-live-elements {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
          max-height: 150px;
          overflow: auto;
        }

        .web-form-builder-generic .wf-generic-live-elements button {
          max-width: 100%;
          padding: 6px 8px;
          overflow: hidden;
          border: 1px solid var(--border-color);
          border-radius: 7px;
          background: var(--surface-color);
          color: var(--text-secondary);
          text-overflow: ellipsis;
          white-space: nowrap;
          cursor: pointer;
        }

        .web-form-builder-generic .wf-generic-live-elements button.is-selected {
          border-color: var(--accent-color, #6366f1);
          color: var(--text-primary);
          box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent-color, #6366f1) 20%, transparent);
        }

        .web-form-builder-generic .wf-generic-live-context-options {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
          gap: 10px;
          align-items: start;
        }

        .web-form-builder-generic .wf-generic-live-context-options > div:first-child {
          grid-column: 1 / -1;
          min-width: 0;
        }

        .web-form-builder-generic .wf-generic-live-context-options > div:first-child > div {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
        }

        .web-form-builder-generic .wf-generic-live-context-options > div:first-child > div > button {
          width: 60px;
          min-width: 60px;
          height: 42px;
          padding: 0;
          display: inline-grid;
          place-items: center;
          box-sizing: border-box;
        }

        .web-form-builder-generic .wf-generic-live-context-options > label > span,
        .web-form-builder-generic .wf-generic-live-context-options .wf-logo-upload-label {
          font-size: 0.8rem;
          line-height: 1.2;
        }

        .web-form-builder-generic .wf-generic-element-text-controls {
          display: flex;
          align-items: end;
          flex-wrap: wrap;
          gap: 8px;
          padding: 8px;
          border: 1px solid var(--border-color);
          border-radius: 8px;
          background: var(--surface-color);
        }

        .web-form-builder-generic .wf-generic-element-text-controls > label {
          display: grid;
          gap: 4px;
          min-width: 84px;
          color: var(--text-secondary);
          font-size: 0.72rem;
        }

        .web-form-builder-generic .wf-generic-element-text-controls select,
        .web-form-builder-generic .wf-generic-element-text-controls input {
          min-height: 30px;
          min-width: 0;
          box-sizing: border-box;
          padding: 4px 6px;
          border: 1px solid var(--border-color);
          border-radius: 6px;
          background: var(--surface-color);
          color: var(--text-primary);
          font: inherit;
          font-size: 0.78rem;
        }

        .web-form-builder-generic .wf-generic-text-toggle-group {
          display: flex;
          gap: 4px;
        }

        .web-form-builder-generic .wf-generic-text-toggle-group button {
          width: 30px;
          height: 30px;
          padding: 0;
          border: 1px solid var(--border-color);
          border-radius: 6px;
          background: var(--surface-color);
          color: var(--text-secondary);
          cursor: pointer;
        }

        .web-form-builder-generic .wf-generic-text-toggle-group button.is-active {
          border-color: var(--accent-color, #6366f1);
          background: color-mix(in srgb, var(--accent-color, #6366f1) 14%, var(--surface-color));
          color: var(--text-primary);
        }

        @media (max-width: 900px) {
          .web-form-builder-generic .wf-generic-live-layout {
            grid-template-columns: 1fr;
          }
        }

        @media (max-width: 560px) {
          .web-form-builder-generic .wf-generic-live-editor {
            padding: 12px;
          }

          .web-form-builder-generic .wf-generic-live-toolbar-control,
          .web-form-builder-generic .wf-generic-live-toolbar .wf-color-field,
          .web-form-builder-generic .wf-generic-live-toolbar .wf-style-number-field {
            width: 100%;
            min-width: 0;
          }
        }

        .web-form-builder-generic .wf-style-grid-top > label,
        .web-form-builder-generic .wf-style-grid-colors > label,
        .web-form-builder-generic .wf-style-grid-colors > .wf-color-field {
          width: 100%;
          min-width: 0;
        }

        .web-form-builder-generic .wf-style-grid-top,
        .web-form-builder-generic .wf-style-grid-colors {
          display: flex !important;
          flex-wrap: wrap;
          align-items: flex-start;
          justify-content: flex-start !important;
          gap: 24px !important;
          column-gap: 24px !important;
          row-gap: 24px !important;
        }

        .web-form-builder-generic .wf-style-grid-top > label,
        .web-form-builder-generic .wf-style-grid-colors > label,
        .web-form-builder-generic .wf-style-grid-colors > .wf-color-field {
          width: max-content !important;
          min-width: 0;
          max-width: none;
        }

        .web-form-builder-generic .wf-style-grid-top > label,
        .web-form-builder-generic .wf-style-grid-colors > label,
        .web-form-builder-generic .wf-style-grid-colors > .wf-color-field {
          flex: 0 0 auto !important;
        }

    .web-form-builder-generic .wf-style-grid-top .input-field,
    .web-form-builder-generic .wf-style-grid-top select {
      width: var(--wf-control-width);
      min-width: 0;
      max-width: 100%;
      box-sizing: border-box;
        }

    .web-form-builder-generic .wf-style-grid-colors > label:not(.wf-color-field) > .input-field {
      width: var(--wf-control-width);
      min-width: 0;
      max-width: 100%;
      box-sizing: border-box;
        }

    .web-form-builder-generic .wf-style-grid-top select,
    .web-form-builder-generic .wf-style-grid-colors > label:not(.wf-color-field) > select {
      width: var(--wf-option-width);
      min-width: var(--wf-option-width);
      max-width: none;
      justify-self: start;
    }

    .web-form-builder-generic .wf-style-grid-colors .wf-color-control {
      width: var(--wf-control-width);
      max-width: 100%;
    }

    .web-form-builder-generic .wf-style-block .wf-style-grid-top > label > span,
    .web-form-builder-generic .wf-style-block .wf-style-grid-colors > label > span,
    .web-form-builder-generic .wf-style-block .wf-style-grid-colors > .wf-color-field > span {
      color: var(--text-primary) !important;
      font-weight: 700 !important;
    }

    .web-form-builder-generic .wf-style-block .wf-style-kicker {
      font-size: 0.95rem;
      font-weight: 700;
    }

    .web-form-builder-generic .wf-style-block .wf-style-grid-top .input-field,
    .web-form-builder-generic .wf-style-block .wf-style-grid-colors .input-field {
      color: var(--text-primary);
      background: var(--surface-color);
      border-color: var(--border-color);
    }

    .web-form-builder-generic .wf-generic-field-editor-grid {
      display: flex !important;
      position: relative;
      padding-right: 280px;
      align-items: flex-start !important;
      flex-wrap: wrap;
      justify-content: flex-start;
      gap: 16px !important;
    }

    .web-form-builder-generic .wf-field-grid {
      grid-template-columns: max-content minmax(0, 1fr) !important;
      gap: 16px !important;
      align-items: start !important;
    }

    .web-form-builder-generic .wf-conditional-child-card {
      margin-left: clamp(18px, 3vw, 44px);
      margin-right: 0;
    }

    .web-form-builder-generic .wf-conditional-child-card.wf-conditional-depth-2 {
      margin-left: clamp(42px, 6vw, 84px);
    }

    .web-form-builder-generic .wf-conditional-child-card.wf-conditional-depth-3 {
      margin-left: clamp(66px, 9vw, 124px);
    }

    .web-form-builder-generic .wf-conditional-config {
      display: flex !important;
      flex-wrap: wrap;
      align-items: flex-start;
      gap: 12px !important;
    }

    .web-form-builder-generic .wf-conditional-config > div:first-child {
      flex-basis: 100%;
    }

    .web-form-builder-generic .wf-conditional-config > .wf-conditional-parent-select {
      flex: 0 1 300px;
      width: 300px;
      min-width: 220px;
      max-width: 300px;
    }

    .web-form-builder-generic .wf-conditional-config > .wf-conditional-answer-select {
      flex: 0 1 180px;
      width: 180px;
      min-width: 150px;
      max-width: 220px;
    }

    .web-form-builder-generic .wf-conditional-config .input-field {
      width: 100%;
      min-width: 0;
      box-sizing: border-box;
    }

    .web-form-builder-generic .wf-generic-field-editor-grid > .wf-generic-field-label {
      flex: 0 1 clamp(180px, 20vw, 220px);
      width: clamp(180px, 20vw, 220px);
      min-width: min(100%, 180px);
      max-width: 220px;
    }

    .web-form-builder-generic .wf-generic-field-editor-grid > .wf-generic-field-step {
      flex: 0 0 160px;
      width: 160px;
      min-width: 150px;
    }

    .web-form-builder-generic .wf-generic-field-editor-grid > .wf-generic-field-default {
      flex: 1 1 240px;
      width: min(100%, 280px);
      min-width: min(100%, 220px);
      max-width: 280px;
    }

    .web-form-builder-generic .wf-generic-field-controls {
      display: flex !important;
      flex: 1 1 380px;
      align-items: flex-start;
      flex-wrap: wrap;
      gap: 16px !important;
      min-width: min(100%, 380px);
    }

    .web-form-builder-generic .wf-generic-field-controls > .wf-generic-field-type {
      flex: 0 0 160px;
      width: 160px;
      min-width: 150px;
    }

    .web-form-builder-generic .wf-generic-field-controls > .wf-generic-field-secondary {
      flex: 0 1 220px;
      width: 220px;
      min-width: 180px;
      max-width: 260px;
    }

    .web-form-builder-generic .wf-generic-field-editor-grid > .wf-field-editor-actions {
      position: absolute;
      top: 0;
      right: 0;
      z-index: 1;
      display: flex !important;
      flex: 0 0 auto;
      width: auto !important;
      max-width: calc(100% - 16px);
      min-width: 0;
      justify-content: flex-end !important;
      align-items: flex-start !important;
      flex-wrap: wrap !important;
      gap: 10px;
    }

    .web-form-builder-generic .wf-generic-field-editor-grid > .wf-field-editor-actions > button.btn-secondary {
      padding: 0 !important;
      width: 20px;
      min-width: 20px;
      height: 20px;
      border: 0 !important;
      background: transparent !important;
      box-shadow: none !important;
      display: inline-grid;
      place-items: center;
      align-self: flex-start !important;
    }

    .web-form-builder-generic .wf-generic-field-editor-grid > .wf-field-editor-actions:has(.wf-email-validation-controls),
    .web-form-builder-generic .wf-generic-field-editor-grid > .wf-field-editor-actions:has(.wf-phone-country-controls) {
      width: min(100%, 520px) !important;
    }

    .web-form-builder-generic .wf-generic-field-editor-grid:has(.wf-email-validation-controls),
    .web-form-builder-generic .wf-generic-field-editor-grid:has(.wf-phone-country-controls) {
      padding-bottom: 20px;
    }

    .web-form-builder-generic .wf-generic-field-editor-grid > .wf-field-editor-actions > .wf-email-validation-controls {
      position: absolute;
      top: 76px;
      right: 0;
      width: min(100%, 520px);
      justify-content: flex-end;
      order: 2;
    }

    .web-form-builder-generic .wf-email-validation-controls {
      align-items: center;
      gap: 6px;
      color: var(--text-secondary);
      font-size: 12px;
      line-height: 1.2;
    }

    .web-form-builder-generic .wf-email-validation-controls > label {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-weight: 700;
    }

    .web-form-builder-generic .wf-email-validation-controls select {
      font-size: 12px !important;
      padding: 3px 5px !important;
      border-radius: 6px !important;
      box-sizing: border-box;
    }

    .web-form-builder-generic .wf-generic-field-editor-grid > .wf-field-editor-actions > .wf-phone-country-controls {
      position: absolute;
      top: 76px;
      right: 0;
      flex-basis: auto;
      order: 3;
      justify-content: flex-end;
      flex-wrap: wrap;
      min-width: 0;
      width: min(100%, 520px);
      margin-left: auto;
    }

    .web-form-builder-generic .wf-phone-country-controls select {
      max-width: 100%;
      box-sizing: border-box;
    }

    .web-form-builder-generic .wf-generic-field-editor-grid .input-field {
      width: 100%;
      min-width: 0;
      box-sizing: border-box;
    }

    .web-form-builder-generic .wf-generic-options-input {
      height: 44px;
      min-height: 44px;
      resize: both;
    }

    /* Keep Generic CRM field controls compact and aligned without changing behavior. */
    .web-form-builder-generic .wf-generic-field-editor-grid {
      padding-right: 220px;
      gap: 12px !important;
    }

    .web-form-builder-generic .wf-generic-field-editor-grid > .wf-generic-field-label {
      flex: 0 1 180px;
      width: 180px;
      min-width: 165px;
      max-width: 190px;
    }

    .web-form-builder-generic .wf-generic-field-editor-grid > .wf-generic-field-step {
      flex: 0 1 150px;
      width: 150px;
      min-width: 135px;
      max-width: 160px;
    }

    .web-form-builder-generic .wf-generic-field-controls {
      flex: 1 1 340px;
      min-width: 320px;
      gap: 12px !important;
    }

    .web-form-builder-generic .wf-generic-field-controls > .wf-generic-field-type {
      flex: 0 1 140px;
      width: 140px;
      min-width: 130px;
      max-width: 150px;
    }

    .web-form-builder-generic .wf-generic-field-controls > .wf-generic-field-secondary {
      flex: 0 1 200px;
      width: 200px;
      min-width: 180px;
      max-width: 220px;
    }

    .web-form-builder-generic .wf-generic-field-editor-grid .input-field,
    .web-form-builder-generic .wf-generic-field-editor-grid textarea {
      width: 100%;
      min-width: 0;
      box-sizing: border-box;
    }

    @media (max-width: 760px) {
      .web-form-builder-generic .wf-generic-field-editor-grid {
        display: flex !important;
        padding-right: 0;
        padding-bottom: 0;
        gap: 16px !important;
      }

      .web-form-builder-generic .wf-generic-field-controls {
        display: flex !important;
        flex: 1 1 100%;
        flex-wrap: wrap;
        gap: 16px !important;
      }

      .web-form-builder-generic .wf-field-grid {
        grid-template-columns: 1fr !important;
      }

      .web-form-builder-generic .wf-generic-field-editor-grid > .wf-field-editor-actions {
        position: static;
        width: 100% !important;
        max-width: none;
        min-width: 0;
        justify-content: flex-start !important;
      }

      .web-form-builder-generic .wf-phone-country-controls {
        position: static;
        width: 100%;
        flex-basis: 100%;
        justify-content: flex-end;
      }

      .web-form-builder-generic .wf-email-validation-controls {
        position: static;
        width: 100%;
      }

      .web-form-builder-generic .wf-generic-field-editor-grid,
      .web-form-builder-generic .wf-generic-field-editor-grid > .wf-field-editor-actions,
      .web-form-builder-generic .wf-generic-field-editor-grid > .wf-field-editor-actions > .wf-email-validation-controls,
      .web-form-builder-generic .wf-generic-field-editor-grid > .wf-field-editor-actions > .wf-phone-country-controls {
        max-width: 100%;
        min-width: 0;
        box-sizing: border-box;
      }

      .web-form-builder-generic .wf-generic-field-editor-grid > .wf-field-editor-actions > .wf-email-validation-controls,
      .web-form-builder-generic .wf-generic-field-editor-grid > .wf-field-editor-actions > .wf-phone-country-controls {
        position: static !important;
        top: auto !important;
        right: auto !important;
        width: 100% !important;
        flex: 1 1 100%;
        flex-basis: 100%;
        justify-content: flex-start;
        white-space: normal;
        margin-left: 0;
      }

      .web-form-builder-generic .wf-email-validation-controls > label {
        flex-wrap: wrap;
      }

      .web-form-builder-generic .wf-email-validation-controls select,
      .web-form-builder-generic .wf-phone-country-controls select {
        max-width: 100%;
      }

      .web-form-builder-generic .wf-conditional-child-card {
        margin-left: 12px;
        margin-right: 0;
      }

      .web-form-builder-generic .wf-conditional-child-card.wf-conditional-depth-2 {
        margin-left: 24px;
      }

      .web-form-builder-generic .wf-conditional-child-card.wf-conditional-depth-3 {
        margin-left: 36px;
      }

      .web-form-builder-generic .wf-conditional-config > .wf-conditional-parent-select,
      .web-form-builder-generic .wf-conditional-config > .wf-conditional-answer-select {
        flex: 1 1 100%;
        width: 100%;
        min-width: 0;
        max-width: none;
      }

      .web-form-builder-generic .wf-generic-field-editor-grid > .wf-generic-field-label,
      .web-form-builder-generic .wf-generic-field-editor-grid > .wf-generic-field-step,
      .web-form-builder-generic .wf-generic-field-editor-grid > .wf-generic-field-default,
      .web-form-builder-generic .wf-generic-field-controls,
      .web-form-builder-generic .wf-generic-field-controls > .wf-generic-field-type,
      .web-form-builder-generic .wf-generic-field-controls > .wf-generic-field-secondary {
        flex: 1 1 100%;
        width: 100%;
        min-width: 0;
        max-width: none;
      }

      .web-form-builder-generic .wf-field-card,
      .web-form-builder-generic .wf-field-grid,
      .web-form-builder-generic .wf-generic-field-editor-grid,
      .web-form-builder-generic .wf-generic-field-controls {
        width: 100%;
        max-width: 100%;
        min-width: 0 !important;
        box-sizing: border-box;
      }

      .web-form-builder-generic .wf-generic-field-editor-grid > .wf-generic-field-label,
      .web-form-builder-generic .wf-generic-field-editor-grid > .wf-generic-field-step,
      .web-form-builder-generic .wf-generic-field-editor-grid > .wf-generic-field-default,
      .web-form-builder-generic .wf-generic-field-controls > .wf-generic-field-type,
      .web-form-builder-generic .wf-generic-field-controls > .wf-generic-field-secondary {
        width: 100% !important;
        min-width: 0 !important;
        max-width: 100% !important;
        flex-basis: 100%;
      }

      .web-form-builder-generic .wf-conditional-child-card {
        margin-left: 8px;
      }

      .web-form-builder-generic .wf-conditional-child-card.wf-conditional-depth-2 {
        margin-left: 16px;
      }

      .web-form-builder-generic .wf-conditional-child-card.wf-conditional-depth-3 {
        margin-left: 24px;
      }
    }

    .web-form-builder-travel .wf-generic-field-editor-grid {
      display: flex !important;
      position: relative;
      padding-right: 190px;
      align-items: flex-start !important;
      flex-wrap: wrap;
      justify-content: flex-start;
      gap: 10px !important;
    }

    .web-form-builder-travel .wf-field-grid {
      grid-template-columns: max-content minmax(0, 1fr) !important;
      gap: 12px !important;
      align-items: start !important;
    }

    .web-form-builder-travel .wf-generic-field-editor-grid > .wf-generic-field-label {
      flex: 0 1 160px;
      width: 160px;
      min-width: 145px;
      max-width: 175px;
    }

    .web-form-builder-travel .wf-generic-field-editor-grid > .wf-generic-field-step {
      flex: 0 1 130px;
      width: 130px;
      min-width: 120px;
      max-width: 145px;
    }

    .web-form-builder-travel .wf-generic-field-controls {
      display: flex !important;
      flex: 1 1 300px;
      min-width: 280px;
      align-items: flex-start;
      flex-wrap: wrap;
      gap: 10px !important;
    }

    .web-form-builder-travel .wf-generic-field-controls > .wf-generic-field-type {
      flex: 0 1 125px;
      width: 125px;
      min-width: 115px;
      max-width: 135px;
    }

    .web-form-builder-travel .wf-generic-field-controls > .wf-generic-field-secondary {
      flex: 0 1 180px;
      width: 180px;
      min-width: 165px;
      max-width: 200px;
    }

    .web-form-builder-travel .wf-generic-field-editor-grid .input-field,
    .web-form-builder-travel .wf-generic-field-editor-grid textarea {
      width: 100%;
      min-width: 0;
      box-sizing: border-box;
    }

    .web-form-builder-travel .wf-generic-field-editor-grid > .wf-field-editor-actions {
      position: absolute;
      top: 0;
      right: 0;
      z-index: 1;
      display: flex !important;
      flex: 0 0 auto;
      width: auto !important;
      max-width: calc(100% - 12px);
      min-width: 0;
      justify-content: flex-end !important;
      align-items: flex-start !important;
      flex-wrap: wrap !important;
      gap: 10px;
    }

    .web-form-builder-travel .wf-generic-field-editor-grid > .wf-field-editor-actions > button.btn-secondary {
      padding: 0 !important;
      width: 20px;
      min-width: 20px;
      height: 20px;
      border: 0 !important;
      background: transparent !important;
      box-shadow: none !important;
      display: inline-grid;
      place-items: center;
      align-self: flex-start !important;
    }

    .web-form-builder-travel .wf-generic-field-editor-grid > .wf-field-editor-actions:has(.wf-email-validation-controls),
    .web-form-builder-travel .wf-generic-field-editor-grid > .wf-field-editor-actions:has(.wf-phone-country-controls) {
      width: 100% !important;
      height: 100%;
      min-height: 42px;
      box-sizing: border-box;
      pointer-events: none;
    }

    .web-form-builder-travel .wf-generic-field-editor-grid > .wf-field-editor-actions:has(.wf-email-validation-controls) > label,
    .web-form-builder-travel .wf-generic-field-editor-grid > .wf-field-editor-actions:has(.wf-email-validation-controls) > button,
    .web-form-builder-travel .wf-generic-field-editor-grid > .wf-field-editor-actions:has(.wf-phone-country-controls) > label,
    .web-form-builder-travel .wf-generic-field-editor-grid > .wf-field-editor-actions:has(.wf-phone-country-controls) > button,
    .web-form-builder-travel .wf-generic-field-editor-grid > .wf-field-editor-actions > .wf-email-validation-controls,
    .web-form-builder-travel .wf-generic-field-editor-grid > .wf-field-editor-actions > .wf-phone-country-controls {
      pointer-events: auto;
    }

    .web-form-builder-travel .wf-generic-field-editor-grid:has(.wf-email-validation-controls),
    .web-form-builder-travel .wf-generic-field-editor-grid:has(.wf-phone-country-controls) {
      padding-bottom: 20px;
    }

    .web-form-builder-travel .wf-generic-field-editor-grid > .wf-field-editor-actions > .wf-email-validation-controls,
    .web-form-builder-travel .wf-generic-field-editor-grid > .wf-field-editor-actions > .wf-phone-country-controls {
      position: static;
      position: absolute;
      right: 0;
      bottom: 0;
      flex-basis: auto;
      width: auto;
      max-width: calc(100% - 12px);
      justify-content: flex-end;
      flex-wrap: wrap;
    }

    .web-form-builder-travel .wf-email-validation-controls,
    .web-form-builder-travel .wf-phone-country-controls {
      min-width: 0;
      max-width: 100%;
      box-sizing: border-box;
    }

    .web-form-builder-travel .wf-email-validation-label {
      font-weight: 700;
    }

    .web-form-builder-travel .wf-generic-field-editor-grid:has(.wf-email-validation-controls),
    .web-form-builder-travel .wf-generic-field-editor-grid:has(.wf-phone-country-controls) {
      padding-bottom: 32px;
    }

    .web-form-builder-generic .wf-country-picker,
    .web-form-builder-travel .wf-country-picker {
      position: relative;
      min-width: 145px;
    }

    .web-form-builder-generic .wf-country-picker-trigger,
    .web-form-builder-travel .wf-country-picker-trigger {
      width: 145px;
      min-height: 26px;
      display: inline-flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 3px 7px;
      border: 1px solid var(--border-color);
      border-radius: 6px;
      background: var(--surface-color);
      color: var(--text-primary);
      font: inherit;
      font-size: 12px;
      cursor: pointer;
    }

    .web-form-builder-generic .wf-country-picker-panel,
    .web-form-builder-travel .wf-country-picker-panel {
      position: absolute;
      right: 0;
      bottom: calc(100% + 6px);
      z-index: 10000;
      width: min(260px, calc(100vw - 24px));
      box-sizing: border-box;
      padding: 8px;
      border: 1px solid var(--border-color);
      border-radius: 8px;
      background: #ffffff !important;
      opacity: 1 !important;
      isolation: isolate;
      box-shadow: 0 8px 20px rgba(0, 0, 0, 0.14);
    }

    .web-form-builder-generic .wf-field-card:has(.wf-country-picker-panel),
    .web-form-builder-travel .wf-field-card:has(.wf-country-picker-panel) {
      position: relative;
      z-index: 10001;
    }

    .web-form-builder-generic .wf-field-card:has(.wf-country-picker-panel) {
      z-index: 10004;
    }

    .web-form-builder-generic .wf-country-picker-panel {
      z-index: 10005;
      background: #ffffff !important;
      opacity: 1 !important;
    }

    .web-form-builder-generic .wf-field-card:has(.wf-email-domain-popover),
    .web-form-builder-travel .wf-field-card:has(.wf-email-domain-popover) {
      position: relative;
      z-index: 10002;
    }

    html[data-theme="dark"] .web-form-builder-generic .wf-country-picker-panel,
    [data-theme="dark"] .web-form-builder-generic .wf-country-picker-panel,
    html[data-theme="dark"] .web-form-builder-travel .wf-country-picker-panel,
    [data-theme="dark"] .web-form-builder-travel .wf-country-picker-panel {
      background: #1a1d24 !important;
    }

    .web-form-builder-generic .wf-country-picker-search,
    .web-form-builder-travel .wf-country-picker-search {
      width: 100%;
      min-width: 0;
      box-sizing: border-box;
      display: block;
      padding: 6px 8px;
      border: 1px solid var(--border-color);
      border-radius: 6px;
      background: var(--surface-color);
      color: var(--text-primary);
      font: inherit;
      font-size: 12px;
    }

    .web-form-builder-generic .wf-country-picker-clear,
    .web-form-builder-travel .wf-country-picker-clear {
      width: auto;
      box-sizing: border-box;
      display: inline-block;
      margin: 0;
      padding: 4px 2px;
      border: 0;
      background: transparent;
      color: var(--accent-color, #4f46e5);
      font: inherit;
      font-size: 12px;
      text-align: left;
      cursor: pointer;
    }

    .web-form-builder-generic .wf-country-picker-actions,
    .web-form-builder-travel .wf-country-picker-actions {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      margin-top: 6px;
    }

    .web-form-builder-generic .wf-country-picker-clear:hover,
    .web-form-builder-travel .wf-country-picker-clear:hover {
      text-decoration: underline;
    }

    .web-form-builder-generic .wf-country-picker-options,
    .web-form-builder-travel .wf-country-picker-options {
      display: grid;
      gap: 4px;
      max-height: 150px;
      margin-top: 7px;
      overflow-y: auto;
    }

    .web-form-builder-generic .wf-country-picker-option,
    .web-form-builder-travel .wf-country-picker-option {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
      padding: 3px 2px;
      color: var(--text-primary);
      font-size: 12px;
      cursor: pointer;
    }

    .web-form-builder-generic .wf-country-picker-option span,
    .web-form-builder-travel .wf-country-picker-option span {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .web-form-builder-generic .wf-country-picker-empty,
    .web-form-builder-travel .wf-country-picker-empty {
      padding: 8px 2px;
      color: var(--text-secondary);
      font-size: 12px;
    }

    @media (max-width: 760px) {
      .web-form-builder-travel .wf-generic-field-editor-grid {
        display: flex !important;
        width: 100%;
        max-width: 100%;
        min-width: 0;
        padding: 0;
        gap: 10px !important;
      }

      .web-form-builder-travel .wf-field-card,
      .web-form-builder-travel .wf-field-grid,
      .web-form-builder-travel .wf-generic-field-controls {
        width: 100%;
        max-width: 100%;
        min-width: 0 !important;
        box-sizing: border-box;
      }

      .web-form-builder-travel .wf-generic-field-editor-grid > .wf-generic-field-label,
      .web-form-builder-travel .wf-generic-field-editor-grid > .wf-generic-field-step,
      .web-form-builder-travel .wf-generic-field-editor-grid > .wf-generic-field-default,
      .web-form-builder-travel .wf-generic-field-controls,
      .web-form-builder-travel .wf-generic-field-controls > .wf-generic-field-type,
      .web-form-builder-travel .wf-generic-field-controls > .wf-generic-field-secondary {
        flex: 1 1 100%;
        width: 100%;
        min-width: 0;
        max-width: 100%;
      }

      .web-form-builder-travel .wf-generic-field-controls {
        gap: 12px !important;
      }

      .web-form-builder-travel .wf-generic-field-editor-grid > .wf-field-editor-actions {
        position: static;
        width: 100% !important;
        max-width: 100%;
        min-width: 0;
        justify-content: flex-start !important;
      }

      .web-form-builder-travel .wf-generic-field-editor-grid > .wf-field-editor-actions > .wf-email-validation-controls,
      .web-form-builder-travel .wf-generic-field-editor-grid > .wf-field-editor-actions > .wf-phone-country-controls {
        position: static !important;
        width: 100% !important;
        max-width: 100%;
        flex-basis: 100%;
        justify-content: flex-start;
        white-space: normal;
      }

      .web-form-builder-travel .wf-phone-country-controls select,
      .web-form-builder-travel .wf-email-validation-controls select {
        max-width: 100%;
      }
    }

        .web-form-builder-generic .wf-email-domain-popover {
          isolation: isolate;
          color: var(--text-primary);
          opacity: 1 !important;
        }

    .web-form-builder-generic .wf-email-domain-popover .input-field {
          opacity: 1 !important;
        }

    .web-form-builder-generic .wf-email-validation-controls .wf-email-domain-popover {
      top: auto !important;
      bottom: 100% !important;
      margin-top: 0 !important;
      margin-bottom: 6px;
    }















        }















        .web-form-builder .input-field {















          background: var(--surface-color) !important;















          border-color: var(--border-color) !important;















          color: var(--text-primary) !important;















        }















        .web-form-builder .input-field::placeholder {















          color: var(--text-secondary) !important;















          opacity: 0.75;















        }















        .web-form-builder .card {















          overflow: visible;















        }















        .web-form-builder .card:hover {















          transform: none;















        }















        .web-form-builder .btn-secondary:disabled,















        .web-form-builder .btn-primary:disabled {















          opacity: 0.55;















          cursor: not-allowed;















          transform: none;















        }















        .wf-form-toolbar {















          display: grid;















          grid-template-columns: minmax(260px, 380px) minmax(0, 1fr);















          gap: 12px;















          align-items: center;















        }















        .wf-search-wrap {















          display: flex;















          align-items: center;















          gap: 10px;















          min-width: 0;















          padding: 0 12px;















          min-height: 44px;















          border: 1px solid var(--border-color);















          border-radius: 12px;















          background: var(--surface-color);















          color: var(--text-secondary);















        }















        .wf-search-wrap .input-field {















          border: 0 !important;















          padding: 0 !important;















          min-height: auto;















          background: transparent !important;















          box-shadow: none !important;















        }















        .wf-builder-context {
          min-width: 0;
          display: flex;
          align-items: center;
          gap: 8px;
          flex-wrap: wrap;
          color: var(--text-secondary);
          font-size: 0.85rem;
        }
        .wf-builder-context strong {
          min-width: 0;
          color: var(--text-primary);
          overflow: visible;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .wf-builder-context small {
          color: var(--text-secondary);
        }
        .wf-forms-library {
          display: grid;
          gap: 16px;
          padding: 18px;
          border: 1px solid var(--border-color);
          border-radius: 18px;
          background: var(--surface-color);
          box-shadow: var(--wf-field-shadow);
        }
        .wf-library-head {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 16px;
          flex-wrap: wrap;
          padding-bottom: 14px;
          border-bottom: 1px solid var(--border-color);
        }
        .wf-library-head h3,
        .wf-library-empty h3,
        .wf-library-card h4 {
          margin: 0;
          color: var(--text-primary);
        }
        .wf-library-head p,
        .wf-library-empty p,
        .wf-library-card p {
          margin: 0.35rem 0 0;
          color: var(--text-secondary);
        }
        .wf-library-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 1fr));
          gap: 14px;
        }
        .wf-library-card {
          display: grid;
          gap: 16px;
          min-width: 0;
          padding: 16px;
          border: 1px solid var(--border-color);
          border-radius: 16px;
          background: var(--surface-2, var(--surface-color));
          color: var(--text-primary);
          transition: border-color 0.18s ease, box-shadow 0.18s ease, transform 0.18s ease;
        }
        .wf-library-card:hover,
        .wf-library-card.active {
          border-color: rgba(91, 107, 255, 0.72);
          box-shadow: 0 18px 40px rgba(91, 107, 255, 0.14);
          transform: translateY(-1px);
        }
        .wf-library-card-top {
          display: grid;
          grid-template-columns: minmax(0, 1fr) auto;
          gap: 12px;
          align-items: flex-start;
        }
        .wf-library-card h4,
        .wf-library-card p,
        .wf-library-meta span {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .wf-status-pill {
          padding: 0.24rem 0.55rem;
          border-radius: 999px;
          background: rgba(148, 163, 184, 0.14);
          color: var(--text-secondary);
          font-size: 0.72rem;
          font-weight: 700;
        }
        .wf-status-pill.active {
          background: rgba(16, 185, 129, 0.14);
          color: #10b981;
        }
        .wf-library-meta {
          display: grid;
          gap: 6px;
          color: var(--text-secondary);
          font-size: 0.82rem;
        }
        .wf-library-actions {
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
        }
        /* Card action buttons share one row height with centered content.
        Text buttons drive the height; icon-only buttons (Leads eye +
        landing globe) stretch to match and stay square via aspect-ratio —
        the lone svg would otherwise sit on the text baseline and look
        shorter than its siblings. */
        .wf-library-actions {
          align-items: stretch;
        }
        .wf-library-actions > .btn-primary,
        .wf-library-actions > .btn-secondary {
          display: inline-flex;
          align-items: center;
          justify-content: center;
        }
        .wf-library-actions .wf-icon-btn {
          padding: 0.6rem;
          aspect-ratio: 1 / 1;
          min-width: 0;
        }
        .wf-library-actions .wf-icon-btn > svg {
          display: block;
        }
        /* Guaranteed hover tooltip for the card action buttons (Leads eye
        icon + landing-page control). Pure CSS via data-tip so it shows
        instantly alongside the native title fallback. */
        .wf-library-actions .wf-tip {
          position: relative;
        }
        .wf-library-actions .wf-tip[data-tip]:hover::after,
        .wf-library-actions .wf-tip[data-tip]:focus-visible::after {
          content: attr(data-tip);
          position: absolute;
          bottom: calc(100% + 8px);
          left: 50%;
          transform: translateX(-50%);
          max-width: 240px;
          width: max-content;
          background: rgba(16, 19, 42, 0.94);
          color: #fff;
          font-size: 0.75rem;
          font-weight: 500;
          line-height: 1.35;
          padding: 0.4rem 0.65rem;
          border-radius: 8px;
          white-space: normal;
          text-align: center;
          pointer-events: none;
          z-index: 60;
          box-shadow: 0 10px 24px rgba(16, 19, 42, 0.25);
        }
        .wf-library-empty {
          min-height: 360px;
          display: grid;
          place-items: center;
          text-align: center;
          padding: 36px 18px;
          border: 1px dashed var(--border-color);
          border-radius: 16px;
          background: var(--surface-2, var(--surface-color));
        }
        .wf-library-empty > * {
          max-width: 560px;
        }

        .wf-form-tabs {















          display: flex;















          gap: 8px;















          overflow-x: auto;















          min-width: 0;















          padding-bottom: 2px;















        }















        .wf-form-tab {















          display: grid;















          gap: 2px;















          min-width: 190px;















          max-width: 260px;















          padding: 10px 12px;















          border: 1px solid var(--border-color);















          border-radius: 12px;















          background: var(--surface-color);















          color: var(--text-primary);















          text-align: left;















        }















        .wf-form-tab.active {















          border-color: var(--accent-color);















          background: color-mix(in srgb, var(--accent-color) 12%, var(--surface-color));















        }















        .wf-form-tab span {















          overflow: hidden;















          text-overflow: ellipsis;















          white-space: nowrap;















          font-weight: 700;















        }















        .wf-form-tab small,















        .wf-muted {















          color: var(--text-secondary);















          font-size: 0.78rem;















        }















        .wf-builder-grid {















          display: grid;















          grid-template-columns: minmax(240px, 260px) minmax(0, 1fr);















          gap: 16px;















          align-items: start;















        }















        .wf-step-rail {















          padding: 12px;















          position: sticky;















          top: 16px;















          display: grid;















          gap: 10px;















          align-content: start;















          overflow: visible;















        }















        .wf-step-button {















          width: 100%;















          min-width: 0;















          max-width: 100%;















          flex: 1 1 auto;















          justify-content: flex-start;















          white-space: normal;















          line-height: 1.25;















          text-align: left;















          clip-path: none;















        }















        .wf-step-button span {















          flex: 0 0 24px;















        }















        .wf-section-actions {















          display: flex;















          gap: 8px;















          flex-wrap: wrap;















          margin-bottom: 16px;















          position: relative;















        }















        .wf-field-picker {















          position: absolute;















          top: calc(100% + 8px);















          left: 0;















          z-index: 1200;















          width: min(360px, calc(100vw - 48px));















          background: var(--modal-bg);















          border: 1px solid var(--border-color);















          border-radius: 12px;















          box-shadow: 0 24px 70px rgba(0, 0, 0, 0.72);















          opacity: 1;















          backdrop-filter: none;















          -webkit-backdrop-filter: none;















          background-image: none;















          color: var(--text-primary);















          overflow: hidden;















        }















        :root[data-theme="light"] .wf-field-picker {















          background: #ffffff;















          box-shadow: 0 24px 70px rgba(15, 23, 42, 0.24);















        }















        .wf-field-picker-search {















          display: flex;















          align-items: center;















          gap: 8px;















          padding: 10px;















          border-bottom: 1px solid var(--border-color);















          color: var(--text-secondary);















        }















        .wf-field-picker-search .input-field {















          min-height: 34px;















        }















        .wf-field-picker-list {















          max-height: 340px;















          overflow: auto;















          padding: 8px 0;















        }















        .wf-field-picker-heading {















          padding: 8px 14px 4px;















          color: var(--text-secondary);















          font-size: 0.72rem;















          font-weight: 700;















          letter-spacing: 0.04em;















          text-transform: uppercase;















        }















        .wf-field-picker-item {















          width: 100%;















          display: flex;















          align-items: center;















          justify-content: space-between;















          gap: 12px;















          padding: 8px 14px;















          border: 0;















          background: transparent;















          color: var(--text-primary);















          text-align: left;















          cursor: pointer;















        }















        .wf-field-picker-item:hover {















          background: var(--modal-bg);















        }















        .wf-field-picker-item small,















        .wf-field-picker-empty {















          color: var(--text-secondary);















          font-size: 0.78rem;















        }















        .wf-field-picker-empty {















          padding: 8px 14px;















        }















        .wf-fields-list {















          display: grid;















          gap: 12px;
          overflow: visible;
          position: relative;















        }

        .wf-conditional-group {
          display: grid;
          gap: 10px;
          padding: 12px;
          border: 1px solid rgba(91, 107, 255, 0.28);
          border-left: 4px solid var(--accent-color, #5b6bff);
          border-radius: 16px;
          background: color-mix(in srgb, var(--accent-color, #5b6bff) 5%, var(--surface-color));
        }

        .wf-conditional-group-header {
          display: flex;
          align-items: center;
          gap: 8px;
          flex-wrap: wrap;
          color: var(--text-primary);
          font-size: 0.82rem;
          font-weight: 700;
        }

        .wf-conditional-group-header small {
          color: var(--text-secondary);
          font-weight: 600;
        }

        .wf-conditional-group-fields {
          display: grid;
          gap: 10px;
        }

        .wf-conditional-child-card {
          margin-left: clamp(12px, 4vw, 44px);
          padding: 12px;
          border: 1px solid var(--border-color);
          border-left: 3px solid var(--accent-color, #5b6bff);
          border-radius: 12px;
          background: var(--surface-hover, rgba(91, 107, 255, 0.045));
        }

        .wf-conditional-child-heading {
          display: flex;
          align-items: center;
          gap: 7px;
          margin: 0 0 10px;
          color: var(--text-secondary);
          font-size: 0.78rem;
        }

        .wf-conditional-child-heading strong { color: var(--text-primary); }
        .wf-conditional-child-heading em { color: var(--accent-color, #5b6bff); font-style: normal; font-weight: 700; }

        .wf-add-page-modal-surface { background: #ffffff; }
        :root[data-theme="dark"] .wf-add-page-modal-surface { background: #171a21; }















        .wf-field-card {















          background: var(--surface-color);















          border: 1px solid var(--border-color);















          border-radius: 14px;















          padding: 16px;















          box-shadow: var(--wf-field-shadow);















        }















        .wf-field-grid {















          display: grid;















          grid-template-columns: minmax(180px, 260px) minmax(0, 1fr);















          gap: 16px;















          align-items: center;















        }

        .wf-field-grid > * {

          min-width: 0;

        }















        .wf-file-card {















          position: relative;















          z-index: 5;















          display: grid;















          gap: 18px;















          overflow: visible;















        }















        .wf-file-top-row {















          display: grid;















          grid-template-columns: minmax(180px, 260px) minmax(260px, 1fr) auto auto;















          gap: 16px;















          align-items: center;















        }















        .wf-file-icon {















          width: 32px;















          height: 32px;















          display: grid;















          place-items: center;















          border: 1px solid var(--border-color);















          border-radius: 8px;















          color: var(--text-primary);















          background: var(--modal-bg);















        }















        .wf-file-label,















        .wf-file-tags {















          display: grid;















          gap: 6px;















          min-width: 0;















          color: var(--text-primary);















          font-weight: 700;















          font-size: 0.86rem;















        }















        .wf-file-options {















          display: grid;















          grid-template-columns: minmax(260px, 1fr) minmax(240px, 1fr);















          gap: 18px 48px;















          padding-top: 18px;















          border-top: 1px solid var(--border-color);















        }















        .wf-file-format-wrap {















          position: relative;















          z-index: 10;















          min-width: 0;















        }















        .wf-file-format-trigger {















          display: inline-flex;















          align-items: center;















          gap: 4px;















          border: 0;















          background: transparent;















          color: var(--accent-color);















          padding: 0;















          font-weight: 600;















          text-align: left;















        }















        .wf-file-format-menu {















          position: absolute;















          top: calc(100% + 8px);















          left: 0;















          z-index: 5000;















          width: min(320px, calc(100vw - 48px));















          background: var(--modal-bg);















          border: 1px solid var(--border-color);















          border-radius: 12px;















          box-shadow: 0 24px 70px rgba(0, 0, 0, 0.72);















          opacity: 1;















          backdrop-filter: none;















          -webkit-backdrop-filter: none;















          background-image: none;















          padding: 12px 12px 0;















        }















        :root[data-theme="light"] .wf-file-format-menu {















          background: #ffffff;















          box-shadow: 0 24px 70px rgba(15, 23, 42, 0.24);















          opacity: 1;















        }















        .wf-link-button {















          border: 0;















          background: transparent;















          color: var(--accent-color);















          padding: 0;















          font-weight: 600;















        }















        .wf-settings-stack {















          display: grid;















          gap: 16px;















        }















        .wf-settings-block {















          display: grid;















          gap: 12px;















        }















        .wf-settings-toggle {















          display: flex;















          align-items: flex-start;















          gap: 10px;















          color: var(--text-primary);















          font-weight: 600;















        }















        .wf-settings-toggle input {















          margin-top: 3px;















          accent-color: var(--accent-color);















        }















        .wf-settings-inline {















          display: flex;















          align-items: center;















          justify-content: space-between;















          gap: 12px;















          flex-wrap: wrap;















        }




        .wf-embed-modal {
          background: var(--surface-color) !important;
          color: var(--text-primary);
          border-color: var(--border-color) !important;
          box-shadow: 0 28px 90px rgba(0, 0, 0, 0.34) !important;
        }
        .wf-embed-modal-head {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 18px;
          padding: 20px 22px 18px;
          border-bottom: 1px solid var(--border-color);
          background: var(--surface-color);
        }
        .wf-embed-modal-head strong {
          display: block;
          color: var(--text-primary);
          font-size: 1.05rem;
          font-weight: 800;
        }
        .wf-embed-modal-head p {
          margin: 0.35rem 0 0;
          color: var(--text-secondary);
          line-height: 1.45;
        }
        .wf-modal-close {
          min-width: 42px;
          min-height: 42px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          padding: 0;
        }
        .wf-embed-modal-body {
          display: grid;
          gap: 16px;
          padding: 20px 22px 22px;
          background: var(--surface-color);
        }
        .wf-copy-field {
          display: grid;
          gap: 8px;
        }
        .wf-copy-field > span {
          color: var(--text-secondary);
          font-size: 0.8rem;
          font-weight: 700;
        }
        .wf-copy-row {
          display: grid;
          grid-template-columns: minmax(0, 1fr) auto;
          gap: 10px;
          align-items: stretch;
        }
        .wf-embed-modal .input-field,
        .wf-embed-modal textarea.input-field {
          width: 100%;
          min-width: 0;
          background: var(--surface-2, var(--surface-hover)) !important;
          color: var(--text-primary) !important;
          border: 1px solid var(--border-color) !important;
          box-shadow: none !important;
        }
        .wf-embed-modal .input-field:read-only,
        .wf-embed-modal textarea.input-field:read-only {
          opacity: 1;
          cursor: text;
        }
        .wf-embed-textarea {
          min-height: 156px;
          resize: vertical;
          font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
          font-size: 0.82rem;
          line-height: 1.45;
        }
        .wf-embed-modal-actions {
          display: flex;
          justify-content: flex-end;
          gap: 10px;
          flex-wrap: wrap;
        }
        :root[data-theme="light"] .wf-embed-modal .input-field,
        :root[data-theme="light"] .wf-embed-modal textarea.input-field {
          background: #ffffff !important;
        }
        @media (max-width: 640px) {
          .wf-copy-row {
            grid-template-columns: 1fr;
          }
          .wf-embed-modal-head,
          .wf-embed-modal-body {
            padding-left: 16px;
            padding-right: 16px;
          }
          .wf-embed-modal-actions .btn-secondary,
          .wf-embed-modal-actions .btn-primary {
            flex: 1 1 160px;
            justify-content: center;
          }
        }

        .wf-link-popover {
          position: fixed;
          z-index: 10000;
          max-width: calc(100vw - 32px);
          max-height: calc(100vh - 32px);
          border: 1px solid var(--border-color);
          border-radius: 14px;
          background: var(--surface-color);
          color: var(--text-primary);
          box-shadow: 0 24px 70px rgba(0, 0, 0, 0.34);
          overflow: auto;
        }
        .wf-link-popover-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          padding: 12px 14px;
          border-bottom: 1px solid var(--border-color);
          background: var(--surface-color);
        }
        .wf-link-popover-body {
          display: grid;
          gap: 12px;
          padding: 14px;
          background: var(--surface-color);
        }
        .wf-link-popover .input-field {
          min-width: 0;
          width: 100%;
        }
        .wf-link-popover-actions {
          display: flex;
          justify-content: flex-end;
          gap: 8px;
          flex-wrap: wrap;
        }
        .wf-share-bar {

          display: grid;

          grid-template-columns: minmax(0, 1fr) auto;

          align-items: center;

          gap: 16px;

          padding: 16px 92px 16px 16px;

          border: 1px solid var(--border-color);

          border-radius: 14px;

          background: var(--surface-color);

          color: var(--text-primary);

          box-shadow: var(--wf-field-shadow);

        }

        .wf-share-meta {

          min-width: 0;

          display: grid;

          gap: 5px;

        }

        .wf-share-meta strong {

          display: block;

          overflow: hidden;

          text-overflow: ellipsis;

          white-space: nowrap;

          color: var(--text-primary);

          font-size: 0.98rem;

          line-height: 1.25;

        }

        .wf-share-meta span {

          display: block;

          overflow: hidden;

          text-overflow: ellipsis;

          white-space: nowrap;

          color: var(--text-secondary);

          font-size: 0.86rem;

        }

        .wf-share-actions {

          display: flex;

          justify-content: flex-end;

          gap: 8px;

          flex-wrap: wrap;

          min-width: 0;

        }

        .wf-share-actions .btn-secondary {

          background: var(--surface-color);

          border-color: var(--border-color);

          color: var(--text-primary);

          min-height: 38px;

          white-space: nowrap;

        }

        .wf-share-actions .btn-secondary:hover {

          background: var(--surface-hover);

        }

        .wf-share-actions .wf-danger-action {

          color: #dc2626;

          border-color: color-mix(in srgb, #dc2626 34%, var(--border-color));

        }

        .wf-share-actions .wf-danger-action:hover {

          background: color-mix(in srgb, #dc2626 10%, var(--surface-color));

        }















        .wf-file-format-list {















          display: grid;















          gap: 10px;















          max-height: 230px;















          overflow: auto;















          padding: 2px 2px 12px;















        }















        .wf-file-format-option {















          display: inline-flex;















          align-items: center;















          gap: 10px;















          color: var(--text-primary);















        }















        .wf-file-format-footer {















          display: flex;















          justify-content: flex-end;















          gap: 8px;















          margin: 0 -12px;















          padding: 10px 12px;















          border-top: 1px solid var(--border-color);















          background: var(--modal-bg);















        }















        .wf-style-block {















          display: grid;















          gap: 18px;















        }















        .wf-style-kicker {















          font-size: 0.86rem;















          font-weight: 700;















          color: var(--text-primary);















        }















        .wf-logo-upload {















          display: grid;















          gap: 10px;















          align-content: start;















        }















        .wf-logo-upload-label {















          font-weight: 700;















          color: var(--text-primary);















        }















        .wf-logo-preview {















          display: inline-flex;















          align-items: center;















          gap: 10px;















          width: fit-content;















          padding: 10px 12px;















          border: 1px solid var(--border-color);















          border-radius: 12px;















          background: var(--modal-bg);















          color: var(--text-secondary);















          font-size: 0.88rem;















        }















        .wf-logo-preview img {















          width: 32px;















          height: 32px;















          border-radius: 8px;















          object-fit: cover;















          background: var(--surface-color);















        }















        .wf-style-grid-top,















        .wf-style-grid-colors {















          display: grid;















          grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));















          gap: 12px;















        }















        .wf-style-divider {















          padding-top: 18px;















          border-top: 1px solid var(--border-color);















        }















        .wf-color-field {















          display: grid;















          gap: 6px;















          min-width: 0;















        }















        .wf-color-control {















          display: flex;















          min-width: 0;















        }















        .wf-color-text {















          border-top-right-radius: 0;















          border-bottom-right-radius: 0;















          min-width: 0;















          flex: 1;















        }















        .wf-color-native {















          width: 48px;















          min-width: 48px;















          height: 42px;















          padding: 4px;















          border: 1px solid var(--border-color);















          border-left: 0;















          border-top-right-radius: 12px;















          border-bottom-right-radius: 12px;















          border-top-left-radius: 0;















          border-bottom-left-radius: 0;















          background: var(--modal-bg);















          cursor: pointer;















        }















        .wf-color-native::-webkit-color-swatch-wrapper {















          padding: 0;















        }















        .wf-color-native::-webkit-color-swatch {















          border: 0;















          border-radius: 8px;
}
 .wf-color-native::-moz-color-swatch {
 border: 0;
 border-radius: 8px;
   }
  @media (max-width: 1200px) {
 .wf-field-grid {
 grid-template-columns: 1fr;
 align-items: stretch;
     }

        }

        @media (max-width: 760px) {

          .wf-field-editor-grid {

            grid-template-columns: 1fr !important;

          }

          .wf-field-editor-actions {

            justify-content: flex-start !important;

            flex-wrap: wrap !important;

            width: auto !important;

          }
       }
     @media (max-width: 1100px) {
    .wf-form-toolbar,
        .wf-builder-grid {
         grid-template-columns: 1fr;
      }
      .wf-step-rail {
     position: static;
       }
        }

        @media (min-width: 761px) and (max-width: 1800px) {

          .wf-builder-grid {

            grid-template-columns: 1fr;

          }

          .wf-step-rail {

            position: static;

            display: flex;

            flex-wrap: wrap;

            gap: 10px;

          }

          .wf-step-button {

            flex: 1 1 180px;

            width: auto;

          }

          .wf-field-editor-grid {

            grid-template-columns: minmax(220px, 1fr) minmax(220px, 1fr) !important;

          }

          .wf-field-editor-actions {

            grid-column: 1 / -1 !important;

            width: 100% !important;

            justify-self: stretch !important;

            justify-content: flex-end !important;

          }

        }
     @media (max-width: 760px) {

          .wf-share-bar {

            grid-template-columns: 1fr;

            align-items: stretch;

            padding-right: 16px;

          }

          .wf-share-actions {

            justify-content: stretch;

          }

          .wf-share-actions .btn-secondary {

            flex: 1 1 150px;

            justify-content: center;

          }

        }

      `}</style>
    <header style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
     <div style={{ minWidth: 0 }}>
     <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <h2 style={{ margin: 0, fontSize: "1.7rem", color: "var(--text-primary)" }}>Web Forms</h2>
        {builderOpen && selectedForm ? <span style={{ padding: "0.25rem 0.5rem", borderRadius: 999, background: selectedForm.isActive ? "rgba(16,185,129,0.14)" : "rgba(255,255,255,0.08)", color: selectedForm.isActive ? "#10b981" : "var(--text-secondary)", fontSize: "0.75rem", fontWeight: 600 }}>{selectedForm.isActive ? "ACTIVE" : "PAUSED"}</span> : null}
         {builderOpen && dirty ? <span style={{ padding: "0.25rem 0.5rem", borderRadius: 999, background: "rgba(91,107,255,0.14)", color: "#8ea0ff", fontSize: "0.75rem", fontWeight: 600 }}>Unsaved changes</span> : null}
   </div>
       <p style={{ margin: "0.45rem 0 0", color: "var(--text-secondary)", maxWidth: 780 }}>
          Build forms that pull from contact fields, lead custom fields, or custom inputs, then share a public URL or iframe snippet.
          </p>
     </div>
       <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {builderOpen ? <button type="button" className="btn-secondary" onClick={showFormsLibrary}>Back to all forms</button> : null}
          <button type="button" className="btn-secondary" onClick={createForm}><Plus size={16} style={{ marginRight: 6, verticalAlign: "middle" }} />New form</button>
          {builderOpen ? <button type="button" className="btn-secondary" disabled={!selectedForm} onClick={() => setShowEmbed(true)}><Code2 size={16} style={{ marginRight: 6, verticalAlign: "middle" }} />Get embed code and URL</button> : null}
          {builderOpen ? <button type="button" className="btn-secondary" disabled={!selectedForm} onClick={() => setShowPreview(true)}><Eye size={16} style={{ marginRight: 6, verticalAlign: "middle" }} />Preview form</button> : null}
          {builderOpen ? <button type="button" className="btn-primary" disabled={!selectedForm || saving || !dirty} onClick={saveForm}><Save size={16} style={{ marginRight: 6, verticalAlign: "middle" }} />Save</button> : null}
        </div>
  </header>
  <div className="wf-form-toolbar">
        <div className="wf-search-wrap">
          <Search size={16} />
          <input className="input-field" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search forms" />
        </div>
        {builderOpen && selectedForm ? (
          <div className="wf-builder-context">
            <span>Editing</span>
            <strong>{selectedForm.name}</strong>
            <small>{selectedForm.submissionCount || 0} submits</small>
          </div>
        ) : null}
      </div>

      {!builderOpen ? (
        <section className="wf-forms-library" aria-label="Saved web forms">
          <div className="wf-library-head">
            <div>
              <h3>All web forms</h3>
              <p>{loading ? "Loading forms..." : `${filteredForms.length} form${filteredForms.length === 1 ? "" : "s"} available`}</p>
            </div>
          </div>

          {loading ? (
            <div className="wf-library-empty"><span className="wf-muted">Loading forms...</span></div>
          ) : filteredForms.length === 0 ? (
            <div className="wf-library-empty">
              <div style={{ width: 64, height: 64, borderRadius: 18, background: "rgba(91,107,255,0.16)", display: "grid", placeItems: "center", margin: "0 auto 12px", color: "#5b6bff" }}><ListChecks size={28} /></div>
              <h3>Create your first form</h3>
              <p>Add contact fields, lead fields, custom inputs, and styling rules. The builder generates an embed snippet you can paste anywhere.</p>
              <button type="button" className="btn-primary" onClick={createForm}><Plus size={16} style={{ marginRight: 6, verticalAlign: "middle" }} />New form</button>
            </div>
          ) : (
            <div className="wf-library-grid">
              {filteredForms.map((form) => (
                <article key={form.id} className={String(selectedForm?.id) === String(form.id) ? "wf-library-card active" : "wf-library-card"}>
                  <div className="wf-library-card-top">
                    <div>
                      <h4>{form.name}</h4>
                      <p>{form.description || "No description added"}</p>
                    </div>
                    <span className={form.isActive ? "wf-status-pill active" : "wf-status-pill"}>{form.isActive ? "Active" : "Paused"}</span>
                  </div>
                  <div className="wf-library-meta">
                    <span>{form.submissionCount || 0} submits</span>
                    <span>{form.slug}</span>
                  </div>
                  <div className="wf-library-actions">
                    <button type="button" className="btn-primary" onClick={() => selectForm(form)}>Open builder</button>
                    <button type="button" className="btn-secondary" onClick={() => { setSelectedForm(normalizeForm(form, leadFields)); setShowEmbed(true); }}>Embed</button>
                    <button type="button" className="btn-secondary" onClick={() => { setSelectedForm(normalizeForm(form, leadFields)); setShowPreview(true); }}>Preview</button>
                    <button type="button" className="btn-secondary wf-danger-action" onClick={() => deleteForm(form)}><Trash2 size={15} style={{ marginRight: 6, verticalAlign: "middle" }} />Delete</button>
                    {canViewFormLeads && <button type="button" className="btn-secondary" onClick={() => setLeadsForm(form)}>View All Leads</button>}
                    {isGenericScope && canManageLandingForm ? (
                      String(landingFormId) === String(form.id) ? (
                        <span className="wf-tip" style={{ display: "inline-flex", alignItems: "center", gap: 8 }} data-tip="This form shows on the public landing page for everyone" title="This form shows on the public landing page for everyone">
                          On landing page<CheckCircle2 size={20} aria-hidden="true" style={{ color: "var(--success-color)", flexShrink: 0 }} />
                        </span>
                      ) : (
                        <label className="wf-landing-checkbox wf-tip" style={{ display: "inline-flex", alignItems: "center", gap: 6 }} data-tip={`Use ${form.name} as the public landing page form`} title={`Use this form in landing page: ${form.name}`}>
                          <input type="checkbox" checked={String(landingFormId) === String(form.id)} disabled={settingLandingFormId === form.id} onChange={() => setAsLandingForm(form)} aria-label={`Use this form in landing page: ${form.name}`} />
                          <span>Landing page</span>
                        </label>
                      )
                    ) : null}
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      ) : null}

      {canViewFormLeads && leadsForm && <WebFormLeadsModal key={leadsForm.id} form={leadsForm} onClose={() => setLeadsForm(null)} />}
      {builderOpen ? (
        <div style={{ display: "grid", gap: 16, alignItems: "start" }}>
  <main style={{ display: "grid", gap: 16, minWidth: 0 }}>
 {!selectedForm ? (
     <div className="card" style={{ padding: 24, minHeight: 420, display: "grid", placeItems: "center", textAlign: "center", background: "var(--surface-1, #14171c)", border: "1px solid var(--border-color, rgba(255,255,255,0.08))", borderRadius: 18 }}>
    <div>
    <div style={{ width: 64, height: 64, borderRadius: 18, background: "rgba(91,107,255,0.16)", display: "grid", placeItems: "center", margin: "0 auto 12px", color: "#8ea0ff" }}><ListChecks size={28} /></div>
      <h3 style={{ margin: 0 }}>Create your first form</h3>
        <p style={{ margin: "0.5rem 0 1rem", color: "var(--text-secondary)", maxWidth: 560 }}>
    Add contact fields, lead fields, custom inputs, and styling rules. The builder generates an embed snippet you can paste anywhere.
    </p>
<button type="button" className="btn-primary" onClick={createForm}><Plus size={16} style={{ marginRight: 6, verticalAlign: "middle" }} />New form</button>
     </div>
   </div>
       ) : (
          <div className="wf-builder-grid">
           <aside className="card wf-step-rail">
          <button type="button" className="btn-secondary wf-step-button" onClick={() => document.getElementById("wf-fields")?.scrollIntoView({ behavior: "smooth", block: "start" })}><span style={{ width: 24, height: 24, borderRadius: 999, display: "inline-grid", placeItems: "center", background: "var(--wf-step-bg)", color: "var(--wf-step-text)", marginRight: 8 }}>1</span>Add fields</button>
          <button type="button" className="btn-secondary wf-step-button" onClick={() => { const section = document.getElementById("wf-style"); if (!section) return; window.scrollTo({ top: section.getBoundingClientRect().top + window.scrollY - 16, behavior: "smooth" }); }}><span style={{ width: 24, height: 24, borderRadius: 999, display: "inline-grid", placeItems: "center", background: "var(--wf-step-bg)", color: "var(--wf-step-text)", marginRight: 8 }}>2</span>Customize text and colors</button>
             <button type="button" className="btn-secondary wf-step-button" onClick={() => document.getElementById("wf-settings")?.scrollIntoView({ behavior: "smooth", block: "start" })}><span style={{ width: 24, height: 24, borderRadius: 999, display: "inline-grid", placeItems: "center", background: "var(--wf-step-bg)", color: "var(--wf-step-text)", marginRight: 8 }}>3</span>Settings</button>
          </aside>
           <div style={{ display: "grid", gap: 16, minWidth: 0 }}>
               <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px 14px", marginBottom: 4, borderRadius: 16, background: "var(--surface-color)", border: "1px solid var(--border-color)", boxShadow: "var(--wf-shadow)" }}>
  <input
 className="input-field"
  value={selectedForm.name}
  onChange={(e) => applyDraft({ name: e.target.value })}
     style={{ maxWidth: 820, border: 0, borderBottom: "1px solid var(--accent-color, #5b6bff)", borderRadius: 0, background: "transparent", color: "var(--text-primary)", fontSize: "1.15rem", fontWeight: 700, paddingLeft: 0 }}
         />
        </div>
             <Section id="wf-fields" step={1} title="Add fields to the form" subtitle="Mix contact fields, lead custom fields, and your own custom inputs. Users can also upload files or choose from dropdown and radio options.">
           <div className="wf-section-actions">
                  <button ref={fieldPickerButtonRef} type="button" className="btn-secondary" onClick={toggleFieldPicker}>
           <Type size={16} style={{ marginRight: 6, verticalAlign: "middle" }} />Add contact fields <ChevronDown size={14} style={{ marginLeft: 6, verticalAlign: "middle" }} />
          </button>

                      <button type="button" className="btn-secondary" onClick={() => addField("file")}><Paperclip size={16} style={{ marginRight: 6, verticalAlign: "middle" }} />Add field for file attachment</button>
                      {supportsAdvancedWebFormFeatures(selectedForm?.scope) ? (
                        <div style={{ display: "flex", gap: 8, marginLeft: "auto", flexWrap: "wrap" }}>
                          <button type="button" className="btn-secondary" onClick={addConditionalFlow}><Plus size={16} style={{ marginRight: 6, verticalAlign: "middle" }} />Add conditional flow</button>
                          <button type="button" className="btn-secondary" onClick={addFormStep}><Plus size={16} style={{ marginRight: 6, verticalAlign: "middle" }} />Add page</button>
                        </div>
                      ) : null}
               <FieldPicker open={fieldPickerOpen} anchorRef={fieldPickerButtonRef} leadFields={leadFields} existingFields={selectedForm?.fields || []} scope={selectedForm?.scope || "generic"} onPick={handlePickField} onClose={() => setFieldPickerOpen(false)} />
                 </div>

                    {leadFields.length === 0 ? <div style={{ marginBottom: 12, color: "var(--text-secondary)", fontSize: "0.88rem" }}>Lead custom fields are not configured yet. You can still build the form with contact and custom fields.</div> : null}
                   <div className="wf-fields-list">
                 <DndContext sensors={sensors} collisionDetection={closestCenter} modifiers={[restrictToVerticalAxis, restrictToWebFormsFieldList]} onDragEnd={handleDragEnd}>
                        <SortableContext items={(selectedForm.fields || []).map((field) => String(field.id))} strategy={verticalListSortingStrategy}>
                          {builderFieldGroups.map((group) => {
                            const groupFields = group.fields.map(({ field }) => field);
                            const renderField = ({ field, index }) => (
                              <FieldCard key={field.id} field={field} index={index} allFields={builderFields} conditionalFlowFields={groupFields} leadFields={leadFields} scope={selectedForm.scope} onChange={updateField} onMove={moveField} onRemove={removeField} phoneSettings={supportsAdvancedWebFormFeatures(selectedForm.scope) && field.sourceKey === "phone" ? selectedForm.settings : null} onPhoneSettingsChange={(settings) => applyDraft({ settings })} onAddConditionalChild={addConditionalChild} steps={selectedForm.settings.steps} multiStepEnabled={selectedForm.settings.multiStepEnabled} formScope={selectedForm.scope} formSettings={selectedForm.settings} onFormSettingsChange={(settings) => applyDraft({ settings })} />
                            );

                            if (group.fields.length === 1) return renderField(group.fields[0]);

                            return (
                              <div key={`conditional-group-${group.root?.id || group.firstIndex}`} className="wf-conditional-group" aria-label={`Conditional flow starting with ${group.root?.label || "parent question"}`}>
                                <div className="wf-conditional-group-header">
                                  <span>Conditional flow</span>
                                  <small>Starts with: {group.root?.label || "Parent question"} · {group.fields.length} questions</small>
                                  <small>For each child: choose its parent question and answer. A child can become the next parent.</small>
                                </div>
                                <div className="wf-conditional-group-fields">
                                  {(() => {
                                    const entriesById = new Map(group.fields.map((entry) => [String(entry.field.id), entry]));
                                    const childrenByParent = new Map();

                                    group.fields.forEach((entry) => {
                                      const parentId = entry.field.showWhen?.fieldId ? String(entry.field.showWhen.fieldId) : "";
                                      if (!parentId || !entriesById.has(parentId)) return;
                                      if (!childrenByParent.has(parentId)) childrenByParent.set(parentId, []);
                                      childrenByParent.get(parentId).push(entry);
                                    });

                                    const renderConditionalEntry = (entry, isRoot = false, depth = 0) => {
                                      const rendered = [
                                        isRoot ? renderField(entry) : (
                                          <div key={`conditional-child-${entry.field.id}`} className={`wf-conditional-child-card wf-conditional-depth-${depth}`}>
                                            <div className="wf-conditional-child-heading">
                                              <span aria-hidden="true">↳</span>
                                              <strong>Show question</strong>
                                              <span>when answer is</span>
                                              <em>{entry.field.showWhen?.value || "Not specified"}</em>
                                            </div>
                                            {renderField(entry)}
                                          </div>
                                        ),
                                      ];

                                      (childrenByParent.get(String(entry.field.id)) || []).forEach((child) => {
                                        rendered.push(...renderConditionalEntry(child, false, depth + 1));
                                      });
                                      return rendered;
                                    };

                                    const rootEntries = group.fields.filter((entry) => {
                                      const parentId = entry.field.showWhen?.fieldId ? String(entry.field.showWhen.fieldId) : "";
                                      return !parentId || !entriesById.has(parentId);
                                    });

                                    return rootEntries.flatMap((entry) => renderConditionalEntry(entry, true));
                                  })()}
                                </div>
                              </div>
                            );
                          })}
                        </SortableContext>
                      </DndContext>
                 </div>
                  </Section>
                 <Section id="wf-style" step={2} title="Customize text and colors" subtitle="Tune the copy, logo, font, and colors so the embedded form matches your brand.">
                    {selectedForm.scope === "generic" ? <GenericLiveCustomizationEditor form={selectedForm} fields={builderFields} selection={genericStyleSelection} onSelectionChange={setGenericStyleSelection} applyDraft={applyDraft} logoUploadRef={logoUploadRef} uploadingLogo={uploadingLogo} onLogoUpload={handleLogoUpload} /> : null}
                    {selectedForm.scope === "travel" ? <div className="web-form-builder-generic wf-travel-live-preview-scope"><GenericLiveCustomizationEditor form={selectedForm} fields={builderFields} selection={genericStyleSelection} onSelectionChange={setGenericStyleSelection} applyDraft={applyDraft} logoUploadRef={logoUploadRef} uploadingLogo={uploadingLogo} onLogoUpload={handleLogoUpload} /></div> : null}
                    {selectedForm.scope !== "generic" && selectedForm.scope !== "travel" ? <div className="wf-style-block">
                     <div className="wf-style-kicker">Logo and form text</div>

                      <div className="wf-logo-upload">
                       <div className="wf-logo-upload-label">Add a logo to your form</div>

                        <input ref={logoUploadRef} type="file" accept="image/*" style={{ display: "none" }} onChange={handleLogoUpload} />
                      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                   <button type="button" className="btn-secondary" disabled={uploadingLogo} onClick={() => logoUploadRef.current?.click()}>
                     <Upload size={16} style={{ marginRight: 6, verticalAlign: "middle" }} /> {uploadingLogo ? "Uploading..." : "Upload"}
                        </button>
                   {selectedForm.style.logoUrl ? <button type="button" className="btn-secondary" onClick={() => applyDraft({ style: { ...selectedForm.style, logoUrl: "" } })}>Remove</button> : null}
                 </div>
                      {selectedForm.style.logoUrl ? (
               <div className="wf-logo-preview">
                 <img src={selectedForm.style.logoUrl} alt="Form logo preview" />
                <span>Logo uploaded</span>
                </div>
               ) : null}
               </div>

                      <div className="wf-style-grid-top">
                        <label style={{ display: "grid", gap: 6, minWidth: 0, ...labelLengthStyle("Title of the form") }}>
                          <span style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>Title of the form</span>
                          <input className="input-field" value={selectedForm.settings.formTitle} onChange={(e) => applyDraft({ settings: { ...selectedForm.settings, formTitle: e.target.value } })} />
                        </label>
                        <label style={{ display: "grid", gap: 6, minWidth: 0, ...labelLengthStyle("Description") }}>
                          <span style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>Description</span>
                          <input className="input-field" value={selectedForm.description} onChange={(e) => applyDraft({ description: e.target.value })} placeholder="Tell people what the form is for" />
                        </label>
                        <label style={{ display: "grid", gap: 6, minWidth: 0, ...labelLengthStyle("Field label for Submit button *") }}>
                          <span style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>Field label for Submit button *</span>
                          <input className="input-field" value={selectedForm.settings.submitButtonLabel} onChange={(e) => applyDraft({ settings: { ...selectedForm.settings, submitButtonLabel: e.target.value } })} />
                        </label>

                        <label style={{ display: "grid", gap: 6, minWidth: 0, ...labelLengthStyle("Font *") }}>
                          <span style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>Font *</span>

                          <select className="input-field" style={optionLengthStyle(["Inter / system UI", "Arial", "Georgia", "Tahoma", "Verdana"])} value={selectedForm.style.fontFamily} onChange={(e) => applyDraft({ style: { ...selectedForm.style, fontFamily: e.target.value } })}>

                            <option value="Inter, system-ui, sans-serif">Inter / system UI</option>

                            <option value="Arial, sans-serif">Arial</option>

                            <option value="Georgia, serif">Georgia</option>
                            <option value="Tahoma, sans-serif">Tahoma</option>
                            <option value="Verdana, sans-serif">Verdana</option>
                          </select>
                        </label>
                      </div>
                      <div className="wf-style-divider">
                        <div className="wf-style-grid-colors">
                          <ColorField label="Background color *" value={selectedForm.style.backgroundColor} onChange={(value) => applyDraft({ style: { ...selectedForm.style, backgroundColor: value } })} fallback="#EBEFF3" />
                          <ColorField label="Form color *" value={selectedForm.style.formColor} onChange={(value) => applyDraft({ style: { ...selectedForm.style, formColor: value } })} fallback="#FFFFFF" />
                          <ColorField label="Title color *" value={selectedForm.style.titleColor} onChange={(value) => applyDraft({ style: { ...selectedForm.style, titleColor: value } })} fallback="#000000" />
                          <ColorField label="Color of Submit button *" value={selectedForm.style.buttonColor} onChange={(value) => applyDraft({ style: { ...selectedForm.style, buttonColor: value } })} fallback="#12344D" />
                          <ColorField label="Color of field labels *" value={selectedForm.style.fieldLabelColor} onChange={(value) => applyDraft({ style: { ...selectedForm.style, fieldLabelColor: value } })} fallback="#666666" />
                        </div>
                      </div>
                      {supportsAdvancedWebFormFeatures(selectedForm.scope) ? (
                        <div className="wf-style-divider" style={{ display: "grid", gap: 18 }}>
                          <div className="wf-style-kicker">Typography</div>
                          <div className="wf-style-grid-colors">
                            <StyleNumberField label="Font size (px)" value={selectedForm.style.fontSize} min={10} max={32} onChange={(value) => applyDraft({ style: { ...selectedForm.style, fontSize: value } })} />
                            <label style={{ display: "grid", gap: 6, ...labelLengthStyle("Font weight") }}><span style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>Font weight</span><select className="input-field" style={optionLengthStyle([400, 500, 600, 700])} value={selectedForm.style.fontWeight} onChange={(e) => applyDraft({ style: { ...selectedForm.style, fontWeight: Number(e.target.value) } })}>{[400, 500, 600, 700].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
                            <StyleNumberField label="Label size (px)" value={selectedForm.style.labelFontSize} min={9} max={24} onChange={(value) => applyDraft({ style: { ...selectedForm.style, labelFontSize: value } })} />
                            <StyleNumberField label="Placeholder size (px)" value={selectedForm.style.placeholderFontSize} min={9} max={24} onChange={(value) => applyDraft({ style: { ...selectedForm.style, placeholderFontSize: value } })} />
                            <StyleNumberField label="Error message size (px)" value={selectedForm.style.errorFontSize} min={9} max={24} onChange={(value) => applyDraft({ style: { ...selectedForm.style, errorFontSize: value } })} />
                            <StyleNumberField label="Success message size (px)" value={selectedForm.style.successFontSize} min={9} max={32} onChange={(value) => applyDraft({ style: { ...selectedForm.style, successFontSize: value } })} />
                          </div>
                          <div className="wf-style-kicker">Fields</div>
                          <div className="wf-style-grid-colors">
                            <StyleNumberField label="Field width (%)" value={selectedForm.style.fieldWidth} min={50} max={100} onChange={(value) => applyDraft({ style: { ...selectedForm.style, fieldWidth: value } })} />
                            <StyleNumberField label="Field height (px)" value={selectedForm.style.fieldHeight} min={10} max={96} onChange={(value) => applyDraft({ style: { ...selectedForm.style, fieldHeight: value } })} />
                            <StyleNumberField label="Border width (px)" value={selectedForm.style.fieldBorderWidth} min={0} max={8} onChange={(value) => applyDraft({ style: { ...selectedForm.style, fieldBorderWidth: value } })} />
                            <StyleNumberField label="Border radius (px)" value={selectedForm.style.fieldBorderRadius} min={0} max={40} onChange={(value) => applyDraft({ style: { ...selectedForm.style, fieldBorderRadius: value } })} />
                            <ColorField label="Border color" value={selectedForm.style.fieldBorderColor} onChange={(value) => applyDraft({ style: { ...selectedForm.style, fieldBorderColor: value } })} fallback="#D8DDEC" />
                            <ColorField label="Focus border color" value={selectedForm.style.fieldFocusBorderColor} onChange={(value) => applyDraft({ style: { ...selectedForm.style, fieldFocusBorderColor: value } })} fallback="#6366F1" />
                            <ColorField label="Field background" value={selectedForm.style.fieldBackgroundColor} onChange={(value) => applyDraft({ style: { ...selectedForm.style, fieldBackgroundColor: value } })} fallback="#FFFFFF" />
                            <ColorField label="Placeholder color" value={selectedForm.style.placeholderColor} onChange={(value) => applyDraft({ style: { ...selectedForm.style, placeholderColor: value } })} fallback="#6B7280" />
                            <ColorField label="Text color" value={selectedForm.style.fieldTextColor} onChange={(value) => applyDraft({ style: { ...selectedForm.style, fieldTextColor: value } })} fallback="#111827" />
                          </div>
                          <div className="wf-style-kicker">Layout</div>
                          <div className="wf-style-grid-colors">
                            <label style={{ display: "grid", gap: 6, ...labelLengthStyle("Desktop columns") }}><span style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>Desktop columns</span><select className="input-field" style={optionLengthStyle(["One column", "Two columns"])} value={selectedForm.style.layoutColumns} onChange={(e) => applyDraft({ style: { ...selectedForm.style, layoutColumns: e.target.value } })}><option value="one">One column</option><option value="two">Two columns</option></select></label>
                            <StyleNumberField label="Custom column width (%)" value={selectedForm.style.customColumnWidth} min={25} max={75} onChange={(value) => applyDraft({ style: { ...selectedForm.style, customColumnWidth: value } })} />
                            <StyleNumberField label="Row gap (px)" value={selectedForm.style.rowGap} min={0} max={64} onChange={(value) => applyDraft({ style: { ...selectedForm.style, rowGap: value } })} />
                            <StyleNumberField label="Column gap (px)" value={selectedForm.style.columnGap} min={0} max={64} onChange={(value) => applyDraft({ style: { ...selectedForm.style, columnGap: value } })} />
                            <label style={{ display: "grid", gap: 6, ...labelLengthStyle("Tablet layout") }}><span style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>Tablet layout</span><select className="input-field" style={optionLengthStyle(["One column", "Two columns"])} value={selectedForm.style.tabletColumns} onChange={(e) => applyDraft({ style: { ...selectedForm.style, tabletColumns: e.target.value } })}><option value="one">One column</option><option value="two">Two columns</option></select></label>
                            <label style={{ display: "grid", gap: 6, ...labelLengthStyle("Mobile layout") }}><span style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>Mobile layout</span><select className="input-field" style={optionLengthStyle(["One column", "Two columns"])} value={selectedForm.style.mobileColumns} onChange={(e) => applyDraft({ style: { ...selectedForm.style, mobileColumns: e.target.value } })}><option value="one">One column</option><option value="two">Two columns</option></select></label>
                          </div>
                          <div className="wf-style-kicker">Form Container</div>
                          <div className="wf-style-grid-colors">
                            <label style={{ display: "grid", gap: 6, ...labelLengthStyle("Background") }}><span style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>Background</span><select className="input-field" style={optionLengthStyle(["Solid background", "Gradient background"])} value={selectedForm.style.containerBackgroundMode} onChange={(e) => applyDraft({ style: { ...selectedForm.style, containerBackgroundMode: e.target.value } })}><option value="solid">Solid background</option><option value="gradient">Gradient background</option></select></label>
                            {selectedForm.style.containerBackgroundMode === "gradient" ? <>
                              <ColorField label="Gradient start" value={selectedForm.style.gradientStart} onChange={(value) => applyDraft({ style: { ...selectedForm.style, gradientStart: value } })} fallback="#FFFFFF" />
                              <ColorField label="Gradient end" value={selectedForm.style.gradientEnd} onChange={(value) => applyDraft({ style: { ...selectedForm.style, gradientEnd: value } })} fallback="#EEF1FF" />
                              <StyleNumberField label="Gradient angle (degrees)" value={selectedForm.style.gradientAngle} min={0} max={360} onChange={(value) => applyDraft({ style: { ...selectedForm.style, gradientAngle: value } })} />
                            </> : null}
                            <ColorField label="Container border" value={selectedForm.style.containerBorderColor} onChange={(value) => applyDraft({ style: { ...selectedForm.style, containerBorderColor: value } })} fallback="#D8DDEC" />
                            <StyleNumberField label="Container border width (px)" value={selectedForm.style.containerBorderWidth} min={0} max={8} onChange={(value) => applyDraft({ style: { ...selectedForm.style, containerBorderWidth: value } })} />
                            <StyleNumberField label="Container radius (px)" value={selectedForm.style.containerBorderRadius} min={0} max={48} onChange={(value) => applyDraft({ style: { ...selectedForm.style, containerBorderRadius: value } })} />
                            <StyleNumberField label="Container padding (px)" value={selectedForm.style.containerPadding} min={0} max={80} onChange={(value) => applyDraft({ style: { ...selectedForm.style, containerPadding: value } })} />
                            <StyleNumberField label="Container margin (px)" value={selectedForm.style.containerMargin} min={0} max={80} onChange={(value) => applyDraft({ style: { ...selectedForm.style, containerMargin: value } })} />
                            <label style={{ display: "grid", gap: 6, ...labelLengthStyle("Shadow") }}><span style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>Shadow</span><select className="input-field" style={optionLengthStyle(["None", "Soft", "Compact"])} value={selectedForm.style.containerShadow} onChange={(e) => applyDraft({ style: { ...selectedForm.style, containerShadow: e.target.value } })}><option value="none">None</option><option value="0 24px 70px rgba(30,41,96,.14)">Soft</option><option value="0 8px 24px rgba(15,23,42,.18)">Compact</option></select></label>
                          </div>
                          <div className="wf-style-kicker">Button</div>
                          <div className="wf-style-grid-colors">
                            <ColorField label="Hover color" value={selectedForm.style.buttonHoverColor} onChange={(value) => applyDraft({ style: { ...selectedForm.style, buttonHoverColor: value } })} fallback="#0D2639" />
                            <ColorField label="Button text color" value={selectedForm.style.buttonTextColor} onChange={(value) => applyDraft({ style: { ...selectedForm.style, buttonTextColor: value } })} fallback="#FFFFFF" />
                            <StyleNumberField label="Button font size (px)" value={selectedForm.style.buttonFontSize} min={10} max={32} onChange={(value) => applyDraft({ style: { ...selectedForm.style, buttonFontSize: value } })} />
                            <StyleNumberField label="Button height (px)" value={selectedForm.style.buttonHeight} min={30} max={96} onChange={(value) => applyDraft({ style: { ...selectedForm.style, buttonHeight: value } })} />
                            <StyleNumberField label="Button radius (px)" value={selectedForm.style.buttonBorderRadius} min={0} max={40} onChange={(value) => applyDraft({ style: { ...selectedForm.style, buttonBorderRadius: value } })} />
                            <ColorField label="Button border" value={selectedForm.style.buttonBorderColor} onChange={(value) => applyDraft({ style: { ...selectedForm.style, buttonBorderColor: value } })} fallback="#12344D" />
                            <StyleNumberField label="Button border width (px)" value={selectedForm.style.buttonBorderWidth} min={0} max={8} onChange={(value) => applyDraft({ style: { ...selectedForm.style, buttonBorderWidth: value } })} />
                            <label style={{ display: "grid", gap: 6, ...labelLengthStyle("Width") }}><span style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>Width</span><select className="input-field" style={optionLengthStyle(["Auto", "Full width"])} value={selectedForm.style.buttonWidth} onChange={(e) => applyDraft({ style: { ...selectedForm.style, buttonWidth: e.target.value } })}><option value="auto">Auto</option><option value="full">Full width</option></select></label>
                            <label style={{ display: "grid", gap: 6, ...labelLengthStyle("Alignment") }}><span style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>Alignment</span><select className="input-field" style={optionLengthStyle(["Left", "Center", "Right", "Full width"])} value={selectedForm.style.buttonAlignment} onChange={(e) => applyDraft({ style: { ...selectedForm.style, buttonAlignment: e.target.value } })}><option value="left">Left</option><option value="center">Center</option><option value="right">Right</option><option value="full">Full width</option></select></label>
                            <ColorField label="Loading color" value={selectedForm.style.buttonLoadingColor} onChange={(value) => applyDraft({ style: { ...selectedForm.style, buttonLoadingColor: value } })} fallback="#12344D" />
                            <label style={{ display: "grid", gap: 6 }}><span style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>Loading text</span><input className="input-field" value={selectedForm.style.buttonLoadingText} onChange={(e) => applyDraft({ style: { ...selectedForm.style, buttonLoadingText: e.target.value } })} /></label>
                          </div>
                          <div className="wf-style-kicker">Messages</div>
                          <div className="wf-style-grid-colors">
                            <ColorField label="Success message color" value={selectedForm.style.successMessageColor} onChange={(value) => applyDraft({ style: { ...selectedForm.style, successMessageColor: value } })} fallback="#065F46" />
                            <ColorField label="Error message color" value={selectedForm.style.errorMessageColor} onChange={(value) => applyDraft({ style: { ...selectedForm.style, errorMessageColor: value } })} fallback="#B91C1C" />
                          </div>
                        </div>
                      ) : null}
                    </div> : null}
                  </Section>
                 <Section id="wf-settings" step={3} title="Settings" subtitle="Choose what happens after submit and how the submission should be routed.">
                    <div className="wf-settings-stack">
                      {supportsAdvancedWebFormFeatures(selectedForm.scope) ? (<div className="wf-settings-block">
                        <label className="wf-settings-toggle">
                          <input type="checkbox" checked={Boolean(selectedForm.settings.recaptchaEnabled)} onChange={(e) => applyDraft({ settings: { ...selectedForm.settings, recaptchaEnabled: e.target.checked } })} />
                          <span>Enable reCAPTCHA</span>
                        </label>
                      </div>) : null}
                      <div className="wf-settings-block">
                        <label className="wf-settings-toggle">
                          <input
                            type="checkbox"
                            checked={selectedForm.settings.showPoweredBy !== false}
                            onChange={(e) => applyDraft({ settings: { ...selectedForm.settings, showPoweredBy: e.target.checked } })}
                          />
                          <span>Show “Powered By GlobusCRM” on this web form</span>
                        </label>
                      </div>
                      <div className="wf-settings-block">
                        <div style={{ fontSize: "0.88rem", fontWeight: 700, color: "var(--text-primary)" }}>Send an automatic message to all leads</div>
                        <div style={{ fontSize: "0.8rem", color: "var(--text-secondary)", marginTop: 4 }}>Choose each channel independently. Messages are sent automatically to all leads using the contact details submitted with the form.</div>
                        <div style={{ display: "grid", gap: 10, marginTop: 12 }}>
                          {[['email', 'Send email automatically to all leads'], ['sms', 'Send SMS automatically to all leads'], ['whatsapp', 'Send WhatsApp automatically to all leads']].map(([channel, label]) => (
                            <label key={channel} className="wf-settings-toggle">
                              <input
                                type="checkbox"
                                checked={Array.isArray(selectedForm.settings.contactNotificationChannels) && selectedForm.settings.contactNotificationChannels.includes(channel)}
                                onChange={(e) => {
                                  const current = Array.isArray(selectedForm.settings.contactNotificationChannels) ? selectedForm.settings.contactNotificationChannels : [];
                                  const next = e.target.checked ? [...new Set([...current, channel])] : current.filter((item) => item !== channel);
                                  applyDraft({ settings: { ...selectedForm.settings, contactNotificationChannels: next } });
                                }}
                              />
                              <span>{label}</span>
                            </label>
                          ))}
                        </div>
                      </div>
                      <div className="wf-settings-block">
                        <label className="wf-settings-toggle">
                          <input
                            type="checkbox"
                            checked={Boolean(selectedForm.settings.notificationEnabled)}
                            onChange={(e) => applyDraft({ settings: { ...selectedForm.settings, notificationEnabled: e.target.checked } })}
                          />
                          <span>Send email notification to this address when a record is created/updated via the form</span>
                        </label>
                        {selectedForm.settings.notificationEnabled ? (
                          <label style={{ display: "grid", gap: 6, maxWidth: 640 }}>
                            <input className="input-field" type="email" value={selectedForm.settings.notificationEmail} onChange={(e) => applyDraft({ settings: { ...selectedForm.settings, notificationEmail: e.target.value } })} placeholder="notifications@example.com" />
                          </label>
                        ) : null}
                      </div>
                      <div className="wf-settings-block">
                        <div className="wf-settings-inline">
                          <label className="wf-settings-toggle" style={{ flex: 1, minWidth: 0 }}>
                            <input
                              type="checkbox"
                              checked={Boolean(selectedForm.settings.optInEnabled)}
                              onChange={(e) => applyDraft({ settings: { ...selectedForm.settings, optInEnabled: e.target.checked } })}
                            />
                            <span>Include an opt-in checkbox at the end of the form</span>
                            <Info size={14} style={{ color: "var(--text-secondary)", flexShrink: 0, marginTop: 2 }} />
                          </label>
                          <button ref={optInLinkButtonRef} type="button" className="wf-link-button" onClick={openOptInLinkEditor}>{selectedForm.settings.optInLinkUrl ? "Edit link" : "Insert link"}</button>
                        </div>
                        <textarea
                          className="input-field"
                          rows={4}
                          disabled={!selectedForm.settings.optInEnabled}
                          value={selectedForm.settings.optInText}
                          onChange={(e) => applyDraft({ settings: { ...selectedForm.settings, optInText: e.target.value } })}
                          placeholder="I agree to receive communication on newsletters, promotional content, offers and events."
                        />
                        {selectedForm.settings.optInLinkText || selectedForm.settings.optInLinkUrl ? (
                          <div style={{ fontSize: "0.84rem", color: "var(--text-secondary)" }}>
                            Link: <strong style={{ color: "var(--text-primary)" }}>{selectedForm.settings.optInLinkText || selectedForm.settings.optInLinkUrl}</strong>
                          </div>
                        ) : null}
                      </div>
                      <div className="wf-settings-block">
                        <div style={{ fontSize: "0.88rem", fontWeight: 700, color: "var(--text-primary)" }}>What should happen after the form is submitted?</div>
                        <div style={{ display: "flex", gap: 18, flexWrap: "wrap", color: "var(--text-primary)" }}>
                          <label style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                            <input type="radio" name="after-submit" checked={selectedForm.settings.afterSubmitAction === "message"} onChange={() => applyDraft({ settings: { ...selectedForm.settings, afterSubmitAction: "message" } })} />
                            Display custom message
                          </label>
                          <label style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                            <input type="radio" name="after-submit" checked={selectedForm.settings.afterSubmitAction === "redirect"} onChange={() => applyDraft({ settings: { ...selectedForm.settings, afterSubmitAction: "redirect" } })} />
                            Redirect to a URL
                          </label>
                        </div>
                        {selectedForm.settings.afterSubmitAction === "redirect" ? (
                          <input className="input-field" value={selectedForm.settings.redirectUrl} onChange={(e) => applyDraft({ settings: { ...selectedForm.settings, redirectUrl: e.target.value } })} placeholder="Enter a URL" />
                        ) : (
                          <textarea className="input-field" rows={4} value={selectedForm.settings.successMessage} onChange={(e) => applyDraft({ settings: { ...selectedForm.settings, successMessage: e.target.value } })} />
                        )}
                      </div>
                    </div>
                  </Section>

                  <div className="wf-share-bar">

                    <div className="wf-share-meta">

                      <strong>{selectedForm.name}</strong>

                      <span>{publicUrl}</span>

                    </div>

                    <div className="wf-share-actions">

                      <button type="button" className="btn-secondary" onClick={() => copyText(publicUrl, "Public URL")}><Link2 size={16} style={{ marginRight: 6, verticalAlign: "middle" }} />Copy URL</button>

                      <button type="button" className="btn-secondary" onClick={() => copyText(embedCode, "Embed code")}><Copy size={16} style={{ marginRight: 6, verticalAlign: "middle" }} />Copy embed code</button>


                    </div>

                  </div>
                </div>
              </div>
            )}
          </main>
        </div>
      ) : null}

      {showOptInLinkEditor && selectedForm && typeof document !== "undefined" ? createPortal((
        <div className="wf-link-popover" style={{ top: optInLinkPosition.top, left: optInLinkPosition.left, width: optInLinkPosition.width }}>
          <div className="wf-link-popover-head">
            <button type="button" className="btn-secondary" onClick={() => setShowOptInLinkEditor(false)} style={{ minWidth: 34, padding: "0.42rem 0.5rem" }}><ArrowDown size={16} style={{ transform: "rotate(90deg)" }} /></button>
            <strong>{selectedForm.settings.optInLinkUrl ? "Edit link" : "Insert link"}</strong>
            <span style={{ width: 34 }} />
          </div>
          <div className="wf-link-popover-body">
            <label style={{ display: "grid", gap: 6 }}>
              <span style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>URL</span>
              <input className="input-field" value={optInLinkDraft.url} onChange={(e) => setOptInLinkDraft((current) => ({ ...current, url: e.target.value }))} placeholder="https://example.com/privacy" />
            </label>
            <label style={{ display: "grid", gap: 6 }}>
              <span style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>Text</span>
              <input className="input-field" value={optInLinkDraft.text} onChange={(e) => setOptInLinkDraft((current) => ({ ...current, text: e.target.value }))} placeholder="privacy policy" />
            </label>
            <div className="wf-link-popover-actions">
              <button type="button" className="btn-secondary" onClick={clearOptInLink}>Clear</button>
              <button type="button" className="btn-secondary" onClick={() => setShowOptInLinkEditor(false)}>Cancel</button>
              <button type="button" className="btn-primary" onClick={saveOptInLink}>Insert</button>
            </div>
          </div>
        </div>
      ), document.body) : null}

      {pageDialog ? (
        <div style={{ position: "absolute", top: 0, left: 0, right: 0, minHeight: "100%", zIndex: 60, background: "var(--wf-modal-overlay, rgba(3, 6, 16, 0.28))", backdropFilter: "blur(2px)", display: "grid", placeItems: "start center", padding: "clamp(24px, 8vh, 96px) 16px" }} role="dialog" aria-modal="true" aria-labelledby="add-page-title">
          <div className="wf-add-page-modal-surface" style={{ width: "min(100%, 520px)", color: "var(--text-primary, #182033)", border: "1px solid var(--border-color, rgba(148, 163, 184, 0.35))", borderRadius: 16, boxShadow: "0 24px 70px rgba(15, 23, 42, 0.24)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "1rem 1.1rem", borderBottom: "1px solid var(--border-color, rgba(255,255,255,0.08))" }}>
              <strong id="add-page-title">Add form page</strong>
              <button type="button" className="btn-secondary" onClick={() => setPageDialog(null)} aria-label="Close add page dialog"><X size={16} /></button>
            </div>
            <div style={{ display: "grid", gap: 14, padding: 18 }}>
              <label style={{ display: "grid", gap: 6 }}>
                <span>Page title *</span>
                <input autoFocus className="input-field" value={pageDialog.title} onChange={(e) => setPageDialog((current) => ({ ...current, title: e.target.value }))} placeholder="Enter page title" />
              </label>
              <label style={{ display: "grid", gap: 6 }}>
                <span>Page description (optional)</span>
                <textarea className="input-field" rows={3} value={pageDialog.description} onChange={(e) => setPageDialog((current) => ({ ...current, description: e.target.value }))} placeholder="Tell users what to complete on this page" />
              </label>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                <button type="button" className="btn-secondary" onClick={() => setPageDialog(null)}>Cancel</button>
                <button type="button" className="btn-primary" onClick={createFormStep} disabled={!String(pageDialog.title || "").trim()}>Add page</button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {showEmbed && selectedForm ? (
        <div style={modalShellStyle()}>
          <div className="wf-embed-modal" style={modalCardStyle(920)}>
            <div className="wf-embed-modal-head">
              <div>
                <strong>Embed code and URL</strong>
                <p>Use this public link or iframe snippet anywhere you want to collect submissions.</p>
              </div>
              <button type="button" className="btn-secondary wf-modal-close" onClick={() => setShowEmbed(false)} aria-label="Close embed code modal"><X size={16} /></button>
            </div>
            <div className="wf-embed-modal-body">
              <label className="wf-copy-field">
                <span>Public URL</span>
                <div className="wf-copy-row">
                  <input className="input-field" readOnly value={publicUrl} />
                  <button type="button" className="btn-secondary" onClick={() => copyText(publicUrl, "Public URL")}>Copy URL</button>
                </div>
              </label>
              <label className="wf-copy-field">
                <span>Embed snippet</span>
                <textarea className="input-field wf-embed-textarea" rows={8} readOnly value={embedCode} />
              </label>
              <div className="wf-embed-modal-actions">
                <button type="button" className="btn-secondary" onClick={() => copyText(embedCode, "Embed code")}>Copy embed code</button>
                <button type="button" className="btn-primary" onClick={() => setShowEmbed(false)}>Done</button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {showPreview && selectedForm ? (
        <div style={modalShellStyle()}>
          <div style={modalCardStyle(1120)}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "1rem 1.1rem", borderBottom: "1px solid var(--border-color, rgba(255,255,255,0.08))" }}>
              <strong>Preview</strong>
              <button type="button" className="btn-secondary" onClick={() => setShowPreview(false)}><X size={16} /></button>
            </div>
            <div style={{ padding: 16 }}>
                <iframe ref={previewFrameRef} title="Web form preview" src={previewSrc} allow="geolocation *" style={{ width: "100%", height: "auto", minHeight: 0, border: 0, display: "block", background: "transparent" }} />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );

}

