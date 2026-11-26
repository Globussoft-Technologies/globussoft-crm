import { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, Layers, Plus, Trash2 } from 'lucide-react';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';

export default function PipelineStagesManager({ embedded = false, genericDialog = false, pipelineId = null, protectTerminalStages = false }) {
  const notify = useNotify();
  const [pipelineStages, setPipelineStages] = useState([]);
  const [newStage, setNewStage] = useState({ name: '', color: '#3b82f6' });
  const [stagesLoading, setStagesLoading] = useState(true);

  const fetchStages = () => {
    setStagesLoading(true);
    const url = pipelineId ? `/api/pipeline_stages?pipelineId=${encodeURIComponent(pipelineId)}` : '/api/pipeline_stages';
    fetchApi(url)
      .then((res) => setPipelineStages(Array.isArray(res) ? res : []))
      .catch(() => notify.error('Failed to load pipeline stages'))
      .finally(() => setStagesLoading(false));
  };

  useEffect(() => {
    fetchStages();
    // The editor owns its list and loads only when its Pipelines-page surface mounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleAddStage = async (event) => {
    event.preventDefault();
    if (!newStage.name.trim()) return;
    try {
      await fetchApi('/api/pipeline_stages', {
        method: 'POST',
        body: JSON.stringify({
          name: newStage.name,
          color: newStage.color,
          position: pipelineStages.length,
          ...(pipelineId ? { pipelineId: Number(pipelineId) } : {}),
        }),
      });
      if (genericDialog) notify.success('Stage added successfully');
      setNewStage({ name: '', color: '#3b82f6' });
      fetchStages();
    } catch {
      notify.error('Failed to add stage');
    }
  };

  const handleDeleteStage = async (id) => {
    if (!await notify.confirm('Delete this pipeline stage?')) return;
    try {
      const url = pipelineId
        ? `/api/pipeline_stages/${id}?pipelineId=${encodeURIComponent(pipelineId)}`
        : `/api/pipeline_stages/${id}`;
      await fetchApi(url, { method: 'DELETE' });
      fetchStages();
    } catch {
      notify.error('Failed to delete stage');
    }
  };

  const handleMoveStage = async (index, direction) => {
    const newStages = [...pipelineStages];
    const swapIndex = index + direction;
    if (swapIndex < 0 || swapIndex >= newStages.length) return;
    [newStages[index], newStages[swapIndex]] = [newStages[swapIndex], newStages[index]];
    const reordered = newStages.map((stage, position) => ({ id: stage.id, position }));
    setPipelineStages(newStages.map((stage, position) => ({ ...stage, position })));
    try {
      const updated = await fetchApi('/api/pipeline_stages/reorder', {
        method: 'PUT',
        body: JSON.stringify({ stages: reordered, ...(pipelineId ? { pipelineId: Number(pipelineId) } : {}) }),
      });
      if (Array.isArray(updated)) setPipelineStages(updated);
      else fetchStages();
    } catch {
      notify.error('Failed to save stage order');
      fetchStages();
    }
  };

  const addStageForm = (
    <form onSubmit={handleAddStage} style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap', marginBottom: genericDialog ? '1.5rem' : 0 }}>
      <input type="text" placeholder="Enter a new stage" aria-label="New pipeline stage name" required className="input-field" style={{ flex: '1 1 180px', minWidth: 0 }} value={newStage.name} onChange={(event) => setNewStage({ ...newStage, name: event.target.value })} />
      <input type="color" aria-label="Stage color" value={newStage.color} onChange={(event) => setNewStage({ ...newStage, color: event.target.value })} style={{ width: 40, height: 40, border: '1px solid var(--border-color)', borderRadius: 8, cursor: 'pointer', padding: 2, background: 'var(--input-bg)' }} />
      <button type="submit" className="btn-primary" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', whiteSpace: 'nowrap' }}><Plus size={16} /> Add Stage</button>
    </form>
  );

  return (
    <section className="card pipelines-stage-manager" style={{ padding: 'clamp(1.25rem, 3vw, 2rem)', marginTop: embedded ? 0 : '2rem', boxShadow: embedded ? 'none' : undefined, background: genericDialog ? 'var(--modal-bg, #fff)' : undefined, opacity: genericDialog ? 1 : undefined, backdropFilter: genericDialog ? 'none' : undefined, WebkitBackdropFilter: genericDialog ? 'none' : undefined, height: genericDialog ? '100%' : undefined, boxSizing: genericDialog ? 'border-box' : undefined, display: genericDialog ? 'flex' : undefined, flexDirection: genericDialog ? 'column' : undefined, overflow: genericDialog ? 'hidden' : undefined }}>
      <h3 style={{ fontSize: '1.25rem', fontWeight: 600, marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <Layers size={20} color="var(--accent-color)" /> Pipeline Stages
      </h3>
      <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', marginBottom: '1.5rem' }}>
        Add, remove, or reorder the stages available to your sales pipelines.
      </p>

      {genericDialog && addStageForm}

      {stagesLoading ? (
        <p>Loading stages...</p>
      ) : (
        <div data-testid={genericDialog ? 'generic-pipeline-stage-list' : undefined} style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginBottom: genericDialog ? 0 : '1.5rem', flex: genericDialog ? '1 1 auto' : undefined, minHeight: genericDialog ? 0 : undefined, overflowY: genericDialog ? 'auto' : undefined, paddingRight: genericDialog ? '0.25rem' : undefined }}>
          {pipelineStages.length === 0 && (
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
              No custom stages configured. The pipeline uses default stages.
            </p>
          )}
          {pipelineStages.map((stage, index) => (
            <div key={stage.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem', background: 'var(--surface-color)', border: '1px solid var(--border-color)', padding: '1rem 1.25rem', borderRadius: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', minWidth: 0 }}>
                <div style={{ width: 20, height: 20, borderRadius: 6, backgroundColor: stage.color, flexShrink: 0 }} />
                <span style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis' }}>{stage.name}</span>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>Position {index + 1}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexShrink: 0 }}>
                <button type="button" aria-label={`Move ${stage.name} up`} onClick={() => handleMoveStage(index, -1)} disabled={index === 0} style={stageAction(index === 0)}><ArrowUp size={16} /></button>
                <button type="button" aria-label={`Move ${stage.name} down`} onClick={() => handleMoveStage(index, 1)} disabled={index === pipelineStages.length - 1} style={stageAction(index === pipelineStages.length - 1)}><ArrowDown size={16} /></button>
                {protectTerminalStages && ['won', 'lost'].includes(String(stage.name || '').trim().toLowerCase())
                  ? <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>Required</span>
                  : <button type="button" aria-label={`Delete ${stage.name}`} onClick={() => handleDeleteStage(stage.id)} style={{ ...stageAction(false), color: 'var(--danger-color)' }}><Trash2 size={16} /></button>}
              </div>
            </div>
          ))}
        </div>
      )}

      {!genericDialog && addStageForm}
    </section>
  );
}

function stageAction(disabled) {
  return {
    background: 'none',
    border: 'none',
    color: disabled ? 'var(--border-color)' : 'var(--text-secondary)',
    cursor: disabled ? 'default' : 'pointer',
    padding: '0.25rem',
  };
}
