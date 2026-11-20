import { Children } from 'react';
import ScrollableSelect from './ScrollableSelect';

export default function AutomationSelect({ children, value, onChange, disabled, id }) {
  const options = Children.toArray(children).filter(child => child?.props).map(child => ({ value: String(child.props.value ?? ''), label: child.props.children }));
  return <ScrollableSelect id={id} className="automation-select" value={String(value ?? '')} options={options} onChange={next => onChange?.({ target: { value: next } })} disabled={disabled} width="100%" searchable={options.length > 6} ariaLabel={id ? undefined : options[0]?.label} />;
}
