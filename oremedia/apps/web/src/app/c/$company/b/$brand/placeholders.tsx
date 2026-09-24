import { EmptyState } from '@oremedia/ui';
import { useBrandContext } from '../../../../../features/brand/brand-context';

/** Honest placeholders: each surface names the phase that delivers it (spec 22). No sample data. */
const PLACEHOLDERS: Array<{ segment: string; title: string; phase: string; detail: string }> = [
  {
    segment: 'campaigns',
    title: 'Campaign planner',
    phase: 'Phase 4',
    detail: 'Briefs, suggested plans and assigned work arrive with the bounded agents.',
  },
  {
    segment: 'review',
    title: 'Review inbox',
    phase: 'Phase 5',
    detail: 'Review requests, frozen manifests and approvals arrive with review and publication.',
  },
  {
    segment: 'calendar',
    title: 'Calendar and publishing',
    phase: 'Phase 5',
    detail: 'Scheduling and per-channel outcomes arrive with the publication workflow.',
  },
  {
    segment: 'intelligence',
    title: 'Intelligence',
    phase: 'Phase 6',
    detail: 'The five intelligence views arrive with measurement and the brand analyst.',
  },
  {
    segment: 'experiments',
    title: 'Experiments',
    phase: 'Phase 6',
    detail: 'Randomised link experiments arrive with measurement.',
  },
  {
    segment: 'agents',
    title: 'Agent activity',
    phase: 'Phase 4',
    detail: 'Runs, steps, costs and exceptions arrive with the agent runtime.',
  },
  {
    segment: 'settings',
    title: 'Settings',
    phase: 'Phase 5',
    detail:
      'Channels, mandates and skills arrive with publication; member management follows the same screen.',
  },
];

function Placeholder({ title, phase, detail }: { title: string; phase: string; detail: string }) {
  const { brand } = useBrandContext();
  return (
    <main id="main" className="mx-auto w-full max-w-3xl p-6">
      <h1 className="mb-4 text-xl font-semibold">{title}</h1>
      <EmptyState
        title={`${title} arrives in ${phase}`}
        description={
          <>
            {detail} Nothing is shown for {brand.name} until then; this page never displays sample data.
          </>
        }
      />
    </main>
  );
}

export const PLACEHOLDER_ROUTES = PLACEHOLDERS.map((p) => ({
  path: p.segment,
  element: <Placeholder title={p.title} phase={p.phase} detail={p.detail} />,
}));
