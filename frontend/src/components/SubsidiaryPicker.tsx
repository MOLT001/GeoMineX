'use client';

import { useSubsidiaries, useSubsidiaryMap } from '@/features/subsidiaries/api';
import { Field, Select } from './ui/Field';

/**
 * Choosing a subsidiary, and rendering one by id.
 *
 * Shared because the same three edge cases turn up on every screen that
 * touches subsidiary scope, and each is a trap:
 *
 *   1. ZERO GRANTS IS A SUCCESS, NOT AN ERROR. A `cil_user` or `moc_official`
 *      with no grants gets HTTP 200 and an empty array — never a failure. A
 *      screen that waits for an error state waits forever, and a picker that
 *      renders an empty dropdown looks broken rather than explaining itself.
 *      Only `admin` is unscoped; `moc_official` is NOT global.
 *
 *   2. A MISSING ID MUST RENDER AS A DASH, NEVER AS A NAME OR AN EXPLANATION.
 *      `byId.get(id)` misses for three different reasons — still loading, out
 *      of the caller's scope, or soft-deleted (documents and analytics keep
 *      referencing a soft-deleted subsidiary's id long after it leaves this
 *      list). The last two must stay indistinguishable: a message like "you
 *      don't have access to BCCL" rebuilds exactly the existence oracle the
 *      API's 404-not-403 convention exists to hide.
 *
 *   3. NEVER REFETCH THIS ON A TIMER. Both routes sit under an IP-keyed
 *      limiter of 100 req/min shared across all API traffic, and behind the
 *      same-origin rewrite an entire office can present one source IP. The
 *      30-minute staleTime in the feature module is load-bearing.
 */

export function SubsidiaryPicker({
  value,
  onChange,
  label = 'Subsidiary',
  /** Adds an "All subsidiaries" option. Filters want it; a required field does not. */
  allowAll = false,
  required = false,
  error,
  disabled = false,
}: {
  value: string;
  onChange: (subsidiaryId: string) => void;
  label?: string;
  allowAll?: boolean;
  required?: boolean;
  error?: string | undefined;
  disabled?: boolean;
}) {
  const { data: subsidiaries, isPending, isError } = useSubsidiaries();

  const options = subsidiaries ?? [];
  const noGrants = !isPending && !isError && options.length === 0;

  return (
    <Field
      label={label}
      required={required}
      error={error}
      description={
        // A FAILED FETCH LOOKS EXACTLY LIKE ZERO GRANTS from the outside — both
        // leave `options` empty — so the failure has to be named here or not at
        // all. Every screen that gates on choosing a subsidiary inherits this
        // picker's silence, and an enabled, empty dropdown reads as "nothing to
        // pick" rather than "the list is broken".
        isError
          ? 'The list of subsidiaries could not be loaded. Reload the page to try again.'
          : noGrants
            ? 'You have not been granted access to any subsidiary yet. Ask an administrator to grant it.'
            : undefined
      }
    >
      {(fieldProps) => (
        <Select
          {...fieldProps}
          value={value}
          disabled={disabled || isPending || isError || noGrants}
          onChange={(subsidiaryId) => onChange(subsidiaryId)}
          // The 44px target floor (WCAG 2.5.5, restated by UX4G), asserted on
          // the control itself. The shared control skin sets PADDING rather
          // than a height, so the box is only ever as tall as its type plus
          // that padding — which leaves a short option row a few pixels under.
          // A minimum cannot be expressed as padding; it has to be a minimum.
          //
          // The 36px dense exception does not apply here: that is for a control
          // sitting inside a table row. This is a form field, and on several
          // screens it is the field that gates everything below it.
          className="min-h-11"
        >
          {isPending ? <option value="">Loading…</option> : null}
          {isError ? <option value="">Unavailable</option> : null}

          {/*
            An explicit placeholder rather than a blank first option, so a
            required picker reads as unset instead of as already answered.
          */}
          {!isPending && !isError && allowAll ? <option value="">All subsidiaries</option> : null}
          {!isPending && !isError && !allowAll && !noGrants ? (
            <option value="">Select a subsidiary…</option>
          ) : null}
          {noGrants ? <option value="">No subsidiaries available</option> : null}

          {options.map((subsidiary) => (
            <option key={subsidiary.id} value={subsidiary.id}>
              {subsidiary.code} — {subsidiary.name}
            </option>
          ))}
        </Select>
      )}
    </Field>
  );
}

/**
 * Render a subsidiary id as its code.
 *
 * A dash on any miss — see note 2 above. The `title` carries the full name for
 * a mouse user; the accessible name carries it too, because a bare code is
 * meaningless read aloud.
 */
export function SubsidiaryLabel({ id, showName = false }: { id: string | null; showName?: boolean }) {
  const { byId, isPending } = useSubsidiaryMap();

  /*
    A bare "—" announces as nothing at all, so the cell reads as blank rather
    than as empty-on-purpose; the hidden label is what every other dash cell in
    the app carries. The wording stays deliberately non-committal — see note 2:
    "no access" would separate out-of-scope from soft-deleted, which is the one
    distinction this component exists to keep hidden.
  */
  const dash = (
    <>
      <span aria-hidden>—</span>
      <span className="sr-only">No subsidiary</span>
    </>
  );

  if (!id) return <span className="text-text-muted">{dash}</span>;

  const subsidiary = byId.get(id);

  if (!subsidiary) {
    return (
      <span className="text-text-muted" title={isPending ? 'Loading' : undefined}>
        {dash}
      </span>
    );
  }

  return (
    <span title={subsidiary.name}>
      {subsidiary.code}
      {showName ? <span className="text-text-muted"> — {subsidiary.name}</span> : null}
      {/* The code alone is an initialism; a screen reader should get the name. */}
      {!showName ? <span className="sr-only"> ({subsidiary.name})</span> : null}
    </span>
  );
}
