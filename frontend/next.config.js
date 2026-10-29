// eslint-disable-next-line @typescript-eslint/no-var-requires
const { i18n } = require("./next-i18next.config");

const isProd = process.env.NODE_ENV === "production";

module.exports = {
  reactStrictMode: true,
  i18n,
  assetPrefix: isProd ? "https://cdn.unenvironment.org" : "",
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
