// =============================================
// 위시풀스테이 고객응답 챗봇 - 서버
// 2단계 RAG: 제목 라우팅 → 관련 문서만 로드
// =============================================

require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { Client: NotionClient } = require('@notionhq/client');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const notion = new NotionClient({ auth: process.env.NOTION_API_KEY });

const CUSTOMER_PAGE_ID = process.env.NOTION_CUSTOMER_PAGE_ID;
const CHAT_PASSWORD = process.env.CHAT_PASSWORD;
const LOG_DB_ID = process.env.NOTION_LOG_DB_ID;
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
const CACHE_TTL_MS = 5 * 60 * 1000;

let pagesListCache = null;
let pageContentCache = {};
let cacheTimestamp = null;

function isCacheValid() {
  return cacheTimestamp && Date.now() - cacheTimestamp < CACHE_TTL_MS;
}

function clearCache() {
  pagesListCache = null;
  pageContentCache = {};
  cacheTimestamp = null;
}

function extractBlockText(block) {
  const type = block.type;
  if (!block[type]) return '';
  const richText = block[type].rich_text || [];
  const text = richText.map(rt => rt.plain_text).join('');
  switch (type) {
    case 'heading_1': return `\n# ${text}\n`;
    case 'heading_2': return `\n## ${text}\n`;
    case 'heading_3': return `\n### ${text}\n`;
    case 'bulleted_list_item': return `- ${text}\n`;
    case 'numbered_list_item': return `1. ${text}\n`;
    case 'quote': return `> ${text}\n`;
    case 'divider': return `---\n`;
    case 'paragraph': return text ? `${text}\n` : '\n';
    default: return text ? `${text}\n` : '';
  }
}

async function logChat(question, reply) {
  if (!LOG_DB_ID) return;
  try {
    const title = question.length > 50 ? question.slice(0, 50) + '…' : question;
    await notion.pages.create({
      parent: { database_id: LOG_DB_ID },
      properties: {
        '제목': { title: [{ text: { content: title } }] },
        '질문': { rich_text: [{ text: { content: question } }] },
        '답변': { rich_text: [{ text: { content: reply.slice(0, 2000) } }] },
      },
    });
  } catch (err) {
    console.error('[로그 저장 실패]', err.message);
  }
}

async function getPagesList() {
  if (isCacheValid() && pagesListCache) return pagesListCache;
  const response = await notion.blocks.children.list({ block_id: CUSTOMER_PAGE_ID });
  pagesListCache = response.results
    .filter(block => block.type === 'child_page')
    .map(block => ({ id: block.id, title: block.child_page?.title || '제목 없음' }));
  if (!cacheTimestamp) cacheTimestamp = Date.now();
  console.log(`[Notion] 문서 목록 로드: ${pagesListCache.length}개`);
  return pagesListCache;
}

async function getPageContent(pageId, depth = 0) {
  if (depth > 2) return '';
  if (depth === 0 && isCacheValid() && pageContentCache[pageId]) return pageContentCache[pageId];
  let content = '';
  let hasMore = true;
  let cursor = undefined;
  while (hasMore) {
    const res = await notion.blocks.children.list({ block_id: pageId, start_cursor: cursor });
    for (const block of res.results) {
      if (block.type === 'child_page') {
        const childTitle = block.child_page?.title || '';
        content += `\n[${childTitle}]\n`;
        content += await getPageContent(block.id, depth + 1);
      } else {
        content += extractBlockText(block);
      }
    }
    hasMore = res.has_more;
    cursor = res.next_cursor;
  }
  if (depth === 0) pageContentCache[pageId] = content;
  return content;
}

