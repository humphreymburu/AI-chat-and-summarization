// eslint-disable-next-line @typescript-eslint/no-var-requires
const { i18n } = require("./next-i18next.config");

const isProd = process.env.NODE_ENV === "production";
// Vercel serves its own build assets, so only use the CDN prefix elsewhere.
// ASSET_PREFIX overrides both ("" disables the prefix).
const assetPrefix =
  process.env.ASSET_PREFIX ??
  (isProd && !process.env.VERCEL ? "https://cdn.unenvironment.org" : "");

module.exports = {
  reactStrictMode: true,
  i18n,
  assetPrefix,
  transpilePackages: [
    "rehype-raw",
    "hast-util-raw",
    "vfile",
    "vfile-message",
    "unist-util-stringify-position",
  ],
  images: {
    domains: [
      "cdn.unenvironment.org",
      "default",
      "staging.unenvironment.xyz",
      "assets.unenvironment.org",
    ],
  },
};
