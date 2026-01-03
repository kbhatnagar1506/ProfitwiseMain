/** @type {import('next').NextConfig} */
const nextConfig = {
  turbopack: {
    resolveAlias: {
      // Prevent Turbopack from trying to bundle Bull
      bull: false,
      redis: false,
    },
  },
}

module.exports = nextConfig
