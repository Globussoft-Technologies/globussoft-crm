import { useEffect, useState } from "react";
import { UsersRound, Plus, Pencil, Trash2, X } from "lucide-react";
import { fetchApi } from "../utils/api";
import { useNotify } from "../utils/notify";

const text = (value, fallback = "") => typeof value === "string" ? value : fallback;

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
  const openCreate = async () => { const data = await fetchApi("/api/staff", { silent: true }); setUsers(Array.isArray(data) ? data : data?.users || []); setEditor({ id: null }); setName(""); setMemberIds([]); };
  const openEdit = (team) => { setEditor(team); setName(text(team.name)); setMemberIds((team.members || []).map((m) => m.user?.id).filter(Boolean)); setUsers((team.members || []).map((m) => m.user).filter(Boolean)); };
  const save = async (event) => { event.preventDefault(); try { await fetchApi(editor.id ? `/api/sales-teams/${editor.id}` : "/api/sales-teams", { method: editor.id ? "PUT" : "POST", body: JSON.stringify({ name: name.trim(), memberIds }) }); await load(); notify.success("Team saved successfully"); setEditor(null); } catch (error) { notify.error(error.message || "Failed to save team"); } };
  const remove = async (team) => { try { await fetchApi(`/api/sales-teams/${team.id}`, { method: "DELETE" }); await load(); notify.success("Team deleted"); } catch (error) { notify.error(error.message || "Failed to delete team"); } };
  return <main style={{ display: "grid", gap: 16, padding: "0 28px", width: "100%", boxSizing: "border-box" }}><section className="card" style={{ padding: 24 }}><div style={{ display: "flex", justifyContent: "space-between" }}><div><h1><UsersRound size={24} /> Teams</h1><p>Bring sales representatives, account executives, and sales leaders together in focused teams.</p><strong>{teams.length} teams</strong></div><button type="button" className="btn-primary" style={{ padding: "8px 14px", fontSize: 13 }} onClick={openCreate}><Plus size={15} /> Create team</button></div></section><section className="card" style={{ padding: 28 }}><h2>Your teams</h2>{teams.length ? teams.map((team) => <article key={team.id} style={{ border: "1px solid var(--border-color)", borderRadius: 12, padding: 18, marginBottom: 12 }}><div style={{ display: "flex", justifyContent: "space-between" }}><div><h3>{text(team.name, "Unnamed team")}</h3><p>Sales team</p></div><div style={{ display: "flex", gap: 8, alignItems: "center" }}><span>{(team.members || []).length} members</span><button type="button" className="btn-secondary" style={{ padding: 6 }} onClick={() => openEdit(team)}><Pencil size={14} /></button><button type="button" className="btn-secondary" style={{ padding: 6, color: "var(--danger-color, #dc2626)" }} onClick={() => remove(team)}><Trash2 size={14} /></button></div></div>{(team.members || []).map((member) => <div key={member.id}>{text(member.user?.name, "Unnamed user")} <small>{text(member.user?.email)}</small></div>)}</article>) : <p>No teams found.</p>}</section>{editor && <div role="dialog" aria-modal="true" style={{ position: "fixed", inset: 0, zIndex: 9999, background: "rgba(15,23,42,.58)" }}><form className="card" onSubmit={save} style={{ position: "absolute", right: 0, top: 0, height: "100%", width: "min(720px,100%)", padding: 24 }}><header style={{ display: "flex", justifyContent: "space-between" }}><h2>{editor.id ? "Edit team" : "Create team"}</h2><button type="button" onClick={() => setEditor(null)}><X size={18} /></button></header><label>Team name *<input className="input-field" required value={name} onChange={(e) => setName(e.target.value)} /></label><h3>Team members</h3>{users.map((user) => <label key={user.id} style={{ display: "block", margin: 8 }}><input type="checkbox" checked={memberIds.includes(user.id)} onChange={(e) => setMemberIds((ids) => e.target.checked ? [...ids, user.id] : ids.filter((id) => id !== user.id))} /> {text(user.name || user.email)}</label>)}<footer style={{ display: "flex", justifyContent: "flex-end", gap: 12, marginTop: 28, paddingTop: 18, borderTop: "1px solid var(--border-color)" }}><button type="button" className="btn-secondary" style={{ padding: "8px 16px", minWidth: 90 }} onClick={() => setEditor(null)}>Cancel</button><button type="submit" className="btn-primary" style={{ padding: "8px 16px", minWidth: 90 }}>Save</button></footer></form></div>}</main>;
}
