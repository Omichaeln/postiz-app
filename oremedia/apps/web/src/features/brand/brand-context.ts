import { useOutletContext } from 'react-router';
import type { BrandDto } from './use-brand';

/** What every brand screen needs: identity from the URL plus the loaded brand (spec 11.1 header). */
export interface BrandContext {
  companyId: string;
  companyName: string | null;
  brandId: string;
  brand: BrandDto;
}

export const useBrandContext = (): BrandContext => useOutletContext<BrandContext>();

export const brandPath = (companyId: string, brandId: string, rest = 'home'): string =>
  `/c/${encodeURIComponent(companyId)}/b/${encodeURIComponent(brandId)}/${rest}`;
