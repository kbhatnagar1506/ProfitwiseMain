/** @type {import('next').NextConfig} */
const nextConfig = {
  webpack: (config, { isServer }) => {
    // Mark bull and redis as external to prevent bundling
    if (isServer) {
      config.externals = config.externals || []
      config.externals.push('bull', 'redis')
    }
    return config
  },
}

module.exports = nextConfig
