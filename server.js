// =============================================
// ììíì¤íì´ ê³ ê°ìëµ ì±ë´ - ìë²
// 2ë¨ê³ RAG: ì ëª© ë¼ì°í â ê´ë ¨ ë¬¸ìë§ ë¡ë
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

// â ë³ê²½: DB ì ì²´ê° ìë ê³ ê°ìëë©ë´ì¼ íì´ì§ ID ì¬ì©
const CUSTOMER_PAGE_ID = process.env.NOTION_CUSTOMER_PAGE_ID;
const CHAT_PASSWORD = process.env.CHAT_PASSWORD;
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
const CACHE_TTL_MS = 5 * 60 * 1000;

// ââ ìºì ââââââââââââââââââââââââââââââââââââââ
let pagesListCache = null; // [{id, title}]
let pageContentCache = {}; // {pageId: content}
let cacheTimestamp = null;

function isCacheValid() {
  return cacheTimestamp && Date.now() - cacheTimestamp < CACHE_TTL_MS;
}

function clearCache() {
  pagesListCache = null;
  pageContentCache = {};
  cacheTimestamp = null;
}

// ââ ë¸ë¡ íì¤í¸ ì¶ì¶ ââââââââââââââââââââââââââ
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

// ââ Step 1: íì´ì§ ëª©ë¡ (ì ëª©ë§) âââââââââââââ
// â ë³ê²½: DB ì¿¼ë¦¬ â ê³ ê°ìëë©ë´ì¼ íì child_pageë§ ë¡ë
async function getPagesList() {
  if (isCacheValid() && pagesListCache) return pagesListCache;

  const response = await notion.blocks.children.list({
    block_id: CUSTOMER_PAGE_ID,
  });

  pagesListCache = response.results
    .filter(block => block.type === 'child_page')
    .map(block => ({
      id: block.id,
      title: block.child_page?.title || 'ì ëª© ìì',
    }));

  if (!cacheTimestamp) cacheTimestamp = Date.now();
  console.log(`[Notion] ë¬¸ì ëª©ë¡ ë¡ë: ${pagesListCache.length}ê°`);
  return pagesListCache;
}

// ââ Step 2: í¹ì  íì´ì§ ë´ì© ë¡ë ââââââââââââ
async function getPageContent(pageId, depth = 0) {
  if (depth > 2) return '';
  if (depth === 0 && isCacheValid() && pageContentCache[pageId]) return pageContentCache[pageId];

  let content = '';
  let hasMore = true;
  let cursor = undefined;

  while (hasMore) {
    const res = await notion.blocks.children.list({
      block_id: pageId,
      start_cursor: cursor,
    });

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

// ââ Step 3: ì§ë¬¸ì ê´ë ¨ë ë¬¸ì ì ë³ ââââââââââ
async function getRelevantPages(question, pagesList) {
  if (pagesList.length === 0) return [];
  if (pagesList.length === 1) return pagesList;

  const titlesText = pagesList.map((p, i) => `${i + 1}. ${p.title}`).join('\n');

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 80,
    system: 'ë¬¸ì ëª©ë¡ ì¤ ì§ë¬¸ê³¼ ê´ë ¨ë ë¬¸ì ë²í¸ë¥¼ JSON ë°°ì´ë¡ë§ ëµíì¸ì. ì: [1,3] / ê´ë ¨ ìì¼ë©´: []',
    messages: [{ role: 'user', content: `ì§ë¬¸: ${question}\n\në¬¸ì ëª©ë¡:\n${titlesText}` }],
  });

  try {
    const raw = response.content[0].text.trim();
    const indices = JSON.parse(raw.match(/\[.*?\]/)[0]);
    const relevant = indices.map(i => pagesList[i - 1]).filter(Boolean);
    console.log(`[RAG] ê´ë ¨ ë¬¸ì: ${relevant.map(p => p.title).join(', ') || 'ìì'}`);
    return relevant.length > 0 ? relevant : pagesList;
  } catch {
    console.log('[RAG] íì± ì¤í¨, ì ì²´ ë¬¸ì ì¬ì©');
    return pagesList;
  }
}

