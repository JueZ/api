export type WillhabenCondition = 'new'|'like_new'|'used'|'broken'|'exhibition';
export type WillhabenFulfillment = 'pickup'|'shipping'|'paylivery';
export type WillhabenSort = 'relevance'|'newest'|'price_asc'|'price_desc';
export interface WillhabenSearchRequest { categorySlug:string; keywords:string[]; price?:{min?:number;max?:number;currency?:string}; condition?:WillhabenCondition[]; fulfillment?:WillhabenFulfillment[]; sort?:WillhabenSort; pagination?:{page?:number;limit?:number}; rawSearchUrl?:string; location?:Record<string,unknown>; naturalLanguageQuery?:unknown; [k:string]:unknown }
