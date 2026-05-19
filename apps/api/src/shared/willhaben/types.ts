export type WillhabenCondition = 'new' | 'like_new' | 'used' | 'broken' | 'exhibition';
export type WillhabenFulfillment = 'pickup' | 'shipping' | 'paylivery';
export type WillhabenSort = 'relevance' | 'newest' | 'price_asc' | 'price_desc';

export type WillhabenAttributeReference = {
  required: boolean;
  treeAttributeId: number;
  code: string;
  selectionType: 'SINGLE_SELECT' | 'MULTI_SELECT';
};

export type WillhabenCategoryNode = {
  treeId: number;
  code: string;
  label: string;
  children: WillhabenCategoryNode[];
  attributeReferences: WillhabenAttributeReference[];
  systemTags: string[];
};

export interface WillhabenSearchRequest {
  categoryPath?: string[];
  categorySlug?: string;
  keywords: string[];
  price?: { min?: number; max?: number; currency?: string };
  condition?: WillhabenCondition[];
  fulfillment?: WillhabenFulfillment[];
  sort?: WillhabenSort;
  pagination?: { page?: number; limit?: number };
  rawSearchUrl?: string;
  naturalLanguageQuery?: unknown;
  [k: string]: unknown;
}
