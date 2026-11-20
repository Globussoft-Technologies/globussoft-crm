export default function AutomationStepper({ style: _style, ...props }) {
  const update = delta => {
    const value = String(Math.max(Number(props.min), Math.min(Number(props.max), Number(props.value) + delta)));
    props.onChange?.({ target: { value } });
    props.onBlur?.({ target: { value } });
  };
  return <span className="automation-stepper">
    <button type="button" data-automation-setting aria-label="Decrease value" disabled={props.disabled || Number(props.value) <= Number(props.min)} onClick={() => update(-1)}>−</button>
    <input {...props} />
    <button type="button" data-automation-setting aria-label="Increase value" disabled={props.disabled || Number(props.value) >= Number(props.max)} onClick={() => update(1)}>+</button>
  </span>;
}
