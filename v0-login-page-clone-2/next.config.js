/** @type {import('next').NextConfig} */
const nextConfig = {
  // Disable Turbopack to use webpack instead
  // This allows us to properly exclude Node.js modules like Bull and Redis
  experimental: {
    turbopack: false,
  },
  webpack: (config, { isServer }) => {
    // Exclude Bull and Redis from bundling
    if (isServer) {
      config.externals = config.externals || []
      config.externals.push('bull', 'redis')
    }
    return config
  },
}

module.exports = nextConfig
