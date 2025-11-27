import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Turbopack config (Next.js 16 default)
  turbopack: {
    // Turbopack doesn't need special WASM config
  },

  // Legacy webpack config (used when --webpack flag is passed)
  webpack: (config, { isServer }) => {
    // Add WASM loader
    config.experiments = {
      ...config.experiments,
      asyncWebAssembly: true,
    };

    // Exclude onnxruntime from server bundle (client-side only)
    if (isServer) {
      config.externals = config.externals || [];
      if (Array.isArray(config.externals)) {
        config.externals.push('onnxruntime-web');
      }
    }

    return config;
  },

  // Required headers for SharedArrayBuffer (needed for ONNX threading)
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'Cross-Origin-Opener-Policy',
            value: 'same-origin',
          },
          {
            key: 'Cross-Origin-Embedder-Policy',
            value: 'require-corp',
          },
        ],
      },
    ];
  },

  // Transpile epub.js for proper ESM support
  transpilePackages: ['epubjs'],

  // Server external packages (not bundled)
  serverExternalPackages: ['onnxruntime-web', 'parakeet.js'],
};

export default nextConfig;
