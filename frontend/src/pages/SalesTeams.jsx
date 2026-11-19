import { useContext, useEffect, useState } from "react";
import { Eye, UsersRound, Plus, Pencil, Trash2, X, Globe2 } from "lucide-react";
import { fetchApi } from "../utils/api";
import { useNotify } from "../utils/notify";
import { AuthContext } from "../appContexts";

const text = (value, fallback = "") => typeof value === "string" ? value : fallback;

const personLabel = (person) => text(person?.name || person?.email, "—");

const staffOptionLabel = (user, withRole) => withRole ? `${text(user?.name || user?.email, "Unnamed user")} (${text(user?.role, "Staff")})` : text(user?.name || user?.email);
const detailCardStyle = (label) => {
  const tones = {
    "Team manager": { background: "var(--accent-bg, rgba(79,70,229,.10))", borderColor: "color-mix(in srgb, var(--accent-color, #4f46e5) 28%, var(--border-color))", accent: "var(--accent-color, #4f46e5)" },
    "Total members": { background: "rgba(14,165,233,.10)", borderColor: "rgba(14,165,233,.28)", accent: "#0284c7" },
    Status: { background: "rgba(16,185,129,.10)", borderColor: "rgba(16,185,129,.28)", accent: "#059669" },
    Scope: { background: "rgba(245,158,11,.12)", borderColor: "rgba(245,158,11,.30)", accent: "#d97706" },
  };
  const tone = tones[label] || tones.Scope;
  return { padding: 14, border: `1px solid ${tone.borderColor}`, borderLeft: `4px solid ${tone.accent}`, borderRadius: 10, background: tone.background };
};

const dateLabel = (value) => {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString();
};

