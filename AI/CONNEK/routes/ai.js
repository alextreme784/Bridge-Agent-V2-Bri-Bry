const express = require('express');
const db = require('../db');
const Anthropic = require('@anthropic-ai/sdk');
const jwt = require('jsonwebtoken');
const { CLAUDE_TOOL_SCHEMAS, CLAUDE_TOOL_EXECUTORS } = require('../config/claudeTools');

const router = express.Router();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'do', 'does', 'have', 'has', 'any', 'for',
  'on', 'in', 'at', 'to', 'of', 'and', 'or', 'with', 'what', 'where', 'who',
  'how', 'can', 'i', 'me', 'my', 'find', 'show', 'tell', 'get', 'need', 'want',
  'looking', 'but', 'not', 'you', 'all', 'her', 'was', 'one', 'our', 'out',
  'day', 'him', 'his', 'its', 'may', 'new', 'now', 'old', 'see', 'two', 'did',
  'let', 'put', 'say', 'she', 'too', 'use', 'this', 'will', 'your', 'from',
  'they', 'know', 'been', 'good', 'much', 'some', 'time', 'that', 'just',
  'into', 'over', 'also', 'back', 'after', 'about', 'there', 'which',
  'look', 'more', 'like', 'help', 'near', 'best',
]);

const aiCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [key, val] of aiCache) {
    if (now - val.ts > CACHE_TTL) aiCache.delete(key);
  }
}, 10 * 60 * 1000);

