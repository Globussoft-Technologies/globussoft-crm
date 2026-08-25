import { useState, useEffect, useRef, useCallback, useContext } from "react";
import {
  Mail,
  ArrowRight,
  User,
  Send,
  Calendar,
  X,
  Paperclip,
  Sparkles,
  Lightbulb,
} from "lucide-react";
import MultiSelectDropdown from "../components/MultiSelectDropdown";
import { AuthContext } from "../App";
import { fetchApi } from "../utils/api";
import { useNotify } from "../utils/notify";

function getInboxPageSize() {
  if (typeof window === "undefined") return 24;
  const usableHeight = Math.max(window.innerHeight - 340, 480);
  return Math.max(12, Math.min(40, Math.ceil(usableHeight / 92)));
}

function mergeUniqueById(previous, next) {
  const seen = new Set();
  const merged = [];
  for (const item of [...previous, ...next]) {
    if (!item || item.id == null || seen.has(item.id)) continue;
    seen.add(item.id);
    merged.push(item);
  }
  return merged;
}

function extractPagedRows(payload, primaryKey) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.[primaryKey])) return payload[primaryKey];
  if (Array.isArray(payload?.messages)) return payload.messages;
  return [];
}

function extractPagination(payload, fallbackPage, fallbackLimit, rows) {
  const meta = payload?.pagination || {};
  const limit = Number.isFinite(meta.limit) && meta.limit > 0 ? meta.limit : fallbackLimit;
  const page = Number.isFinite(meta.page) && meta.page > 0 ? meta.page : fallbackPage;
  const total = Number.isFinite(meta.total) && meta.total >= 0 ? meta.total : rows.length;
  const hasMore =
    typeof meta.hasMore === "boolean"
      ? meta.hasMore
      : page * limit < total;
  return {
    page,
    limit,
    total,
    pages: Number.isFinite(meta.pages) && meta.pages > 0 ? meta.pages : Math.max(1, Math.ceil(total / limit)),
    hasMore,
  };
}

