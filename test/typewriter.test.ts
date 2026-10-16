// Typewriter (fake streaming) tests. Two servers: one with the env default off
// (upstream behaviour), one with TELEGRAM_PLUS_TYPEWRITER=1.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { DM, GROUP, startHarness } from './harness'

const SENTENCE = 'Em đã kiểm xong ba agent, cả ba đều đang chạy ổn định và không có lỗi mới trong log từ sáng tới giờ.'
const drafts = (sent: { method: string }[]) => sent.filter(c => c.method === 'sendMessageDraft' || c.method === 'sendRichMessageDraft')

describe('env unset (default off)', () => {
  let h: Awaited<ReturnType<typeof startHarness>>
  beforeAll(async () => { h = await startHarness() })
  afterAll(async () => { await h.stop() })

  test('reply sends exactly the upstream request, no drafts', async () => {
    const r = await h.call('reply', { chat_id: String(DM), text: SENTENCE })
    expect(r.sent).toEqual([{ method: 'sendMessage', body: { chat_id: String(DM), text: SENTENCE } }])
  })

  test('typewriter:true turns it on per call', async () => {
    const r = await h.call('reply', { chat_id: String(DM), text: SENTENCE, typewriter: true })
    const d = drafts(r.sent)
    expect(d.length).toBeGreaterThanOrEqual(4)
    expect(d.length).toBeLessThanOrEqual(8)
    expect(r.sent[r.sent.length - 1]).toEqual({ method: 'sendMessage', body: { chat_id: String(DM), text: SENTENCE } })
  })
})

