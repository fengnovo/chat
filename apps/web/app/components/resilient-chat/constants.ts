import type { PipelineEvent } from './types';

const starterPrompts = [
  {
    icon: 'panel' as const,
    label: '创建网页',
    description: '从空白目录开始搭建',
    prompt: '请在空白工作区中创建一个可运行的现代 Web 应用，并完成基础页面结构。',
  },
  {
    icon: 'braces' as const,
    label: '搭建 React',
    description: '使用 React 与 Vite',
    prompt: '请用 React 和 Vite 创建一个 Web 应用，完成依赖配置、页面代码并运行构建验证。',
  },
  {
    icon: 'triangle' as const,
    label: '诊断错误',
    description: '复现并定位根因',
    prompt: '请运行项目的检查和测试，定位当前错误的根因并提出修复方案。',
  },
  {
    icon: 'check' as const,
    label: '运行验证',
    description: '类型、测试与构建',
    prompt: '请检查现有改动，并运行适合这个项目的类型检查、测试和构建。',
  },
];

const initialTrace: PipelineEvent[] = [
  {
    id: 'boot-transport',
    stage: 'transport',
    status: 'success',
    title: '持久化事件流已就绪',
    detail: 'SSE 断流后将从数据库 cursor 续传',
    timestamp: '--:--:--',
  },
  {
    id: 'boot-circuit',
    stage: 'circuit',
    status: 'success',
    title: '共享熔断器已连接',
    detail: 'Redis 在 Worker 之间共享模型健康状态',
    timestamp: '--:--:--',
  },
  {
    id: 'boot-verify',
    stage: 'verify',
    status: 'success',
    title: '租户与工作区隔离已加载',
    detail: 'API 鉴权、队列和独立 workspace 正在保护运行',
    timestamp: '--:--:--',
  },
];

export { initialTrace, starterPrompts };
