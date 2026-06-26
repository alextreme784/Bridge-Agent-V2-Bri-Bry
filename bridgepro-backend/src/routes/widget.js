const express = require('express');
const cors = require('cors');
const db = require('../db');
const { getGroqToolsForRole } = require('./agent-tools');

const router = express.Router();

const widgetCors = cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
});

router.options('*', widgetCors);

// GET /api/widget/config?key=PARTNER_KEY
router.get('/config', widgetCors, async (req, res) => {
  const { key } = req.query;
  if (!key) return res.status(400).json({ valid: false, error: 'Missing key' });
  try {
    const { rows } = await db.query(
      'SELECT business_name, greeting, brand_color FROM partner_widgets WHERE partner_key = $1 AND is_active = true',
      [key]
    );
    if (!rows.length) return res.json({ valid: false });
    return res.json({ valid: true, ...rows[0] });
  } catch (err) {
    console.error('Widget config error:', err);
    return res.status(500).json({ valid: false, error: 'Server error' });
  }
});

// POST /api/widget/chat?key=PARTNER_KEY
router.post('/chat', widgetCors, async (req, res) => {
  const { key } = req.query;
  if (!key) return res.status(400).json({ error: 'Missing key' });

  try {
    const { rows } = await db.query(
      'SELECT business_name, country_code FROM partner_widgets WHERE partner_key = $1 AND is_active = true',
      [key]
    );
    if (!rows.length) return res.status(403).json({ error: 'Invalid partner key' });

    const { business_name } = rows[0];
    const country_code = rows[0].country_code || 'VC';
    const { messages = [], userMessage } = req.body;
    if (!userMessage) return res.status(400).json({ error: 'Missing userMessage' });

    console.log('WIDGET chat received:', userMessage, 'key:', key);

    const systemPrompt = `You are Bri, a warm Caribbean AI assistant embedded on partner websites, powered by BridgePro — the Caribbean service marketplace at https://bridgepro.a3tech.uk.

CRITICAL RULES:
1. When asked about activities, services, food, transport, or anything local — ALWAYS call search_providers first before responding
2. When asked to go to BridgePro or the main site — respond with: I can take you there! [VISIT_BRIDGEPRO]
3. Always search before saying something is not available
4. You serve Saint Vincent and the Grenadines — country code VC
5. Be warm, concise, Caribbean friendly`;

    const tools = getGroqToolsForRole('customer');

    const callGroq = async (msgs) => {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'meta-llama/llama-4-scout-17b-16e-instruct',
          messages: [{ role: 'system', content: systemPrompt }, ...msgs],
          tools,
          tool_choice: 'auto',
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error('Groq error: ' + JSON.stringify(data.error));
      return data;
    };

    const executeTool = async (name, args) => {
      if (name === 'search_providers') {
        const keywords = (args.query || '').toLowerCase()
          .replace(/[^\w\s]/g, ' ')
          .split(/\s+/)
          .filter(w => w.length > 2)
          .slice(0, 5);
        console.log('WIDGET search keywords:', keywords, 'country:', country_code);
        if (!keywords.length) return [];
        const searchTerms = keywords.map(k => '%' + k + '%');
        let sql = `
          SELECT l.id, l.business_name, l.description, l.phone, l.service_areas, c.name AS category_name
          FROM listings l LEFT JOIN categories c ON c.id = l.category_id
          WHERE l.is_active = true AND l.country_code = $1
            AND (l.business_name ILIKE ANY($2::text[]) OR l.description ILIKE ANY($2::text[]))
        `;
        const params = [country_code, searchTerms];
        if (args.category) { params.push('%' + args.category + '%'); sql += ` AND c.name ILIKE $${params.length}`; }
        sql += ' ORDER BY l.created_at DESC LIMIT 8';
        const { rows: results } = await db.query(sql, params);
        console.log('WIDGET search result:', JSON.stringify(results).slice(0, 200));
        return results;
      }
      return { error: `Tool ${name} not available in widget` };
    };

    // History + new message
    const history = (messages || []).slice(-10);
    let msgs = [...history, { role: 'user', content: userMessage }];

    for (let i = 0; i < 3; i++) {
      const data = await callGroq(msgs);
      console.log('WIDGET tool calls:', JSON.stringify(data.choices[0]?.message?.tool_calls));
      const choice = data.choices[0];
      const assistantMsg = choice.message;

      if (choice.finish_reason === 'stop' || !assistantMsg.tool_calls?.length) {
        return res.json({ reply: assistantMsg.content || '' });
      }

      msgs.push({ role: 'assistant', content: assistantMsg.content || null, tool_calls: assistantMsg.tool_calls });
      for (const toolCall of assistantMsg.tool_calls) {
        const args = JSON.parse(toolCall.function.arguments);
        const result = await executeTool(toolCall.function.name, args);
        msgs.push({ role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify(result) });
      }
    }

    const final = await callGroq(msgs);
    return res.json({ reply: final.choices[0].message.content || "I'm unable to help right now." });
  } catch (err) {
    console.error('Widget chat error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
