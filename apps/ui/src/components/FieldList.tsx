import type { FieldSpec, FieldValue } from '../data/snapshot';
import { Chip } from './Chips';

function renderValue(value: FieldValue, unit?: string) {
  if (value.kind === 'pending') return <Chip tone="pending">{value.value}</Chip>;
  if (value.kind === 'nocredit') return <Chip tone="danger">{value.value}</Chip>;
  if (value.kind === 'unknown') return <Chip tone="unknown">{value.value}</Chip>;
  return (
    <span className="field__plain">
      {value.value}
      {unit ? <span className="field__unit"> {unit}</span> : null}
    </span>
  );
}

export function FieldList({ fields }: { fields: FieldSpec[] }) {
  return (
    <dl className="field-list">
      {fields.map((f) => (
        <div className="field" key={f.label}>
          <dt className="field__label">{f.label}</dt>
          <dd className="field__value">
            {renderValue(f.value, f.unit)}
            {f.note ? <span className="field__note">{f.note}</span> : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}