// ââ API: ì± âââââââââââââââââââââââââââââââââââ
app.post('/api/chat', async (req, res) => {
  const { message, password, history } = req.body;

  // â ë³ê²½: ë¹ë°ë²í¸ ë¯¸ì¤ì  ì íµê³¼ (ê³ ê°ì©ì ê³µê° ê°ë¥)
  if (CHAT_PASSWORD && password !== CHAT_PASSWORD) {
    return res.status(401).json({ error: 'ë¹ë°ë²í¸ê° ì¬ë°ë¥´ì§ ììµëë¤.' });
  }

  if (!message || message.trim() === '') {
    return res.status(400).json({ error: 'ë©ìì§ë¥¼ ìë ¥í´ì£¼ì¸ì.' });
  }

  try {
    // 1ë¨ê³: ë¬¸ì ëª©ë¡ ê°ì ¸ì¤ê¸°
    const pagesList = await getPagesList();

    // 2ë¨ê³: ê´ë ¨ ë¬¸ì ì ë³
    const relevantPages = await getRelevantPages(message.trim(), pagesList);

    // 3ë¨ê³: ê´ë ¨ ë¬¸ì ë´ì© ë¡ë
    let notionContent = '';
    for (const page of relevantPages) {
      const content = await getPageContent(page.id);
      notionContent += `\n\n=== ð ${page.title} ===\n${content}`;
    }

    // â ë³ê²½: ìì¤í íë¡¬íí¸ â ììíì¤íì´ ê³ ê°ìëµ ì±ë´
    const systemPrompt = `ë¹ì ì ììíì¤íì´ ê³ ê°ìëµ ì±ë´ìëë¤.
ê³ ê°ì ìì½, ì´ì©, ì·¨ì, ìì¤ ê´ë ¨ ë¬¸ìì ìë ìë´ ë¬¸ìë¥¼ ê¸°ë°ì¼ë¡ë§ ì¹ì íê² ëµë³íì¸ì.

[ëµë³ ê·ì¹]
- ë°ë»íê³  ì¹ê·¼í ì¡´ëë§ë¡ ëµë³íì¸ì.
- íµì¬ ë´ì©ë§ 3ì¤ ì´ë´ë¡ ê°ê²°íê² ëµë³íì¸ì.
- ë¨ê³ë³ ì¤ëªì´ íìí ê²½ì°ìë§ ë²í¸ë¥¼ ë¶ì¬ì ì¤ëªíì¸ì.
- ##, **, --, --- ê°ì ë§í¬ë¤ì´ ê¸°í¸ë ì ë ì¬ì©íì§ ë§ì¸ì.
- ë¬¸ìì ìë ë´ì©ì "ë´ë¹ì íì¸ í ìë´ëë¦¬ê² ìµëë¤. ì ìë§ ê¸°ë¤ë ¤ ì£¼ì¸ì ð"ë¼ê³  ëµë³íì¸ì.
- ì¶ì¸¡íê±°ë ììë¡ ë´ì©ì ë§ë¤ì§ ë§ì¸ì.
- í­ì ìì°ì¤ë¬ì´ íêµ­ì´ë¡ ëµë³íì¸ì.

=== ì°¸ì¡° ë¬¸ì ===
${notionContent || 'ê´ë ¨ ë¬¸ìë¥¼ ì°¾ì ì ììµëë¤.'}`;

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

    res.json({ reply: response.content[0].text });

  } catch (err) {
    console.error('[ì¤ë¥]', err.message);
    res.status(500).json({ error: 'ìë² ì¤ë¥ê° ë°ìíìµëë¤.' });
  }
});

// ââ API: ìºì ìë¡ê³ ì¹¨ ââââââââââââââââââââââââ
app.post('/api/refresh', async (req, res) => {
  const { password } = req.body;

  if (CHAT_PASSWORD && password !== CHAT_PASSWORD) {
    return res.status(401).json({ error: 'ê¶í ìì' });
  }

  clearCache();
  try {
    await getPagesList();
    res.json({ message: `ë¸ì ë¬¸ì ëª©ë¡ì´ ê°±ì ëììµëë¤. (${pagesListCache.length}ê° ë¬¸ì)` });
  } catch (err) {
    res.status(500).json({ error: 'ê°±ì  ì¤í¨: ' + err.message });
  }
});

// ââ ìë² ìì ââââââââââââââââââââââââââââââââââ
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`\nð¬ ììíì¤íì´ ê³ ê°ìëµ ì±ë´ (2ë¨ê³ RAG)`);
  console.log(`ð¡ ìë² ì£¼ì: http://localhost:${PORT}`);
  console.log(`ð¤ ëª¨ë¸: ${MODEL}`);
  try {
    await getPagesList();
  } catch (err) {
    console.error('[ê²½ê³ ] ë¸ì ë¬¸ì ë¡ë ì¤í¨:', err.message);
  }
});
