import type { ImageValue } from "emdash";

export interface ProductData {
  id: string;
  name: string;
  price: string | number;
  currency?: string;
  image?: ImageValue | null;
  active: boolean | number;
  [key: string]: unknown;
}