export default function SalesTeams() {
  const notify = useNotify();
  const { tenant } = useContext(AuthContext) || {};
  const isGeneric = tenant?.vertical === "generic" || document.body?.dataset.vertical === "generic";
  const [teams, setTeams] = useState([]);
  const [users, setUsers] = useState([]);
  const [editor, setEditor] = useState(null);
  const [name, setName] = useState("");
  const [scope, setScope] = useState("Sales");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState("Active");
  const [territoryMode, setTerritoryMode] = useState("individual");
  const [territoryId, setTerritoryId] = useState("");
  const [managerId, setManagerId] = useState("");
  const [memberIds, setMemberIds] = useState([]);
  const [detailsTeam, setDetailsTeam] = useState(null);
  const [detailsUsers, setDetailsUsers] = useState([]);
  const [detailsTerritories, setDetailsTerritories] = useState([]);
  const [detailsTerritoryMode, setDetailsTerritoryMode] = useState("individual");
  const [detailsTerritoryId, setDetailsTerritoryId] = useState("");
  const [detailsMemberId, setDetailsMemberId] = useState("");

  const load = async () => {
    try { const data = await fetchApi("/api/sales-teams", { silent: true }); setTeams(Array.isArray(data) ? data : []); }
    catch (error) { notify.error(error.message || "Failed to load teams"); }
  };
  useEffect(() => { load(); }, []);
  const openCreate = async () => { const [data, territoryData] = await Promise.all([fetchApi("/api/staff?fields=summary", { silent: true }), isGeneric ? fetchApi("/api/territories?fields=summary", { silent: true }) : Promise.resolve([])]); setUsers(Array.isArray(data) ? data : data?.users || []); setDetailsTerritories(Array.isArray(territoryData) ? territoryData : []); setEditor({ id: null }); setName(""); setScope("Sales"); setDescription(""); setStatus("Active"); setTerritoryMode("individual"); setTerritoryId(""); setManagerId(""); setMemberIds([]); };
  const openEdit = async (team) => { const [data, territoryData] = await Promise.all([fetchApi("/api/staff?fields=summary", { silent: true }), isGeneric ? fetchApi("/api/territories?fields=summary", { silent: true }) : Promise.resolve([])]); setEditor(team); setName(text(team.name)); setScope(text(team.scope, "Sales")); setDescription(text(team.description)); setStatus(text(team.status, team.isActive === false ? "Inactive" : "Active")); setTerritoryMode(text(team.territoryMode, "individual")); setTerritoryId(team.territoryId ? String(team.territoryId) : ""); setManagerId(String(team.managerId || team.manager?.id || "")); setMemberIds((team.members || []).map((m) => m.user?.id).filter(Boolean)); setUsers(Array.isArray(data) ? data : data?.users || []); setDetailsTerritories(Array.isArray(territoryData) ? territoryData : []); };
  const openDetails = async (team) => { setDetailsTeam(team); setDetailsMemberId(""); setDetailsTerritoryMode(text(team.territoryMode, "individual")); setDetailsTerritoryId(team.territoryId ? String(team.territoryId) : ""); try { const [staffData, territoryData] = await Promise.all([fetchApi(isGeneric ? "/api/staff" : "/api/staff?fields=summary", { silent: true }), isGeneric ? fetchApi("/api/territories?fields=summary", { silent: true }) : Promise.resolve([])]); setDetailsUsers(Array.isArray(staffData) ? staffData : staffData?.users || []); setDetailsTerritories(Array.isArray(territoryData) ? territoryData : []); } catch (error) { notify.error(error.message || "Failed to load staff"); } };
  const assignMemberTerritory = async (userId, territoryId) => { const territory = detailsTerritories.find((item) => String(item.id) === String(territoryId)); if (!territory) return; const assignedUserIds = [...new Set([...(territory.assignedUserIds || []).map(Number), Number(userId)])]; try { await fetchApi(`/api/territories/${territory.id}`, { method: "PUT", body: JSON.stringify({ name: territory.name, regions: territory.regions || [], assignedUserIds }) }); const refreshed = await fetchApi("/api/staff", { silent: true }); setDetailsUsers(Array.isArray(refreshed) ? refreshed : refreshed?.users || []); notify.success("Territory assigned"); } catch (error) { notify.error(error.message || "Failed to assign territory"); } };
  const detailsAssignmentFields = () => ({ territoryMode: detailsTerritoryMode, territoryId: detailsTerritoryMode === "team" && detailsTerritoryId ? Number(detailsTerritoryId) : null });
  const updateDetailsAssignment = async (mode, id) => { if (!detailsTeam) return; setDetailsTerritoryMode(mode); setDetailsTerritoryId(id); try { const updated = await fetchApi(`/api/sales-teams/${detailsTeam.id}`, { method: "PUT", body: JSON.stringify({ name: text(detailsTeam.name), scope: text(detailsTeam.scope, "Sales"), description: text(detailsTeam.description), status: text(detailsTeam.status, "Active"), territoryMode: mode, territoryId: mode === "team" && id ? Number(id) : null, managerId: detailsTeam.managerId || detailsTeam.manager?.id || null, memberIds: (detailsTeam.members || []).map((member) => member.user?.id).filter(Boolean) }) }); setDetailsTeam(updated); setTeams((rows) => rows.map((row) => row.id === updated.id ? updated : row)); notify.success("Territory assignment updated"); } catch (error) { notify.error(error.message || "Failed to update territory assignment"); } };
  const updateDetailsMembers = async (nextMemberIds) => { if (!detailsTeam) return; try { const updated = await fetchApi(`/api/sales-teams/${detailsTeam.id}`, { method: "PUT", body: JSON.stringify({ name: text(detailsTeam.name), scope: text(detailsTeam.scope, "Sales"), description: text(detailsTeam.description), status: text(detailsTeam.status, "Active"), ...detailsAssignmentFields(), managerId: detailsTeam.managerId || detailsTeam.manager?.id || null, memberIds: nextMemberIds }) }); setDetailsTeam(updated); setTeams((rows) => rows.map((row) => row.id === updated.id ? updated : row)); setDetailsMemberId(""); notify.success("Team members updated"); } catch (error) { notify.error(error.message || "Failed to update team members"); } };
  const updateDetailsStatus = async (nextStatus) => { if (!detailsTeam || nextStatus === detailsTeam.status) return; try { const updated = await fetchApi(`/api/sales-teams/${detailsTeam.id}`, { method: "PUT", body: JSON.stringify({ name: text(detailsTeam.name), scope: text(detailsTeam.scope, "Sales"), description: text(detailsTeam.description), status: nextStatus, ...detailsAssignmentFields(), managerId: detailsTeam.managerId || detailsTeam.manager?.id || null, memberIds: (detailsTeam.members || []).map((member) => member.user?.id).filter(Boolean) }) }); setDetailsTeam(updated); setTeams((rows) => rows.map((row) => row.id === updated.id ? updated : row)); notify.success("Team status updated"); } catch (error) { notify.error(error.message || "Failed to update team status"); } };
  const save = async (event) => { event.preventDefault(); try { await fetchApi(editor.id ? `/api/sales-teams/${editor.id}` : "/api/sales-teams", { method: editor.id ? "PUT" : "POST", body: JSON.stringify({ name: name.trim(), ...(isGeneric ? { scope, description: description.trim(), status, territoryMode, territoryId: territoryMode === "team" && territoryId ? Number(territoryId) : null } : {}), managerId: managerId ? Number(managerId) : null, memberIds }) }); await load(); notify.success("Team saved successfully"); setEditor(null); } catch (error) { notify.error(error.message || "Failed to save team"); } };
  const remove = async (team) => { try { await fetchApi(`/api/sales-teams/${team.id}`, { method: "DELETE" }); await load(); notify.success("Team deleted"); } catch (error) { notify.error(error.message || "Failed to delete team"); } };
  return <main
    className="sales-teams-page"
    data-testid="sales-teams-page"
    style={{
      display: "grid",
      alignContent: "start",
      gap: 14,
      height: "fit-content",
      minHeight: 0,
      overflowY: "visible",
      padding: "0 28px 28px",
      width: "100%",
      boxSizing: "border-box",
    }}
  >
    <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--text-muted, #64748b)", fontSize: 13 }}>
      <span style={{ color: "var(--accent-color, #4f46e5)" }}>Admin Settings</span><span aria-hidden="true">›</span><strong>Teams</strong>
    </div>
    <section className="card sales-teams-intro" style={{ padding: 24 }}>
      <div className="sales-teams-intro-row" style={{ display: "flex", justifyContent: "space-between", gap: 24, alignItems: "flex-start" }}>
        <div style={{ minWidth: 0 }}>
          <h1 style={{ display: "flex", alignItems: "center", gap: 10, margin: 0 }}><UsersRound size={25} /> Teams</h1>
          <p style={{ maxWidth: 900, lineHeight: 1.55 }}>Teams help you bring together different kinds of sales personnel like sales reps, account executives, and even VPs of sales. This makes collaboration easier: you can track team members&apos; performance, set up meetings, and quickly share reports and automations with them.</p>
          <button type="button" className="btn-secondary" style={{ padding: "8px 14px", color: "var(--accent-color, #4f46e5)" }} onClick={() => notify.info("Teams help you organize sales representatives and leaders.")}>ⓘ&nbsp; Learn more</button>
        </div>
        <button type="button" className="btn-primary sales-teams-create-button" style={{ padding: "10px 16px", whiteSpace: "nowrap" }} onClick={openCreate}><Plus size={15} /> Create team</button>
      </div>
    </section>
    <section className="card sales-teams-table" data-testid="sales-teams-table" style={{ padding: 0, width: "100%", minWidth: 0, maxWidth: "100%", overflowX: "hidden", overflowY: "hidden" }}>
      <table className="stable-table" style={{ width: "100%", maxWidth: "100%", tableLayout: "fixed", borderCollapse: "collapse", minWidth: 0 }}>
        <thead><tr>{(isGeneric ? ["Team name", "Team scope", "Team manager", "Members", "Created date", "Status", "Actions"] : ["Team name", "Team manager(s)", "Team members", "Created by", "Updated by", "Actions"]).map((heading) => <th key={heading} style={{ textAlign: "left", padding: "14px 20px", borderBottom: "1px solid var(--border-color)", fontSize: 12, textTransform: "uppercase", letterSpacing: ".02em" }}>{heading}</th>)}</tr></thead>
        <tbody>{teams.length ? teams.map((team) => {
          const members = team.members || [];
          const people = members.map((member) => member.user).filter(Boolean);
          const managers = team.managers || team.manager ? (team.managers || [team.manager]) : [];
          const scope = text(team.scope || team.teamScope || team.purpose, "Sales");
          const status = String(team.status || (team.isActive === false ? "Inactive" : "Active"));
          return <tr key={team.id}>
            <td style={{ padding: "18px 20px", borderBottom: "1px solid var(--border-color)" }}><button type="button" onClick={() => isGeneric ? openDetails(team) : openEdit(team)} style={{ border: 0, background: "none", padding: 0, color: "var(--accent-color, #4f46e5)", cursor: "pointer", fontWeight: 600 }}>{text(team.name, "Unnamed team")}</button></td>
            {isGeneric ? <><td style={{ padding: "18px 20px", borderBottom: "1px solid var(--border-color)" }}>{scope}</td><td style={{ padding: "18px 20px", borderBottom: "1px solid var(--border-color)" }}>{managers.length ? managers.map(personLabel).join(", ") : "None"}</td><td style={{ padding: "18px 20px", borderBottom: "1px solid var(--border-color)" }}>{members.length}</td><td style={{ padding: "18px 20px", borderBottom: "1px solid var(--border-color)" }}>{dateLabel(team.createdAt)}</td><td style={{ padding: "18px 20px", borderBottom: "1px solid var(--border-color)" }}>{status}</td></> : <><td style={{ padding: "18px 20px", borderBottom: "1px solid var(--border-color)" }}>{managers.length ? managers.map(personLabel).join(", ") : "None"}</td><td style={{ padding: "18px 20px", borderBottom: "1px solid var(--border-color)" }}>{people.length ? people.map(personLabel).join(", ") : `${members.length} members`}</td><td style={{ padding: "18px 20px", borderBottom: "1px solid var(--border-color)" }}>{personLabel(team.createdBy)}<small style={{ display: "block", color: "var(--text-muted, #64748b)" }}>{dateLabel(team.createdAt)}</small></td><td style={{ padding: "18px 20px", borderBottom: "1px solid var(--border-color)" }}>{personLabel(team.updatedBy)}<small style={{ display: "block", color: "var(--text-muted, #64748b)" }}>{dateLabel(team.updatedAt)}</small></td></>}
            <td style={{ padding: "18px 20px", borderBottom: "1px solid var(--border-color)" }}><div style={{ display: "flex", gap: 6 }}><button type="button" className="btn-secondary" style={{ padding: 6 }} aria-label={`${isGeneric ? "View" : "Edit"} ${text(team.name, "team")}`} onClick={() => isGeneric ? openDetails(team) : openEdit(team)}>{isGeneric ? <Eye size={14} /> : <Pencil size={14} />}</button>{isGeneric && <button type="button" className="btn-secondary" style={{ padding: 6 }} aria-label={`Edit ${text(team.name, "team")}`} onClick={() => openEdit(team)}><Pencil size={14} /></button>}<button type="button" className="btn-secondary" style={{ padding: 6, color: "var(--danger-color, #dc2626)" }} aria-label={`Delete ${text(team.name, "team")}`} onClick={() => remove(team)}><Trash2 size={14} /></button></div></td>
          </tr>;
        }) : <tr><td colSpan={isGeneric ? 7 : 6} style={{ padding: 24, textAlign: "center" }}>No teams found.</td></tr>}</tbody>
      </table>
      <div style={{ padding: "14px 20px", color: "var(--text-muted, #64748b)", fontSize: 13 }}>Showing {teams.length ? 1 : 0} - {teams.length} of {teams.length}</div>
    </section>
    {detailsTeam && isGeneric && (
      <div role="dialog" aria-modal="true" aria-label="Team details" className="sales-team-details-overlay" style={{ position: "fixed", inset: 0, zIndex: 9998, display: "flex", alignItems: "center", justifyContent: "center", padding: 24, boxSizing: "border-box", background: "rgba(15,23,42,.68)", backdropFilter: "blur(2px)" }}>
        <section className="card sales-team-details-modal" style={{ width: "min(760px,100%)", maxHeight: "calc(100vh - 48px)", overflowY: "auto", boxSizing: "border-box", padding: 24, borderRadius: 16, background: "var(--modal-bg)", color: "var(--text-primary)" }}>
          <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, marginBottom: 20 }}><div><h2 style={{ margin: 0 }}>{text(detailsTeam.name, "Unnamed team")}</h2><p style={{ margin: "6px 0 0", color: "var(--text-secondary)" }}>{text(detailsTeam.scope, "Sales")} team</p></div><div style={{ display: "flex", alignItems: "center", gap: 12 }}><select aria-label="Team status" value={text(detailsTeam.status, "Active")} onChange={(event) => updateDetailsStatus(event.target.value)} style={{ appearance: "none", minWidth: 102, border: `1px solid ${detailsTeam.status === "Active" ? "rgba(5,150,105,.35)" : "rgba(220,38,38,.35)"}`, borderRadius: 999, padding: "7px 27px 7px 12px", background: detailsTeam.status === "Active" ? "rgba(16,185,129,.16)" : "rgba(239,68,68,.13)", color: detailsTeam.status === "Active" ? "#047857" : "#b91c1c", fontWeight: 800, fontSize: 13, cursor: "pointer" }}><option value="Active">Active</option><option value="Inactive">Inactive</option></select><button type="button" className="btn-secondary" aria-label="Close team details" onClick={() => setDetailsTeam(null)} style={{ padding: 6 }}><X size={18} /></button></div></header>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, marginBottom: 20 }}>
            {[['Team manager', detailsTeam.manager ? staffOptionLabel(detailsTeam.manager, true) : 'None'], ['Total members', String((detailsTeam.members || []).length)], ['Scope', text(detailsTeam.scope, "Sales")]].map(([label, value]) => <div key={label} style={detailCardStyle(label)}><small style={{ display: "block", color: "var(--text-secondary)", marginBottom: 7, fontWeight: 600 }}>{label}</small><strong style={{ fontSize: 16 }}>{value}</strong></div>)}
          </div>
          <section style={{ marginBottom: 20 }}><h3 style={{ margin: "0 0 8px" }}>Description</h3><p style={{ margin: 0, color: "var(--text-secondary)", whiteSpace: "pre-wrap" }}>{text(detailsTeam.description, "No description added.")}</p></section>
          <section style={{ marginBottom: 20, padding: "10px 12px", border: "1px solid var(--border-color)", borderRadius: 10, background: "var(--surface-color)" }}><div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}><div><strong>Territory assignment</strong><div style={{ marginTop: 3, color: "var(--text-secondary)", fontSize: 12 }}>{detailsTerritoryMode === "team" ? "All team members work on one shared territory." : "Each staff member can work on different territories."}</div></div><div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}><select aria-label="Territory assignment mode" value={detailsTerritoryMode} onChange={(event) => updateDetailsAssignment(event.target.value, event.target.value === "team" ? detailsTerritoryId : "")} style={{ border: "1px solid var(--border-color)", borderRadius: 8, padding: "7px 9px", background: "var(--input-bg)", color: "var(--text-primary)" }}><option value="individual">Individual territories</option><option value="team">One shared territory</option></select>{detailsTerritoryMode === "team" && <select aria-label="Shared team territory" value={detailsTerritoryId} onChange={(event) => updateDetailsAssignment("team", event.target.value)} style={{ border: "1px solid var(--border-color)", borderRadius: 8, padding: "7px 9px", background: "var(--input-bg)", color: "var(--text-primary)" }}><option value="">Select territory</option>{detailsTerritories.map((territory) => <option key={territory.id} value={territory.id}>{territory.name}</option>)}</select>}</div></div></section>
          <section style={{ marginBottom: 20 }}><div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 10 }}><h3 style={{ margin: 0 }}>Members</h3><span style={{ color: "var(--text-secondary)", fontSize: 13 }}>{(detailsTeam.members || []).length} total</span></div><div style={{ display: "grid", gap: 6 }}>{(detailsTeam.members || []).length ? detailsTeam.members.map((member) => { const memberUser = detailsUsers.find((user) => String(user.id) === String(member.user?.id)) || member.user; return <div key={member.id || member.user?.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "7px 10px", border: "1px solid var(--border-color)", borderRadius: 8, background: "var(--surface-color)" }}><div style={{ minWidth: 0 }}><div style={{ fontWeight: 600 }}>{staffOptionLabel(memberUser, true)}</div><div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 4, marginTop: 4 }}>{detailsTerritoryMode === "team" ? <span style={{ padding: "2px 7px", borderRadius: 999, background: "rgba(245,158,11,.14)", color: "#b45309", fontSize: 11 }}>{detailsTerritories.find((territory) => String(territory.id) === String(detailsTerritoryId))?.name || "Shared territory not selected"}</span> : memberUser?.territories?.length ? memberUser.territories.map((territory) => <span key={territory.id} style={{ padding: "2px 7px", borderRadius: 999, background: "var(--accent-bg, rgba(79,70,229,.10))", color: "var(--accent-color, #4f46e5)", fontSize: 11 }}>{territory.name}</span>) : <span style={{ color: "var(--text-secondary)", fontSize: 11 }}>No territory assigned</span>}{detailsTerritoryMode !== "team" && detailsTerritories.length > 0 && <span title="Assign territory" style={{ position: "relative", display: "inline-flex", alignItems: "center", justifyContent: "center", width: 28, height: 28, color: "var(--accent-color, #4f46e5)" }}><Globe2 size={15} aria-hidden="true" /><select aria-label={`Assign territory to ${staffOptionLabel(memberUser, false)}`} value="" onChange={(event) => assignMemberTerritory(memberUser.id, event.target.value)} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", opacity: 0, cursor: "pointer" }}><option value="">Assign territory</option>{detailsTerritories.map((territory) => <option key={territory.id} value={territory.id}>{territory.name}</option>)}</select></span>}</div></div><button type="button" className="btn-secondary" style={{ padding: "4px 9px", color: "var(--danger-color, #dc2626)" }} onClick={() => updateDetailsMembers((detailsTeam.members || []).map((item) => item.user?.id).filter((id) => id && id !== member.user?.id))}>Remove</button></div>; }) : <p style={{ margin: 0, color: "var(--text-secondary)" }}>No members assigned.</p>}</div><div style={{ display: "flex", gap: 8, marginTop: 10 }}><select className="input-field" aria-label="Add team member" value={detailsMemberId} onChange={(event) => setDetailsMemberId(event.target.value)} style={{ flex: 1 }}><option value="">Select a Staff member</option>{detailsUsers.map((user) => { const alreadyAdded = (detailsTeam.members || []).some((member) => String(member.user?.id) === String(user.id)); return <option key={user.id} value={user.id} disabled={alreadyAdded}>{staffOptionLabel(user, true)}{alreadyAdded ? " — Already added" : ""}</option>; })}</select><button type="button" className="btn-secondary" disabled={!detailsMemberId || (detailsTeam.members || []).some((member) => String(member.user?.id) === String(detailsMemberId))} onClick={() => updateDetailsMembers([...((detailsTeam.members || []).map((item) => item.user?.id).filter(Boolean)), Number(detailsMemberId)])}>Add member</button></div></section>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12, marginBottom: 20 }}><section style={{ padding: 16, border: "1px solid var(--border-color)", borderRadius: 10 }}><h3 style={{ margin: "0 0 6px" }}>Shared reports</h3><p style={{ margin: 0, color: "var(--text-secondary)", fontSize: 13 }}>Team-shared reports will appear here.</p></section><section style={{ padding: 16, border: "1px solid var(--border-color)", borderRadius: 10 }}><h3 style={{ margin: "0 0 6px" }}>Shared activities & collaboration</h3><p style={{ margin: 0, color: "var(--text-secondary)", fontSize: 13 }}>Team notes, activities, and collaboration updates will appear here.</p></section></div>
          <footer style={{ display: "flex", justifyContent: "flex-end", gap: 10, paddingTop: 16, borderTop: "1px solid var(--border-color)" }}><button type="button" className="btn-secondary" onClick={() => { setDetailsTeam(null); openEdit(detailsTeam); }}>Edit team</button><button type="button" className="btn-primary" onClick={() => setDetailsTeam(null)}>Close</button></footer>
        </section>
      </div>
    )}
    {editor && (
      <div role="dialog" aria-modal="true" aria-label={editor.id ? "Edit team" : "Create team"} className="sales-teams-editor-overlay" style={isGeneric ? { position: "fixed", inset: 0, zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", padding: 24, boxSizing: "border-box", background: "rgba(15,23,42,.68)", backdropFilter: "blur(2px)" } : { position: "fixed", inset: 0, zIndex: 9999, background: "rgba(15,23,42,.68)" }}>
        <form className="card sales-teams-editor" onSubmit={save} style={isGeneric ? { position: "relative", width: "min(720px,100%)", maxHeight: "calc(100vh - 48px)", boxSizing: "border-box", padding: 24, overflowY: "auto", borderRadius: 16, background: "var(--modal-bg)", color: "var(--text-primary)", backdropFilter: "none", WebkitBackdropFilter: "none" } : { position: "absolute", right: 0, top: 0, height: "100%", width: "min(720px,100%)", boxSizing: "border-box", padding: 24, overflowY: "auto", background: "var(--modal-bg)", color: "var(--text-primary)", backdropFilter: "none", WebkitBackdropFilter: "none" }}>
          <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 20 }}>
            <h2 style={{ margin: 0, fontSize: "1.2rem" }}>{editor.id ? "Edit team" : "Create team"}</h2>
            <button type="button" className="btn-secondary" aria-label="Close team editor" onClick={() => setEditor(null)} style={{ padding: 6, flexShrink: 0 }}><X size={18} /></button>
          </header>
          <label style={{ display: "grid", gap: 8, fontWeight: 600 }}>Team name *
            <input className="input-field" required value={name} onChange={(e) => setName(e.target.value)} style={{ boxSizing: "border-box", width: "100%", background: "var(--input-bg)", color: "var(--text-primary)" }} />
          </label>
          {isGeneric && <>
            <label style={{ display: "grid", gap: 8, fontWeight: 600, marginTop: 22 }}>Team scope
              <select className="input-field" value={scope} onChange={(e) => setScope(e.target.value)} style={{ boxSizing: "border-box", width: "100%", background: "var(--input-bg)", color: "var(--text-primary)" }}>
                {['Sales', 'Support', 'Technical', 'Marketing', 'HR', 'Finance', 'Operations'].map((option) => <option key={option} value={option}>{option}</option>)}
              </select>
            </label>
          </>}
          <label style={{ display: "grid", gap: 8, fontWeight: 600, marginTop: 22 }}>Team manager
            <select className="input-field" value={managerId} onChange={(e) => setManagerId(e.target.value)} style={{ boxSizing: "border-box", width: "100%", background: "var(--input-bg)", color: "var(--text-primary)" }}>
              <option value="">Select a team manager</option>
              {users.filter((user) => !user.deactivatedAt && (isGeneric || user.role === "ADMIN" || user.role === "MANAGER")).map((user) => <option key={user.id} value={user.id}>{staffOptionLabel(user, isGeneric)}</option>)}
            </select>
          </label>
          <h3 style={{ margin: "22px 0 12px", fontSize: "1rem" }}>Team members</h3>
          <select className="input-field" value="" aria-label="Select a member to add" onChange={(e) => { const id = Number(e.target.value); if (id && !memberIds.includes(id)) setMemberIds((ids) => [...ids, id]); }} style={{ boxSizing: "border-box", width: "100%", background: "var(--input-bg)", color: "var(--text-primary)" }}>
            <option value="">Select a member to add</option>
            {users.filter((user) => (isGeneric ? !user.deactivatedAt && !memberIds.includes(user.id) : user.role === "USER" && !memberIds.includes(user.id))).map((user) => <option key={user.id} value={user.id}>{staffOptionLabel(user, isGeneric)}</option>)}
          </select>
          <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
            {memberIds.map((id) => {
              const user = users.find((item) => item.id === id) || (editor.members || []).find((member) => member.user?.id === id)?.user;
              return <div key={id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "9px 12px", border: "1px solid var(--border-color)", borderRadius: 8 }}><span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{text(user?.name || user?.email, "Unnamed user")}</span><button type="button" className="btn-secondary" style={{ padding: "4px 9px", color: "var(--danger-color, #dc2626)" }} onClick={() => setMemberIds((ids) => ids.filter((memberId) => memberId !== id))}>Remove</button></div>;
            })}
          </div>
          {isGeneric && <>
            <label style={{ display: "grid", gap: 8, fontWeight: 600, marginTop: 22 }}>Description
              <textarea className="input-field" rows={4} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this team does" style={{ boxSizing: "border-box", width: "100%", background: "var(--input-bg)", color: "var(--text-primary)", resize: "vertical" }} />
            </label>
            <label style={{ display: "grid", gap: 8, fontWeight: 600, marginTop: 22 }}>Territory assignment
              <select className="input-field" value={territoryMode} onChange={(e) => { setTerritoryMode(e.target.value); if (e.target.value !== "team") setTerritoryId(""); }} style={{ boxSizing: "border-box", width: "100%", background: "var(--input-bg)", color: "var(--text-primary)" }}><option value="individual">Individual territories per staff member</option><option value="team">One shared territory for the whole team</option></select>
            </label>
            {territoryMode === "team" && <label style={{ display: "grid", gap: 8, fontWeight: 600, marginTop: 12 }}>Shared territory
              <select className="input-field" value={territoryId} onChange={(e) => setTerritoryId(e.target.value)} style={{ boxSizing: "border-box", width: "100%", background: "var(--input-bg)", color: "var(--text-primary)" }}><option value="">Select a territory</option>{detailsTerritories.map((territory) => <option key={territory.id} value={territory.id}>{territory.name}</option>)}</select>
            </label>}
            <label style={{ display: "grid", gap: 8, fontWeight: 600, marginTop: 22 }}>Status
              <select className="input-field" value={status} onChange={(e) => setStatus(e.target.value)} style={{ boxSizing: "border-box", width: "100%", background: "var(--input-bg)", color: "var(--text-primary)" }}><option value="Active">Active</option><option value="Inactive">Inactive</option></select>
            </label>
          </>}
          <footer style={{ display: "flex", justifyContent: "flex-end", gap: 12, marginTop: 28, paddingTop: 18, borderTop: "1px solid var(--border-color)" }}>
            <button type="button" className="btn-secondary" style={{ padding: "8px 16px", minWidth: 90 }} onClick={() => setEditor(null)}>Cancel</button>
            <button type="submit" className="btn-primary" style={{ padding: "8px 16px", minWidth: 90 }}>Save</button>
          </footer>
        </form>
      </div>
    )}
  </main>;
}
