import * as React from 'react';

/** Screen-reader-only text (the Tailwind `sr-only` recipe, kept as a component so intent is explicit). */
export function VisuallyHidden({
  children,
  as: Tag = 'span',
}: {
  children: React.ReactNode;
  as?: 'span' | 'div';
}) {
  return <Tag className="sr-only">{children}</Tag>;
}