router.post('/chat', async (req, res) => {
  const { message, conversationHistory = [], provider = 'groq' } = req.body;

  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'Message is required' });
  }

  // Fix: Consume normalized 3-letter code from middleware (SLU, GRD, SVG)
  const countryCode = req.countryCode || 'SVG';
  const cacheKey = `${countryCode}:${provider}:${message.trim().toLowerCase()}`;
  const cached = aiCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return res.json(cached.data);
  }

  const keywords = message
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOPWORDS.has(w))
    .slice(0, 6);

  let listings = [];
  let jobs = [];
  let products = [];
  if (keywords.length > 0) {
    try {
      const searchTerms = keywords.map(k => `%${k}%`);
      const [listingsResult, jobsResult, productsResult] = await Promise.all([
        db.query(`
          SELECT l.id, l.business_name, l.description, l.phone, l.whatsapp,
                 l.website_url, l.service_areas, l.logo_url,
                 c.name AS category_name
          FROM listings l
          LEFT JOIN categories c ON c.id = l.category_id
          WHERE l.is_active = true
            AND l.country_code = $1
            AND (
              l.business_name ILIKE ANY($2::text[])
              OR l.description ILIKE ANY($2::text[])
              OR l.category_id::text ILIKE ANY($2::text[])
            )
          ORDER BY l.created_at DESC
          LIMIT 10
        `, [countryCode, searchTerms]),
        db.query(`
          SELECT j.title, j.description, j.job_type, j.listing_type, j.location,
                 c.name AS category_name
          FROM job_listings j
          LEFT JOIN categories c ON c.id = j.category_id
          WHERE j.is_active = true
            AND j.country_code = $1
            AND (
              j.title ILIKE ANY($2::text[])
              OR j.description ILIKE ANY($2::text[])
            )
          ORDER BY j.created_at DESC
          LIMIT 10
        `, [countryCode, searchTerms]),
        db.query(`
          SELECT bp.name, bp.description, bp.price, bp.currency, bp.unit,
                 bp.in_stock, bp.deal_price, bp.deal_expires, l.business_name
          FROM business_products bp
          JOIN listings l ON l.id = bp.listing_id
          WHERE bp.country_code = $1
            AND l.is_active = true
            AND (
              bp.name ILIKE ANY($2::text[])
              OR bp.description ILIKE ANY($2::text[])
              OR bp.category ILIKE ANY($2::text[])
            )
          ORDER BY bp.name ASC
          LIMIT 15
        `, [countryCode, searchTerms]),
      ]);
      listings = listingsResult.rows;
      jobs = jobsResult.rows;
      products = productsResult.rows;
    } catch (err) {
      console.error('AI chat DB search error:', err.message);
    }
  }

  const listingsContext = listings.length > 0
    ? listings.map(l => `${l.business_name} (${l.category_name || 'Service'}): ${l.description}`).join('; ')
    : 'No specific listings found for this query.';

  const jobsContext = jobs.length > 0
    ? jobs.map(j => `[${j.listing_type === 'hire_me' ? 'Available for hire' : 'Job wanted'}] ${j.title} (${j.category_name || 'General'}${j.location ? ', ' + j.location : ''}): ${j.description}`).join('; ')
    : 'No specific job listings found for this query.';

  const productsContext = products.length > 0
    ? products.map(p => {
        const price = p.price ? `$${p.price} ${p.currency}${p.unit ? ' ' + p.unit : ''}` : 'price on request';
        const stock = p.in_stock ? '' : ' (out of stock)';
        let dealInfo = '';
        if (p.deal_price && (!p.deal_expires || new Date(p.deal_expires) > new Date())) {
          const expiryStr = p.deal_expires
            ? ` until ${new Date(p.deal_expires).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`
            : '';
          dealInfo = ` [on sale for $${p.deal_price}${expiryStr}]`;
        }
        return `${p.business_name} sells ${p.name}${p.description ? ' — ' + p.description : ''}: ${price}${dealInfo}${stock}`;
      }).join('; ')
    : null;

  const systemPrompt = `You are Bridge AI, an autonomous marketplace and life assistant. You help users manage calendar tasks, search merchant listings, and initiate procurement workflows.
Here are relevant service listings from our database: ${listingsContext}. Here are relevant job listings: ${jobsContext}.${productsContext ? ' Here are matching products and prices: ' + productsContext + '.' : ''}

CRITICAL RULES:
1. CONTEXT MEMORY: Before creating any calendar task or starting a procurement workflow, you MUST invoke checkPendingActions to see if a similar task or order is already pending. If it is pending, inform the user and ask if they still wish to proceed. Do not duplicate reminders or purchase orders.
2. JSON RESPONSE FORMAT: Your final response to the user must strictly be a valid JSON object in this exact format:
{
  "reply": "Your conversational answer to the user",
  "tool_actions": [
    {
      "label": "Text for Pill Button (e.g. 'Initiate Chat' or 'Schedule Booking')",
      "action": "action_name (e.g. 'initiate_chat' or 'schedule_booking')",
      "params": {
        "providerId": "listing_id_uuid_or_user_id_uuid",
        "taskDetails": "description",
        "timestamp": "date"
      }
    }
  ]
}
If no tools/buttons are applicable, set tool_actions to an empty array [].
Return ONLY the JSON string. Do not output any markdown code blocks, trailing text or commentary.`;

  try {
    let aiMessage;

    if (provider === 'claude') {
      const claudeMessages = conversationHistory.map(m => ({ role: m.role, content: m.content }));
      claudeMessages.push({ role: 'user', content: message.trim() });

      // Optional user parsing from Authorization header
      let userId = null;
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        try {
          const decoded = jwt.verify(authHeader.slice(7), process.env.JWT_SECRET);
          userId = decoded.id;
        } catch (err) {
          console.warn('AI chat auth token parsing failed:', err.message);
        }
      }

      const context = { userId, countryCode };
      let iterations = 0;
      const MAX_ITERATIONS = 5;

      while (iterations < MAX_ITERATIONS) {
        iterations++;
        const response = await anthropic.messages.create({
          model: 'claude-sonnet-4-5',
          max_tokens: 1024,
          system: systemPrompt,
          tools: CLAUDE_TOOL_SCHEMAS,
          messages: claudeMessages,
        });

        if (response.stop_reason === 'end_turn') {
          aiMessage = response.content.find(b => b.type === 'text')?.text || '';
          break;
        }

        if (response.stop_reason === 'tool_use') {
          claudeMessages.push({ role: 'assistant', content: response.content });
          const toolResults = [];

          for (const block of response.content) {
            if (block.type !== 'tool_use') continue;

            const fnName = block.name;
            let result;
            try {
              console.log('AI Claude executing tool:', fnName, JSON.stringify(block.input));
              const executor = CLAUDE_TOOL_EXECUTORS[fnName];
              result = executor ? await executor(block.input, context) : { error: `Unknown tool: ${fnName}` };
              console.log('AI Claude tool result:', JSON.stringify(result));
            } catch (toolErr) {
              console.error('AI Claude tool executor crash:', fnName, toolErr.message);
              result = { error: toolErr.message };
            }

            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) });
          }

          claudeMessages.push({ role: 'user', content: toolResults });
          continue;
        }

        aiMessage = response.content.find(b => b.type === 'text')?.text || '';
        break;
      }
    } else {
      const groqMessages = [
        { role: 'system', content: systemPrompt + ' Be concise. Maximum 3 sentences for simple queries. List products in one line each. Never repeat information.' },
        ...conversationHistory.map(m => ({ role: m.role, content: m.content })),
        { role: 'user', content: message.trim() },
      ];

      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: groqMessages,
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error?.message || 'Groq API error');
      }
      aiMessage = data.choices[0].message.content;
    }

    let responseData;
    try {
      const cleaned = aiMessage.replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(cleaned);
      responseData = {
        reply: parsed.reply || aiMessage,
        tool_actions: parsed.tool_actions || [],
        listings,
        jobs,
        products
      };
    } catch (e) {
      responseData = {
        reply: aiMessage,
        tool_actions: [],
        listings,
        jobs,
        products
      };
    }

    aiCache.set(cacheKey, { data: responseData, ts: Date.now() });
    res.json(responseData);
  } catch (err) {
    console.error('AI chat error:', err.message);
    res.status(500).json({ error: 'AI service temporarily unavailable.' });
  }
});

