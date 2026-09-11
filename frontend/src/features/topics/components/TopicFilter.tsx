'use client';

import { useMemo } from 'react';
import { CloseIcon } from '@/components/ui/Icon';
import { Field, Select } from '@/components/ui/Field';
import { categoryLabel, useTopicCatalog, useTopicVocabulary } from '@/features/topics/api';

/**
 * The topic filter — §8.
 *
 * ─── WHY A TOKEN FIELD AND NOT A MULTI-SELECT LISTBOX ───────────────────────
 * A true multi-select combobox is a different ARIA pattern from the
 * select-only one `Select` implements, and building a second one would be a
 * second keyboard model to get right and keep right. A picker that ADDS,
 * plus removable chips, is built entirely from controls that already work: the
 * picker is the existing listbox, each chip is an ordinary button, and the
 * whole thing is operable by keyboard without a line of new key handling.
 *
 * It also reads better on a dense government screen — the chosen topics are
 * visible as objects rather than as a collapsed "3 selected".
 *
 * ─── COUNTS COME FROM THE CATALOGUE, THE LIST FROM THE TAXONOMY ─────────────
 * Two sources on purpose. The vocabulary is a constant compiled into the
 * server, so the dropdown fills instantly and offers every topic — including
 * ones no document carries yet, which a user is entitled to try. The catalogue
 * is an aggregation, and it supplies the counts that tell them which are worth
 * trying. If it has not arrived, the picker still works; it just has no counts.
 *
 * Discovered topics are deliberately EXCLUDED from the option list. They are
 * phrases the extractor found rather than vetted vocabulary, and offering
 * `Sand Stowing` beside `Mine Safety` presents the two as equally considered.
 * They remain reachable by clicking one on a document, which is the context
 * where their provenance is visible.
 */
export function TopicFilter({
  value,
  match,
  onChange,
  onMatchChange,
  subsidiaryId,
}: {
  value: string[];
  match: 'any' | 'all';
  onChange: (next: string[]) => void;
  onMatchChange: (next: 'any' | 'all') => void;
  /** Scopes the counts to the same subsidiary the list is filtered to. */
  subsidiaryId?: string;
}) {
  const vocabulary = useTopicVocabulary();
  const catalog = useTopicCatalog({ subsidiaryId, limit: 100, includeDiscovered: false });

  const countByTopic = useMemo(() => {
    const counts = new Map<string, number>();
    for (const topic of catalog.data?.topics ?? []) counts.set(topic.topicId, topic.documentCount);
    return counts;
  }, [catalog.data]);

  /**
   * Grouped by category, and a category with nothing left in it disappears
   * rather than rendering an empty `<optgroup>` — which some browsers show as a
   * bare heading with no children under it.
   */
  const groups = useMemo(() => {
    const byCategory = new Map<string, { topicId: string; label: string }[]>();
    for (const topic of vocabulary.data ?? []) {
      if (value.includes(topic.topicId)) continue; // already chosen
      const list = byCategory.get(topic.category) ?? [];
      list.push({ topicId: topic.topicId, label: topic.label });
      byCategory.set(topic.category, list);
    }
    return [...byCategory.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  }, [vocabulary.data, value]);

  const labelFor = useMemo(() => {
    const labels = new Map<string, string>();
    for (const topic of vocabulary.data ?? []) labels.set(topic.topicId, topic.label);
    for (const topic of catalog.data?.topics ?? []) labels.set(topic.topicId, topic.label);
    return labels;
  }, [vocabulary.data, catalog.data]);

  return (
    <div className="flex w-full basis-full flex-wrap items-end gap-2">
      <div className="min-w-52 flex-1">
        <Field
          label="Topic"
          description="What documents are about, from their extracted subjects"
        >
          {(fieldProps) => (
            <Select
              {...fieldProps}
              // Always empty: this control ADDS, and resetting it after each
              // choice is what makes a second selection possible without an
              // extra interaction to clear it first.
              value=""
              onChange={(topicId) => {
                // The server accepts at most eight; stopping here means a user
                // is told by the control rather than by a 400.
                if (topicId && !value.includes(topicId) && value.length < 8) {
                  onChange([...value, topicId]);
                }
              }}
            >
              <option value="">{value.length === 0 ? 'Any topic' : 'Add another topic…'}</option>
              {groups.map(([category, topics]) => (
                <optgroup key={category} label={categoryLabel(category)}>
                  {topics.map((topic) => {
                    const count = countByTopic.get(topic.topicId);
                    return (
                      <option key={topic.topicId} value={topic.topicId}>
                        {count === undefined ? topic.label : `${topic.label} (${count})`}
                      </option>
                    );
                  })}
                </optgroup>
              ))}
            </Select>
          )}
        </Field>
      </div>

      {/*
        Only offered once the choice exists. With one topic selected the
        distinction is meaningless, and a control that cannot change anything is
        a control a reader has to work out is irrelevant.
      */}
      {value.length > 1 ? (
        <div className="min-w-40">
          <Field label="Match">
            {(fieldProps) => (
              <Select
                {...fieldProps}
                value={match}
                onChange={(next) => onMatchChange(next as 'any' | 'all')}
              >
                <option value="any">Any of these topics</option>
                <option value="all">All of these topics</option>
              </Select>
            )}
          </Field>
        </div>
      ) : null}

      {value.length > 0 ? (
        // A list, so a screen reader announces how many filters are applied
        // before reading them — the chips are otherwise an undifferentiated run.
        <ul aria-label="Selected topics" className="flex basis-full flex-wrap gap-1.5">
          {value.map((topicId) => (
            <li key={topicId}>
              <button
                type="button"
                onClick={() => onChange(value.filter((id) => id !== topicId))}
                className="inline-flex items-center gap-1.5 rounded-sm border border-primary-dark bg-primary-dark px-2 py-0.5 text-sm font-medium text-white transition-colors hover:bg-primary-deep"
              >
                <span>{labelFor.get(topicId) ?? topicId}</span>
                <CloseIcon size={12} aria-hidden="true" />
                <span className="sr-only">Remove topic filter</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
