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

// Pilot guide flows — selectors must match the live frontend DOM exactly.
// When the AI returns guide_flow, this map is used to resolve the steps.
const GUIDE_FLOWS = {
  create_listing: [
    { type: 'hash_nav',  hash: '#/dashboard' },
    { type: 'scroll_to', selector: "[data-for='listing-section']",   message: 'Scroll to the My Listing section.' },
    { type: 'click',     selector: "[data-for='listing-section']" },
    { type: 'highlight', selector: '#create-listing-btn',            message: "Tap 'Create Listing' to get started." },
    { type: 'highlight', selector: '#biz-cat',                       message: 'Pick a category — this determines where you appear in search results.', requiresInput: true },
    { type: 'highlight', selector: '#save-listing-btn',              message: 'Fill in your details, then tap here to publish your listing.' },
  ],
  service_requests: [
    { type: 'hash_nav',  hash: '#/dashboard' },
    { type: 'scroll_to', selector: "[data-for='enquiries-section']", message: 'Your Service Requests are right here — all customer enquiries come in through this section.' },
  ],
  messenger: [
    { type: 'hash_nav',  hash: '#/connect' },
    { type: 'scroll_to', selector: '#conv-list', message: 'BridgePro Messenger is here — tap any conversation to open it, or go to a listing and tap Connect to start a new one.' },
  ],
  my_documents: [
    { type: 'hash_nav', hash: '#/provider/documents', message: 'Opening My Documents — all your receipts, invoices and credit memos are saved here and available to download at any time.' },
  ],
  payroll: [
    { type: 'hash_nav', hash: '#/provider/payroll', message: 'Opening Payroll Ledger — manage your staff, run payroll, and download statutory compliance reports here.' },
  ],
  business_health: [
    { type: 'hash_nav', hash: '#/provider/finance', message: 'Opening Business Health — your credit profile, trust score and underwriting insights are here.' },
  ],
};

setInterval(() => {
  const now = Date.now();
  for (const [key, val] of aiCache) {
    if (now - val.ts > CACHE_TTL) aiCache.delete(key);
  }
}, 10 * 60 * 1000);