router.post('/connek-chat', async (req, res) => {
  const { message, country_code } = req.body;

  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'Message is required' });
  }

  const rawCountry = country_code || req.headers['x-country-code'] || 'SVG';
  // Connek stores ISO alpha-2 codes (VC, BB, GD, LC) but BridgePro DB uses alpha-3 (SVG, BRB, GRD, SLU)
  const COUNTRY_MAP = { 'VC': 'SVG', 'BB': 'BRB', 'GD': 'GRD', 'LC': 'SLU' };
  const countryCode = COUNTRY_MAP[rawCountry.toUpperCase()] || rawCountry;
  const cacheKey = `connek:${countryCode}:${message.trim().toLowerCase()}`;
  const cached = aiCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return res.json({ ...cached.data, cached: true });
  }

  const SYNONYMS = {
    'gel': ['gel', 'orbie', 'gelsoft', 'gel ball'],
    'orbie': ['gel', 'orbie', 'gelsoft', 'gel ball'],
    'gelsoft': ['gel', 'orbie', 'gelsoft', 'gel ball'],
    'pastry': ['pastry', 'pastries', 'cake', 'dessert', 'bakery', 'baked'],
    'pastries': ['pastry', 'pastries', 'cake', 'dessert', 'bakery', 'baked'],
    'cake': ['pastry', 'pastries', 'cake', 'dessert', 'bakery', 'baked'],
    'dessert': ['pastry', 'pastries', 'cake', 'dessert', 'bakery', 'baked'],
    'bakery': ['pastry', 'pastries', 'cake', 'dessert', 'bakery', 'baked'],
    'taekwondo': ['taekwondo', 'martial arts', 'karate', 'self defense', 'self defence', 'combat'],
    'karate': ['taekwondo', 'martial arts', 'karate', 'self defense', 'self defence', 'combat'],
    'martial': ['taekwondo', 'martial arts', 'karate', 'self defense', 'self defence', 'combat'],
  };

  const rawKeywords = message
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOPWORDS.has(w))
    .slice(0, 6);

  const keywords = [...new Set(rawKeywords.flatMap(w => SYNONYMS[w] || [w]))];

  let listings = [];
  let jobs = [];
  let products = [];
  if (keywords.length > 0) {
    try {
      const searchTerms = keywords.map(k => `%${k}%`);
      const [listingsResult, jobsResult, productsResult] = await Promise.all([
        db.query(`
          SELECT l.id, l.business_name, l.description, l.phone, l.whatsapp,
                 l.website_url, l.service_areas, l.logo_url,
                 c.name AS category_name
          FROM listings l
          LEFT JOIN categories c ON c.id = l.category_id
          WHERE l.is_active = true
            AND l.country_code = $1
            AND (
              l.business_name ILIKE ANY($2::text[])
              OR l.description ILIKE ANY($2::text[])
              OR l.category_id::text ILIKE ANY($2::text[])
            )
          ORDER BY l.created_at DESC
          LIMIT 10
        `, [countryCode, searchTerms]),
        db.query(`
          SELECT j.title, j.description, j.job_type, j.listing_type, j.location,
                 c.name AS category_name
          FROM job_listings j
          LEFT JOIN categories c ON c.id = j.category_id
          WHERE j.is_active = true
            AND j.country_code = $1
            AND (
              j.title ILIKE ANY($2::text[])
              OR j.description ILIKE ANY($2::text[])
            )
          ORDER BY j.created_at DESC
          LIMIT 10
        `, [countryCode, searchTerms]),
        db.query(`
          SELECT bp.name, bp.description, bp.price, bp.currency, bp.unit,
                 bp.in_stock, bp.deal_price, bp.deal_expires, l.business_name,
                 l.phone, l.whatsapp
          FROM business_products bp
          JOIN listings l ON l.id = bp.listing_id
          WHERE bp.country_code = $1
            AND l.is_active = true
            AND (
              bp.name ILIKE ANY($2::text[])
              OR bp.description ILIKE ANY($2::text[])
              OR bp.category ILIKE ANY($2::text[])
            )
          ORDER BY bp.name ASC
          LIMIT 15
        `, [countryCode, searchTerms]),
      ]);
      listings = listingsResult.rows;
      jobs = jobsResult.rows;
      products = productsResult.rows;
    } catch (err) {
      console.error('Connek AI DB search error:', err.message);
    }
  }

  const listingsContext = listings.length > 0
    ? listings.map(l => {
        const contact = [l.phone && `Phone: ${l.phone}`, l.whatsapp && `WhatsApp: ${l.whatsapp}`].filter(Boolean).join(', ');
        return `id:${l.id} | ${l.business_name} (${l.category_name || 'Service'}): ${l.description}${contact ? ' — ' + contact : ''}`;
      }).join('; ')
    : 'No specific listings found for this query.';

  const jobsContext = jobs.length > 0
    ? jobs.map(j => `[${j.listing_type === 'hire_me' ? 'Available' : 'Wanted'}] ${j.title} (${j.category_name || 'General'}${j.location ? ', ' + j.location : ''}): ${j.description}`).join('; ')
    : 'No specific job listings found.';

  const productsContext = products.length > 0
    ? products.map(p => {
        const price = p.price ? `$${p.price} ${p.currency}${p.unit ? ' ' + p.unit : ''}` : 'price on request';
        const stock = p.in_stock ? '' : ' (out of stock)';
        let dealInfo = '';
        if (p.deal_price && (!p.deal_expires || new Date(p.deal_expires) > new Date())) {
          const expiryStr = p.deal_expires
            ? ` until ${new Date(p.deal_expires).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`
            : '';
          dealInfo = ` [on sale for $${p.deal_price}${expiryStr}]`;
        }
        const contact = [p.phone && `Phone: ${p.phone}`, p.whatsapp && `WhatsApp: ${p.whatsapp}`].filter(Boolean).join(', ');
        return `${p.business_name} sells ${p.name}${p.description ? ' — ' + p.description : ''}: ${price}${dealInfo}${stock}${contact ? ' — ' + contact : ''}`;
      }).join('; ')
    : null;

  const systemPrompt = `You are Bri, a warm Caribbean AI life assistant built into Connek — the Caribbean super app. You help people solve everyday problems by finding local services on BridgePro and navigating Connek mini apps.

When a user describes a problem or need:
1. Search for relevant BridgePro providers using the context provided and name them specifically with their contact info when available.
2. If a Connek mini app can help, suggest opening it using this exact format: [OPEN_APP:appname] where appname is one of: calendar, tasks, translate, news, fitness, meals, arcade, study, tip
3. Keep responses warm, concise, and Caribbean in tone.
4. When you mention a specific business from the listings context, wrap it as: [BUSINESS:BusinessName:listingId]. Use the id field from the listing context. Example: [BUSINESS:VC-TAC:179aca40-b3db-498d-b030-838513aa0a0b]. This renders as a clickable button that opens the business profile on BridgePro.

Examples:
- User: I need milk → suggest nearby grocery stores from listings, tag each as [BUSINESS:StoreName:their-uuid]
- User: My tire is flat → suggest auto repair providers tagged as [BUSINESS:name:uuid] + [OPEN_APP:tasks] to add a reminder
- User: I want to translate something → [OPEN_APP:translate]
- User: Set a reminder → [OPEN_APP:calendar]
- User: I'm bored → [OPEN_APP:arcade]
- User: I need to study → [OPEN_APP:study]

Relevant local listings: ${listingsContext}
Relevant job listings: ${jobsContext}
${productsContext ? 'Matching products from local businesses: ' + productsContext + '.' : ''}

CARIBBEAN SEARCH SYNONYMS (treat these as equivalent when interpreting user queries):
- gel soft = gel ball = orbie = gelsoft = VC-TAC (a gel ball party activity provider)
- pastry = pastries = cake = dessert = bakery = baked goods
- taekwondo = martial arts = karate = self defense = combat sports

CRITICAL RULE: If the listings context says No specific listings found — you MUST say you could not find a specific provider and direct them to bridgepro.a3tech.uk. NEVER invent, guess or suggest business names that are not in the listings context. Only recommend businesses explicitly listed in the context provided.

Always be warm, Caribbean, and helpful. Sign off as Bri 💜`;

  try {
    const groqMessages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: message.trim() },
    ];

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: groqMessages,
      }),
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'Groq API error');

    const reply = data.choices[0].message.content;
    const responseData = { reply, cached: false };
    aiCache.set(cacheKey, { data: responseData, ts: Date.now() });
    res.json(responseData);
  } catch (err) {
    console.error('Connek AI chat error:', err.message);
    res.status(500).json({ error: 'AI service temporarily unavailable.' });
  }
});

module.exports = router;
