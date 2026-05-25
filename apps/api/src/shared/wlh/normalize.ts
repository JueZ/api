export function normalizeText(v: string): string { return v.toLowerCase().replace(/\s+/g,' ').trim(); }
export function htmlToText(v: string): string { return v.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim(); }