router.post('/chat', async (req, res) => {
  const { message, conversationHistory = [], provider = 'groq', is_hands_free = false, pending_agent_tool = null } = req.body;

  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'Message is required' });
  }

  // Fix: Consume normalized 3-letter code from middleware (SLU, GRD, SVG)
  const countryCode = req.countryCode || 'SVG';
  let userId = null;
  let role = null;
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      const decoded = jwt.verify(authHeader.slice(7), process.env.JWT_SECRET);
      userId = decoded.id;
      role = decoded.role;
    } catch (err) {
      console.warn('AI chat auth token parsing failed:', err.message);
    }
  }

  const isActionIntent = /check|enquir|message|unread|task|remind|schedule|calendar|todo|pending|book|procure|buy|alarm|translate|translat|news|headline|creat|delet|updat|edit|reschedul|search|what can you|what do you|capabilities|tools|apps/i.test(message);
  let activeProvider = provider;

  // Authenticated users (providers, customers with accounts) always use Claude
  // so they always have access to the full tool suite (calendar, tasks, translate, news…)
  if (userId && activeProvider === 'groq') {
    console.log(`[AI Routing] Authenticated user ${userId} — upgrading to Claude for full tool access.`);
    activeProvider = 'claude';
  } else if (activeProvider === 'groq' && isActionIntent) {
    console.log(`[AI Routing] Action intent detected ("${message.slice(0,60)}"). Upgraded provider from groq to claude for tool execution.`);
    activeProvider = 'claude';
  }

  const cacheKey = `${countryCode}:${activeProvider}:${message.trim().toLowerCase()}`;
  const cached = aiCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return res.json(cached.data);
  }
  const keywords = isActionIntent ? [] : message
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

  let pendingActionsContext = '';
  if (userId) {
    try {
      const pendingData = await CLAUDE_TOOL_EXECUTORS.checkPendingActions({ type: 'all' }, { userId, countryCode, role });
      if (pendingData && pendingData.success) {
        pendingActionsContext = JSON.stringify({
          enquiries: pendingData.enquiries,
          tasks: pendingData.tasks,
          chatConversations: pendingData.chatConversations,
          inventory: pendingData.inventory
        });
      }
    } catch (err) {
      console.error('Failed to pre-fetch pending actions for AI prompt:', err.message);
    }
  }

  // Pre-fetch pending listings for admin — grounded IDs for approve_listing agent_tool
  let pendingListingsContext = '';
  if (userId && role === 'admin') {
    try {
      const { rows: pending } = await db.query(
        `SELECT l.id, l.business_name, l.description, l.created_at, c.name AS category_name
         FROM listings l
         LEFT JOIN categories c ON c.id = l.category_id
         WHERE l.is_active = false AND l.country_code = $1
         ORDER BY l.created_at DESC LIMIT 10`,
        [countryCode]
      );
      if (pending.length > 0) pendingListingsContext = JSON.stringify(pending);
    } catch (err) {
      console.error('Failed to pre-fetch pending listings for AI context:', err.message);
    }
  }

  // Pre-fetch latest headlines when news/headlines are mentioned — works for both Groq and Claude
  let headlinesContext = '';
  const isNewsIntent = /news|headline|article|buzz|current events|latest/i.test(message);
  if (isNewsIntent) {
    try {
      const { rows: articles } = await db.query(
        `SELECT a.title, a.url, a.excerpt, a.published_at, f.name AS source
         FROM rss_articles a
         JOIN rss_feeds f ON f.id = a.feed_id
         WHERE f.is_active = true
           AND (f.country_code = $1 OR f.country_code = 'ALL')
         ORDER BY a.published_at DESC NULLS LAST
         LIMIT 8`,
        [countryCode]
      );
      if (articles.length > 0) {
        headlinesContext = articles.map((a, i) =>
          `${i + 1}. [${a.source}] ${a.title}${a.excerpt ? ' — ' + a.excerpt.slice(0, 120) : ''} (${a.url})`
        ).join('\n');
      }
    } catch (err) {
      console.error('Failed to pre-fetch news headlines for AI prompt:', err.message);
    }
  }

  const systemPrompt = `You are Bridge AI, an autonomous marketplace and life assistant built into BridgePro. You help users manage calendar tasks, search merchant listings, initiate procurement workflows, and control their Connek mini apps — all from a single conversation.
${userId ? `You are interacting with the user whose ID is "${userId}" and role is "${role || 'customer'}".` : ''}
Here are relevant service listings from our database: ${listingsContext}. Here are relevant job listings: ${jobsContext}.${productsContext ? ' Here are matching products and prices: ' + productsContext + '.' : ''}
${pendingActionsContext ? `Here are the user's current pending actions, tasks, open chat conversations with messages, and business inventory: ${pendingActionsContext}.` : ''}
${pendingListingsContext ? `Here are listings currently pending admin approval (use these EXACT IDs for approve_listing agent_tool — never invent IDs): ${pendingListingsContext}.` : ''}
${headlinesContext ? `Here are the latest Caribbean news headlines — read these out and summarise when the user asks about news:\n${headlinesContext}\nFor each article, format its link as [OPEN_URL:url|Headline Title] so the user can tap to open it in the BridgeBrowser. Always include [OPEN_URL] links for article URLs.` : ''}

CONNEK APP WRITE ACCESS — You have full read/write tool access to the following Connek mini apps on behalf of the user:
- CALENDAR & TASKS: createCalendarTask (create), updateCalendarTask (edit/reschedule/mark done), deleteCalendarTask (remove), searchCalendarTask (find by title/date including completed tasks).
- NEWS FEEDS: manageNewsFeed (create/update/deactivate RSS feeds — admin/moderator only).
- TRANSLATE: translateText (translate any text between languages using the local translation engine).
- MARKETPLACE: fetchListing (search BridgePro listings), initiateProcurementWorkflow (create purchase orders), checkPendingActions (read all pending tasks, enquiries, messages, inventory).
- VOICE MODE: Bridge AI has a hands-free voice mode — users tap the mic to talk and say "stop listening" to exit. In voice mode they can describe a listing or enquiry reply and Bridge AI drafts it for review before sending. Mention this when asked about your capabilities or features; do not bring it up otherwise.
Use these tools directly on the user's behalf when they ask. Inform the user when a write action is completed.

