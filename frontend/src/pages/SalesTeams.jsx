import { useEffect, useState } from "react";
import { UsersRound, Plus, Pencil, Trash2, X } from "lucide-react";
import { fetchApi } from "../utils/api";
import { useNotify } from "../utils/notify";

const text = (value, fallback = "") => typeof value === "string" ? value : fallback;

const personLabel = (person) => text(person?.name || person?.email, "—");

const dateLabel = (value) => {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString();
};

export default function SalesTeams() {
  const notify = useNotify();
  const [teams, setTeams] = useState([]);
  const [users, setUsers] = useState([]);
  const [editor, setEditor] = useState(null);
  const [name, setName] = useState("");
  const [memberIds, setMemberIds] = useState([]);

  const load = async () => {
    try { const data = await fetchApi("/api/sales-teams", { silent: true }); setTeams(Array.isArray(data) ? data : []); }
    catch (error) { notify.error(error.message || "Failed to load teams"); }
  };
  useEffect(() => { load(); }, []);
  const openCreate = async () => { const data = await fetchApi("/api/staff?fields=summary", { silent: true }); setUsers(Array.isArray(data) ? data : data?.users || []); setEditor({ id: null }); setName(""); setMemberIds([]); };
  const openEdit = async (team) => { const data = await fetchApi("/api/staff?fields=summary", { silent: true }); setEditor(team); setName(text(team.name)); setMemberIds((team.members || []).map((m) => m.user?.id).filter(Boolean)); setUsers(Array.isArray(data) ? data : data?.users || []); };
  const save = async (event) => { event.preventDefault(); try { await fetchApi(editor.id ? `/api/sales-teams/${editor.id}` : "/api/sales-teams", { method: editor.id ? "PUT" : "POST", body: JSON.stringify({ name: name.trim(), memberIds }) }); await load(); notify.success("Team saved successfully"); setEditor(null); } catch (error) { notify.error(error.message || "Failed to save team"); } };
  const remove = async (team) => { try { await fetchApi(`/api/sales-teams/${team.id}`, { method: "DELETE" }); await load(); notify.success("Team deleted"); } catch (error) { notify.error(error.message || "Failed to delete team"); } };
  return <main style={{ display: "grid", gap: 14, padding: "0 28px 28px", width: "100%", boxSizing: "border-box" }}>
    <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--text-muted, #64748b)", fontSize: 13 }}>
      <span style={{ color: "var(--accent-color, #4f46e5)" }}>Admin Settings</span><span aria-hidden="true">›</span><strong>Teams</strong>
    </div>
    <section className="card" style={{ padding: 24 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 24, alignItems: "flex-start" }}>
        <div style={{ minWidth: 0 }}>
          <h1 style={{ display: "flex", alignItems: "center", gap: 10, margin: 0 }}><UsersRound size={25} /> Teams</h1>
          <p style={{ maxWidth: 900, lineHeight: 1.55 }}>Teams help you bring together different kinds of sales personnel like sales reps, account executives, and even VPs of sales. This makes collaboration easier: you can track team members&apos; performance, set up meetings, and quickly share reports and automations with them.</p>
          <button type="button" className="btn-secondary" style={{ padding: "8px 14px", color: "var(--accent-color, #4f46e5)" }} onClick={() => notify.info("Teams help you organize sales representatives and leaders.")}>ⓘ&nbsp; Learn more</button>
        </div>
        <button type="button" className="btn-primary" style={{ padding: "10px 16px", whiteSpace: "nowrap" }} onClick={openCreate}><Plus size={15} /> Create team</button>
      </div>
    </section>
    <section className="card" style={{ padding: 0, overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 760 }}>
        <thead><tr>{["Team name", "Team manager(s)", "Users", "Created by", "Updated by", "Actions"].map((heading) => <th key={heading} style={{ textAlign: "left", padding: "14px 20px", borderBottom: "1px solid var(--border-color)", fontSize: 12, textTransform: "uppercase", letterSpacing: ".02em" }}>{heading}</th>)}</tr></thead>
        <tbody>{teams.length ? teams.map((team) => {
          const members = team.members || [];
          const people = members.map((member) => member.user).filter(Boolean);
          const managers = team.managers || team.manager ? (team.managers || [team.manager]) : [];
          return <tr key={team.id}>
            <td style={{ padding: "18px 20px", borderBottom: "1px solid var(--border-color)" }}><button type="button" onClick={() => openEdit(team)} style={{ border: 0, background: "none", padding: 0, color: "var(--accent-color, #4f46e5)", cursor: "pointer", fontWeight: 600 }}>{text(team.name, "Unnamed team")}</button></td>
            <td style={{ padding: "18px 20px", borderBottom: "1px solid var(--border-color)" }}>{managers.length ? managers.map(personLabel).join(", ") : "—"}</td>
            <td style={{ padding: "18px 20px", borderBottom: "1px solid var(--border-color)" }}>{people.length ? people.map(personLabel).join(", ") : `${members.length} members`}</td>
            <td style={{ padding: "18px 20px", borderBottom: "1px solid var(--border-color)" }}>{personLabel(team.createdBy)}<small style={{ display: "block", color: "var(--text-muted, #64748b)" }}>{dateLabel(team.createdAt)}</small></td>
            <td style={{ padding: "18px 20px", borderBottom: "1px solid var(--border-color)" }}>{personLabel(team.updatedBy)}<small style={{ display: "block", color: "var(--text-muted, #64748b)" }}>{dateLabel(team.updatedAt)}</small></td>
            <td style={{ padding: "18px 20px", borderBottom: "1px solid var(--border-color)" }}><div style={{ display: "flex", gap: 6 }}><button type="button" className="btn-secondary" style={{ padding: 6 }} aria-label={`Edit ${text(team.name, "team")}`} onClick={() => openEdit(team)}><Pencil size={14} /></button><button type="button" className="btn-secondary" style={{ padding: 6, color: "var(--danger-color, #dc2626)" }} aria-label={`Delete ${text(team.name, "team")}`} onClick={() => remove(team)}><Trash2 size={14} /></button></div></td>
          </tr>;
        }) : <tr><td colSpan={6} style={{ padding: 24, textAlign: "center" }}>No teams found.</td></tr>}</tbody>
      </table>
      <div style={{ padding: "14px 20px", color: "var(--text-muted, #64748b)", fontSize: 13 }}>Showing {teams.length ? 1 : 0} - {teams.length} of {teams.length}</div>
    </section>
    {editor && <div role="dialog" aria-modal="true" style={{ position: "fixed", inset: 0, zIndex: 9999, background: "rgba(15,23,42,.68)", opacity: 1 }}><form className="card" onSubmit={save} style={{ position: "absolute", right: 0, top: 0, height: "100%", width: "min(720px,100%)", padding: 24, background: "#ffffff", backgroundColor: "#ffffff", backdropFilter: "none", WebkitBackdropFilter: "none", opacity: 1, filter: "none" }}><header style={{ display: "flex", justifyContent: "space-between" }}><h2>{editor.id ? "Edit team" : "Create team"}</h2><button type="button" onClick={() => setEditor(null)}><X size={18} /></button></header><label>Team name *<input className="input-field" required value={name} onChange={(e) => setName(e.target.value)} /></label><h3>Team members</h3><select className="input-field" value="" onChange={(e) => { const id = Number(e.target.value); if (id && !memberIds.includes(id)) setMemberIds((ids) => [...ids, id]); }}><option value="">Select a member to add</option>{users.filter((user) => !memberIds.includes(user.id)).map((user) => <option key={user.id} value={user.id}>{text(user.name || user.email)}</option>)}</select><div style={{ display: "grid", gap: 8, marginTop: 12 }}>{memberIds.map((id) => { const user = users.find((item) => item.id === id) || (editor.members || []).find((member) => member.user?.id === id)?.user; return <div key={id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "9px 12px", border: "1px solid var(--border-color)", borderRadius: 8 }}><span>{text(user?.name || user?.email, "Unnamed user")}</span><button type="button" className="btn-secondary" style={{ padding: "4px 9px", color: "var(--danger-color, #dc2626)" }} onClick={() => setMemberIds((ids) => ids.filter((memberId) => memberId !== id))}>Remove</button></div>; })}</div><footer style={{ display: "flex", justifyContent: "flex-end", gap: 12, marginTop: 28, paddingTop: 18, borderTop: "1px solid var(--border-color)" }}><button type="button" className="btn-secondary" style={{ padding: "8px 16px", minWidth: 90 }} onClick={() => setEditor(null)}>Cancel</button><button type="submit" className="btn-primary" style={{ padding: "8px 16px", minWidth: 90 }}>Save</button></footer></form></div>}
  </main>;
}
