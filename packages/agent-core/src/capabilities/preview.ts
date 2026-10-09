import { tool } from '@langchain/core/tools';
import { z } from 'zod';

/** 沙箱构建完成后，生成产品预览能力链接。 */
export function createPreviewPageTool() {
  return tool(
    async (_input: { message?: string }) => {
      return '✅ 页面预览已准备好。请在回复中包含以下链接让用户点击查看：[📺 打开页面预览](preview://open)';
    },
    {
      name: 'preview_page',
      description: 'Web 项目构建完成后调用此工具，为用户生成一个可点击的页面预览按钮。调用后在回复文本中包含返回的预览链接。',
      schema: z.object({ message: z.string().optional().describe('可选的预览说明文字，如页面标题') }),
    },
  );
}