HONESTY ABOUT YOUR OWN STATE — This applies globally to every response:
- You do not have a persistent memory system across sessions. What you "remember" is only whatever is in the current conversation context you were actually given for this request — nothing more.
- If asked whether you remember something: check what is actually visible in your current context. If it is there, confirm it plainly (e.g. "Yes — we were discussing X and Y", stating only what is actually present). Do not dramatise it as proof of a memory system.
- If you are not sure whether something survived (e.g. the user mentions the app closed, restarted, or a long gap occurred), say so honestly: "I'm not certain what carried over — can you remind me, or tell me what you'd like to pick back up?" Do not confidently assert continuity you cannot verify.
- Never describe your own architecture, memory persistence, or deployment status with invented specifics. If you don't actually know, say so rather than producing a plausible-sounding but unverified answer.
- This applies especially to completed actions: never say a submission, payment, or status change succeeded unless you have actual confirmation from a real tool/endpoint response — not because it seems like the kind of thing that should have worked.
- Bridge AI does not process payments and has no payment tool. If a user asks about paying online, checkout, or similar, say plainly that payment isn't handled in-app yet and will be arranged directly between customer and provider — never imply otherwise or attempt to walk someone through a payment flow that doesn't exist.

DOCUMENT DELIVERY & RECEIPT FALLBACK:
Every receipt, invoice, and credit memo generated on BridgePro is permanently saved to the provider's Documents tab at the moment it is created — regardless of whether the download pill appears correctly in this chat. The document is never lost even if the chat button fails.
- If a provider says they cannot see a receipt, the download button is missing, or the pill did not appear: say "No problem — your receipt is saved in My Documents. I'll take you there now." and set guide_flow to "my_documents".
- If a provider wants to send a receipt or invoice to a customer: tell them to open My Documents, download the file, then send it directly via WhatsApp, email, or BridgePro Messenger. This is the correct human-verified delivery workflow — the provider confirms the document looks right before forwarding it to the customer.
- Never tell a provider a receipt is unavailable or needs regenerating. It is always recoverable from My Documents.
- Receipts appear under the "Receipts" section; invoices under "Invoices"; credit memos under "Other Documents".
- For payroll statutory reports: direct them to #/provider/payroll → Payroll History → download CSV or PDF from any run card.

CRITICAL RULES:
1. CONTEXT MEMORY: Before creating any calendar task or starting a procurement workflow, you MUST invoke checkPendingActions to see if a similar task or order is already pending. If it is pending, inform the user and ask if they still wish to proceed. Do not duplicate reminders or purchase orders.
2. MESSAGE CHECKING & AUDIT: When checking messages/conversations (using either the provided open chatConversations context or checkPendingActions):
   - Identify unread messages: Any message in the messages array of chatConversations where is_read = false and sender_id != current userId is unread (new). Always state and read out these new messages.
   - Older messages check: If all messages in a conversation are read, tell the user there are no new messages, summarize the last message, and ask if they would like to go through older messages.
   - Reply Audit: Check the last message in each conversation. If the last message was from the other party (sender_id != current userId), note that they haven't replied to it yet and offer an action to reply.