const URL_REGEX = /(https?:\/\/[^\s<>"')\]]+)/gi;

function renderTextWithLinks(text) {
  const input = String(text ?? "");
  if (!input) return input;

  const linkRegex = new RegExp(URL_REGEX.source, URL_REGEX.flags);
  const nodes = [];
  let lastIndex = 0;

  for (const match of input.matchAll(linkRegex)) {
    const url = match[0];
    const index = match.index ?? 0;

    if (index > lastIndex) {
      nodes.push(input.slice(lastIndex, index));
    }

    nodes.push(
      <a
        key={`${index}-${url}`}
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        style={{
          color: "var(--accent-color)",
          textDecoration: "underline",
          wordBreak: "break-word",
        }}
      >
        {url}
      </a>,
    );

    lastIndex = index + url.length;
  }

  if (nodes.length === 0) return input;
  if (lastIndex < input.length) {
    nodes.push(input.slice(lastIndex));
  }

  return nodes;
}

const COMPOSE_TONE_OPTIONS = [
  { value: "professional", label: "Professional" },
  { value: "friendly", label: "Friendly" },
  { value: "formal", label: "Formal" },
  { value: "casual", label: "Casual" },
];

function getRecipientQuery(rawValue) {
  const text = String(rawValue ?? "");
  const commaIndex = text.lastIndexOf(",");
  return (commaIndex >= 0 ? text.slice(commaIndex + 1) : text).trim();
}

function replaceRecipientQuery(rawValue, selectedEmail) {
  const text = String(rawValue ?? "");
  const commaIndex = text.lastIndexOf(",");
  if (commaIndex < 0) return selectedEmail;

  const prefix = text.slice(0, commaIndex + 1).trimEnd();
  return `${prefix} ${selectedEmail}`;
}

function buildFallbackSubject(toValue, bodyValue, tone) {
  const body = String(bodyValue ?? "").trim();
  if (body) {
    const firstLine = body
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    if (firstLine) {
      return firstLine.slice(0, 72);
    }
  }

  const recipients = String(toValue ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (recipients.length > 0) {
    return `Following up with ${recipients[0]}`;
  }

  if (tone === "formal") return "Formal follow up";
  if (tone === "casual") return "Quick follow up";
  if (tone === "friendly") return "Friendly follow up";
  return "Following up";
}

function buildMeetingActivityDescription({ date, time, agenda, staffNames = [], recipientLabel }) {
  const parts = [
    `Scheduled Meeting for ${date} at ${time}.`,
    recipientLabel ? `Contact: ${recipientLabel}.` : null,
    staffNames.length > 0 ? `Assigned staff: ${staffNames.join(", ")}.` : null,
    agenda ? `Agenda: ${agenda}` : null,
  ].filter(Boolean);
  return parts.join(" ");
}

function buildContactMeetingEmail({ recipientLabel, date, time, agenda, staffNames = [] }) {
  return [
    `Hello ${recipientLabel},`,
    "",
    `Your meeting has been scheduled for ${date} at ${time}.`,
    staffNames.length > 0 ? `Assigned staff: ${staffNames.join(", ")}.` : null,
    agenda ? `Agenda: ${agenda}` : null,
    "",
    "Thank you.",
  ].filter(Boolean).join("\n");
}

function buildStaffMeetingEmail({ staffName, recipientLabel, date, time, agenda }) {
  return [
    `Hello ${staffName},`,
    "",
    `You have been assigned to a meeting with ${recipientLabel} on ${date} at ${time}.`,
    agenda ? `Agenda: ${agenda}` : null,
    "",
    "Please review the details and join on time.",
  ].filter(Boolean).join("\n");
}

function buildStaffMeetingNotification({ recipientLabel, date, time, agenda }) {
  return [
    `You have been assigned to a meeting with ${recipientLabel} on ${date} at ${time}.`,
    agenda ? `Agenda: ${agenda}` : null,
  ].filter(Boolean).join(" ");
}

function formatStaffOptionLabel(staff) {
  const name = staff?.name?.trim() || staff?.email?.trim() || `Staff ${staff?.id}`;
  return staff?.email ? `${name} — ${staff.email}` : name;
}

export default function Inbox() {
  const notify = useNotify();
  const { user } = useContext(AuthContext) || {};
  const canAssignMeetingStaff = user?.role === "ADMIN";
  const [emails, setEmails] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [patients, setPatients] = useState([]);
  const [staffMembers, setStaffMembers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [staffLoading, setStaffLoading] = useState(false);

  const [showCompose, setShowCompose] = useState(false);
  const [composeData, setComposeData] = useState({
    to: "",
    cc: "",
    bcc: "",
    subject: "",
    body: "",
  });
  const [composeTone, setComposeTone] = useState("professional");
  const [showCcBcc, setShowCcBcc] = useState(false);
  const [showRecipientSuggestions, setShowRecipientSuggestions] = useState(false);
  const [showSubjectSuggestions, setShowSubjectSuggestions] = useState(false);
  const [composeSubjectSuggestions, setComposeSubjectSuggestions] = useState([]);
  const [draftingEmail, setDraftingEmail] = useState(false);
  const [loadingSubjects, setLoadingSubjects] = useState(false);
  const [composeAttachments, setComposeAttachments] = useState([]);
  const composeFileInputRef = useRef(null);
  const MAX_ATTACHMENTS = 5;
  const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

  const [emailFolder, setEmailFolder] = useState("all");
  const [emailPagination, setEmailPagination] = useState(() => ({
    page: 0,
    limit: getInboxPageSize(),
    total: 0,
    pages: 0,
    hasMore: true,
    loading: false,
    loadingMore: false,
  }));
  const inboxScrollRef = useRef(null);
  const loadMoreLockRef = useRef(false);
  const emailPaginationRef = useRef(emailPagination);

  const [showMeet, setShowMeet] = useState(false);
  const [meetData, setMeetData] = useState({
    contactId: "",
    date: "",
    time: "",
    description: "",
    staffIds: [],
  });

  const [detail, setDetail] = useState(null);

  const inboxPath =
    emailFolder === "all"
      ? "/api/communications/inbox"
      : `/api/communications/inbox?folder=${emailFolder}`;
  const inboxPathRef = useRef(inboxPath);

  const didInitialLoadRef = useRef(false);
  useEffect(() => {
    emailPaginationRef.current = emailPagination;
  }, [emailPagination]);

  useEffect(() => {
    inboxPathRef.current = inboxPath;
  }, [inboxPath]);

  const loadEmailsPage = useCallback(async ({ page = 1, reset = false } = {}) => {
    const currentPagination = emailPaginationRef.current;
    const currentInboxPath = inboxPathRef.current;

    if (
      (page > 1 && !currentPagination.hasMore) ||
      currentPagination.loading ||
      currentPagination.loadingMore
    ) {
      return [];
    }

    setEmailPagination((prev) => ({
      ...prev,
      loading: reset || page === 1,
      loadingMore: !reset && page > 1,
    }));

    const pageSize = currentPagination.limit;
    const pageUrl =
      page > 1
        ? `${currentInboxPath}${currentInboxPath.includes("?") ? "&" : "?"}page=${page}&limit=${pageSize}`
        : currentInboxPath;

    try {
      const data = await fetchApi(pageUrl);
      const rows = extractPagedRows(data, "emails");
      const pagination = extractPagination(data, page, pageSize, rows);

      setEmails((prev) => (reset || page === 1 ? rows : mergeUniqueById(prev, rows)));
      setEmailPagination((prev) => ({
        ...prev,
        ...pagination,
      }));

      return rows;
    } catch (err) {
      console.error(err);
      return [];
    } finally {
      setEmailPagination((prev) => ({
        ...prev,
        loading: false,
        loadingMore: false,
      }));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadMoreLockRef.current = false;

    const bootstrap = async () => {
      try {
        setLoading(true);
        if (canAssignMeetingStaff) setStaffLoading(true);
        const [emailRows, contactData, patientData, staffData] = await Promise.all([
          loadEmailsPage({ page: 1, reset: true }),
          fetchApi("/api/contacts"),
          fetchApi("/api/wellness/patients", { silent: true }).catch(() => ({ patients: [] })),
          canAssignMeetingStaff
            ? fetchApi("/api/staff?fields=summary", { silent: true }).catch(() => [])
            : Promise.resolve([]),
        ]);

        if (cancelled) return;
        setEmails(Array.isArray(emailRows) ? emailRows : []);
        setContacts(Array.isArray(contactData) ? contactData : []);
        const patientList = patientData?.patients || patientData;
        setPatients(Array.isArray(patientList) ? patientList : []);
        setStaffMembers(Array.isArray(staffData) ? staffData : []);
      } catch (err) {
        if (!cancelled) console.error(err);
      } finally {
        if (!cancelled) {
          setLoading(false);
          setStaffLoading(false);
          didInitialLoadRef.current = true;
        }
      }
    };

    bootstrap();
    return () => {
      cancelled = true;
    };
  }, [loadEmailsPage, canAssignMeetingStaff]);

  useEffect(() => {
    if (!didInitialLoadRef.current) return;
    loadEmailsPage({ page: 1, reset: true }).catch((err) => console.error(err));
  }, [inboxPath, loadEmailsPage]);

  const handleInboxScroll = async (event) => {
    const el = event.currentTarget;
    if (el.scrollTop + el.clientHeight < el.scrollHeight - 140) return;
    if (loadMoreLockRef.current || !emailPagination.hasMore) return;

    loadMoreLockRef.current = true;
    try {
      await loadEmailsPage({ page: emailPagination.page + 1 });
    } finally {
      loadMoreLockRef.current = false;
    }
  };

  const closeCompose = () => {
    setShowCompose(false);
    setShowCcBcc(false);
    setShowRecipientSuggestions(false);
    setShowSubjectSuggestions(false);
    setComposeSubjectSuggestions([]);
    setComposeTone("professional");
    setDraftingEmail(false);
    setLoadingSubjects(false);
    setComposeData({ to: "", cc: "", bcc: "", subject: "", body: "" });
    setComposeAttachments([]);
    composeFileInputRef.current = null;
  };

  const meetingStaffOptions = staffMembers
    .filter((staff) => staff && staff.email && !staff.deactivatedAt)
    .map((staff) => ({
      value: String(staff.id),
      label: formatStaffOptionLabel(staff),
    }));

  const composeRecipientOptions = [
    ...contacts.map((contact) => ({
      key: `contact-${contact.id}`,
      email: contact.email || "",
      name: contact.name || "",
    })),
    ...patients.map((patient) => ({
      key: `patient-${patient.id}`,
      email: patient.email || "",
      name: patient.name || "",
    })),
  ].filter((entry) => entry.email || entry.name);

  const recipientQuery = getRecipientQuery(composeData.to);
  const filteredRecipientSuggestions = recipientQuery
    ? composeRecipientOptions.filter((entry) => {
        const haystack = `${entry.email} ${entry.name}`.toLowerCase();
        return haystack.includes(recipientQuery.toLowerCase());
      })
    : composeRecipientOptions;
  const visibleRecipientSuggestions = filteredRecipientSuggestions.slice(0, 6);

  const handleRecipientSelect = (email) => {
    setComposeData((prev) => ({
      ...prev,
      to: replaceRecipientQuery(prev.to, email),
    }));
    setShowRecipientSuggestions(false);
  };

  const handleMeetingStaffChange = (selectedIds) => {
    setMeetData((prev) => ({
      ...prev,
      staffIds: selectedIds,
    }));
  };

  const handleLoadSubjects = useCallback(async () => {
    const context = composeData.body.trim() || composeData.to.trim() || "follow up";
    setLoadingSubjects(true);
    try {
      const data = await fetchApi("/api/ai/subject-lines", {
        method: "POST",
        body: JSON.stringify({ context, count: 5 }),
      });
      const subjects = Array.isArray(data?.subjects) ? data.subjects.filter(Boolean) : [];
      setComposeSubjectSuggestions(subjects);
      setShowSubjectSuggestions(true);
      if (subjects.length > 0) {
        setComposeData((prev) => ({
          ...prev,
          subject: prev.subject?.trim() ? prev.subject : subjects[0],
        }));
      }
    } catch (err) {
      console.error(err);
      notify.error("Failed to load subject ideas.");
    } finally {
      setLoadingSubjects(false);
    }
  }, [composeData.body, composeData.to, notify]);

  const handleComposeDraft = useCallback(async () => {
    const context = composeData.body.trim() || composeData.to.trim() || "follow up";
    setDraftingEmail(true);
    try {
      const [subjectData, draftData] = await Promise.all([
        fetchApi("/api/ai/subject-lines", {
          method: "POST",
          body: JSON.stringify({ context, count: 5 }),
        }),
        fetchApi("/api/ai/draft", {
          method: "POST",
          body: JSON.stringify({
            context,
            tone: composeTone,
            recipientEmail: composeData.to.split(",")[0]?.trim() || "",
          }),
        }),
      ]);

      const subjects = Array.isArray(subjectData?.subjects) ? subjectData.subjects.filter(Boolean) : [];
      const draft = typeof draftData?.draft === "string" ? draftData.draft : "";

      setComposeSubjectSuggestions(subjects);
      setShowSubjectSuggestions(subjects.length > 0);
      setComposeData((prev) => ({
        ...prev,
        subject: prev.subject?.trim() || subjects[0] || buildFallbackSubject(prev.to, draft, composeTone),
        body: draft || prev.body,
      }));
    } catch (err) {
      console.error(err);
      notify.error("AI draft could not be generated right now.");
    } finally {
      setDraftingEmail(false);
    }
  }, [composeData.body, composeData.to, composeTone, notify]);

  const formatAttachmentSize = (bytes) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const handlePickAttachments = (event) => {
    const files = Array.from(event.target.files || []);
    if (!files.length) return;

    const slotsLeft = MAX_ATTACHMENTS - composeAttachments.length;
    if (slotsLeft <= 0) {
      notify.error(`You can attach up to ${MAX_ATTACHMENTS} files.`);
      event.target.value = "";
      return;
    }

    const accepted = [];
    let skippedLarge = 0;

    for (const file of files) {
      if (accepted.length >= slotsLeft) break;
      if (file.size > MAX_ATTACHMENT_BYTES) {
        skippedLarge += 1;
        continue;
      }
      accepted.push(file);
    }

    if (skippedLarge > 0) {
      notify.error(
        `Some files were skipped because they exceed ${formatAttachmentSize(MAX_ATTACHMENT_BYTES)}.`,
      );
    }

    if (accepted.length > 0) {
      setComposeAttachments((prev) => [...prev, ...accepted].slice(0, MAX_ATTACHMENTS));
    }

    event.target.value = "";
  };

  const handleRemoveAttachment = (index) => {
    setComposeAttachments((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSendEmail = async (e) => {
    e.preventDefault();

    try {
      const subject =
        composeData.subject.trim() ||
        composeSubjectSuggestions[0] ||
        buildFallbackSubject(composeData.to, composeData.body, composeTone);
      let requestBody;
      if (composeAttachments.length > 0) {
        const fd = new FormData();
        fd.append("to", composeData.to);
        if (composeData.cc) fd.append("cc", composeData.cc);
        if (composeData.bcc) fd.append("bcc", composeData.bcc);
        fd.append("subject", subject);
        fd.append("body", composeData.body);
        for (const file of composeAttachments) {
          fd.append("attachments", file, file.name);
        }
        requestBody = fd;
      } else {
        requestBody = JSON.stringify({
          ...composeData,
          subject,
        });
      }

      await fetchApi("/api/communications/send-email", {
        method: "POST",
        body: requestBody,
      });

      notify.success("Email sent successfully.");
      closeCompose();
      await loadEmailsPage({ page: 1, reset: true });
    } catch (err) {
      console.error(err);
      notify.error("Failed to send email. Please try again.");
    }
  };

  const handleScheduleMeeting = async (e) => {
    e.preventDefault();
    if (!meetData.contactId) {
      notify.error("Please select a contact from the dropdown.");
      return;
    }

    try {
      const isPatient = String(meetData.contactId).startsWith("patient:");
      const rawId = isPatient ? meetData.contactId.slice("patient:".length) : meetData.contactId;
      const endpoint = isPatient
        ? `/api/wellness/patients/${rawId}/activities`
        : `/api/contacts/${rawId}/activities`;

      const selected = isPatient
        ? patients.find((p) => String(p.id) === String(rawId))
        : contacts.find((c) => String(c.id) === String(rawId));
      const recipientEmail = selected?.email || "";
      const recipientLabel = selected?.name || recipientEmail || "the selected contact";
      const selectedStaff = canAssignMeetingStaff
        ? staffMembers.filter(
            (staff) =>
              meetData.staffIds.includes(String(staff.id)) &&
              staff.email &&
              !staff.deactivatedAt,
          )
        : [];
      const selectedStaffEmails = [...new Set(selectedStaff.map((staff) => staff.email).filter(Boolean))];
      const selectedStaffNames = selectedStaff.map((staff) => staff.name || staff.email);

      await fetchApi(endpoint, {
        method: "POST",
        body: JSON.stringify({
          type: "Meeting",
          description: buildMeetingActivityDescription({
            date: meetData.date,
            time: meetData.time,
            agenda: meetData.description,
            staffNames: selectedStaffNames,
            recipientLabel,
          }),
        }),
      });

      let contactEmailDelivered = false;
      let staffEmailDelivered = false;
      let staffNotificationsDelivered = 0;
      let staffNotificationsFailed = 0;

      if (recipientEmail) {
        try {
          await fetchApi("/api/communications/send-email", {
            method: "POST",
            body: JSON.stringify({
              to: recipientEmail,
              subject: `Meeting invitation — ${meetData.date} at ${meetData.time}`,
              contactId: isPatient ? undefined : rawId,
              body: buildContactMeetingEmail({
                recipientLabel,
                date: meetData.date,
                time: meetData.time,
                agenda: meetData.description,
                staffNames: selectedStaffNames,
              }),
            }),
          });
          contactEmailDelivered = true;
        } catch (mailErr) {
          console.error("Meeting invite email failed:", mailErr);
        }
      }

      if (selectedStaffEmails.length > 0) {
        try {
          await fetchApi("/api/communications/send-email", {
            method: "POST",
            body: JSON.stringify({
              to: selectedStaffEmails.join(", "),
              subject: `Meeting assigned — ${meetData.date} at ${meetData.time}`,
              body: buildStaffMeetingEmail({
                staffName: "Team",
                recipientLabel,
                date: meetData.date,
                time: meetData.time,
                agenda: meetData.description,
              }),
            }),
          });
          staffEmailDelivered = true;
        } catch (mailErr) {
          console.error("Meeting staff email failed:", mailErr);
        }

        const notificationResults = await Promise.allSettled(
          selectedStaff.map((staff) =>
            fetchApi("/api/notifications", {
              method: "POST",
              body: JSON.stringify({
                targetUserId: staff.id,
                title: `Meeting assigned — ${meetData.date} at ${meetData.time}`,
                message: buildStaffMeetingNotification({
                  recipientLabel,
                  date: meetData.date,
                  time: meetData.time,
                  agenda: meetData.description,
                }),
                type: "info",
                link: "/calendar-sync",
                channels: ["db", "socket"],
              }),
            }),
          ),
        );
        for (const result of notificationResults) {
          if (result.status === "fulfilled") staffNotificationsDelivered += 1;
          else staffNotificationsFailed += 1;
        }
      }

      const hasDeliveryIssue =
        (recipientEmail && !contactEmailDelivered) ||
        (selectedStaffEmails.length > 0 && (!staffEmailDelivered || staffNotificationsFailed > 0));
      const parts = ["Meeting scheduled."];
      if (recipientEmail) {
        parts.push(
          contactEmailDelivered
            ? `Invite emailed to ${recipientEmail}.`
            : `The contact invite could not be emailed to ${recipientEmail}.`,
        );
      } else {
        parts.push("No email on file for the contact, so no contact invite was sent.");
      }
      if (selectedStaffEmails.length > 0) {
        parts.push(
          staffEmailDelivered
            ? `${selectedStaffEmails.length} staff member${selectedStaffEmails.length === 1 ? "" : "s"} emailed.`
            : "The staff invite email could not be sent.",
        );
        parts.push(
          staffNotificationsFailed > 0
            ? `${staffNotificationsDelivered} of ${selectedStaffEmails.length} staff notifications delivered.`
            : `${staffNotificationsDelivered} staff notification${staffNotificationsDelivered === 1 ? "" : "s"} delivered.`,
        );
      }

      notify[hasDeliveryIssue ? "info" : "success"](parts.join(" "));
      setShowMeet(false);
      setMeetData({ contactId: "", date: "", time: "", description: "", staffIds: [] });
    } catch (err) {
      console.error(err);
      notify.error("Failed to schedule meeting.");
    }
  };

  return (
    <div
      data-testid="inbox-page-shell"
      style={{
        width: "100%",
        maxWidth: 1480,
        margin: "0 auto",
        padding: "2rem",
        boxSizing: "border-box",
        overflowX: "hidden",
        animation: "fadeIn 0.5s ease-out",
      }}
    >
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "1rem",
          marginBottom: "2.25rem",
        }}
      >
        <div style={{ minWidth: 0, flex: "1 1 240px" }}>
          <h1 style={{ fontSize: "2rem", fontWeight: "bold" }}>Unified Inbox</h1>
          <p style={{ color: "var(--text-secondary)", marginTop: "0.25rem" }}>
            Manage all client emails from one hub.
          </p>
        </div>

        <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap" }}>
          <button
            onClick={() => setShowMeet(true)}
            className="btn-primary"
            style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}
          >
            <Calendar size={18} /> Schedule Meeting
          </button>
          <button
            onClick={() => setShowCompose(true)}
            className="btn-primary"
            style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}
          >
            <Mail size={18} /> Compose Email
          </button>
        </div>
      </header>

      <div
        className="card"
        data-testid="inbox-list-card"
        ref={inboxScrollRef}
        onScroll={handleInboxScroll}
        style={{
          width: "100%",
          flex: "0 0 auto",
          maxHeight: "calc(100vh - 320px)",
          overflowY: "auto",
          overflowX: "hidden",
          padding: "1.25rem",
        }}
      >
        {loading ? (
          <p
            style={{
              textAlign: "center",
              padding: "2rem",
              color: "var(--text-secondary)",
            }}
          >
            Syncing communications...
          </p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "1rem", minWidth: 0 }}>
            <div
              role="tablist"
              aria-label="Email folder"
              style={{
                display: "flex",
                gap: "0.25rem",
                padding: "0.3rem",
                background: "var(--subtle-bg-2)",
                border: "1px solid var(--border-color)",
                borderRadius: "12px",
                alignSelf: "flex-start",
              }}
            >
              {[
                { id: "all", label: "All" },
                { id: "inbox", label: "Inbox" },
                { id: "sent", label: "Sent" },
              ].map((folder) => (
                <button
                  key={folder.id}
                  role="tab"
                  aria-selected={emailFolder === folder.id}
                  onClick={() => setEmailFolder(folder.id)}
                  style={{
                    padding: "0.4rem 1rem",
                    border: "none",
                    background: emailFolder === folder.id ? "var(--accent-color)" : "transparent",
                    color: emailFolder === folder.id ? "#fff" : "var(--text-secondary)",
                    fontWeight: emailFolder === folder.id ? 600 : 500,
                    borderRadius: "6px",
                    cursor: "pointer",
                    fontSize: "0.85rem",
                  }}
                >
                  {folder.label}
                </button>
              ))}
            </div>

            {emails.length === 0 ? (
              <p
                style={{
                  color: "var(--text-secondary)",
                  textAlign: "center",
                  padding: "2rem",
                }}
              >
                No emails yet.
              </p>
            ) : (
              emails.map((email) => (
                <div
                  key={email.id}
                  className="table-row-hover"
                  onClick={() => setDetail(email)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setDetail(email);
                    }
                  }}
                  style={{
                    padding: "1.5rem",
                    border: "1px solid var(--border-color)",
                    borderRadius: "12px",
                    background: email.read ? "var(--subtle-bg-4)" : "var(--subtle-bg-3)",
                    display: "flex",
                    gap: "1.5rem",
                    minWidth: 0,
                    flexWrap: "wrap",
                    cursor: "pointer",
                    transition: "background 0.18s ease, border-color 0.18s ease",
                  }}
                >
                  <div
                    style={{
                      width: "40px",
                      height: "40px",
                      borderRadius: "50%",
                      background: "var(--accent-color)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      flexShrink: 0,
                    }}
                  >
                    <User size={20} color="#fff" />
                  </div>

                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        gap: "1rem",
                        marginBottom: "0.5rem",
                      }}
                    >
                      <p style={{ fontWeight: "bold", fontSize: "1.05rem", overflowWrap: "anywhere" }}>
                        {email.from} <ArrowRight size={14} style={{ margin: "0 0.5rem" }} /> {email.to}
                      </p>
                      <span
                        style={{
                          fontSize: "0.8rem",
                          color: "var(--text-secondary)",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {new Date(email.createdAt).toLocaleString()}
                      </span>
                    </div>

                    <h4
                      style={{
                        fontWeight: "600",
                        marginBottom: "0.5rem",
                        color: "var(--text-primary)",
                        overflowWrap: "anywhere",
                      }}
                    >
                      {email.subject}
                    </h4>

                    <p
                      style={{
                        color: "var(--text-secondary)",
                        fontSize: "0.9rem",
                        lineHeight: "1.5",
                        overflowWrap: "anywhere",
                      }}
                    >
                      {email.body}
                    </p>
                  </div>

                  {!email.read && (
                    <div
                      style={{
                        width: "10px",
                        height: "10px",
                        borderRadius: "50%",
                        background: "var(--accent-color)",
                        alignSelf: "center",
                      }}
                    />
                  )}
                </div>
              ))
            )}

            {emailPagination.loadingMore && (
              <p style={{ textAlign: "center", color: "var(--text-secondary)", padding: "0.75rem 0" }}>
                Loading more emails...
              </p>
            )}
          </div>
        )}
      </div>

      {showCompose && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "var(--overlay-bg)",
            backdropFilter: "blur(8px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 100,
            padding: "1rem",
            animation: "fadeIn 0.2s ease-out",
          }}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) closeCompose();
          }}
        >
          <div
            className="card modal"
            style={{
              padding: "1.5rem",
              width: "min(760px, calc(100vw - 2rem))",
              maxHeight: "90vh",
              overflowY: "auto",
              background: "var(--modal-bg)",
              color: "var(--text-primary)",
              border: "1px solid var(--border-color)",
              boxShadow: "var(--glass-shadow)",
              display: "flex",
              flexDirection: "column",
              gap: "1rem",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: "1rem",
              }}
            >
              <h3
                style={{
                  margin: 0,
                  fontSize: "1.5rem",
                  fontWeight: 700,
                  display: "flex",
                  alignItems: "center",
                  gap: "0.6rem",
                }}
              >
                <Mail size={22} color="var(--accent-color)" /> New Message
              </h3>
              <button
                type="button"
                onClick={closeCompose}
                style={{
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  color: "var(--text-secondary)",
                  padding: 0,
                  display: "inline-flex",
                  alignItems: "center",
                }}
                aria-label="Close compose"
              >
                <X size={24} />
              </button>
            </div>

            <form
              onSubmit={handleSendEmail}
              style={{ display: "flex", flexDirection: "column", gap: "1rem", minHeight: 0 }}
            >
              <div>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: "0.75rem",
                    marginBottom: "0.4rem",
                  }}
                >
                  <label
                    htmlFor="compose-to"
                    style={{
                      display: "block",
                      fontSize: "0.9rem",
                      color: "var(--text-secondary)",
                    }}
                  >
                    To:
                  </label>
                  <button
                    type="button"
                    onClick={() => setShowCcBcc((value) => !value)}
                    style={{
                      background: "transparent",
                      border: "none",
                      color: "var(--accent-color)",
                      cursor: "pointer",
                      padding: 0,
                      fontWeight: 600,
                      fontSize: "0.9rem",
                    }}
                  >
                    Cc / Bcc
                  </button>
                </div>

                <div style={{ position: "relative" }}>
                  <input
                    id="compose-to"
                    type="text"
                    required
                    autoComplete="off"
                    className="input-field"
                    value={composeData.to}
                    onFocus={() => setShowRecipientSuggestions(true)}
                    onBlur={() => {
                      window.setTimeout(() => setShowRecipientSuggestions(false), 120);
                    }}
                    onChange={(e) => {
                      setComposeData({ ...composeData, to: e.target.value });
                      setShowRecipientSuggestions(true);
                    }}
                    placeholder="client@company.com (comma-separated for multiple)"
                  />

                  {showRecipientSuggestions && visibleRecipientSuggestions.length > 0 && (
                    <div
                      role="listbox"
                      aria-label="Recipient suggestions"
                      style={{
                        position: "absolute",
                        top: "calc(100% + 0.35rem)",
                        left: 0,
                        right: 0,
                        zIndex: 10,
                        background: "var(--modal-bg)",
                        border: "1px solid var(--border-color)",
                        borderRadius: "14px",
                        boxShadow: "var(--glass-shadow)",
                        maxHeight: "230px",
                        overflowY: "auto",
                      }}
                    >
                      {visibleRecipientSuggestions.map((entry, index) => (
                        <button
                          type="button"
                          key={entry.key || `${entry.email}-${index}`}
                          role="option"
                          aria-label={entry.email}
                          onMouseDown={(event) => {
                            event.preventDefault();
                            handleRecipientSelect(entry.email);
                          }}
                          style={{
                            width: "100%",
                            textAlign: "left",
                            background: "transparent",
                            border: "none",
                            borderBottom:
                              index === visibleRecipientSuggestions.length - 1
                                ? "none"
                                : "1px solid var(--border-color)",
                            padding: "0.85rem 1rem",
                            cursor: "pointer",
                            color: "var(--text-primary)",
                          }}
                        >
                          <div style={{ fontWeight: 600, marginBottom: "0.15rem" }}>{entry.email}</div>
                          {entry.name && (
                            <div style={{ color: "var(--text-secondary)", fontSize: "0.85rem" }}>
                              {entry.name}
                            </div>
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {showCcBcc && (
                <div style={{ display: "grid", gap: "0.9rem" }}>
                  <div>
                    <label
                      htmlFor="compose-cc"
                      style={{
                        display: "block",
                        marginBottom: "0.4rem",
                        fontSize: "0.9rem",
                        color: "var(--text-secondary)",
                      }}
                    >
                      Cc:
                    </label>
                    <input
                      id="compose-cc"
                      type="text"
                      className="input-field"
                      value={composeData.cc}
                      onChange={(e) => setComposeData({ ...composeData, cc: e.target.value })}
                      placeholder="cc@company.com"
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="compose-bcc"
                      style={{
                        display: "block",
                        marginBottom: "0.4rem",
                        fontSize: "0.9rem",
                        color: "var(--text-secondary)",
                      }}
                    >
                      Bcc:
                    </label>
                    <input
                      id="compose-bcc"
                      type="text"
                      className="input-field"
                      value={composeData.bcc}
                      onChange={(e) => setComposeData({ ...composeData, bcc: e.target.value })}
                      placeholder="bcc@company.com"
                    />
                  </div>
                </div>
              )}

              <div>
                <label
                  htmlFor="compose-subject"
                  style={{
                    display: "block",
                    marginBottom: "0.5rem",
                    fontSize: "0.875rem",
                    color: "var(--text-secondary)",
                  }}
                >
                  Subject:
                </label>
                <input
                  id="compose-subject"
                  type="text"
                  className="input-field"
                  value={composeData.subject}
                  onChange={(e) => setComposeData({ ...composeData, subject: e.target.value })}
                  placeholder="Following up"
                />
              </div>

              <div>
                <label
                  htmlFor="compose-body"
                  style={{
                    display: "block",
                    marginBottom: "0.5rem",
                    fontSize: "0.875rem",
                    color: "var(--text-secondary)",
                  }}
                >
                  Message:
                </label>
                <textarea
                  id="compose-body"
                  required
                  className="input-field"
                  value={composeData.body}
                  onChange={(e) => setComposeData({ ...composeData, body: e.target.value })}
                  placeholder="Write your email here..."
                  rows={6}
                  style={{ resize: "vertical" }}
                />
              </div>

              <div>
                <input
                  ref={composeFileInputRef}
                  type="file"
                  multiple
                  onChange={handlePickAttachments}
                  style={{ display: "none" }}
                />
                <button
                  type="button"
                  onClick={() => composeFileInputRef.current?.click()}
                  disabled={composeAttachments.length >= MAX_ATTACHMENTS}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "0.4rem",
                    padding: "0.4rem 0.75rem",
                    background: "transparent",
                    border: "1px solid var(--border-color)",
                    borderRadius: "6px",
                    color: "var(--text-secondary)",
                    fontSize: "0.8rem",
                    cursor:
                      composeAttachments.length >= MAX_ATTACHMENTS ? "not-allowed" : "pointer",
                    opacity: composeAttachments.length >= MAX_ATTACHMENTS ? 0.6 : 1,
                  }}
                >
                  <Paperclip size={14} /> Attach files
                  {composeAttachments.length > 0 && (
                    <span style={{ color: "var(--accent-color)", fontWeight: 600 }}>
                      ({composeAttachments.length}/{MAX_ATTACHMENTS})
                    </span>
                  )}
                </button>

                {composeAttachments.length > 0 && (
                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      gap: "0.4rem",
                      marginTop: "0.6rem",
                    }}
                  >
                    {composeAttachments.map((file, index) => (
                      <div
                        key={`${file.name}-${index}`}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "0.4rem",
                          padding: "0.3rem 0.6rem",
                          background: "var(--subtle-bg-2)",
                          border: "1px solid var(--border-color)",
                          borderRadius: "14px",
                          fontSize: "0.75rem",
                          color: "var(--text-primary)",
                          maxWidth: "100%",
                        }}
                      >
                        <Paperclip size={12} color="var(--accent-color)" />
                        <span
                          style={{
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            maxWidth: "180px",
                          }}
                        >
                          {file.name}
                        </span>
                        <span style={{ color: "var(--text-secondary)", fontSize: "0.7rem" }}>
                          {formatAttachmentSize(file.size)}
                        </span>
                        <button
                          type="button"
                          onClick={() => handleRemoveAttachment(index)}
                          aria-label={`Remove ${file.name}`}
                          style={{
                            background: "transparent",
                            border: "none",
                            color: "var(--text-secondary)",
                            cursor: "pointer",
                            padding: 0,
                            display: "inline-flex",
                            alignItems: "center",
                          }}
                        >
                          <X size={12} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {showSubjectSuggestions && (
                <div
                  style={{
                    borderTop: "1px solid var(--border-color)",
                    paddingTop: "0.9rem",
                    display: "flex",
                    flexDirection: "column",
                    gap: "0.75rem",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem" }}>
                    <div>
                      <p style={{ margin: 0, fontWeight: 700 }}>Subject ideas</p>
                      <p style={{ margin: "0.2rem 0 0", color: "var(--text-secondary)", fontSize: "0.85rem" }}>
                        Pick one or keep the currently selected subject.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setShowSubjectSuggestions(false)}
                      style={{
                        background: "transparent",
                        border: "none",
                        color: "var(--text-secondary)",
                        cursor: "pointer",
                        fontWeight: 600,
                      }}
                    >
                      Hide
                    </button>
                  </div>

                  {loadingSubjects ? (
                    <p style={{ color: "var(--text-secondary)", margin: 0 }}>Loading subjects...</p>
                  ) : composeSubjectSuggestions.length > 0 ? (
                    <div style={{ display: "grid", gap: "0.5rem" }}>
                      {composeSubjectSuggestions.map((subject, index) => (
                        <button
                          key={`${subject}-${index}`}
                          type="button"
                          onMouseDown={(event) => {
                            event.preventDefault();
                            setComposeData((prev) => ({ ...prev, subject }));
                            setShowSubjectSuggestions(false);
                          }}
                          style={{
                            textAlign: "left",
                            background: "var(--subtle-bg-2)",
                            border: "1px solid var(--border-color)",
                            borderRadius: "10px",
                            padding: "0.75rem 0.9rem",
                            color: "var(--text-primary)",
                            cursor: "pointer",
                            fontWeight: 500,
                          }}
                        >
                          {subject}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p style={{ color: "var(--text-secondary)", margin: 0 }}>No subject ideas yet.</p>
                  )}
                </div>
              )}

              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: "1rem",
                  paddingTop: "1rem",
                  borderTop: "1px solid var(--border-color)",
                  flexWrap: "wrap",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
                  <select
                    value={composeTone}
                    onChange={(e) => setComposeTone(e.target.value)}
                    className="input-field"
                    style={{
                      width: "150px",
                      padding: "0.55rem 0.75rem",
                      fontSize: "0.9rem",
                    }}
                  >
                    {COMPOSE_TONE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={handleComposeDraft}
                    disabled={draftingEmail || loadingSubjects}
                    className="btn-secondary"
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "0.45rem",
                    }}
                  >
                    <Sparkles size={14} /> {draftingEmail ? "Drafting..." : "AI Draft"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (showSubjectSuggestions) {
                        setShowSubjectSuggestions(false);
                      } else {
                        handleLoadSubjects();
                      }
                    }}
                    disabled={loadingSubjects || draftingEmail}
                    className="btn-secondary"
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "0.45rem",
                    }}
                  >
                    <Lightbulb size={14} /> {loadingSubjects ? "Loading..." : "Subjects"}
                  </button>
                </div>

                <button
                  type="submit"
                  className="btn-primary"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "0.5rem",
                    padding: "0.6rem 1.15rem",
                    fontWeight: 600,
                  }}
                >
                  <Send size={16} /> Send Email
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showMeet && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: "var(--overlay-bg)",
            backdropFilter: "blur(8px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 100,
            animation: "fadeIn 0.2s ease-out",
          }}
        >
          <div
            className="card modal"
            style={{
              padding: "2.5rem",
              width: "min(560px, calc(100vw - 2rem))",
              maxHeight: "90vh",
              overflowY: "auto",
              background: "var(--modal-bg)",
              color: "var(--text-primary)",
              border: "1px solid var(--border-color)",
              boxShadow: "var(--glass-shadow)",
            }}
          >
            <h3
              style={{
                marginBottom: "1.5rem",
                fontSize: "1.5rem",
                fontWeight: "bold",
                display: "flex",
                alignItems: "center",
                gap: "0.5rem",
              }}
            >
              <Calendar size={24} color="var(--accent-color)" /> Schedule Meeting
            </h3>

            <form onSubmit={handleScheduleMeeting} style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
              <div>
                <label
                  style={{
                    display: "block",
                    marginBottom: "0.5rem",
                    fontSize: "0.875rem",
                    color: "var(--text-secondary)",
                  }}
                >
                  Select Contact:
                </label>
                <select
                  required
                  className="input-field"
                  value={meetData.contactId}
                  onChange={(e) => setMeetData({ ...meetData, contactId: e.target.value })}
                >
                  <option value="">-- Choose Contact --</option>
                  {contacts.filter((c) => c.email).length > 0 && (
                    <optgroup label="Contacts">
                      {contacts
                        .filter((c) => c.email)
                        .map((c) => (
                          <option key={`c-${c.id}`} value={c.id}>
                            {c.email}
                          </option>
                        ))}
                    </optgroup>
                  )}
                  {patients.filter((p) => p.email).length > 0 && (
                    <optgroup label="Patients">
                      {patients
                        .filter((p) => p.email)
                        .map((p) => (
                          <option key={`p-${p.id}`} value={`patient:${p.id}`}>
                            {p.name} — {p.email}
                          </option>
                        ))}
                    </optgroup>
                  )}
                </select>
              </div>

              <div style={{ display: "flex", gap: "1rem" }}>
                <div style={{ flex: 1 }}>
                  <label
                  style={{
                    display: "block",
                    marginBottom: "0.5rem",
                    fontSize: "0.875rem",
                    color: "var(--text-secondary)",
                  }}
                >
                    Meeting Date:
                  </label>
                  <input
                    type="date"
                    required
                    className="input-field"
                    value={meetData.date}
                    onChange={(e) => setMeetData({ ...meetData, date: e.target.value })}
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <label
                  style={{
                    display: "block",
                    marginBottom: "0.5rem",
                    fontSize: "0.875rem",
                    color: "var(--text-secondary)",
                  }}
                >
                    Meeting Time:
                  </label>
                  <input
                    type="time"
                    required
                    className="input-field"
                    value={meetData.time}
                    onChange={(e) => setMeetData({ ...meetData, time: e.target.value })}
                  />
                </div>
              </div>

              <div>
                <label
                  style={{
                    display: "block",
                    marginBottom: "0.5rem",
                    fontSize: "0.875rem",
                    color: "var(--text-secondary)",
                  }}
                >
                  Meeting Agenda & Conferencing Links:
                </label>
                <textarea
                  required
                  className="input-field"
                  value={meetData.description}
                  onChange={(e) => setMeetData({ ...meetData, description: e.target.value })}
                  placeholder="Zoom/Google Meet links and agenda..."
                  rows={3}
                  style={{ resize: "vertical" }}
                />
              </div>

              {canAssignMeetingStaff && (
                <div
                  style={{
                    border: "1px solid var(--border-color)",
                    borderRadius: "0.875rem",
                    padding: "1rem",
                    background: "var(--subtle-bg-2)",
                    display: "flex",
                    flexDirection: "column",
                    gap: "0.75rem",
                  }}
                >
                  <div>
                    <label
                      style={{
                        display: "block",
                        marginBottom: "0.35rem",
                        fontSize: "0.875rem",
                        color: "var(--text-secondary)",
                        fontWeight: "600",
                      }}
                    >
                      Assign Staff Members:
                    </label>
                    <p
                      style={{
                        margin: 0,
                        fontSize: "0.8rem",
                        color: "var(--text-tertiary, var(--text-secondary))",
                        lineHeight: 1.45,
                      }}
                    >
                      Selected staff will receive the invite by email and a private notification in their bell icon.
                    </p>
                  </div>

                  {staffLoading ? (
                    <p style={{ margin: 0, color: "var(--text-secondary)", fontSize: "0.9rem" }}>
                      Loading staff members...
                    </p>
                  ) : meetingStaffOptions.length > 0 ? (
                    <MultiSelectDropdown
                      options={meetingStaffOptions}
                      selected={meetData.staffIds}
                      onChange={handleMeetingStaffChange}
                      placeholder="No staff selected"
                      searchable
                    />
                  ) : (
                    <p style={{ margin: 0, color: "var(--text-secondary)", fontSize: "0.9rem" }}>
                      No active staff members with email addresses are available to assign.
                    </p>
                  )}
                </div>
              )}

              <div
                style={{
                  display: "flex",
                  justifyContent: "flex-end",
                  marginTop: "1rem",
                  gap: "1rem",
                }}
              >
                <button
                  type="button"
                  onClick={() => setShowMeet(false)}
                  style={{
                    background: "transparent",
                    color: "var(--text-secondary)",
                    border: "none",
                    cursor: "pointer",
                    fontWeight: "500",
                  }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn-primary"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "0.5rem",
                  }}
                >
                  <Calendar size={16} /> Send Invites
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {detail && (
        <div
          onClick={() => setDetail(null)}
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: "var(--overlay-bg)",
            backdropFilter: "blur(8px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 100,
            animation: "fadeIn 0.2s ease-out",
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="card modal"
            style={{
              padding: "2.5rem",
              width: "min(640px, calc(100vw - 2rem))",
              maxHeight: "80vh",
              overflowY: "auto",
              background: "var(--modal-bg)",
              color: "var(--text-primary)",
              border: "1px solid var(--border-color)",
              boxShadow: "var(--glass-shadow)",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: "1.25rem",
              }}
            >
              <h3
                style={{
                  margin: 0,
                  fontSize: "1.25rem",
                  fontWeight: "bold",
                  display: "flex",
                  alignItems: "center",
                  gap: "0.5rem",
                }}
              >
                <Mail size={20} color="var(--accent-color)" /> Email
              </h3>
              <button
                onClick={() => setDetail(null)}
                style={{
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  color: "var(--text-secondary)",
                }}
                aria-label="Close"
              >
                <X size={20} />
              </button>
            </div>

            <div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "1rem",
                  marginBottom: "1.25rem",
                }}
              >
                <div
                  style={{
                    width: "50px",
                    height: "50px",
                    borderRadius: "50%",
                    background: "var(--primary-color, var(--accent-color))",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                  }}
                >
                  <User size={24} color="#fff" />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p
                    style={{
                      fontSize: "1.05rem",
                      fontWeight: "bold",
                      margin: 0,
                      marginBottom: "0.15rem",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                    title={detail.from}
                  >
                    {detail.from}
                  </p>
                  <p
                    style={{
                      fontSize: "0.85rem",
                      color: "var(--text-secondary)",
                      margin: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                    title={detail.to}
                  >
                    to {detail.to}
                  </p>
                </div>
              </div>

              <h2
                style={{
                  fontSize: "1.4rem",
                  fontWeight: "bold",
                  margin: 0,
                  marginBottom: "0.4rem",
                }}
              >
                {detail.subject}
              </h2>
              <p
                style={{
                  fontSize: "0.85rem",
                  color: "var(--text-secondary)",
                  margin: 0,
                  marginBottom: "1.25rem",
                }}
              >
                {new Date(detail.createdAt).toLocaleString()}
              </p>

              <div
                style={{
                  borderTop: "1px solid var(--border-color)",
                  paddingTop: "1.25rem",
                  whiteSpace: "pre-wrap",
                  wordWrap: "break-word",
                  lineHeight: 1.65,
                  color: "var(--text-primary)",
                }}
              >
                {detail.body ? (
                  renderTextWithLinks(detail.body)
                ) : (
                  <em style={{ color: "var(--text-secondary)" }}>(empty body)</em>
                )}
              </div>
            </div>

            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                marginTop: "1.25rem",
              }}
            >
              <button onClick={() => setDetail(null)} className="btn-secondary">
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