describe('TELEGRAM_PLUS_TYPEWRITER=1', () => {
  let h: Awaited<ReturnType<typeof startHarness>>
  beforeAll(async () => { h = await startHarness({ TELEGRAM_PLUS_TYPEWRITER: '1' }) })
  afterAll(async () => { await h.stop() })
  beforeEach(() => { h.knobs.draft = undefined })

  test('private chat: 4-8 growing drafts on one draft_id, then the real message, within 2s', async () => {
    const r = await h.call('reply', { chat_id: String(DM), text: SENTENCE })
    const d = drafts(r.sent)
    expect(d.length).toBeGreaterThanOrEqual(4)
    expect(d.length).toBeLessThanOrEqual(8)
    const ids = new Set(d.map(c => c.body.draft_id))
    expect(ids.size).toBe(1)
    expect([...ids][0]).not.toBe(0)
    const texts = d.map(c => c.body.text as string)
    for (let i = 1; i < texts.length; i++) {
      expect(texts[i].startsWith(texts[i - 1])).toBe(true)
      expect(texts[i].length).toBeGreaterThan(texts[i - 1].length)
    }
    expect(texts[texts.length - 1]).toBe(SENTENCE)
    for (const t of texts) expect(SENTENCE.startsWith(t)).toBe(true)          // cuts on word boundaries
    expect(r.sent[r.sent.length - 1]).toEqual({ method: 'sendMessage', body: { chat_id: String(DM), text: SENTENCE } })
    expect(r.ms).toBeLessThan(2000)
    expect(r.ms).toBeGreaterThan(500) // it is a visible animation, not a burst
  })

  test('typewriter:false opts out', async () => {
    const r = await h.call('reply', { chat_id: String(DM), text: SENTENCE, typewriter: false })
    expect(drafts(r.sent)).toHaveLength(0)
  })

  test('group, files, ephemeral: no drafts', async () => {
    const g = await h.call('reply', { chat_id: String(GROUP), text: SENTENCE })
    expect(drafts(g.sent)).toHaveLength(0)
    const e = await h.call('reply', { chat_id: String(GROUP), text: SENTENCE, ephemeral_for: String(DM), typewriter: true })
    expect(drafts(e.sent)).toHaveLength(0)
    const f = await h.call('reply', { chat_id: String(DM), text: SENTENCE, files: [import.meta.path] })
    expect(drafts(f.sent)).toHaveLength(0)
  })

  test('long text: only the first ~600 chars are animated, full text is sent', async () => {
    const long = (SENTENCE + ' ').repeat(30).trim() // ~3000 chars
    const r = await h.call('reply', { chat_id: String(DM), text: long })
    const d = drafts(r.sent)
    expect(d.length).toBe(8)
    for (const c of d) expect((c.body.text as string).length).toBeLessThanOrEqual(600)
    expect(r.sent[r.sent.length - 1].body.text).toBe(long)
    expect(r.ms).toBeLessThan(2000)
  })

  test('keeps format, buttons, effect and reply_to on the real message', async () => {
    const r = await h.call('reply', {
      chat_id: String(DM), text: SENTENCE, reply_to: '9', effect_id: 'E',
      buttons: [[{ text: 'OK' }]],
    })
    const last = r.sent[r.sent.length - 1]
    expect(last.method).toBe('sendMessage')
    expect(last.body).toEqual({
      chat_id: String(DM), text: SENTENCE, reply_parameters: { message_id: 9 },
      message_effect_id: 'E', reply_markup: { inline_keyboard: [[{ text: 'OK', callback_data: 'u:OK' }]] },
    })
    for (const c of drafts(r.sent)) expect(c.body.reply_markup).toBeUndefined()
  })

  test('rich: drafts via sendRichMessageDraft, then sendRichMessage', async () => {
    const md = '## Tiến độ\n- [x] build xong\n- [ ] deploy đang chờ anh duyệt\n\n| Agent | Trạng thái |\n|--|--|\n| rnd | ổn |'
    const r = await h.call('reply', { chat_id: String(DM), text: md, format: 'rich' })
    const d = drafts(r.sent)
    expect(d.length).toBeGreaterThanOrEqual(4)
    expect(d.every(c => c.method === 'sendRichMessageDraft')).toBe(true)
    expect(r.sent[r.sent.length - 1]).toEqual({ method: 'sendRichMessage', body: { chat_id: String(DM), rich_message: { markdown: md } } })
  })

  test('markdownv2 cut mid-entity: rejected frame falls back to raw text drafts', async () => {
    h.knobs.draft = body => (body.parse_mode ? { fail: true } : undefined)
    const text = '*Kết quả*: tất cả các bước đã chạy xong và đã được kiểm lại bằng test'
    const r = await h.call('reply', { chat_id: String(DM), text, format: 'markdownv2' })
    const d = drafts(r.sent)
    expect(d[0].body.parse_mode).toBe('MarkdownV2')            // first try formatted
    expect(d.slice(1).every(c => c.body.parse_mode === undefined)).toBe(true) // then raw
    expect(d.length).toBeGreaterThanOrEqual(4)
    expect(r.sent[r.sent.length - 1]).toEqual({ method: 'sendMessage', body: { chat_id: String(DM), text, parse_mode: 'MarkdownV2' } })
  })

  test('drafts failing entirely: real message still sent', async () => {
    h.knobs.draft = () => ({ fail: true })
    const r = await h.call('reply', { chat_id: String(DM), text: SENTENCE })
    expect(r.isError).toBe(false)
    expect(r.sent[r.sent.length - 1]).toEqual({ method: 'sendMessage', body: { chat_id: String(DM), text: SENTENCE } })
    expect(r.ms).toBeLessThan(2000)
  })

  test('slow draft API: animation is cut at the 1.5s budget, total stays under 2s', async () => {
    h.knobs.draft = () => ({ delayMs: 700 })
    const r = await h.call('reply', { chat_id: String(DM), text: SENTENCE })
    expect(r.isError).toBe(false)
    expect(r.sent[r.sent.length - 1].method).toBe('sendMessage')
    expect(r.ms).toBeLessThan(2000)
  })

  test('draft_id follows the last inbound DM message (same id as the progress hook)', async () => {
    h.push({ message: { message_id: 4242, date: 0, chat: { id: DM, type: 'private' }, from: { id: DM, is_bot: false, first_name: 'E' }, text: 'kiểm agent giúp em' } })
    const before = h.notes.length
    await h.waitFor(() => h.notes.length > before)
    const r = await h.call('reply', { chat_id: String(DM), text: SENTENCE })
    expect(new Set(drafts(r.sent).map(c => c.body.draft_id))).toEqual(new Set([4242]))
  })

  test('one-word reply: single draft frame, then the message', async () => {
    const r = await h.call('reply', { chat_id: String(DM), text: 'Xong.' })
    expect(drafts(r.sent)).toHaveLength(1)
    expect(r.sent[r.sent.length - 1].body.text).toBe('Xong.')
  })
})
