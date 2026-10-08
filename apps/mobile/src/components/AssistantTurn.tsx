import React from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import type { ChatItem } from '../chat/state';
import ActivityPanel from './ActivityPanel';
import { AssistantMessage } from './MessageBubble';
import ReasoningBlock from './ReasoningBlock';
import {
  ApprovalCard,
  QuestionCard,
  type ApprovalRequest,
  type QuestionRequest,
} from './InterruptCards';
import { colors, spacing } from '../theme';

function AssistantTurn({
  item,
  sessionId,
  onApproval,
  onQuestion,
}: {
  item: ChatItem;
  sessionId: string;
  onApproval: (
    request: ApprovalRequest,
    approve: boolean,
    scope: 'once' | 'session',
  ) => Promise<void>;
  onQuestion: (
    request: QuestionRequest,
    selections: { index: number; label: string }[],
    customText?: string,
  ) => Promise<void>;
}) {
  const run = item.run;
  const streaming = !!run && !run.finished;
  const waiting = !!(run?.approval || run?.question);
  const reasoning = run?.reasoning ?? item.reasoning;
  return (
    <View>
      {reasoning ? (
        <ReasoningBlock
          text={reasoning}
          streaming={streaming && !waiting && !item.text}
        />
      ) : null}
      {run ? (
        <ActivityPanel items={run.activities} finished={run.finished} />
      ) : null}
      {run?.approval ? (
        <ApprovalCard
          key={run.approval.interruptId}
          request={run.approval}
          onRespond={(approve, scope) =>
            onApproval(run.approval!, approve, scope)
          }
        />
      ) : null}
      {run?.question ? (
        <QuestionCard
          key={run.question.interruptId}
          request={run.question}
          onRespond={(selections, customText) =>
            onQuestion(run.question!, selections, customText)
          }
        />
      ) : null}
      {run?.finished && run.outcome && run.outcome !== 'completed' ? (
        <Text
          style={{
            color: run.outcome === 'failed' ? colors.danger : colors.warning,
            padding: spacing.md,
          }}
        >
          {run.outcome === 'failed' ? '本次任务未完成' : '任务已停止'}
        </Text>
      ) : null}
      {item.text ? (
        <AssistantMessage
          sessionId={sessionId}
          text={item.text}
          streaming={streaming && !waiting}
        />
      ) : streaming && !waiting ? (
        <View
          style={{ padding: spacing.md, flexDirection: 'row', gap: spacing.sm }}
        >
          <ActivityIndicator color={colors.accent} />
          <Text style={{ color: colors.textSecondary }}>正在执行…</Text>
        </View>
      ) : null}
    </View>
  );
}

export default React.memo(AssistantTurn);
