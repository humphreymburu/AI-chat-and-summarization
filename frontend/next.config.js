module.exports = {
  reactStrictMode: true,
  // Optional CDN for build assets, e.g. https://cdn.example.org. Empty by default.
  assetPrefix: process.env.ASSET_PREFIX ?? "",
  // The search page is the app's start page.
  async redirects() {
    return [{ source: "/", destination: "/search", permanent: false }];
  },
};
