/**
 * Static export: the target is Apache + PHP with no Node process, so there is no SSR,
 * no ISR, no route handlers and no image optimisation. Pages are built from content/
 * on disk and served as files; only search and voting talk to the PHP API at runtime.
 */
/** @type {import('next').NextConfig} */
export default {
  output: "export",
  trailingSlash: true,
  distDir: ".next",
  images: { unoptimized: true },
};
