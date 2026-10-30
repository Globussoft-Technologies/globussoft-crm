import { MapPin, Plus, RefreshCw } from 'lucide-react';
import './PickupPlotEmptyState.css';

export default function PickupPlotEmptyState({
  icon: Icon = MapPin,
  title,
  description,
  actionLabel,
  onAction,
  actionVariant = 'primary',
  actionIcon: ActionIcon,
  compact = false,
  testId,
}) {
  const ResolvedActionIcon = ActionIcon || (actionVariant === 'secondary' ? RefreshCw : Plus);

  return (
    <div className={`pickup-plot-empty-state${compact ? ' is-compact' : ''}`} data-testid={testId}>
      <div className="pickup-plot-empty-icon" aria-hidden="true"><Icon size={compact ? 22 : 26} /></div>
      <div className="pickup-plot-empty-copy">
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      {actionLabel && onAction && (
        <button type="button" className={actionVariant === 'secondary' ? 'btn-secondary' : 'btn-primary'} onClick={onAction}>
          <ResolvedActionIcon size={15} /> {actionLabel}
        </button>
      )}
    </div>
  );
}
