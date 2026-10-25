import { test } from 'node:test'
import assert from 'node:assert/strict'

import { CORRECTION_RE, extractCorrections, formatCorrections } from '../lib/rules.js'

function transcript(events) {
  return events.map((e) => JSON.stringify(e)).join('\n')
}

const assistant = (text) => ({
  type: 'assistant/message',
  data: { message: { content: [{ type: 'text', text }] } },
})
const user = (text, kind = 'user') => ({
  type: 'user/message',
  data: { content: [{ type: 'text', text }], source: { kind } },
})

test('CORRECTION_RE：认得出真实纠正', () => {
  for (const line of [
    '刷新按钮的位置完全不对',
    '你这样放按钮，新建工作区的按钮不就消失了吗',
    '括号还是反的',
    '这里格式乱了',
    '以后都先备份再动手',
  ]) {
    assert.ok(CORRECTION_RE.test(line), `应判定为纠正：${line}`)
  }
})

test('CORRECTION_RE：普通指令不该误判', () => {
  for (const line of ['帮我整理数模文件夹', '把记忆系统找给我', '做1和2吧', '攒数据吧']) {
    assert.ok(!CORRECTION_RE.test(line), `不该判定为纠正：${line}`)
  }
})

test('extractCorrections：带上「当时我在做什么」', () => {
  const text = transcript([
    assistant('按钮加好了，位置在红框那里'),
    user('位置完全不对，应该在加号边上'),
  ])
  const found = extractCorrections(text)
  assert.equal(found.length, 1)
  assert.match(found[0].correction, /位置完全不对/)
  assert.match(found[0].wasDoing, /按钮加好了/, '应记录上一轮助手在做什么')
})

test('extractCorrections：没有前文产出的纠正不计入', () => {
  const text = transcript([user('位置完全不对')])
  assert.equal(extractCorrections(text).length, 0, '必须有一轮助手产出才可能是「纠正」')
})

test('extractCorrections：系统注入与长篇粘贴被排除', () => {
  const long = '不对'.repeat(200)
  const text = transcript([
    assistant('做完了'),
    user('You are the WORKER role of a dual-agent runtime. 失败 不对'),
    user(long),
    user('这个位置不对', 'time-context'),
  ])
  assert.equal(extractCorrections(text).length, 0)
})

test('formatCorrections：无信号时给出人话', () => {
  const out = formatCorrections({ scanned: 5, total: 0, sessions: [] })
  assert.match(out, /没有发现明确的纠正信号/)
})

test('formatCorrections：列出候选并声明不写入', () => {
  const scan = {
    scanned: 2,
    total: 1,
    sessions: [
      {
        sessionId: 'session-abcdef123456',
        mtime: '2026-10-25T00:00:00.000Z',
        corrections: [{ correction: '位置完全不对', wasDoing: '按钮加好了' }],
      },
    ],
  }
  const out = formatCorrections(scan)
  assert.match(out, /位置完全不对/)
  assert.match(out, /当时我在做：按钮加好了/)
  assert.match(out, /只收集不写入/)
})
