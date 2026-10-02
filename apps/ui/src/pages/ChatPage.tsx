import { useState } from 'react';
import { Chip, PageHeader, Section } from '../components/Chips';
import {
  CURRENT_EVIDENCE,
  EVIDENCE_SUMMARY,
  OPERATION_STATE_LABEL,
  SEND_DISABLED_LABEL,
  SEND_GATE_CLOSED_NOTICE,
  SEND_GATE_UNLOCK_CONDITION
} from '../data/snapshot';
import type { AppState } from '../app/useAppState';

interface Bubble {
  id: string;
  role: 'user' | 'assistant';
  text: string;
}

const PLACEHOLDER_TURNS: Bubble[] = [
  { id: 'u1', role: 'user', text: '帮我确认一下「模型与套餐」页里计费类别和上下文长度这两列的取值域。' },
  {
    id: 'a1',
    role: 'assistant',
    text: '（版式占位）这里显示助手气泡的排版：正文换行、列表缩进与代码片段样式。真正的回复需要运行时接入后才能产生，本轮没有任何模型请求被发出。'
  },
  { id: 'u2', role: 'user', text: '那先别发，窗口在 09:00 之后会不会直接扣订阅桶？' },
  {
    id: 'a2',
    role: 'assistant',
    text: '（版式占位）窗口模式为 advisory 时，窗口外只提示可能扣套餐，不自动改模型、不换通道、不续票。是否扣桶仍需 E3 证据才能断言。'
  }
];

export function ChatPage({ state }: { state: AppState }) {
  const [draft, setDraft] = useState('');

  // 仅剩的非发送操作：清空草稿只动本地内存状态，不产生任何请求。
  const handleClearDraft = () => {
    setDraft('');
    state.log('INFO', 'ui.chat.draft', '草稿已清空：仅本地内存操作，未发起任何请求（dispatch = 0）。');
  };

  return (
    <div className="page">
      <PageHeader
        title="会话"
        subtitle={`对话版式占位。发送门因 ${CURRENT_EVIDENCE} 关闭，本页不存在任何可点击的发送入口；草稿只留在本机内存中。`}
        badges={
          <>
            <Chip tone="pending">模型未选择（目录未接入）</Chip>
            <Chip tone="warn">证据等级 {CURRENT_EVIDENCE} · 零 dispatch</Chip>
            <Chip tone="danger">发送门：关闭</Chip>
          </>
        }
      />

      <Section
        title="对话"
        description="两轮中文占位对话，用于确认气泡、引文、换行与长文案在 1280×800 / 1920×1080 下不溢出错位。"
        actions={<Chip tone="danger">发送门：关闭（{CURRENT_EVIDENCE}）· dispatch = 0</Chip>}
      >
        <div className="thread">
          {PLACEHOLDER_TURNS.map((b) => (
            <div key={b.id} className={`turn turn--${b.role}`}>
              <div className="turn__role">{b.role === 'user' ? '我' : '助手'}</div>
              <div className="bubble">{b.text}</div>
            </div>
          ))}

          <div className="turn turn--assistant">
            <div className="turn__role">助手</div>
            <div className="bubble bubble--muted">
              （结果未知占位）本轮任何一轮都停在
              <Chip tone="unknown">{OPERATION_STATE_LABEL['outcome_unknown']}</Chip>
              之前：没有 accepted、没有终态回执，因此不展示任何助手实际输出。
            </div>
          </div>
        </div>

        {/* 与「模型与套餐」页引用同一份发送门口径（snapshot.ts 单一来源）。 */}
        <div className="notice notice--danger" role="status">
          <span className="notice__tag">{CURRENT_EVIDENCE}</span>
          <span className="notice__text">{SEND_GATE_CLOSED_NOTICE}</span>
        </div>

        <div className="composer">
          <label className="composer__label" htmlFor="composer-input">
            输入（仅本地草稿，回车不发送）
          </label>
          <textarea
            id="composer-input"
            className="composer__input"
            rows={3}
            value={draft}
            placeholder="输入内容不会离开本机：本轮没有 fetch/XHR/WebSocket，草稿仅存在于内存中。"
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="composer__actions">
            <button
              type="button"
              className="btn"
              disabled
              aria-describedby="composer-gate"
              title={`发送门因 ${CURRENT_EVIDENCE} 关闭：${EVIDENCE_SUMMARY[CURRENT_EVIDENCE]}`}
            >
              {SEND_DISABLED_LABEL}
            </button>
            <button type="button" className="btn" disabled title="精确取消未实现（I08）">
              取消
            </button>
            <button type="button" className="btn" onClick={handleClearDraft}>
              清空草稿
            </button>
            <span className="composer__hint">草稿字数：{draft.length}</span>
          </div>
          <p className="composer__gate" id="composer-gate">
            为什么不可发送：{EVIDENCE_SUMMARY[CURRENT_EVIDENCE]}。{SEND_GATE_UNLOCK_CONDITION}
          </p>
        </div>
      </Section>
    </div>
  );
}
