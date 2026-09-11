import type { Metadata } from 'next';
import './globals.css';
import '@cognicatch/react/style.css';

export const metadata: Metadata = {
  title: 'Resilient AI Reliability Lab',
  description: '可恢复流式传输、重试、熔断、降级与生成式 UI 隔离演示。',
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
