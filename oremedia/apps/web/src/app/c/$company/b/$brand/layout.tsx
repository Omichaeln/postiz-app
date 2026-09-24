import { Link, NavLink, Outlet, useParams } from 'react-router';
import { Button, Skeleton, cn } from '@oremedia/ui';
import { RequestError } from '../../../../../components/request-state';
import { useCompanies } from '../../../../../features/portfolio/use-companies';
import { useBrand } from '../../../../../features/brand/use-brand';
import { brandPath, type BrandContext } from '../../../../../features/brand/brand-context';
import { useTheme } from '../../../../../lib/theme';
import { clearBearerToken, getBearerToken } from '../../../../../lib/session';

const NAV: Array<[string, string]> = [
  ['home', 'Home'],
  ['system', 'Brand system'],
  ['assets', 'Assets'],
  ['campaigns', 'Campaigns'],
  ['review', 'Review'],
  ['calendar', 'Calendar'],
  ['intelligence', 'Intelligence'],
  ['experiments', 'Experiments'],
  ['agents', 'Agents'],
  ['settings', 'Settings'],
];

/** Spec 11.1: company and brand are always visible in the header; every brand screen renders inside this shell. */
export function BrandLayout() {
  const { company = '', brand: brandId = '' } = useParams();
  const companies = useCompanies();
  const brand = useBrand(brandId);
  const { theme, toggle } = useTheme();
  const companyName = companies.data?.find((c) => c.tenantId === company)?.name ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-border px-4 py-2">
        <div className="flex min-w-0 items-center gap-2 text-sm">
          <Link to="/portfolio" className="font-semibold">
            Oremedia
          </Link>
          <span aria-hidden="true" className="text-muted-foreground">
            /
          </span>
          <Link to={`/c/${encodeURIComponent(company)}`} className="truncate" aria-label="Company">
            {companyName ?? company}
          </Link>
          <span aria-hidden="true" className="text-muted-foreground">
            /
          </span>
          <span className="truncate font-medium" aria-label="Brand">
            {brand.data?.name ?? (brand.isPending ? 'Loading…' : brandId)}
          </span>
        </div>
        <nav
          aria-label="Brand sections"
          className="order-3 -mb-2 flex w-full gap-1 overflow-x-auto md:order-none md:w-auto"
        >
          {NAV.map(([segment, label]) => (
            <NavLink
              key={segment}
              to={brandPath(company, brandId, segment)}
              className={({ isActive }) =>
                cn(
                  'whitespace-nowrap rounded-md px-2 py-1 text-sm',
                  isActive
                    ? 'bg-secondary font-medium text-secondary-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )
              }
            >
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" onClick={toggle} aria-pressed={theme === 'dark'}>
            {theme === 'dark' ? 'Light theme' : 'Dark theme'}
          </Button>
          {getBearerToken() && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                clearBearerToken();
                window.location.assign('/sign-in');
              }}
            >
              Sign out
            </Button>
          )}
        </div>
      </header>
      {brand.isPending && (
        <main id="main" className="p-6">
          <Skeleton label="Loading brand" />
        </main>
      )}
      {brand.isError && (
        <main id="main" className="p-6">
          <RequestError error={brand.error} onRetry={() => void brand.refetch()} title="Restricted access" />
        </main>
      )}
      {brand.isSuccess && (
        <Outlet
          context={{ companyId: company, companyName, brandId, brand: brand.data } satisfies BrandContext}
        />
      )}
    </div>
  );
}
