import { Plus, Trash2 } from 'lucide-react';
import { emptyGenericFieldCondition } from '../utils/genericSequenceConditions';

const TEXT_OPERATORS = [
  { value: 'eq', label: 'Equals' },
  { value: 'neq', label: 'Does not equal' },
  { value: 'contains', label: 'Contains' },
  { value: 'notContains', label: 'Does not contain' },
  { value: 'empty', label: 'Is empty' },
  { value: 'notEmpty', label: 'Is not empty' },
];

const NUMBER_OPERATORS = [
  { value: 'eq', label: 'Equals' },
  { value: 'neq', label: 'Does not equal' },
  { value: 'gt', label: 'Greater than' },
  { value: 'gte', label: 'Greater than or equal' },
  { value: 'lt', label: 'Less than' },
  { value: 'lte', label: 'Less than or equal' },
  { value: 'empty', label: 'Is empty' },
  { value: 'notEmpty', label: 'Is not empty' },
];

export default function GenericSequenceFieldConditions({ rule, fields, onChange }) {
  const conditions = Array.isArray(rule.conditions) ? rule.conditions : [];
  const updateCondition = (index, patch) => onChange({
    conditions: conditions.map((condition, current) => current === index ? { ...condition, ...patch } : condition),
  });

  return (
    <div style={wrapperStyle}>
      <div style={filterHeaderStyle}>
        <div>
          <strong style={{ fontSize: '0.74rem' }}>Lead field filters</strong>
          <div style={helpStyle}>{conditions.length ? 'Send only when these lead details match.' : 'No field filter — every lead for this event can continue.'}</div>
        </div>
        <button
          type="button"
          className="btn-secondary"
          onClick={() => onChange({ conditions: [...conditions, emptyGenericFieldCondition()] })}
          style={addFilterStyle}
        >
          <Plus size={13} /> Add field condition
        </button>
      </div>

      {conditions.length > 1 && (
        <label style={logicStyle}>
          Match
          <select
            className="input-field"
            aria-label="Field condition logic"
            value={rule.conditionLogic || 'AND'}
            onChange={event => onChange({ conditionLogic: event.target.value })}
            style={{ width: 'auto', minHeight: 34 }}
          >
            <option value="AND">all conditions</option>
            <option value="OR">any condition</option>
          </select>
        </label>
      )}

      {conditions.map((condition, index) => {
        const selectedField = fields.find(field => field.value === condition.field);
        const operators = selectedField?.number ? NUMBER_OPERATORS : TEXT_OPERATORS;
        const valueOptional = ['empty', 'notEmpty'].includes(condition.op);
        return (
          <div key={`${index}-${condition.field}`} style={conditionRowStyle}>
            <select
              className="input-field"
              aria-label={`Lead field ${index + 1}`}
              value={condition.field || ''}
              onChange={event => updateCondition(index, { field: event.target.value, op: 'eq', value: '' })}
              style={conditionInputStyle}
            >
              <option value="">Select lead field</option>
              <optgroup label="Lead fields">
                {fields.filter(field => !field.custom).map(field => <option key={field.value} value={field.value}>{field.label}</option>)}
              </optgroup>
              {fields.some(field => field.custom) && <optgroup label="Custom fields">
                {fields.filter(field => field.custom).map(field => <option key={field.value} value={field.value}>{field.label}</option>)}
              </optgroup>}
            </select>
            <select
              className="input-field"
              aria-label={`Lead field operator ${index + 1}`}
              value={condition.op || 'eq'}
              disabled={!selectedField}
              onChange={event => updateCondition(index, { op: event.target.value, value: '' })}
              style={conditionInputStyle}
            >
              {operators.map(operator => <option key={operator.value} value={operator.value}>{operator.label}</option>)}
            </select>
            {selectedField?.options?.length ? (
              <select
                className="input-field"
                aria-label={`Lead field value ${index + 1}`}
                value={condition.value || ''}
                disabled={!selectedField || valueOptional}
                onChange={event => updateCondition(index, { value: event.target.value })}
                style={conditionInputStyle}
              >
                <option value="">Select value</option>
                {selectedField.options.map(option => {
                  const value = typeof option === 'string' ? option : option.value;
                  const label = typeof option === 'string' ? option : (option.label || option.value);
                  return <option key={value} value={value}>{label}</option>;
                })}
              </select>
            ) : (
              <input
                className="input-field"
                aria-label={`Lead field value ${index + 1}`}
                type={selectedField?.number ? 'number' : 'text'}
                value={condition.value || ''}
                disabled={!selectedField || valueOptional}
                onChange={event => updateCondition(index, { value: event.target.value })}
                placeholder={valueOptional ? 'No value needed' : 'Enter value'}
                style={conditionInputStyle}
              />
            )}
            <button
              type="button"
              aria-label={`Remove lead field condition ${index + 1}`}
              onClick={() => onChange({ conditions: conditions.filter((_, current) => current !== index) })}
              style={removeFilterStyle}
            >
              <Trash2 size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

const wrapperStyle = { marginTop: '0.85rem', paddingTop: '0.8rem', borderTop: '1px dashed var(--border-color)', display: 'grid', gap: '0.55rem' };
const filterHeaderStyle = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' };
const helpStyle = { marginTop: 3, color: 'var(--text-secondary)', fontSize: '0.68rem' };
const addFilterStyle = { display: 'inline-flex', alignItems: 'center', gap: 5, padding: '0.42rem 0.55rem', fontSize: '0.7rem' };
const logicStyle = { display: 'flex', alignItems: 'center', gap: 7, color: 'var(--text-secondary)', fontSize: '0.7rem' };
const conditionRowStyle = { display: 'grid', gridTemplateColumns: 'minmax(0, 1.2fr) minmax(0, 1fr) minmax(0, 1.2fr) auto', gap: 6, alignItems: 'center' };
const conditionInputStyle = { minWidth: 0, minHeight: 36, fontSize: '0.72rem' };
const removeFilterStyle = { display: 'inline-flex', padding: 7, border: '1px solid var(--border-color)', borderRadius: 7, background: 'var(--surface-color)', color: 'var(--danger-color)', cursor: 'pointer' };
