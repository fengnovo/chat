import type { Metadata } from 'next';
import type React from 'react';
import './globals.css';
import '@cognicatch/react/style.css';

export const metadata: Metadata = {
  title: 'Keen Agent',
  description: '多租户、可恢复、支持人工审批的 Headless Coding Agent 平台。',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang='zh-CN'
      className='h-full antialiased'
    >
      <body>{children}</body>
    </html>
  );
}
