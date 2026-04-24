/**
 * Resolves a relative asset path to an absolute URL.
 *
 * In production with a CDN, import.meta.env.BASE_URL is the full CDN URL
 * (e.g. 'https://cdn.vmsandbox.net/{hash}/'), so all assets resolve there.
 * In dev mode or without a CDN, BASE_URL is '/' or './', resolving to the
 * current origin.
 */
export function assetUrl(path: string): string {
    return new URL(path, new URL(import.meta.env.BASE_URL, window.location.href)).href
}
