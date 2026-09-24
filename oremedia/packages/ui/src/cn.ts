import { clsx, type ClassValue } from 'clsx';

/** Class-name join used by every component; keeps conditional classes readable. */
export const cn = (...inputs: ClassValue[]): string => clsx(inputs);
