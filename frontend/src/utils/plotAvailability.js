const UNASSIGNABLE_PLOT_STATUSES = new Set(['BOOKED', 'RESERVED', 'SOLD']);

export function isAssignablePlot(plot) {
  return !UNASSIGNABLE_PLOT_STATUSES.has(String(plot?.availability || '').toUpperCase());
}

export function groupPlotsByName(plots = []) {
  const groups = new Map();
  for (const plot of plots) {
    const name = String(plot?.name || '').trim();
    const key = name ? name.toLocaleLowerCase() : `plot-${plot.id}`;
    const group = groups.get(key) || {
      key,
      name: name || 'Unnamed plot',
      representative: plot,
      plotIds: [],
    };
    group.plotIds.push(Number(plot.id));
    groups.set(key, group);
  }
  return [...groups.values()];
}

export function selectedPlotGroupKeys(groups, selectedPlotIds = []) {
  const selected = new Set(selectedPlotIds.map(Number));
  return groups.filter((group) => group.plotIds.some((id) => selected.has(id))).map((group) => group.key);
}

export function expandPlotGroupKeys(groups, selectedKeys = []) {
  const selected = new Set(selectedKeys);
  return groups.filter((group) => selected.has(group.key)).flatMap((group) => group.plotIds);
}