3. INVENTORY & STOCK CHECK: When a provider asks about their stock/inventory or when matching an enquiry for items, check the \`inventory\` array returned by checkPendingActions. It contains \`name\`, \`in_stock\`, and \`stock_quantity\`. Let the store owner know if they have the item and exactly how many units are in stock.
4. BOOKING & OVER-BOOKING AUDIT: When service providers or clients check tasks/appointments, review the \`due_at\` timestamp in the \`tasks\` array (which represents bookings). Let the provider know if there are already bookings at that date/time to avoid over-booking.
5. TASK SEARCH BEFORE EDIT/DELETE: When a user asks to update, edit, reschedule, mark as done, or delete a task and the task ID is not already known, you MUST first call \`searchCalendarTask\` with \`includeDone: true\` to locate the correct task by title. Use the returned task ID for any subsequent \`updateCalendarTask\` or \`deleteCalendarTask\` calls. Never guess or invent task IDs.
6. FINANCIAL INTELLIGENCE — PREDICTIVE SAVINGS: When you can see the user's booking or enquiry history (from checkPendingActions or the pending actions context), identify if they repeatedly use the same service category (e.g., plumbing, taxi, cleaning, tutoring). If a pattern of 2+ similar bookings exists, check the inventory/products context for any business_products in that category where deal_price is set and lower than price, and deal_expires has not passed. If a live deal is found, proactively include this in your reply: "You book [category] regularly — [Business Name] has a current deal on [product name]: was $[price], now $[deal_price] (save [X]%). Want me to check their availability?" Only trigger when both conditions are met: (1) clear repeat pattern, AND (2) an active, unexpired deal_price exists.
7. CALENDAR ACCESS OPTION: If the user request, response, or conversation mentions, implies, or relates to any date, time, scheduling, booking, appointment, reminder, or calendar agenda, you MUST include a tool action in your JSON response's \`tool_actions\` array to open/access the calendar, formatted precisely as:
   { "label": "Open Calendar 📅", "action": "open_app", "params": { "app": "calendar" } }
7. TRANSLATE OPTION: If the user asks to translate something or mentions a language, use the translateText tool directly and return the translated result in your reply. Also suggest opening the translate app:
   { "label": "Open Translator 🌍", "action": "open_app", "params": { "app": "translate" } }
8. JSON RESPONSE FORMAT: Your final response to the user must strictly be a valid JSON object in this exact format:
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
  ],
  "guide_flow": null,
  "agent_tool": null
}
If no tools/buttons are applicable, set tool_actions to an empty array [].
Return ONLY the JSON string. Do not output any markdown code blocks, trailing text or commentary.
9. APP NAVIGATION GUIDES — When the user asks HOW TO DO something inside the BridgePro app (e.g. "how do I create a listing", "where are my enquiries", "how do I open the messenger"), set guide_flow to the matching key:
- "create_listing"    — how to create or publish a business/service listing
- "service_requests"  — how to find or view service requests and customer enquiries
- "messenger"         — how to open or use BridgePro Messenger
- "my_documents"      — where to find receipts, invoices, or credit memos; when a receipt pill failed in chat; when provider wants to retrieve and send a document to a customer
- "payroll"           — how to access the Payroll Ledger, run payroll, manage staff, or download a statutory report
- "business_health"   — how to view the business credit profile, trust score, or MSME report
- null                — for ALL other questions (content questions, service searches, etc.)
Never set guide_flow for content queries. Only set it when the user is asking for in-app navigation help or document recovery.
10. AGENT TOOLS — Set agent_tool when the user requests one of these actions. Set agent_tool to null for ALL other messages. Never set both guide_flow and agent_tool simultaneously.

── DRAFT LISTING ── When a provider wants you to CREATE a listing for them and gives at least a service type and some description:
{ "name": "draft_listing", "status": "draft", "data": {
  "business_name": "ONLY include if the user explicitly stated a trading name — use \"\" if not given",
  "category_name": "pick ONE from: Construction & Trades, Automotive, Transport & Delivery, Beauty & Wellness, Landscaping & Outdoors, Food & Catering, Technology, Home Services, Education & Training, Professional Services, Equipment & Rentals, Garment & Fashion, Retail & Trade, Health & Medical, Entertainment & Events, Marine & Fishing, Childcare & Domestic, Government & Public",
  "description": "polished description based on what they told you (max 500 chars)",
  "service_areas": ["areas they mentioned — omit if none"]
} }
If key fields are missing, still render the card AND ask for them in your reply. Only trigger for CREATE requests — for HOW-TO questions use guide_flow instead.

── DRAFT REPLY ── When a provider wants to send a reply to a customer's service request/enquiry, ALWAYS set agent_tool (the card will show a picker if the enquiry can't be identified):
{ "name": "draft_reply", "status": "draft", "data": {
  "enquiry_id": "copy the EXACT enquiry id from the enquiries array in your context if you can identify which one — use \"\" if there are multiple and the user hasn't specified, or if no enquiries are in context",
  "customer_name": "customer name from the matched enquiry — \"\" if unknown",
  "draft_text": "a professional, helpful reply based on what the provider said (max 800 chars)"
} }
NEVER invent or guess an enquiry_id — only use real IDs from pendingActionsContext. If the user says "reply to John" and you see an enquiry from John in context, use that ID. If uncertain, use \"\" — the card will let the user pick. Still always render the card so the reply can be sent.

── APPROVE / REJECT LISTING ── Admin only. When an admin wants to approve or reject a pending listing, use real IDs from the pending listings context — NEVER invent a listing_id:
{ "name": "approve_listing", "status": "draft", "data": {
  "listing_id": "EXACT id from pending listings context",
  "business_name": "business name from context",
  "category_name": "category from context",
  "description": "description from context (truncate to 300 chars for display)",
  "action": "approve",
  "reason": ""
} }
Set action to "approve" or "reject". reason is required for reject (leave "" for approve). If the admin says "approve all" or "reject X with reason Y", render one card at a time, not multiple. Only available when the user's role is admin and pending listings are in context.

── MARK JOB COMPLETE ── When a provider wants to mark a job (scheduled appointment) as completed:
{ "name": "mark_job_complete", "status": "draft", "data": {
  "job_id": "EXACT job/appointment ID (integer) from provider's scheduled jobs (due/upcoming tasks) — leave as null if not specified or if no active job exists in context, the card will display a picker",
  "completion_note": "Optional short note summarizing the completion details"
} }
Ensure the job_id is grounded against real appointments/jobs. NEVER guess or invent one.

── CANCEL ENQUIRY ── When a customer wants to cancel/withdraw a pending enquiry/service request:
{ "name": "cancel_enquiry", "status": "draft", "data": {
  "enquiry_id": "EXACT enquiry conversation ID (integer) from customer's pending enquiries list — leave as null if not specified, the card will show a picker",
  "reason": "Optional reason for withdrawing/cancelling the enquiry"
} }
Ensure the enquiry_id is grounded. NEVER invent one.

── SUBMIT REVIEW ── When a customer wants to review/rate a completed job or transaction:
{ "name": "submit_review", "status": "draft", "data": {
  "transaction_id": "EXACT transaction UUID (string) from completed jobs list — leave as null if not specified, the card will show a picker",
  "rating": "Rating score from 1 to 5 (integer, e.g. 5)",
  "body": "Optional written review text describing the experience"
} }
Ensure the transaction_id is grounded. Never guess or invent one.

── GET REVIEWS ── When a user asks to see reviews for a provider listing:
{ "name": "get_reviews", "status": "draft", "data": {
  "listing_id": "EXACT listing UUID (string) of the provider listing to retrieve reviews for"
} }
This is a read-only tool. If listing_id is not known, ask the user to specify which business listing they want to see reviews for.

── CONFIRM HANDLING ── When the user says something confirm-shaped ("yes", "submit it", "confirm", "send it", "looks good", "go ahead"):
- If session context says hands-free is OFF: tell them to tap the button on the card (e.g. "Go ahead and tap Publish Listing on the card above to publish it."). Set agent_tool to null. NEVER say "I don't have that tool" or "I can't do that directly" — you can always instruct them to tap.
- If session context says hands-free is ON and an unsubmitted draft is listed: set agent_tool to {"name": "<same name as the draft>", "status": "confirm", "data": <current data from session context, unchanged>}. Your reply MUST confirm out loud (e.g. "Done — submitting your listing now." or "Sending your reply now.") since hands-free users may not be looking at the screen.
- If hands-free is ON but there is NO pending draft in session context: do not fabricate a submission. Reply asking what they'd like to confirm.`
  + `\n\n[Session context: hands-free voice is ${is_hands_free ? 'ON' : 'OFF'}. ${pending_agent_tool ? `Unsubmitted draft: ${pending_agent_tool.name} with current data: ${JSON.stringify(pending_agent_tool.data)}.` : 'No pending draft.'}]`;

  try {
    let aiMessage;

    if (activeProvider === 'claude') {
      const claudeMessages = conversationHistory.map(m => ({ role: m.role, content: m.content }));
      claudeMessages.push({ role: 'user', content: message.trim() });

      const context = { userId, countryCode, role };
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
      let parsed = null;
      const start = aiMessage.indexOf('{');
      const end = aiMessage.lastIndexOf('}');
      if (start !== -1 && end !== -1 && end > start) {
        try {
          parsed = JSON.parse(aiMessage.slice(start, end + 1));
        } catch (jsonErr) {
          console.warn('Failed to parse extracted JSON substring:', jsonErr.message);
        }
      }

      if (!parsed) {
        const cleaned = aiMessage.replace(/```json|```/g, '').trim();
        parsed = JSON.parse(cleaned);
      }

      const guideActions = parsed.guide_flow ? (GUIDE_FLOWS[parsed.guide_flow] || null) : null;
      const agentTool = parsed.agent_tool || null;
      responseData = {
        reply: parsed.reply || aiMessage,
        tool_actions: parsed.tool_actions || [],
        guide_actions: guideActions,
        agent_tool: agentTool,
        listings,
        jobs,
        products
      };
    } catch (e) {
      responseData = {
        reply: aiMessage,
        tool_actions: [],
        guide_actions: null,
        agent_tool: null,
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
  const { message, country_code, provider = 'groq', conversationHistory = [] } = req.body;

  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'Message is required' });
  }

  // Extract JWT token from request header to resolve userId and role
  let userId = null;
  let role = null;
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      const decoded = jwt.verify(authHeader.slice(7), process.env.JWT_SECRET);
      userId = decoded.id;
      role = decoded.role;
    } catch (err) {
      console.warn('Connek AI chat auth token parsing failed:', err.message);
    }
  }

  const isActionIntent = /check|enquir|message|unread|task|remind|schedule|calendar|todo|pending|book|procure|buy|alarm|translate|translat|news|headline|creat|delet|updat|edit|reschedul|search|what can you|what do you|capabilities|tools|apps/i.test(message);
  let activeProvider = provider;

  // Authenticated users always get Claude for full tool access
  if (userId && activeProvider === 'groq') {
    console.log(`[AI Routing/Connek] Authenticated user ${userId} — upgrading to Claude for full tool access.`);
    activeProvider = 'claude';
  } else if (activeProvider === 'groq' && isActionIntent) {
    console.log(`[AI Routing/Connek] Action intent detected — upgrading to Claude.`);
    activeProvider = 'claude';
  }

  const rawCountry = country_code || req.headers['x-country-code'] || 'SVG';
  // Connek stores ISO alpha-2 codes (VC, BB, GD, LC) but BridgePro DB uses alpha-3 (SVG, BRB, GRD, SLU)
  const COUNTRY_MAP = { 'VC': 'SVG', 'BB': 'BRB', 'GD': 'GRD', 'LC': 'SLU' };
  const countryCode = COUNTRY_MAP[rawCountry.toUpperCase()] || rawCountry;
  const cacheKey = `connek:${countryCode}:${activeProvider}:${message.trim().toLowerCase()}`;
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

  const rawKeywords = isActionIntent ? [] : message
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

  let pendingActionsContext = '';
  if (userId) {
    try {
      const pendingData = await CLAUDE_TOOL_EXECUTORS.checkPendingActions({ type: 'all' }, { userId, countryCode, role });
      if (pendingData && pendingData.success) {
        pendingActionsContext = JSON.stringify({
          enquiries: pendingData.enquiries,
          tasks: pendingData.tasks,
          chatConversations: pendingData.chatConversations,
          inventory: pendingData.inventory
        });
      }
    } catch (err) {
      console.error('Failed to pre-fetch pending actions for Connek AI prompt:', err.message);
    }
  }

  // Pre-fetch latest headlines when news/headlines are mentioned — works for both Groq and Claude
  let headlinesContext = '';
  const isNewsIntent = /news|headline|article|buzz|current events|latest/i.test(message);
  if (isNewsIntent) {
    try {
      const { rows: articles } = await db.query(
        `SELECT a.title, a.url, a.excerpt, a.published_at, f.name AS source
         FROM rss_articles a
         JOIN rss_feeds f ON f.id = a.feed_id
         WHERE f.is_active = true
           AND (f.country_code = $1 OR f.country_code = 'ALL')
         ORDER BY a.published_at DESC NULLS LAST
         LIMIT 8`,
        [countryCode]
      );
      if (articles.length > 0) {
        headlinesContext = articles.map((a, i) =>
          `${i + 1}. [${a.source}] ${a.title}${a.excerpt ? ' — ' + a.excerpt.slice(0, 120) : ''} (${a.url})`
        ).join('\n');
      }
    } catch (err) {
      console.error('Failed to pre-fetch news headlines for Connek AI prompt:', err.message);
    }
  }

  let svgLocalTime = '';
  try {
    const { rows: svgRows } = await db.query("SELECT TO_CHAR(LOCALTIMESTAMP, 'YYYY-MM-DD HH24:MI') AS t");
    svgLocalTime = svgRows[0]?.t || '';
  } catch (_) {}

  let systemPrompt = `You are Bri, a warm Caribbean AI life assistant built into Connek — the Caribbean super app. You help people solve everyday problems by finding local services on BridgePro and navigating Connek mini apps. Users on BridgePro can also talk to you and you can write to their Connek apps on their behalf.
${svgLocalTime ? `Current date and time in Saint Vincent is ${svgLocalTime} (UTC-4, no DST). Use this to resolve day names and phrases like "tomorrow", "next Tuesday", "June 25th" into ISO 8601 dates when calling createCalendarTask. For relative times like "in 5 minutes" or "in 2 hours", use minutes_from_now instead — the server computes the exact time.\n` : ''}${userId ? `You are interacting with the user whose ID is "${userId}" and role is "${role || 'customer'}".` : ''}

CONNEK APP WRITE ACCESS — You have full read/write tool access to the following Connek mini apps on behalf of the user:
- CALENDAR & TASKS: createCalendarTask (create), updateCalendarTask (edit/reschedule/mark done), deleteCalendarTask (remove), searchCalendarTask (find by title/date including completed tasks).
- NEWS FEEDS: manageNewsFeed (create/update/deactivate RSS feeds — admin/moderator only).
- TRANSLATE: translateText (translate any text between languages using the local engine — return the result directly in your reply).
- MARKETPLACE: fetchListing (search listings), initiateProcurementWorkflow (place orders), checkPendingActions (read tasks, enquiries, messages, inventory).
Use these tools directly on the user's behalf when they ask. Always confirm to the user when a write action is completed.

When a user describes a problem or need:
1. Search for relevant BridgePro providers using the context provided and name them specifically with their contact info when available.
2. If a Connek mini app can help, suggest opening it using this exact format: [OPEN_APP:appname] where appname is one of: calendar, tasks, translate, news, fitness, meals, arcade, study, tip, ocr, bridgemeet, cashflow, qrquest, social, wahgwaan
3. Keep responses warm, concise, and Caribbean in tone.
4. When you mention a specific business from the listings context, wrap it as: [BUSINESS:BusinessName:listingId]. Use the id field from the listing context. Example: [BUSINESS:VC-TAC:179aca40-b3db-498d-b030-838513aa0a0b]. This renders as a clickable button that opens the business profile on BridgePro.
5. CALENDAR ACCESS OPTION: Whenever any date, time, scheduling, booking, appointment, reminder, or calendar agenda is mentioned, implied, or involved in the conversation, you MUST suggest opening the calendar mini app by outputting \`[OPEN_APP:calendar]\` in your response text.
6. KEYWORD APP SUGGESTION TRIGGERS (Suggest opening the app whenever the user mentions related topics/keywords):
   - calendar: calendar, schedule, date, booking, time, appointment, agenda, reminder, tomorrow, next week, alarm
   - tasks: tasks, todo, to-do, list, checklist, chores, follow-up, job tasks
   - translate: translate, translation, language, speak, spanish, french, patois, creole, dictionary
   - news: news, buzz, article, headlines, feed, current events, read, paper
   - fitness: fitness, workout, gym, exercise, cardio, running, health, steps, run
   - meals: meal, meals, recipe, cooking, lunch, dinner, food, eat, ingredients, prep
   - arcade: game, play, fun, bored, arcade, gaming, play game
   - study: study, flashcard, flashcards, quiz, learn, test, exam, revision, practice
   - tip: tip, report, anonymous, leak, alert, crime, tip line
   - ocr: ocr, scanner, scan, text, read photo, extract text, scan image
   - bridgemeet: meet, video, call, conference, meeting, zoom, video call
   - cashflow: cashflow, money, expenses, budget, finance, tracker, spending, accounting
   - qrquest: qr, scan, code, code scanner, scan code, bar code
   - social: social, feed, post, comment, share, community, wall, updates
   - wahgwaan: chat, local chat, community chat, chatroom

Relevant local listings: ${listingsContext}
Relevant job listings: ${jobsContext}
${productsContext ? 'Matching products from local businesses: ' + productsContext + '.' : ''}
${pendingActionsContext ? `Here are the user's current pending actions, tasks, open chat conversations with messages, and business inventory: ${pendingActionsContext}.` : ''}
${headlinesContext ? `Here are the latest Caribbean news headlines. When the user asks about news, read them out warmly and name the source. For each article, format its link as [OPEN_URL:url|Headline Title] so the user can tap to open it in the BridgeBrowser. Always include these [OPEN_URL] links and suggest [OPEN_APP:news] to browse more.` : ''}


