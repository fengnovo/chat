import type { Metadata } from 'next';
import './globals.css';
import '@cognicatch/react/style.css';

export const metadata: Metadata = {
  title: 'Node Coding Agent Platform',
  description: '多租户、可恢复、支持人工审批的 Headless Coding Agent 平台。',
};

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html
      lang='zh-CN'
      className='h-full antialiased'
    >
      <body>{children}</body>
    </html>
  );
}
