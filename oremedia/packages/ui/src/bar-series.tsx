import * as React from 'react';
import { cn } from './cn';
import { VisuallyHidden } from './visually-hidden';

export interface BarSeriesPoint {
  label: string;
  /** null = unavailable: drawn as a gap and listed as "unavailable", never as zero (spec 15.1). */
  value: number | null;
}

export interface BarSeriesProps {
  /** Accessible name of the chart; also the caption of the table alternative. */
  title: string;
  points: readonly BarSeriesPoint[];
  /** How a value reads in the table and the summary (default: locale number). */
  format?: (value: number) => string;
  className?: string;
}

const WIDTH = 240;
const HEIGHT = 56;
const BASELINE = HEIGHT - 12;
const GAP = 6;

/**
 * A native inline bar chart with one axis (the baseline) and text from the theme tokens; no chart library. Every
 * number is also in the table below it (the accessible alternative), so the drawing is decoration for sighted
 * readers and the table is the record (spec 21.3: nothing is carried by colour or shape alone).
 */
export function BarSeries({ title, points, format, className }: BarSeriesProps) {
  const fmt = format ?? ((v: number) => new Intl.NumberFormat().format(v));
  const values = points.map((p) => p.value).filter((v): v is number => v !== null);
  const max = Math.max(0, ...values);
  const slot = points.length ? (WIDTH - GAP * (points.length + 1)) / points.length : WIDTH;
  const tableId = React.useId();
  return (
    <figure className={cn('flex flex-col gap-1', className)}>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-labelledby={tableId}
        className="h-14 w-full max-w-xs text-foreground"
      >
        <line
          x1={0}
          x2={WIDTH}
          y1={BASELINE}
          y2={BASELINE}
          stroke="currentColor"
          strokeWidth={1}
          className="text-border"
        />
        {points.map((p, i) => {
          const x = GAP + i * (slot + GAP);
          const h = p.value === null || max === 0 ? 0 : Math.max(2, ((BASELINE - 8) * p.value) / max);
          return (
            <g key={p.label}>
              {p.value === null ? (
                <text
                  x={x + slot / 2}
                  y={BASELINE - 4}
                  textAnchor="middle"
                  fontSize={9}
                  fill="currentColor"
                  className="text-muted-foreground"
                >
                  n/a
                </text>
              ) : (
                <rect
                  x={x}
                  y={BASELINE - h}
                  width={slot}
                  height={h}
                  fill="currentColor"
                  className="text-accent"
                />
              )}
              <text
                x={x + slot / 2}
                y={HEIGHT - 2}
                textAnchor="middle"
                fontSize={9}
                fill="currentColor"
                className="text-muted-foreground"
              >
                {p.label}
              </text>
            </g>
          );
        })}
      </svg>
      <figcaption>
        <VisuallyHidden>
          <span id={tableId}>{title}</span>
        </VisuallyHidden>
        <table className="w-full max-w-xs text-xs">
          <caption className="sr-only">{title}</caption>
          <thead>
            <tr className="text-left text-muted-foreground">
              <th scope="col" className="pr-2 font-medium">
                Point
              </th>
              <th scope="col" className="font-medium">
                Value
              </th>
            </tr>
          </thead>
          <tbody>
            {points.map((p) => (
              <tr key={p.label}>
                <th scope="row" className="pr-2 text-left font-normal">
                  {p.label}
                </th>
                <td>{p.value === null ? 'unavailable' : fmt(p.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </figcaption>
    </figure>
  );
}