async function getRelevantPages(question, pagesList) {
  if (pagesList.length === 0) return [];
  if (pagesList.length === 1) return pagesList;
  const titlesText = pagesList.map((p, i) => `${i + 1}. ${p.title}`).join('\n');
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 80,
    system: '문서 목록 중 질문과 관련된 문서 번호를 JSON 배열로만 답하세요. 예: [1,3] / 관련 없으면: []',
    messages: [{ role: 'user', content: `질문: ${question}\n\n문서 목록:\n${titlesText}` }],
  });
  try {
    const raw = response.content[0].text.trim();
    const indices = JSON.parse(raw.match(/\[.*?\]/)[0]);
    const relevant = indices.map(i => pagesList[i - 1]).filter(Boolean);
    console.log(`[RAG] 관련 문서: ${relevant.map(p => p.title).join(', ') || '없음'}`);
    return relevant.length > 0 ? relevant : pagesList;
  } catch {
    console.log('[RAG] 파싱 실패, 전체 문서 사용');
    return pagesList;
  }
}

app.post('/api/chat', async (req, res) => {
  const { message, password, history } = req.body;
  if (CHAT_PASSWORD && password !== CHAT_PASSWORD) {
    return res.status(401).json({ error: '비밀번호가 올바르지 않습니다.' });
  }
  if (!message || message.trim() === '') {
    return res.status(400).json({ error: '메시지를 입력해주세요.' });
  }
  try {
    const pagesList = await getPagesList();
    const relevantPages = await getRelevantPages(message.trim(), pagesList);
    let notionContent = '';
    for (const page of relevantPages) {
      const content = await getPageContent(page.id);
      notionContent += `\n\n=== 📄 ${page.title} ===\n${content}`;
    }

    const isFirstMessage = !Array.isArray(history) || history.length === 0;

    const systemPrompt = `당신은 위시풀스테이 고객응답 챗봇입니다.
고객의 예약, 이용, 취소, 시설 관련 문의에 아래 안내 문서를 기반으로만 친절하게 답변하세요.

[답변 규칙]
- 따뜻하고 친근한 존댓말로 답변하세요.
- ${isFirstMessage ? '첫 번째 답변이므로 "안녕하세요! 위시풀스테이입니다 😊"로 시작하세요.' : '두 번째 이후 답변이므로 인사말(안녕하세요 등)은 절대 쓰지 마세요. 바로 본론부터 시작하세요.'}
- 핵심 내용만 3줄 이내로 간결하게 답변하세요.
- 단계별 설명이 필요한 경우에만 번호를 붙여서 설명하세요.
- ##, **, --, --- 같은 마크다운 기호는 절대 사용하지 마세요.
- 문서에 없는 내용은 "담당자 확인 후 안내드리겠습니다. 잠시만 기다려 주세요 😊"라고 답변하세요.
- 추측하거나 임의로 내용을 만들지 마세요.
- 항상 자연스러운 한국어로 답변하세요.

=== 참조 문서 ===
${notionContent || '관련 문서를 찾을 수 없습니다.'}`;

    const messages = [
      ...(Array.isArray(history) ? history.slice(-10) : []),
      { role: 'user', content: message.trim() },
    ];

    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: systemPrompt,
      messages,
    });

    const reply = response.content[0].text;
    res.json({ reply });
    logChat(message.trim(), reply);

  } catch (err) {
    console.error('[오류]', err.message);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

app.post('/api/refresh', async (req, res) => {
  const { password } = req.body;
  if (CHAT_PASSWORD && password !== CHAT_PASSWORD) {
    return res.status(401).json({ error: '권한 없음' });
  }
  clearCache();
  try {
    await getPagesList();
    res.json({ message: `노션 문서 목록이 갱신되었습니다. (${pagesListCache.length}개 문서)` });
  } catch (err) {
    res.status(500).json({ error: '갱신 실패: ' + err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`\n💬 위시풀스테이 고객응답 챗봇 (2단계 RAG)`);
  console.log(`📡 서버 주소: http://localhost:${PORT}`);
  console.log(`🤖 모델: ${MODEL}`);
  try {
    await getPagesList();
  } catch (err) {
    console.error('[경고] 노션 문서 로드 실패:', err.message);
  }
});
