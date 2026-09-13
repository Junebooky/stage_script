/** Shared by canonical import and the read-only audience, without loading a script. */
export function isLocalImageSource(src: string): boolean {
  // Root-relative raster paths only: no URL schemes, encodings, redirects,
  // query-string proxies, traversal or SVG subresources.
  return src.length <= 2048 && /^\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+\.(?:avif|gif|jpe?g|png|webp)$/i.test(src)
    && !src.split("/").some((part) => part === "." || part === "..");
}