CARIBBEAN SEARCH SYNONYMS (treat these as equivalent when interpreting user queries):
- gel soft = gel ball = orbie = gelsoft = VC-TAC (a gel ball party activity provider)
- pastry = pastries = cake = dessert = bakery = baked goods
- taekwondo = martial arts = karate = self defense = combat sports

CRITICAL RULES:
1. CONTEXT MEMORY: Before creating any calendar task or starting a procurement workflow, you MUST invoke checkPendingActions to see if a similar task or order is already pending. If it is pending, inform the user and ask if they still wish to proceed. Do not duplicate reminders or purchase orders.
2. MESSAGE CHECKING & AUDIT: When checking messages/conversations (using either the provided open chatConversations context or checkPendingActions):
   - Identify unread messages: Any message in the messages array of chatConversations where is_read = false and sender_id != current userId is unread (new). Always state and read out these new messages.
   - Older messages check: If all messages in a conversation are read, tell the user there are no new messages, summarize the last message, and ask if they would like to go through older messages.
   - Reply Audit: Check the last message in each conversation. If the last message was from the other party (sender_id != current userId), note that they haven't replied to it yet and offer an action to reply.
3. INVENTORY & STOCK CHECK: When a provider asks about their stock/inventory or when matching an enquiry for items, check the \`inventory\` array returned by checkPendingActions. It contains \`name\`, \`in_stock\`, and \`stock_quantity\`. Let the store owner know if they have the item and exactly how many units are in stock.
4. BOOKING & OVER-BOOKING AUDIT: When service providers or clients check tasks/appointments, review the \`due_at\` timestamp in the \`tasks\` array (which represents bookings). Let the provider know if there are already bookings at that date/time to avoid over-booking.
5. TASK SEARCH BEFORE EDIT/DELETE: When a user asks to update, edit, reschedule, mark as done, or delete a task and the task ID is not already known, you MUST first call \`searchCalendarTask\` with \`includeDone: true\` to locate the correct task by title. Use the returned task ID for any subsequent \`updateCalendarTask\` or \`deleteCalendarTask\` calls. Never guess or invent task IDs.
6. If the listings context says No specific listings found — you MUST say you could not find a specific provider and direct them to bridgepro.a3tech.uk. NEVER invent, guess or suggest business names that are not in the listings context. Only recommend businesses explicitly listed in the context provided.
7. FINANCIAL INTELLIGENCE — PREDICTIVE SAVINGS: When you can see the user's booking or enquiry history (from checkPendingActions or the pending actions context), identify if they repeatedly use the same service category (e.g., plumbing, taxi, cleaning, tutoring). If a pattern of 2+ similar bookings exists, check the inventory/products context for any business_products in that category where deal_price is set and lower than price, and deal_expires has not passed. If a live deal is found, proactively include in your reply: "You book [category] regularly — [Business Name] has a deal on [product name]: was $[price], now $[deal_price] (save [X]%). Want me to check their availability?" Only trigger when both conditions are met: (1) clear repeat pattern, AND (2) an active, unexpired deal_price exists.
8. PAYMENT DISCLAIMER: Bridge AI does not process payments and has no payment tool. If a user asks about paying online, checkout, or similar, say plainly that payment isn't handled in-app yet and will be arranged directly between customer and provider — never imply otherwise or attempt to walk someone through a payment flow that doesn't exist.

Always be warm, Caribbean, and helpful. Sign off as Bri 💜`;

  if (activeProvider === 'claude') {
    systemPrompt += `\n\n6. JSON RESPONSE FORMAT: Your final response to the user must strictly be a valid JSON object in this exact format:
{
  "reply": "Your conversational answer to the user containing Bri's response (written as Bri 💜)"
}
Return ONLY the JSON string. Do not output any markdown code blocks, trailing text or commentary.`;
  }

  try {
    let aiMessage;

    if (activeProvider === 'claude') {
      const claudeMessages = conversationHistory.map(m => ({ role: m.role, content: m.content }));
      claudeMessages.push({ role: 'user', content: message.trim() });

      const context = { userId, countryCode, role };
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
              console.log('Connek AI Claude executing tool:', fnName, JSON.stringify(block.input));
              const executor = CLAUDE_TOOL_EXECUTORS[fnName];
              result = executor ? await executor(block.input, context) : { error: `Unknown tool: ${fnName}` };
              console.log('Connek AI Claude tool result:', JSON.stringify(result));
            } catch (toolErr) {
              console.error('Connek AI Claude tool executor crash:', fnName, toolErr.message);
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

      let reply = aiMessage;
      try {
        let parsed = null;
        const start = aiMessage.indexOf('{');
        const end = aiMessage.lastIndexOf('}');
        if (start !== -1 && end !== -1 && end > start) {
          try {
            parsed = JSON.parse(aiMessage.slice(start, end + 1));
          } catch (jsonErr) {
            console.warn('Failed to parse extracted JSON substring:', jsonErr.message);
          }
        }

        if (!parsed) {
          const cleaned = aiMessage.replace(/```json|```/g, '').trim();
          parsed = JSON.parse(cleaned);
        }

        reply = parsed.reply || aiMessage;
      } catch (e) {
        console.warn('Connek Claude response JSON parse fallback to plain text:', e.message);
      }

      const responseData = { reply, cached: false };
      aiCache.set(cacheKey, { data: responseData, ts: Date.now() });
      res.json(responseData);

    } else {
      const groqMessages = [
        { role: 'system', content: systemPrompt },
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
      if (!response.ok) throw new Error(data.error?.message || 'Groq API error');

      const reply = data.choices[0].message.content;
      const responseData = { reply, cached: false };
      aiCache.set(cacheKey, { data: responseData, ts: Date.now() });
      res.json(responseData);
    }
  } catch (err) {
    console.error('Connek AI chat error:', err.message);
    res.status(500).json({ error: 'AI service temporarily unavailable.' });
  }
});

module.exports = router;
