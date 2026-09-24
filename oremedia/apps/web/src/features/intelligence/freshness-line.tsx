import { Badge } from '@oremedia/ui';
import { coverageText, freshnessText, type CoverageDto, type FreshnessDto } from './intelligence-helpers';

export interface FreshnessLineProps {
  freshness: FreshnessDto;
  /** The view's coverage statement (spec 16.1) when it has one. */
  coverage?: CoverageDto;
  statement?: string;
  className?: string;
}

/**
 * Spec 15.2: freshness is displayed next to every number and stale data is visibly marked (with text). Spec 16.1:
 * the coverage statement is shown wherever listening outputs are displayed.
 */
export function FreshnessLine({ freshness, coverage, statement, className }: FreshnessLineProps) {
  return (
    <div
      className={`mb-2 flex flex-col gap-1 text-xs text-muted-foreground ${className ?? ''}`}
      data-testid="freshness"
    >
      <p className="flex flex-wrap items-center gap-2">
        <span>{freshnessText(freshness)}</span>
        {freshness.stale && freshness.asOf !== null && (
          <Badge tone="warning" data-testid="stale">
            Stale
          </Badge>
        )}
      </p>
      {coverage && <p data-testid="coverage">{coverageText(coverage)}</p>}
      {statement && <p>{statement}</p>}
    </div>
  );
}
