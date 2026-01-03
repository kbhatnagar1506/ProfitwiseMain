/** @type {import('next').NextConfig} */
const nextConfig = {
  webpack: (config, { isServer }) => {
    // Exclude Bull from client-side bundling
    // Bull is only used on the server side for job processing
    if (!isServer) {
      config.externals = [...(config.externals || []), 'bull', 'redis']
    }

    return config
  },
}

module.exports = nextConfig
