'use client';

import { SubsidiaryLabel } from '@/components/SubsidiaryPicker';
import { Badge } from '@/components/ui/Badge';
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/Feedback';
import { Card, PageHeader, ProseText, Section } from '@/components/ui/Layout';
import { CreateTemplatePanel } from '@/features/reports/components/CreateTemplatePanel';
import { useReportTemplates } from '@/features/reports/api';

/**
 * Report templates — PRD §5.5, admin only (gated by `app/(app)/admin/layout.tsx`).
 *
 * This screen exists because the capability had no UI at all: the backend
 * exposes `POST /report-templates`, but until now nothing in the frontend
 * called it, so templates could only ever be created by the seed script. Every
 * report is stamped from a template, which made that a hole in the product
 * rather than a missing convenience.
 *
 * Templates are WRITE-ONCE. The API has two routes, GET and POST — no PATCH, no
 * DELETE — and `version` is hardcoded to 1 on create because nothing updates
 * one. So this screen lists and creates, and deliberately offers no edit or
 * delete control: a disabled button for an operation the API does not implement
 * is worse than its absence.
 */
export default function AdminTemplatesPage() {
  const { data: templates, isPending, error, refetch } = useReportTemplates();

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Report templates"
        description="The skeletons new reports are drafted from. A template's section bodies keep their placeholder markers, which the drafting flow fills in."
      />

      <Section
        id="existing"
        title="Templates"
        description="Once created, a template cannot be edited or removed — the API has no route for either."
      >
        {isPending ? <LoadingBlock label="Loading templates" rows={2} /> : null}

        {error ? <ErrorState error={error} onRetry={() => void refetch()} /> : null}

        {templates && templates.length === 0 ? (
          <EmptyState
            title="No templates yet"
            description="Create the first one below. Every report is drafted from a template, so nothing can be drafted until one exists."
          />
        ) : null}

        {templates && templates.length > 0 ? (
          <ul className="flex flex-col gap-3">
            {templates.map((template) => (
              <li key={template.id}>
                <Card>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="font-medium break-words text-text-default">{template.name}</h3>
                      {/*
                        `description` is null when unset but '' when the client
                        sent an empty one — both mean "nothing to show", so test
                        for content rather than for null.
                      */}
                      {template.description ? (
                        <p className="mt-1 text-sm text-text-muted">{template.description}</p>
                      ) : null}
                    </div>
                    <Badge tone="info" srPrefix="Sections">
                      {template.sections.length}{' '}
                      {template.sections.length === 1 ? 'section' : 'sections'}
                    </Badge>
                  </div>

                  <div className="mt-3 text-sm">
                    <span className="text-text-muted">Available to: </span>
                    {/*
                      An EMPTY scope means EVERY subsidiary, not none. Rendering
                      it as "—" would invert the meaning of the field.
                    */}
                    {template.subsidiaryScope.length === 0 ? (
                      <span className="text-text-default">Every subsidiary</span>
                    ) : (
                      <span className="inline-flex flex-wrap gap-x-2">
                        {template.subsidiaryScope.map((id) => (
                          <SubsidiaryLabel key={id} id={id} />
                        ))}
                      </span>
                    )}
                  </div>

                  {template.sections.length > 0 ? (
                    <details className="mt-3">
                      <summary className="cursor-pointer text-sm text-sih-blue">
                        Show sections
                      </summary>
                      <ol className="mt-3 flex flex-col gap-3">
                        {template.sections.map((section, index) => (
                          <li key={`${template.id}-${index}`} className="border-l-2 border-border pl-3">
                            <p className="text-sm font-medium text-text-default">
                              {section.heading}
                            </p>
                            {/*
                              A template body is author-written rather than
                              document-derived, but it is still an untrusted
                              string from the server and still needs its
                              placeholder markers preserved verbatim — so it
                              goes through ProseText like every other one.
                            */}
                            {section.body ? <ProseText>{section.body}</ProseText> : null}
                          </li>
                        ))}
                      </ol>
                    </details>
                  ) : null}
                </Card>
              </li>
            ))}
          </ul>
        ) : null}
      </Section>

      <Section id="create" title="Create a template">
        <CreateTemplatePanel />
      </Section>
    </div>
  );
}
