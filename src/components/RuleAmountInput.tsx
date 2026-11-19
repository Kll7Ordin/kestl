import { useState } from 'react';

/**
 * Amount condition for a rule, with an explicit Debit/Credit toggle.
 * Stored convention: debits are positive, credits (money in) are negative. The user types a
 * plain positive amount; `value`/`onChange` carry the signed string that is saved on the rule.
 */
export function RuleAmountInput({
  value,
  onChange,
  width = '90px',
}: {
  value: string;
  onChange: (signed: string) => void;
  width?: string;
}) {
  const [credit, setCredit] = useState(value.trim().startsWith('-'));
  const magnitude = value.trim().replace(/^-/, '');

  const emit = (isCredit: boolean, mag: string) => onChange(isCredit && mag ? `-${mag}` : mag);

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
      <span style={{ display: 'inline-flex', gap: '0.15rem' }}>
        <button
          type="button"
          className={`btn btn-sm ${!credit ? 'btn-primary' : 'btn-ghost'}`}
          title="Money out (expense)"
          onClick={() => { setCredit(false); emit(false, magnitude); }}
        >Debit</button>
        <button
          type="button"
          className={`btn btn-sm ${credit ? 'btn-primary' : 'btn-ghost'}`}
          title="Money in (income, refund, transfer in)"
          onClick={() => { setCredit(true); emit(true, magnitude); }}
        >Credit</button>
      </span>
      <input
        type="number"
        step="0.01"
        min="0"
        value={magnitude}
        onChange={(e) => emit(credit, e.target.value.replace(/^-/, ''))}
        placeholder="0.00"
        style={{ width }}
      />
    </span>
  );
}
