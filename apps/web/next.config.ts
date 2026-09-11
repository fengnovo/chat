import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: 'http://127.0.0.1:8000/api/:path*',
        // 注意：如果 FastAPI 路由没有前缀，则为 http://127.0.0.1:8000/:path*。我们将 FastAPI 路由设为 `/api/chat`。
      },
    ];
  },
};

export default nextConfig;
